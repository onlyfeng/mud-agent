/**
 * autopilot 主循环 — 从 scripts/autopilot.js 迁移。
 */

import fs from "node:fs";
import type { Alert, AutopilotConfig, Decision, GameState, IStrategy, MudPaths, OutputLine } from "../../core/types.js";
import {
  claimStopSignal,
  clearStaleStopSignal as clearStaleStopSignalFile,
  hasStopSignal as hasStopSignalFile,
  isStopSuperseded,
  launchBoundaryMs,
  readGameModeRecord,
} from "../../infra/control-signal.js";
import { loadJSON, writeJSON } from "../../infra/file-store.js";
import { notify, sendToChannel } from "../../infra/notifier.js";
import { acquirePidLock, isProcessRunning, removeOwnPid, removePid } from "../../infra/process-guard.js";
import { enqueueCommands } from "../../infra/send-queue.js";
import { ExplorationStrategy } from "./exploration.strategy.js";
import { GrindingStrategy } from "./grinding.strategy.js";

const DEFAULT_CONFIG: AutopilotConfig = {
  style: "exploration",
  loopInterval: 3500,
  reportInterval: 4,
  safetyBoundary: {
    minHpPercent: 30,
    autoFlee: true,
    avoidCombatWith: [],
  },
  pauseOn: ["rare_item", "boss", "puzzle", "level_up"],
  autoPickup: true,
  combatEnabled: false,
  disconnectGraceSec: 150,
};

// 断连 wait tick 的统一长度；内部常量，不进 AutopilotConfig（避免引入
// 第二个"循环节拍"观念，用户只需要关心 disconnectGraceSec 即可）
const DISCONNECT_TICK_MS = 5000;
const DISCONNECT_GRACE_HARD_CAP_SEC = 3600;
// daemon 进程还活着时它在按自己的重连策略（10 次指数退避，累计 30 余分钟）努力：autopilot 只等，不按 disconnectGraceSec 退出；
// 这里是 daemon 活着但始终连不上/登不上时的兜底上限
const DAEMON_ALIVE_WAIT_CAP_TICKS = Math.ceil((DISCONNECT_GRACE_HARD_CAP_SEC * 1000) / DISCONNECT_TICK_MS);
const LOGIN_WAIT_MS = 60_000;
const LOGIN_POLL_MS = 1000;
// full-auto 下同类暂停事件（长战斗、稀有物品…）的频道通知冷却：同一事件每轮循环都会命中。
const FULL_AUTO_NOTICE_COOLDOWN_MS = 60_000;

/**
 * 等 daemon 登录完成（connected && loginDone），最多等 timeoutMs。
 * 用户在 daemon 还在登录时就切 semi-auto / full-auto 是常态，此时直接退出会让模式标记为自动但没有 autopilot 进程。
 * 导出供单测覆盖。
 */
export async function waitForLogin(
  paths: Pick<MudPaths, "state" | "pid" | "autopilotControl">,
  timeoutMs: number,
  log: (msg: string) => void,
  pollMs: number = LOGIN_POLL_MS,
): Promise<"ok" | "timeout" | "daemon-gone" | "stopped"> {
  const deadline = Date.now() + timeoutMs;
  let lastLogged = 0;
  while (Date.now() < deadline) {
    if (hasStopSignal(paths.autopilotControl)) {
      log("等待登录期间收到停止信号，取消启动。");
      return "stopped";
    }
    const s = loadJSON<Partial<GameState>>(paths.state, {});
    if (s.connected && s.loginDone) return "ok";
    if (!isProcessRunning(paths.pid)) {
      log("等待登录期间 daemon 已退出。");
      return "daemon-gone";
    }
    const now = Date.now();
    if (now - lastLogged >= 10_000) {
      log(`等待 daemon 登录… (connected=${s.connected}, loginDone=${s.loginDone})`);
      lastLogged = now;
    }
    await sleep(Math.min(pollMs, Math.max(deadline - now, 0)));
  }
  return "timeout";
}

const STARTUP_LOGIN_WAIT_CAP_MS = DISCONNECT_GRACE_HARD_CAP_SEC * 1000;

