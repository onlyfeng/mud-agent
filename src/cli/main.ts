#!/usr/bin/env node
/**
 * mud-ctl CLI 入口 — 从 scripts/mud-ctl.js 迁移。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Alert, AutopilotConfig, Decision, GameState, MudConfig } from "../core/types.js";
import { launchAutopilot, STABLE_ALIVE_POLLS } from "../infra/autopilot-launcher.js";
import {
  hasEffectiveStopSignal,
  publishExplicitStop,
  readGameModeRecord,
  signalAutopilotStop,
  writeGameMode,
} from "../infra/control-signal.js";
import { launchDaemonSync } from "../infra/daemon-launcher.js";
import { loadJSON, writeJSON } from "../infra/file-store.js";
import { buildPaths, resolveMudDir } from "../infra/paths.js";
import { isProcessRunning } from "../infra/process-guard.js";
import { enqueueCommands, withQueueLock, writeQueueFile } from "../infra/send-queue.js";
import { sleepSync } from "../lib/dir-lock-contract.mjs";
import { resolveSessionDir } from "../lib/session-key.js";
import { parseTcpPort } from "../lib/tcp-port.js";
import { configureMudStorage, getMudSessionStore } from "../storage/session-store.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const runtimeMudDir = resolveMudDir();

configureMudStorage(runtimeMudDir);

function parseCliArgs(argv: string[]): { action?: string; args: string[]; sessionKey?: string } {
  const rest = [...argv];
  let sessionKey: string | undefined;

  for (let i = 0; i < rest.length; ) {
    const arg = rest[i];
    if (arg === "--session" || arg === "--session-key") {
      sessionKey = requireSessionValue(arg, rest[i + 1]);
      rest.splice(i, 2);
      continue;
    }
    if (arg.startsWith("--session=")) {
      sessionKey = requireSessionValue("--session", arg.slice("--session=".length));
      rest.splice(i, 1);
      continue;
    }
    if (arg.startsWith("--session-key=")) {
      sessionKey = requireSessionValue("--session-key", arg.slice("--session-key=".length));
      rest.splice(i, 1);
      continue;
    }
    i += 1;
  }

  const [action, ...args] = rest;
  return { action, args, sessionKey };
}

// 缺值或空值直接失败：否则 `mud-ctl stop --session` 会静默落到默认运行目录，对错误的会话执行 stop / reset / restart。
function requireSessionValue(flag: string, value: string | undefined): string {
  if (value === undefined || value.trim() === "" || value.startsWith("--")) {
    console.error(`${flag} 需要一个会话键参数，例如 ${flag} 'agent:main:telegram:group:<chatId>:topic:<id>'`);
    process.exit(2);
  }
  return value;
}

// 模型路由 / 子任务策略钩子以 session 目录存在为门控：status / stop 这类命令、以及前置条件不满足就会失败的
// start / send 等，若为打错的键建了目录，那个话题之后的普通对话会被永久当成 MUD 流量。所以：
// - setup 只有参数合法（host + 1-65535 端口）才注册；
// - 其他写动作只有会话已经初始化（config.json 存在）才补注册（兼容旧目录 → 长格式目录迁移），否则交给 main() 报"未配置"退出；
// - 只读动作从不注册。
const SESSION_REQUIRED_ACTIONS = new Set([
  "config-update-creds",
  "login-step",
  "start",
  "restart",
  "send",
  "send-multi",
  "alerts-clear",
  "decisions-resolve",
]);

type RegistrationKind = "init" | "require" | "readonly";

function registrationKind(action: string | undefined, args: string[]): RegistrationKind {
  if (!action) return "readonly";
  if (action === "autopilot") return args[0] === "start" ? "require" : "readonly";
  if (action === "setup") return "init";
  return SESSION_REQUIRED_ACTIONS.has(action) ? "require" : "readonly";
}

function setupArgsValid(args: string[]): boolean {
  return Boolean(args[0]) && parseTcpPort(args[1]) !== null;
}

function resolveMudDirFromCli(
  sessionKey: string | undefined,
  kind: RegistrationKind,
  args: string[],
): { mudDir: string; registered: boolean } {
  if (!sessionKey) return { mudDir: runtimeMudDir, registered: kind !== "readonly" };

  const store = getMudSessionStore();
  const existingDir = resolveSessionDir(store, sessionKey);
  const shouldRegister =
    kind === "init" ? setupArgsValid(args) : kind === "require" && fs.existsSync(path.join(existingDir, "config.json"));
  if (shouldRegister) store.ensure(sessionKey);
  return { mudDir: resolveSessionDir(store, sessionKey), registered: shouldRegister };
}

const cli = parseCliArgs(process.argv.slice(2));
const invocationKind = registrationKind(cli.action, cli.args);
const { mudDir, registered } = resolveMudDirFromCli(cli.sessionKey, invocationKind, cli.args);
const P = buildPaths(mudDir);
const DAEMON_ENTRY = path.resolve(__dirname, "daemon-entry.js");

// 需要已初始化会话的动作统一在分发前拦住：--session 指向打错/从未用过的键时目录不存在，
// 否则 send / alerts-clear 等会在 writeJSON 处以未捕获的 ENOENT 崩掉，而不是报"未配置"
if (invocationKind === "require" && !fs.existsSync(P.config)) {
  console.error("未配置，请先运行 setup");
  process.exit(1);
}

if (registered) fs.mkdirSync(mudDir, { recursive: true });

const { action, args } = cli;

function spawnDaemon(): number | undefined {
  const launched = launchDaemonSync(getMudSessionStore().getStorageRoot(), mudDir, DAEMON_ENTRY);
  if (!launched.ok) {
    console.error(launched.reason);
    process.exit(1);
  }
  if (launched.alreadyRunning) console.log(`守护进程已在运行 (PID ${launched.pid})，未重复派生`);
  else if (!launched.confirmed) console.log("10 s 内未确认到守护进程 PID，请用 status 查看");
  return launched.pid;
}

// daemon 重启（start 清残留 / restart）会让旧 autopilot 退出；模式文件仍是自动时要重新派生，
// 否则会话显示自动模式却没有自动化进程。等旧进程真正退出再派生，避免 PID 锁冲突。
function respawnAutopilotIfAutoMode(label: string): void {
  const isAuto = () => {
    const mode = readGameModeRecord(mudDir)?.mode;
    return mode === "semi-auto" || mode === "full-auto" ? mode : null;
  };
  if (!isAuto()) return;
  const deadline = Date.now() + 15_000;
  let stableAlive = 0;
  const attempt = () => {
    // 每次真正派生前重读模式：等待期间用户切到 companion 就取消，否则会在陪伴模式下多出一个 autopilot 并清掉刚写的 stop。
    // 清理边界取在重读模式之前：重读之后写入的 companion stop 不会被当成遗留物清掉
    const launchTs = Date.now();
    const mode = isAuto();
    if (!mode) {
      console.log(`${label}: 模式已不是自动，取消重派 autopilot`);
      return;
    }
    if (isProcessRunning(P.autopilotPid)) {
      // 旧进程认领联停信号后、删 PID 前有窗口：连续几次都活着且看不到联停才算健康（与共享恢复器同一规则），
      // 健康就立刻返回，不要空转到 15 s 再误报"仍在运行"
      stableAlive = hasEffectiveStopSignal(P.autopilotControl, mudDir) ? 0 : stableAlive + 1;
      if (stableAlive >= STABLE_ALIVE_POLLS) {
        console.log(`${label}: autopilot 已在运行，无需重派`);
        return;
      }
      if (Date.now() < deadline) setTimeout(attempt, 500);
      else console.log(`${label}: 旧 autopilot 仍未退出，未重新派生`);
      return;
    }
    stableAlive = 0;
    // 新 daemon 可能还没写 mud-daemon.pid：autopilot 启动第一步就检查它，没就绪就再等
    if (!isProcessRunning(P.pid)) {
      if (Date.now() < deadline) setTimeout(attempt, 500);
      else console.log(`${label}: daemon pid 未就绪，未重新派生 autopilot`);
      return;
    }
    const launched = launchAutopilot(getMudSessionStore().getStorageRoot(), mudDir, launchTs);
    if (launched.ok) console.log(`${label}: 模式为 ${mode}，已重新启动 autopilot (PID ${launched.pid})`);
    else console.log(`${label}: 模式为 ${mode}，恢复 autopilot 失败：${launched.reason}`);
  };
  setTimeout(attempt, 500);
}

function main(): void {
  switch (action) {
    case "setup": {
      const [host, port, encoding, username, password] = args;
      const tcpPort = parseTcpPort(port);
      if (!host || tcpPort === null) {
        console.error("用法: mud-ctl setup <host> <port(1-65535)> [encoding] [username] [password]");
        process.exit(1);
      }
      // 保留已有的 loginSequence，避免重新 setup 时把登录步骤清空
      let existingLoginSequence: MudConfig["loginSequence"] = [];
      try {
        const existing = loadJSON<MudConfig | null>(P.config, null);
        if (Array.isArray(existing?.loginSequence)) {
          existingLoginSequence = existing.loginSequence;
        }
      } catch {}
      const cfg: MudConfig = {
        server: {
          host,
          port: tcpPort,
          encoding: encoding || "gbk",
        },
        credentials: { username: username || "", password: password || "" },
        loginSequence: existingLoginSequence,
      };
      writeJSON(P.config, cfg);
      try {
        fs.writeFileSync(P.output, "");
      } catch {}
      writeJSON(P.alerts, []);
      withQueueLock(P.queue, () => writeQueueFile(P.queue, { items: [] }));
      console.log("配置已保存");
      console.log(`  服务器: ${host}:${port}`);
      console.log(`  编码:   ${encoding || "gbk"}`);
      console.log(`  角色:   ${username || "(未设置)"}`);
      break;
    }

    case "config-update-creds": {
      const [username, password] = args;
      const cfg = loadJSON<MudConfig | null>(P.config, null);
      if (!cfg) {
        console.error("未配置，请先 setup");
        process.exit(1);
      }
      cfg.credentials = { username, password };
      writeJSON(P.config, cfg);
      console.log(`账号已更新: ${username}`);
      break;
    }

    case "config-show": {
      const cfg = loadJSON<MudConfig | null>(P.config, null);
      if (!cfg) {
        console.log("未配置");
        break;
      }
      const safe = JSON.parse(JSON.stringify(cfg));
      if (safe.credentials?.password) safe.credentials.password = "***";
      console.log(JSON.stringify(safe, null, 2));
      break;
    }

    case "login-step": {
      const [trigger, send] = args;
      const cfg = loadJSON<MudConfig | null>(P.config, null);
      if (!cfg) {
        console.error("未配置");
        process.exit(1);
      }
      cfg.loginSequence = cfg.loginSequence || [];
      cfg.loginSequence.push({ trigger, send });
      writeJSON(P.config, cfg);
      console.log(`已添加登录步骤: 当检测到 "${trigger}" 时发送 "${send}"`);
      break;
    }

    case "start": {
      const pid = isProcessRunning(P.pid);
      if (pid) {
        console.log(`守护进程已在运行 (PID ${pid})`);
        // daemon 还在、自动模式的 autopilot 却崩了/被杀了：这里也要恢复
        respawnAutopilotIfAutoMode("start");
        break;
      }
      // 启动新 daemon 前先清理残留 autopilot（旧 autopilot 是配对旧 daemon 的）；身份核对与 /mud stop 共用同一 helper
      const staleAp = signalAutopilotStop(mudDir, { keepAlive: true });
      if (staleAp) console.log(`发现残留 autopilot (PID ${staleAp})，已发送停止信号`);
      const cfg = loadJSON<MudConfig | null>(P.config, null);
      if (!cfg) {
        console.error("未配置，请先运行 setup");
        process.exit(1);
      }
      const childPid = spawnDaemon();
      console.log(`守护进程已启动 (PID ${childPid})`);
      console.log(`  日志: ${P.log}`);
      console.log("  等待连接... (约3-5秒后可用 read 查看服务器输出)");
      respawnAutopilotIfAutoMode("start");
      break;
    }

    case "stop": {
      const pid = isProcessRunning(P.pid);
      // CLI 调用完就退出：定时器保持引用，否则进程在 800 ms 的 SIGTERM 兜底之前就结束了
      const apPid = signalAutopilotStop(mudDir, { keepAlive: true });
      if (!pid && !apPid) {
        console.log("守护进程和 autopilot 均未运行");
        break;
      }
      if (apPid) console.log(`autopilot (PID ${apPid}) 已发送停止信号`);
      if (pid) {
        writeJSON(P.control, { action: "stop" });
        setTimeout(() => {
          try {
            process.kill(pid, "SIGTERM");
          } catch {}
          console.log("守护进程已停止");
        }, 1500);
      }
      break;
    }

    case "restart": {
      // 未配置（打错的 --session 键也会落到这里）：立即报错，不要 2.5 s 后在定时器里派生一个立刻退出的 daemon
      if (!loadJSON<MudConfig | null>(P.config, null)) {
        console.error("未配置，请先运行 setup");
        process.exit(1);
      }
      const pid = isProcessRunning(P.pid);
      if (pid) {
        writeJSON(P.control, { action: "stop" });
        setTimeout(() => {
          try {
            process.kill(pid, "SIGTERM");
          } catch {}
        }, 1000);
      }
      setTimeout(() => {
        const childPid = spawnDaemon();
        console.log(`守护进程已重启 (PID ${childPid})`);
        // 只看持久化模式：旧 autopilot 崩溃/被杀后模式文件仍是自动，restart 也要把它恢复回来
        respawnAutopilotIfAutoMode("restart");
      }, 2500);
      break;
    }

    case "status": {
      const pid = isProcessRunning(P.pid);
      const cfg = loadJSON<MudConfig | null>(P.config, null);
      const state = loadJSON<Partial<GameState> | null>(P.state, null);
      const alerts = loadJSON<Alert[]>(P.alerts, []);
      const unread = alerts.filter((a) => !a.read);

      console.log("=== MUD 守护进程状态 ===");
      console.log(`进程: ${pid ? `运行中 (PID ${pid})` : "未运行"}`);
      if (cfg) {
        console.log(`服务器: ${cfg.server.host}:${cfg.server.port}`);
        console.log(`角色: ${cfg.credentials?.username || "未设置"}`);
      }
      if (state) {
        console.log(`连接: ${state.connected ? "是" : "否"}`);
        console.log(`登录: ${state.loginDone ? "是" : "否"}`);
        if (state.hp != null) console.log(`HP: ${state.hp}/${state.maxHp ?? "?"}`);
        if (state.mp != null) console.log(`MP: ${state.mp}/${state.maxMp ?? "?"}`);
        if (state.level) console.log(`等级: ${state.level}`);
        if (state.exits?.length) console.log(`出口: ${state.exits.join(" ")}`);
      }
      if (unread.length) {
        console.log(`\n未读警报 ${unread.length} 条:`);
        for (const a of unread) {
          console.log(`  [${a.priority}] ${a.label}: ${a.advice}`);
        }
      }
      break;
    }

    case "send": {
      const cmd = args.join(" ");
      if (!cmd) {
        console.error("用法: mud-ctl send <命令>");
        process.exit(1);
      }
      enqueueCommands(P.queue, [cmd]);
      console.log(`命令已入队: ${cmd}`);
      break;
    }

    case "send-multi": {
      let cmds: string[];
      try {
        cmds = JSON.parse(args.join(" "));
      } catch {
        cmds = args;
      }
      enqueueCommands(P.queue, cmds);
      console.log(`已入队 ${cmds.length} 条命令: ${cmds.join(", ")}`);
      break;
    }

    case "read": {
      const n = parseInt(args[0], 10) || 40;
      try {
        const content = fs.readFileSync(P.output, "utf8");
        const lines = content.trim().split("\n").filter(Boolean).slice(-n);
        if (!lines.length) {
          console.log("(暂无输出)");
          break;
        }
        console.log(`=== 最近 ${lines.length} 行游戏输出 ===`);
        for (const line of lines) {
          try {
            const { ts, text } = JSON.parse(line);
            const t = new Date(ts).toLocaleTimeString("zh-CN", {
              hour12: false,
            });
            console.log(`[${t}] ${text}`);
          } catch {
            console.log(line);
          }
        }
      } catch {
        console.log("(暂无输出文件)");
      }
      break;
    }

    case "read-since": {
      const since = args[0] ? new Date(args[0]) : new Date(Date.now() - 30000);
      try {
        const content = fs.readFileSync(P.output, "utf8");
        const lines = content
          .trim()
          .split("\n")
          .filter(Boolean)
          .filter((l) => {
            try {
              return new Date(JSON.parse(l).ts) > since;
            } catch {
              return false;
            }
          });
        if (!lines.length) {
          console.log("(这段时间无新输出)");
          break;
        }
        for (const l of lines) {
          try {
            const { ts, text } = JSON.parse(l);
            const t = new Date(ts).toLocaleTimeString("zh-CN", {
              hour12: false,
            });
            console.log(`[${t}] ${text}`);
          } catch {
            console.log(l);
          }
        }
      } catch {
        console.log("(暂无输出)");
      }
      break;
    }

    case "state": {
      const state = loadJSON<Partial<GameState> | null>(P.state, null);
      if (!state) {
        console.log("无状态数据");
        break;
      }
      console.log("=== 角色状态 ===");
      console.log(JSON.stringify(state, null, 2));
      break;
    }

    case "alerts": {
      const alerts = loadJSON<Alert[]>(P.alerts, []);
      const unread = alerts.filter((a) => !a.read);
      if (!unread.length) {
        console.log("无未读警报");
        break;
      }
      console.log(`=== 未读警报 (${unread.length} 条) ===`);
      for (const a of unread) {
        const t = new Date(a.time).toLocaleTimeString("zh-CN", {
          hour12: false,
        });
        console.log(`[${t}] [${a.priority.toUpperCase()}] ${a.label}`);
        console.log(`  建议: ${a.advice}`);
        if (a.context) console.log(`  原文: ${a.context}`);
        console.log("");
      }
      break;
    }

    case "alerts-clear": {
      const alerts = loadJSON<Alert[]>(P.alerts, []);
      const cleared = alerts.map((a) => ({ ...a, read: true }));
      writeJSON(P.alerts, cleared);
      console.log(`已标记 ${alerts.filter((a) => !a.read).length} 条警报为已读`);
      break;
    }

    case "autopilot": {
      const sub = args[0];
      if (sub === "start") {
        const launchTs = Date.now();
        // 子进程第一步就会因 daemon 不在而退出：在这里就拒绝，不要给用户一个假的 PID
        if (!isProcessRunning(P.pid)) {
          console.error("守护进程未运行，无法启动 autopilot；请先 mud-ctl start 并登录。");
          process.exit(1);
        }
        const style = args[1] || "exploration";
        // 模式与配置先落盘（同一把锁，与 /mud mode、mud_admin set-mode 同一套写入协议），再看有没有 autopilot 在跑：
        // companion（比如刚 autopilot stop 过）必须切回自动模式，否则旧进程退出后留下的是 companion + 没有 autopilot。
        // 目标模式与配置都在锁内按当前记录决定：full-auto 保留、其余切 semi-auto；
        // 只有 companion → semi-auto 这一步恢复半自动的默认暂停规则（文件里可能残留 full-auto 的 pauseOn: []），
        // 已经是 semi-auto 时操作者自定义的 pauseOn 原样保留。
        const semiAutoPauseOn = ["rare_item", "boss", "puzzle", "level_up"];
        let fromMode: string | undefined;
        writeGameMode(
          mudDir,
          (current) => {
            fromMode = current?.mode;
            return fromMode === "full-auto" ? "full-auto" : "semi-auto";
          },
          (existingCfg: Record<string, unknown>) =>
            Object.keys(existingCfg).length === 0
              ? {
                  style,
                  loopInterval: 3500,
                  reportInterval: 4,
                  safetyBoundary: { minHpPercent: 30, autoFlee: true, avoidCombatWith: [] },
                  pauseOn: semiAutoPauseOn,
                  notifyOn: semiAutoPauseOn,
                  autoPickup: true,
                  combatEnabled: false,
                }
              : {
                  ...existingCfg,
                  style,
                  ...(fromMode !== "full-auto" && fromMode !== "semi-auto" ? { pauseOn: semiAutoPauseOn } : {}),
                },
        );
        // 旧 autopilot 还在：它可能正在退出——stop 文件仍可见，或已被它原子认领（控制文件已移走、PID 还没删）。
        // 与共享恢复器同一规则：连续 STABLE_ALIVE_POLLS 次观察到"活着且看不到生效的 stop"才算真的在运行，
        // 期间 PID 消失就派生；最多等 5 s。
        let apPid = isProcessRunning(P.autopilotPid);
        if (apPid) {
          const deadline = Date.now() + 5000;
          let stableAlive = 0;
          while (apPid && stableAlive < STABLE_ALIVE_POLLS && Date.now() < deadline) {
            stableAlive = hasEffectiveStopSignal(P.autopilotControl, mudDir) ? 0 : stableAlive + 1;
            if (stableAlive >= STABLE_ALIVE_POLLS) break;
            sleepSync(250);
            apPid = isProcessRunning(P.autopilotPid);
          }
        }
        if (apPid) {
          console.log(`autopilot 已在运行 (PID ${apPid})，模式已恢复为自动`);
          break;
        }
        const launched = launchAutopilot(getMudSessionStore().getStorageRoot(), mudDir, launchTs);
        if (!launched.ok) {
          console.error(`autopilot 未启动：${launched.reason}`);
          process.exit(1);
        }
        console.log(`autopilot 已启动 (PID ${launched.pid}, style: ${style})`);
        console.log(`  日志: ${P.autopilotLog}`);
      } else if (sub === "stop") {
        const apPid = isProcessRunning(P.autopilotPid);
        if (!apPid) {
          console.log("autopilot 未运行");
          break;
        }
        // 记下发出时看到的模式代际并在落盘后复核：autopilot 据此判断这个 stop 是否已被更晚的 set-mode 切回自动取代（因果序，不用墙钟）
        if (!publishExplicitStop(P.autopilotControl, mudDir)) {
          console.error("停止信号未能稳定发布（模式正被并发修改），请重试 mud-ctl autopilot stop");
          process.exit(1);
        }
        console.log("已发送停止信号");
      } else if (sub === "status") {
        const apPid = isProcessRunning(P.autopilotPid);
        const cfg = loadJSON<Partial<AutopilotConfig> | null>(P.autopilotConfig, null);
        console.log("=== autopilot 状态 ===");
        console.log(`进程: ${apPid ? `运行中 (PID ${apPid})` : "未运行"}`);
        if (cfg) {
          console.log(`风格: ${cfg.style || "-"}`);
          console.log(`安全线: HP >= ${cfg.safetyBoundary?.minHpPercent ?? 30}%`);
          console.log(`暂停触发: ${(cfg.pauseOn || []).join(", ")}`);
        }
        const decs = loadJSON<Decision[]>(P.decisions, []);
        const pending = decs.filter((d) => !d.resolved);
        if (pending.length) console.log(`待决策 ${pending.length} 条`);
      } else {
        console.log("用法: mud-ctl autopilot <start [style]|stop|status>");
        console.log("  style 可选: exploration（探索，默认）/ grinding（练级）");
      }
      break;
    }

    case "decisions": {
      const decs = loadJSON<Decision[]>(P.decisions, []);
      const pending = decs.filter((d) => !d.resolved);
      if (!pending.length) {
        console.log("无待决策事项");
        break;
      }
      console.log(`=== 待决策事项 (${pending.length} 条) ===\n`);
      for (const d of pending) {
        const t = new Date(d.time).toLocaleTimeString("zh-CN", {
          hour12: false,
        });
        console.log(`[${d.id}] ${t}  [${d.priority || "normal"}]`);
        console.log(`  ${d.summary}`);
        if (d.options?.length) {
          for (let i = 0; i < d.options.length; i++) {
            console.log(`  ${i + 1}. ${d.options[i]}`);
          }
        }
        console.log("");
      }
      console.log("用 decisions-resolve <id> <选项编号或文字> 来响应");
      break;
    }

    case "decisions-resolve": {
      const [decId, ...choiceParts] = args;
      if (!decId) {
        console.error("用法: mud-ctl decisions-resolve <id> <choice>");
        process.exit(1);
      }
      const choice = choiceParts.join(" ");
      const decs = loadJSON<Decision[]>(P.decisions, []);
      const idx = decs.findIndex((d) => d.id === decId);
      if (idx === -1) {
        console.error(`未找到决策 ID: ${decId}`);
        process.exit(1);
      }
      decs[idx].resolved = true;
      decs[idx].choice = choice;
      decs[idx].resolvedAt = new Date().toISOString();
      writeJSON(P.decisions, decs);
      console.log(`决策 [${decId}] 已解决: ${choice}`);
      break;
    }

    case "report": {
      const n = parseInt(args[0], 10) || 50;
      try {
        const content = fs.readFileSync(P.report, "utf8");
        const lines = content.split("\n");
        const tail = lines.slice(-n).join("\n").trim();
        if (!tail) {
          console.log("(report.md 暂无内容)");
          break;
        }
        console.log(`=== 叙事日志（最近 ${n} 行）===\n`);
        console.log(tail);
      } catch {
        console.log("(report.md 不存在，autopilot 尚未运行过)");
      }
      break;
    }

    default:
      console.log(`
mud-ctl — MUD 守护进程控制工具

配置:
  setup <host> <port> [encoding] [username] [password]
  config-update-creds <username> <password>
  config-show
  login-step <触发正则> <发送内容>

守护进程:
  start / stop / restart / status

游戏交互:
  send <命令>
  send-multi '["cmd1","cmd2"]'
  read [行数]
  read-since [ISO时间]
  state / alerts / alerts-clear

自动驾驶:
  autopilot start [style] / stop / status
  decisions / decisions-resolve <id> <choice>
  report [行数]

数据目录: ${mudDir}
`);
  }
}

main();