/**
 * 启动时等登录：daemon 进程还活着就一直等（它在按自己的重连策略重试、或还在交互式登录），与主循环一致；
 * 只有 daemon 退出、收到生效的 stop、或超过 1 h 兜底上限才放弃。导出供单测覆盖。
 */
export async function waitForLoginWhileDaemonAlive(
  paths: Pick<MudPaths, "state" | "pid" | "autopilotControl">,
  log: (msg: string) => void,
  opts: { capMs?: number; sliceMs?: number; pollMs?: number; onStop?: () => "exit" | "continue" } = {},
): Promise<"ok" | "timeout" | "daemon-gone"> {
  const capMs = opts.capMs ?? STARTUP_LOGIN_WAIT_CAP_MS;
  const sliceMs = opts.sliceMs ?? LOGIN_WAIT_MS;
  const onStop = opts.onStop ?? (() => (resolveStopSignal(paths as MudPaths, log) === "exit" ? "exit" : "continue"));
  const deadline = Date.now() + capMs;
  for (;;) {
    const outcome = await waitForLogin(paths, Math.min(sliceMs, Math.max(deadline - Date.now(), 1)), log, opts.pollMs);
    if (outcome === "ok" || outcome === "daemon-gone") return outcome;
    if (outcome === "stopped") {
      if (onStop() === "exit") process.exit(0);
      continue;
    }
    if (Date.now() >= deadline) return "timeout";
    log("daemon 仍在重连 / 登录中，继续等待…");
  }
}

export function hasStopSignal(controlFile: string): boolean {
  return hasStopSignalFile(controlFile);
}

/**
 * 上一个进程遗留的 stop 信号对新启动的 autopilot 没有意义；但只清早于本进程启动时刻写入的标记，
 * 派生后、进入主循环前用户发出的 stop（比如立即切回陪伴模式）必须保留。派生方也会在 spawn 前清一次。导出供单测覆盖。
 */
export function clearStaleStopSignal(controlFile: string, log: (msg: string) => void): boolean {
  return clearStaleStopSignalFile(controlFile, { notNewerThan: launchBoundaryMs(), log });
}

/**
 * 把 disconnectGraceSec 折算成主循环里的 tick 数。
 * - undefined / 非数字 / NaN → 默认 150s
 * - <= 0 → 立刻退出（1 tick）
 * - > 3600 → clamp 到 3600（2 小时兜底）
 * 导出供单测覆盖。
 */
export function resolveDisconnectTickLimit(graceSec: number | undefined): number {
  const fallback = 150;
  const raw = typeof graceSec === "number" && Number.isFinite(graceSec) ? graceSec : fallback;
  if (raw <= 0) return 1;
  const capped = Math.min(raw, DISCONNECT_GRACE_HARD_CAP_SEC);
  return Math.max(1, Math.ceil((capped * 1000) / DISCONNECT_TICK_MS));
}

/**
 * 收到 stop 后决定去留。先放开 PID 锁再裁决，只比较模式代际（因果序，不用墙钟）：
 * - stop 带着它发出时看到的模式代际（set-mode companion 是自己写的那一代，mud-ctl autopilot stop 是当时读到的）；
 * - 模式记录现在是 semi-auto / full-auto 且代际不同 → stop 之后又有人切回自动（而那次 set-mode 因为看到本进程还活着没有派生）
 *   → 被取代，重新拿锁继续；重新拿锁失败说明那次 set-mode 在我们放锁后已派生了新进程，本进程安静退出；
 * - 代际相同（stop 是最新意图）、模式是 companion、stop 没有代际或标了 force → 退出。
 * 放锁 → 读模式 → 拿锁 的顺序配合 O_EXCL 锁，任一交错都不会出现“模式是自动但没有 autopilot”。
 */
export function resolveStopSignal(
  paths: Pick<MudPaths, "root" | "autopilotPid" | "autopilotControl">,
  log: (msg: string) => void,
): "exit" | "continue" {
  // 原子认领：认领后写入的新 stop（比如更晚的显式停止）保留在原路径，下一轮再裁决。
  const stop = claimStopSignal(paths.autopilotControl);
  if (!stop) return "continue";
  removePid(paths.autopilotPid);
  const current = readGameModeRecord(paths.root);
  if (!isStopSuperseded(stop, current)) return "exit";
  if (!acquirePidLock(paths.autopilotPid)) {
    log("stop 已被新的 set-mode 取代且新 autopilot 已启动，本进程退出。");
    return "exit";
  }
  log(`stop 已被更晚的 set-mode ${current?.mode} 取代，继续运行。`);
  return "continue";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function appendReport(reportFile: string, text: string): void {
  const ts = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  const entry = `\n### ${ts}\n${text.trim()}\n`;
  try {
    fs.appendFileSync(reportFile, entry, "utf8");
  } catch {}
}

function logLine(logFile: string, msg: string): void {
  const line = `[${new Date().toLocaleTimeString("zh-CN", { hour12: false })}] ${msg}\n`;
  try {
    fs.appendFileSync(logFile, line);
  } catch {}
  process.stdout.write(line);
}

// autopilot 是单用途进程：队列锁被占就等（最多 SEND_LOCK_WAIT_MS，远长于任何生产者的毫秒级临界区），
// 策略状态与实际发出的命令因此始终一致。等了这么久还拿不到锁说明持锁者已经挂死，抛出让进程带着明确原因退出。
const SEND_LOCK_WAIT_MS = 30_000;

/** 入队；`unless` 在持锁时求值，为 true 则不写入。返回是否真的发出。 */
export function sendCommand(
  queueFile: string,
  cmd: string,
  log: (msg: string) => void,
  opts: { lockTimeoutMs?: number; unless?: () => boolean } = {},
): boolean {
  const added = enqueueCommands(queueFile, [cmd], {
    lockTimeoutMs: opts.lockTimeoutMs ?? SEND_LOCK_WAIT_MS,
    unless: opts.unless,
  });
  log(added.length > 0 ? `→ ${cmd}` : `等锁期间收到 stop，未发送 ${cmd}`);
  return added.length > 0;
}

function readOutputSince(outputFile: string, sinceTs: string): OutputLine[] {
  try {
    const content = fs.readFileSync(outputFile, "utf8");
    const lines = content.trim().split("\n").filter(Boolean);
    const result: OutputLine[] = [];
    for (const line of lines) {
      try {
        const obj = JSON.parse(line) as OutputLine;
        if (new Date(obj.ts) > new Date(sinceTs)) result.push(obj);
      } catch {}
    }
    return result;
  } catch {
    return [];
  }
}

/**
 * 取出自上次调用以来新解决的决策（最新一条），并把本次看到的所有已解决决策记为已消费。
 * 启动时先把文件里已有的已解决决策全部记为已消费，旧决策不会被当成"刚刚解决"。
 */
export type ResolvedDecision = { eventType?: string; choice: string | null };

export function takeNewlyResolvedDecision(decisionsFile: string, consumed: Set<string>): ResolvedDecision | null {
  const list = loadJSON<Decision[]>(decisionsFile, []);
  let latest: Decision | null = null;
  for (const d of list) {
    if (!d.resolved || consumed.has(d.id)) continue;
    consumed.add(d.id);
    latest = d;
  }
  if (!latest) return null;
  // CLI 允许"选项编号或文字"：编号先映射回该决策的选项文本，策略只看文本
  const choice = resolveChoiceText(latest.choice, latest.options);
  return { eventType: latest.eventType, choice };
}

export function resolveChoiceText(choice: string | null, options: string[] | undefined): string | null {
  if (choice === null) return null;
  const trimmed = choice.trim();
  if (/^\d+$/.test(trimmed) && options) {
    const option = options[Number(trimmed) - 1];
    if (option !== undefined) return option;
  }
  return trimmed;
}

function hasPendingDecisions(decisionsFile: string): boolean {
  const list = loadJSON<Decision[]>(decisionsFile, []);
  return list.some((d) => !d.resolved);
}

function writeDecision(
  decisionsFile: string,
  evt: {
    eventType?: string;
    summary: string;
    context: string;
    options: string[];
    priority?: string;
  },
  log: (msg: string) => void,
): void {
  const list = loadJSON<Decision[]>(decisionsFile, []);
  list.push({
    id: `d_${Date.now()}`,
    time: new Date().toISOString(),
    priority: (evt.priority as Decision["priority"]) || "high",
    eventType: evt.eventType,
    summary: evt.summary,
    context: evt.context,
    options: evt.options || ["继续", "暂停"],
    resolved: false,
    choice: null,
  });
  writeJSON(decisionsFile, list);
  log(`[决策] ${evt.summary}`);
}

/**
 * 本轮用哪份配置：
 * - 文件缺失 → 模式记录里的快照
 * - 文件没有 generation（旧格式 / 操作者删掉了）或与记录同代 → 文件（操作者热改文件下一轮生效）
 * - 文件与记录不同代 → 正有 set-mode 在写（文件已更新、记录还没）：用记录自己的快照，保持 (mode, config) 同一代
 */
export function selectLiveConfig(
  fileConfig: Partial<AutopilotConfig> | null,
  modeRecord: { generation?: string; autopilotConfig?: Record<string, unknown> } | null,
): Partial<AutopilotConfig> {
  const snapshot = modeRecord?.autopilotConfig as Partial<AutopilotConfig> | undefined;
  if (!fileConfig) return snapshot ?? {};
  if (!snapshot || typeof fileConfig.generation !== "string" || fileConfig.generation === modeRecord?.generation) {
    return fileConfig;
  }
  return snapshot;
}

/** 风格变了才切换；本轮有刚解决的决策时推迟一轮，让原策略先消费它。 */
export function shouldSwitchStrategy(
  configStyle: string | undefined,
  currentStyle: string,
  resolvedDecision: unknown,
): boolean {
  return Boolean(configStyle) && configStyle !== currentStyle && !resolvedDecision;
}

export function createStrategy(style: string): IStrategy {
  return style === "grinding" ? new GrindingStrategy() : new ExplorationStrategy();
}

export async function startAutopilot(paths: MudPaths): Promise<void> {
  const log = (msg: string) => logLine(paths.autopilotLog, msg);

  // 最先清掉上一个进程遗留的 stop：此刻之后写入的 stop 都是针对本进程的请求（比如等登录期间用户切回陪伴模式）。
  clearStaleStopSignal(paths.autopilotControl, log);

  // ── 修复 3：验证 daemon 存活，先拿 PID 锁再等登录 ──────────────────────────
  const daemonPid = isProcessRunning(paths.pid);
  if (!daemonPid) {
    log("daemon 未运行，无法启动 autopilot。请先 `mud-ctl start` 或 `mud_admin start`。");
    process.exit(1);
  }
  // PID 锁必须在等登录之前拿到：登录期间重复 set-mode 才能看到 autopilot.pid，不会派生多个等待进程。
  if (!acquirePidLock(paths.autopilotPid)) {
    log("另一个 autopilot 已在运行（PID 锁获取失败），拒绝启动。");
    process.exit(1);
  }
  const preState = loadJSON<Partial<GameState>>(paths.state, {});
  if (!preState.connected || !preState.loginDone) {
    log(
      `daemon 已启动 (PID ${daemonPid}) 但尚未完成登录 (connected=${preState.connected}, loginDone=${preState.loginDone})，最多等待 ${Math.round(LOGIN_WAIT_MS / 1000)}s。`,
    );
    const outcome = await waitForLoginWhileDaemonAlive(paths, log);
    if (outcome !== "ok") {
      const msg =
        outcome === "daemon-gone"
          ? "daemon 在等待登录期间退出，autopilot 未启动。"
          : `daemon 持续 ${Math.round(STARTUP_LOGIN_WAIT_CAP_MS / 1000)}s 未完成登录，autopilot 退出。登录成功后再切 semi-auto / full-auto。`;
      log(msg);
      appendReport(paths.report, `⚠️ ${msg}`);
      sendToChannel(paths.notifyTarget, `⚠️ ${msg}`, log);
      removeOwnPid(paths.autopilotPid);
      process.exit(1);
    }
  }

  const initialConfig = loadJSON<Partial<AutopilotConfig>>(paths.autopilotConfig, {});
  const styleArg = initialConfig.style || "exploration";
  log(`autopilot 启动，策略: ${styleArg}`);

  if (!fs.existsSync(paths.decisions)) writeJSON(paths.decisions, []);
  if (!fs.existsSync(paths.report)) {
    fs.writeFileSync(paths.report, `# autopilot 探索日志\n\n启动时间：${new Date().toLocaleString("zh-CN")}\n`, "utf8");
  }

  // SIGTERM 优雅退出（stop 命令的 800ms 后会发 SIGTERM，不注册则被硬杀不清理）
  // 不动控制文件：此刻里面可能已是更新的信号（并发的 set-mode / stop），删掉会让顶上来的新 autopilot 忽略它；
  // 本进程消费的那个信号由 resolveStopSignal/claimStopSignal 原子认领，启动时的 clearStaleStopSignal 按派生边界清遗留。
  process.on("SIGTERM", () => {
    log("收到 SIGTERM，优雅退出");
    removeOwnPid(paths.autopilotPid);
    process.exit(0);
  });

  // 等锁期间 SIGTERM 处理器跑不了、控制文件也没轮询：拿到锁后、写入前在同一临界区里裁决 stop（与主循环开头同一个
  // resolveStopSignal：认领、代际比较、被取代则重新持 PID 继续）。裁决为退出 → 不写入且本进程立即退出，不存在
  // "取消了发送却继续跑"的中间状态；裁决为继续 → 命令照发，策略状态与实际发送一致。
  let stopVerdict: "exit" | null = null;
  const stopPending = () => {
    if (hasStopSignal(paths.autopilotControl) && resolveStopSignal(paths, log) === "exit") {
      stopVerdict = "exit";
      return true;
    }
    return false;
  };
  const stoppedWhileSending = (): boolean => {
    if (stopVerdict !== "exit") return false;
    log("收到停止信号，退出。");
    appendReport(paths.report, "autopilot 已停止。");
    return true;
  };

  let strategy: IStrategy = createStrategy(styleArg);
  let currentStyle = styleArg;

  let lastTs = new Date(Date.now() - 5000).toISOString();
  let disconnectTicks = 0;
  let daemonAliveWaitTicks = 0;
  // 启动前文件里已解决的决策都是历史，不能当成本轮刚解决的
  const consumedDecisionIds = new Set(
    loadJSON<Decision[]>(paths.decisions, [])
      .filter((d) => d.resolved)
      .map((d) => d.id),
  );
  let lowHpNotified = false;
  const fullAutoNoticeAt = new Map<string, number>();

  while (true) {
    // 停止信号（可能已被并发的 set-mode 取代，由 resolveStopSignal 判断）
    if (hasStopSignal(paths.autopilotControl)) {
      if (resolveStopSignal(paths, log) === "exit") {
        log("收到停止信号，退出。");
        appendReport(paths.report, "autopilot 已停止。");
        break;
      }
    }

    // 每次循环读取当前游戏模式；模式记录里带配置快照时用它（与模式同一次原子写入，不会出现"新模式 + 旧配置"）
    const modeRecord = readGameModeRecord(paths.root);
    const gameMode = modeRecord?.mode ?? "semi-auto";

    // companion 模式下 autopilot 不应执行，等待停止信号
    if (gameMode === "companion") {
      log("检测到陪伴模式，autopilot 暂停执行，等待停止信号...");
      await sleep(2000);
      continue;
    }

    const userConfig = selectLiveConfig(
      fs.existsSync(paths.autopilotConfig) ? loadJSON<Partial<AutopilotConfig>>(paths.autopilotConfig, {}) : null,
      modeRecord,
    );
    const config: AutopilotConfig = {
      ...DEFAULT_CONFIG,
      ...userConfig,
      safetyBoundary: {
        ...DEFAULT_CONFIG.safetyBoundary,
        ...userConfig.safetyBoundary,
      },
    };
    const state = loadJSON<Partial<GameState>>(paths.state, {});
    const alerts = loadJSON<Alert[]>(paths.alerts, []).filter((a) => !a.read);

    // 未连接或尚未登录都等：重连后 socket 一连上就是 connected=true/loginDone=false，
    // 这时排队游戏命令会插进用户名/密码流程干扰自动登录。
    if (!state.connected || !state.loginDone) {
      // 断线重连后的首份状态可能是重新登录或新的受伤，低血通知边沿要重新开始。
      lowHpNotified = false;
      // daemon 的生命周期由 /mud start 独占；autopilot 只等待，不自己 spawn。
      // daemon 进程还在就继续等（它自己会在重连失败 10 次后退出）；只有 daemon 不在了才按 disconnectGraceSec 等人工 /mud start。
      if (isProcessRunning(paths.pid)) {
        daemonAliveWaitTicks += 1;
        disconnectTicks = 0;
        if (daemonAliveWaitTicks >= DAEMON_ALIVE_WAIT_CAP_TICKS) {
          const msg = `守护进程持续 ${Math.round((DAEMON_ALIVE_WAIT_CAP_TICKS * DISCONNECT_TICK_MS) / 1000)}s 未能连接并登录，autopilot 优雅退出，请检查 daemon 日志。`;
          log(msg);
          appendReport(paths.report, `⚠️ ${msg}`);
          notify("mud-agent autopilot 退出", msg);
          sendToChannel(paths.notifyTarget, `🛑 ${msg}`, log);
          break;
        }
        if (daemonAliveWaitTicks % 12 === 1)
          log(
            `守护进程${state.connected ? "尚未登录" : "正在重连"}，等待... (${daemonAliveWaitTicks}/${DAEMON_ALIVE_WAIT_CAP_TICKS})`,
          );
        await sleep(DISCONNECT_TICK_MS);
        continue;
      }
      // 必须有退路：daemon 不在超过阈值就 append 报告、channel 告警一次，然后优雅退出。
      // 阈值从 config.disconnectGraceSec 折算，未配置时落到 DEFAULT_CONFIG（150s）
      const disconnectTickLimit = resolveDisconnectTickLimit(config.disconnectGraceSec);
      disconnectTicks += 1;
      if (disconnectTicks >= disconnectTickLimit) {
        const graceSec = Math.round((disconnectTickLimit * DISCONNECT_TICK_MS) / 1000);
        const msg = `守护进程已断开连接或未完成登录 ${graceSec}s，autopilot 优雅退出，请用 /mud start 重启 daemon 并登录后再切回 semi-auto / full-auto 模式。`;
        log(msg);
        appendReport(paths.report, `⚠️ ${msg}`);
        notify("mud-agent autopilot 退出", msg);
        sendToChannel(paths.notifyTarget, `🛑 ${msg}`, log);
        break;
      }
      log(`守护进程${state.connected ? "尚未登录" : "未连接"}，等待... (${disconnectTicks}/${disconnectTickLimit})`);
      await sleep(DISCONNECT_TICK_MS);
      continue;
    }

    // daemon 已连上并登录，重置计数器
    disconnectTicks = 0;
    daemonAliveWaitTicks = 0;

    // 安全边界：每轮都尝试 flee，但频道通知只在进入低血状态时发一次，回到安全线后重置。
    // 单值样本（`生命值: N`）没有 maxHp，用最近一次已知的 maxHp 换算，恢复样本才能重置边沿。
    // 只信解析器的 maxHp：单值样本沿用上限（或在连续性断裂时置空）的判断已在 parseState 里做，这里再缓存一层只会把失效结果撤销
    const maxHpForEdge = state.maxHp;
    if (state.hp != null && maxHpForEdge && config.safetyBoundary.autoFlee) {
      const hpPct = (state.hp / maxHpForEdge) * 100;
      if (hpPct < config.safetyBoundary.minHpPercent) {
        log(`HP ${Math.round(hpPct)}% 低于安全线，自动 flee`);
        sendCommand(paths.queue, "flee", log, { unless: stopPending });
        if (stoppedWhileSending()) break;
        if (!lowHpNotified) {
          lowHpNotified = true;
          appendReport(paths.report, `⚠️ HP 告急（${Math.round(hpPct)}%），自动撤退。`);
          notify("mud-agent 血量危急", `HP ${Math.round(hpPct)}%，已自动逃跑`);
          sendToChannel(paths.notifyTarget, `🚨 HP 告急（${Math.round(hpPct)}%），已自动逃跑！`, log);
        }
        await sleep(config.loopInterval);
        continue;
      }
      lowHpNotified = false;
    }

    // 待处理决策检查：只在 semi-auto 模式下执行，full-auto 跳过
    if (gameMode === "semi-auto" && hasPendingDecisions(paths.decisions)) {
      log("有待处理的决策，暂停执行。");
      await sleep(2000);
      continue;
    }

    for (const alert of alerts.filter((a) => a.priority === "critical")) {
      notify("mud-agent 紧急警报", `${alert.label}：${alert.context || ""}`);
    }

    // 上一轮没发出去的命令先补发（在读输出 / 消费决策之前）。无论成败本轮都到此为止：
    // 补发成功后策略要等补发之后的新回包，补发前累计的输出不是它的响应（输出游标推到现在，下一轮只看新输出）
    const newLines = readOutputSince(paths.output, lastTs);
    if (newLines.length > 0) {
      lastTs = newLines[newLines.length - 1].ts;
    }

    // 配置里的 style 变了（mud-ctl autopilot start grinding / set-mode 换风格）：换策略，不用重启进程。
    // 本轮有刚解决的决策时先让原策略消费它（它的决策文本只有原策略懂），下一轮再换。
    const resolvedDecision: ResolvedDecision | null = takeNewlyResolvedDecision(paths.decisions, consumedDecisionIds);
    if (shouldSwitchStrategy(config.style, currentStyle, resolvedDecision)) {
      log(`策略切换：${currentStyle} → ${config.style}`);
      strategy = createStrategy(config.style);
      currentStyle = config.style;
    }

    const action = strategy.decide({
      state: state as GameState,
      newLines,
      alerts,
      resolvedDecision,
      config,
    });

    if (action.command) {
      sendCommand(paths.queue, action.command, log, { unless: stopPending });
      if (stoppedWhileSending()) break;
    }
    // narrative 只进 report 文件；默认 loopInterval=3500ms，每条都推 channel 会刷屏
    if (action.narrative) appendReport(paths.report, action.narrative);

    if (action.pauseEvent) {
      // 暂停只在半自动且事件要求暂停（pauseOn 命中）时发生；全自动、或只在 notifyOn 里的事件走播报分支
      if (gameMode === "semi-auto" && action.pauseEvent.pause !== false) {
        // semi-auto：写决策 + 通知 + 报告 + channel 推送
        writeDecision(paths.decisions, action.pauseEvent, log);
        notify("mud-agent", action.pauseEvent.summary.slice(0, 100));
        appendReport(paths.report, `**[需要决策]** ${action.pauseEvent.summary}`);
        sendToChannel(paths.notifyTarget, `⚠️ [需要决策] ${action.pauseEvent.summary}`, log);
      } else {
        // 播报分支（全自动，或只播报不暂停的事件）：只通知 + 报告 + channel 推送，不写决策。同一事件实例（比如一场长战斗）每轮循环都会命中，
        // 按策略给出的实例键做冷却：同一场战斗不刷屏，换了一个 boss / 另一件稀有物品是新实例，照常通知。
        const kind =
          action.pauseEvent.instanceKey ??
          `${action.pauseEvent.eventType ?? ""}|${action.pauseEvent.summary.slice(0, 80)}`;
        const now = Date.now();
        for (const [k, at] of fullAutoNoticeAt)
          if (now - at >= FULL_AUTO_NOTICE_COOLDOWN_MS) fullAutoNoticeAt.delete(k);
        const lastAt = fullAutoNoticeAt.get(kind) ?? 0;
        if (now - lastAt >= FULL_AUTO_NOTICE_COOLDOWN_MS) {
          fullAutoNoticeAt.set(kind, now);
          notify("mud-agent", action.pauseEvent.summary.slice(0, 100));
          appendReport(paths.report, `**[全自动跳过]** ${action.pauseEvent.summary}`);
          sendToChannel(paths.notifyTarget, `ℹ️ [全自动跳过] ${action.pauseEvent.summary}`, log);
        }
      }
    }

    await sleep(config.loopInterval || 3500);
  }

  // 锁可能已被更晚 set-mode 派生的新进程拿走（resolveStopSignal 重新拿锁失败的那条路径），只删自己持有的。
  removeOwnPid(paths.autopilotPid);
  log("autopilot 已退出。");
}
