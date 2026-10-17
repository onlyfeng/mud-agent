import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { GameMode } from "../core/types.js";
import { acquireDirLockSync } from "../lib/dir-lock-contract.mjs";
import { inspectSessionPid, readVerifiedSessionPid } from "../lib/session-process.mjs";
import { loadJSON } from "./file-store.js";

export function hasStopSignal(controlFile: string): boolean {
  return readStopSignal(controlFile) !== null;
}

export interface StopSignal {
  /**
   * 发出 stop 时看到的模式代际（set-mode companion 是它自己写的那一代，mud-ctl autopilot stop 是当时读到的）。
   * 裁决只比代际：模式记录仍是这一代 → stop 是最新意图；已被改写为自动模式 → stop 被取代。没有代际的 stop 一律退出。
   */
  modeGeneration?: string;
  /** 写入时刻（毫秒），仅供诊断；不参与裁决（毫秒墙钟不能表达跨进程写入顺序）。 */
  issuedAt?: number;
  /** 整体下线（daemon 也在停，或随后会 SIGTERM）：不可被更晚的 set-mode 取代，收到就退。 */
  force?: boolean;
}

export function readStopSignal(controlFile: string): StopSignal | null {
  if (!fs.existsSync(controlFile)) return null;
  const ctrl = loadJSON<{ action?: string; modeGeneration?: unknown; issuedAt?: unknown; force?: unknown }>(
    controlFile,
    {},
  );
  if (ctrl.action !== "stop") return null;
  return {
    ...(typeof ctrl.modeGeneration === "string" ? { modeGeneration: ctrl.modeGeneration } : {}),
    ...(typeof ctrl.issuedAt === "number" && Number.isFinite(ctrl.issuedAt) ? { issuedAt: ctrl.issuedAt } : {}),
    ...(ctrl.force === true ? { force: true } : {}),
  };
}

export function writeStopSignal(controlFile: string, signal: StopSignal = {}): void {
  writeFileAtomic(controlFile, JSON.stringify({ action: "stop", issuedAt: Date.now(), ...signal }));
}

// 跨进程认领（rename）的文件必须整体可见：先写临时文件再 rename 到目标路径，认领方看不到截断后、写入前的空文件。
function writeFileAtomic(target: string, content: string): void {
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
  fs.writeFileSync(tmp, content);
  try {
    fs.renameSync(tmp, target);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {}
    throw err;
  }
}

/**
 * 原子认领并消费一个 stop：先 rename 到私有路径，再读认领到的这一份。认领之后写入的新 stop 是新文件，不会被这次消费吃掉。
 * 认领到的不是 stop（别的 action）就无覆盖地放回去。
 */
export function claimStopSignal(controlFile: string): StopSignal | null {
  if (!fs.existsSync(controlFile)) return null;
  const claimed = `${controlFile}.claim-${process.pid}-${Date.now()}`;
  try {
    fs.renameSync(controlFile, claimed);
  } catch {
    return null;
  }
  try {
    const signal = readStopSignal(claimed);
    if (!signal) {
      try {
        fs.linkSync(claimed, controlFile);
      } catch {}
    }
    return signal;
  } finally {
    try {
      fs.unlinkSync(claimed);
    } catch {}
  }
}

export interface GameModeRecord {
  mode: GameMode;
  /** 每次写入唯一；stop 带的 modeGeneration 与它不同即表示模式在 stop 之后又被改过。 */
  generation?: string;
  /** 写入时刻（毫秒），仅供诊断。 */
  writtenAt?: number;
  /** 与模式同一次写入的 autopilot 配置快照：无锁读方从这一个原子文件里同时拿到模式和配置，不会读到"新模式 + 旧配置" */
  autopilotConfig?: Record<string, unknown>;
}

const GAME_MODES: readonly GameMode[] = ["companion", "semi-auto", "full-auto"];

export function readGameModeRecord(root: string): GameModeRecord | null {
  try {
    return parseGameModeRecord(fs.readFileSync(path.join(root, "game-mode.json"), "utf8"));
  } catch {
    return null;
  }
}

function parseGameModeRecord(raw: string): GameModeRecord | null {
  try {
    const obj = JSON.parse(raw) as {
      mode?: unknown;
      generation?: unknown;
      writtenAt?: unknown;
      autopilotConfig?: unknown;
    };
    if (!GAME_MODES.includes(obj.mode as GameMode)) return null;
    const autopilotConfig =
      obj.autopilotConfig && typeof obj.autopilotConfig === "object" && !Array.isArray(obj.autopilotConfig)
        ? (obj.autopilotConfig as Record<string, unknown>)
        : undefined;
    return {
      mode: obj.mode as GameMode,
      ...(typeof obj.generation === "string" ? { generation: obj.generation } : {}),
      ...(typeof obj.writtenAt === "number" && Number.isFinite(obj.writtenAt) ? { writtenAt: obj.writtenAt } : {}),
      ...(autopilotConfig ? { autopilotConfig } : {}),
    };
  } catch {
    return null;
  }
}

// 所有模式写入方（set-mode 两个入口、旧记录补 generation）都持同一把 game-mode.json.lock（atomic 目录锁，崩溃遗留可自愈），
// 模式与 autopilot-config.json 在同一临界区内一起提交：两个并发 set-mode 的模式/配置不会交叉覆盖。
function withGameModeLock<T>(root: string, fn: () => T): T {
  const release = acquireDirLockSync(path.join(root, "game-mode.json.lock"), {
    timeoutMs: 2000,
    pollMs: 5,
    atomic: true,
  });
  try {
    return fn();
  } finally {
    release();
  }
}

/**
 * 写模式文件并返回本次写入的代际；set-mode companion 用它给随后的 stop 打标。
 * @param autopilotConfig 一并提交的 autopilot-config.json 内容（semi-auto / full-auto）；与模式在同一把锁内写入
 */
export type AutopilotConfigUpdate = (current: Record<string, unknown>) => unknown;

export function writeGameMode(
  root: string,
  modeOrSelect: GameMode | ((current: GameModeRecord | null) => GameMode),
  autopilotConfigOrUpdate?: unknown | AutopilotConfigUpdate,
): string {
  return withGameModeLock(root, () => {
    const generation = randomUUID();
    // 目标模式也可以在锁内按当前记录决定（autopilot start 要"保留 full-auto、否则 semi-auto"）：
    // 与并发的 /mud mode、set-mode 串行化，不会用锁外读到的旧模式覆盖刚提交的那一个
    const current = readGameModeRecord(root);
    const mode = typeof modeOrSelect === "function" ? modeOrSelect(current) : modeOrSelect;
    // 以函数形式传入的配置在锁内基于当前文件内容合并：读-改-写不会把并发 set-mode 刚提交的配置用旧快照覆盖
    const autopilotConfig =
      typeof autopilotConfigOrUpdate === "function"
        ? (autopilotConfigOrUpdate as (current: Record<string, unknown>) => unknown)(
            loadJSON<Record<string, unknown>>(path.join(root, "autopilot-config.json"), {}),
          )
        : autopilotConfigOrUpdate;
    // 配置文件带上本次模式的 generation 再落盘（操作者热改文件时保留该字段即可立即生效），
    // 随后把模式 + 配置快照作为一条原子记录写入 game-mode.json：读方按 generation 判断文件是否与当前模式同一代
    const stamped =
      autopilotConfig !== undefined && autopilotConfig !== null && typeof autopilotConfig === "object"
        ? { ...(autopilotConfig as Record<string, unknown>), generation }
        : autopilotConfig;
    if (stamped !== undefined) {
      writeFileAtomic(path.join(root, "autopilot-config.json"), JSON.stringify(stamped, null, 2));
    }
    writeFileAtomic(
      path.join(root, "game-mode.json"),
      JSON.stringify(
        { mode, generation, writtenAt: Date.now(), ...(stamped !== undefined ? { autopilotConfig: stamped } : {}) },
        null,
        2,
      ),
    );
    return generation;
  });
}

/**
 * 清除遗留的 stop 信号。`notNewerThan`（毫秒时间戳）给出时只清早于该时刻写入的标记：
 * autopilot 子进程用派生时刻做界限，这样派生后、进入主循环前用户发出的 stop 不会被当成遗留物删掉。
 * 校验与删除用 rename 原子认领：先把文件改名到私有路径，再看认领到的这一份的 mtime；它仍是新的（并发的
 * set-mode companion 在我们认领前覆写了它）就用 link 无覆盖地放回去，放回时已有更新的文件则丢弃这一份。
 * 认领之后写入的 stop 是新文件，不受影响。
 */
export function clearStaleStopSignal(
  controlFile: string,
  opts: { notNewerThan?: number; log?: (msg: string) => void } = {},
): boolean {
  if (!hasStopSignal(controlFile)) return false;
  const claimed = `${controlFile}.stale-${process.pid}-${Date.now()}`;
  try {
    fs.renameSync(controlFile, claimed);
  } catch {
    return false;
  }
  try {
    if (opts.notNewerThan !== undefined && fs.statSync(claimed).mtimeMs >= opts.notNewerThan) {
      try {
        fs.linkSync(claimed, controlFile);
      } catch {}
      return false;
    }
    opts.log?.("清除上次遗留的 stop 信号。");
    return true;
  } catch {
    return false;
  } finally {
    try {
      fs.unlinkSync(claimed);
    } catch {}
  }
}

/** 一个 stop 是否已被更新的 set-mode 取代（取代了就不生效，autopilot 继续跑）。 */
export function isStopSuperseded(stop: StopSignal, current: GameModeRecord | null): boolean {
  // 整体下线（daemon 也在停、随后还会 SIGTERM）不可被取代：继续跑也会被杀，反而留下“自动模式但没有 autopilot”。
  if (stop.force || !stop.modeGeneration) return false;
  if (current === null || (current.mode !== "semi-auto" && current.mode !== "full-auto")) return false;
  return current.generation !== stop.modeGeneration;
}

/** 控制文件里是否有一个仍会生效的 stop：有就意味着活着的 autopilot 稍后一定退出，不能把它计为健康实例。 */
export function hasEffectiveStopSignal(controlFile: string, root: string): boolean {
  const stop = readStopSignal(controlFile);
  return stop !== null && !isStopSuperseded(stop, readGameModeRecord(root));
}

export function processStartMs(): number {
  return Date.now() - process.uptime() * 1000;
}

/**
 * 旧版 game-mode.json 只有 mode 没有 generation：补一个代际（保留 mode）再用。否则据此发出的 stop 没有标签，
 * 会被当成无条件停止——用户随后切回自动模式时 set-mode 看到旧 PID 不再派生，而旧进程消费这个 stop 退出。
 */
export function ensureGameModeGeneration(root: string): string | undefined {
  const file = path.join(root, "game-mode.json");
  for (let attempt = 0; attempt < 8; attempt++) {
    let raw: string;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch {
      return undefined;
    }
    const record = parseGameModeRecord(raw);
    if (!record) return undefined;
    if (record.generation) return record.generation;
    // 旧格式（无 generation）补写：比较后再写——文件仍是刚读到的那份才写，被并发 set-mode 换掉就重读（新记录自带 generation）
    const generation = randomUUID();
    const next = JSON.stringify({ mode: record.mode, generation, writtenAt: Date.now() }, null, 2);
    if (writeFileIfUnchanged(file, raw, next)) return generation;
  }
  return readGameModeRecord(root)?.generation;
}

// 比较后写：在模式锁内复核内容未变再原子写入；set-mode 也持同一把锁，复核成功后不可能再被它插进来
function writeFileIfUnchanged(file: string, expected: string, next: string): boolean {
  try {
    return withGameModeLock(path.dirname(file), () => {
      let current: string;
      try {
        current = fs.readFileSync(file, "utf8");
      } catch {
        return false;
      }
      if (current !== expected) return false;
      writeFileAtomic(file, next);
      return true;
    });
  } catch {
    return false;
  }
}

/**
 * 发布一个显式 stop（mud-ctl autopilot stop）：标上发出时看到的模式代际，发布后再读一次，
 * 代际在读取与发布之间被并发的 set-mode 改了就重贴重发，直到稳定。这样 stop 文件最终带的是它落盘之后观察到的代际：
 * 在它之前的 set-mode 不会让它被误判为被取代，在它之后的 set-mode 才会。
 */
/**
 * 整体下线时联停 autopilot：有活 autopilot 就写 force stop 并在 800 ms 后 SIGTERM（它没消费信号也会被杀）。
 * daemon 是否在跑无关——daemon 突然死掉后 autopilot 可能还在按旧 state 排队命令。
 * @returns 被联停的 autopilot pid，没有则 null
 */
export const AUTOPILOT_SIGTERM_DELAY_MS = 800;

/**
 * @param opts.keepAlive true = 不 unref 定时器（CLI 这种调用完就退出的进程要等 SIGTERM 发出去）；网关进程里默认 unref
 */
export function signalAutopilotStop(dir: string, opts: { keepAlive?: boolean } = {}): number | null {
  const pidFile = path.join(dir, "autopilot.pid");
  const live = inspectSessionPid(pidFile);
  if (live === null) return null;
  // 协作式 stop 文件是会话私有的、伤不到别的进程：只要 PID 活着就写（身份不可核验时真实的 autopilot 也会读到它）；
  // SIGTERM 才需要命令行确认是 autopilot 入口，800 ms 后发之前再核对一次（强杀遗留的号码可能已被别的进程复用）
  writeStopSignal(path.join(dir, "autopilot-control.json"), { force: true });
  if (!live.verified) return live.pid;
  const timer = setTimeout(() => {
    if (readVerifiedSessionPid(pidFile) !== live.pid) return;
    try {
      process.kill(live.pid, "SIGTERM");
    } catch {}
  }, AUTOPILOT_SIGTERM_DELAY_MS);
  if (!opts.keepAlive) timer.unref();
  return live.pid;
}

export const EXPLICIT_STOP_BUDGET_MS = 2000;

/**
 * @returns 落盘的 stop 是否已与当前模式代际线性化；false 表示并发 set-mode 一直在改代际、预算内没能稳定，
 *          最后一份 stop 可能被判为已取代——调用方必须报告失败，不能当成"已发送"。
 */
export function publishExplicitStop(controlFile: string, root: string, budgetMs = EXPLICIT_STOP_BUDGET_MS): boolean {
  let generation = ensureGameModeGeneration(root);
  const deadline = Date.now() + budgetMs;
  for (;;) {
    writeStopSignal(controlFile, generation ? { modeGeneration: generation } : {});
    const after = readGameModeRecord(root)?.generation;
    if (after === generation) return true;
    if (Date.now() >= deadline) return false;
    generation = after;
  }
}

/**
 * autopilot 子进程清理遗留 stop 的时间边界：派生方在检查“没有 autopilot 在跑”之前记下的时刻
 * （环境变量 MUD_AUTOPILOT_LAUNCH_TS）。早于它的标记一定是上一个进程留下的；晚于它的（比如并发的
 * set-mode companion）是有效请求，必须保留。没有环境变量（手动启动）时退到进程启动时刻。
 */
export const LAUNCH_TS_ENV = "MUD_AUTOPILOT_LAUNCH_TS";

export function launchBoundaryMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env[LAUNCH_TS_ENV]);
  return Number.isFinite(raw) && raw > 0 ? raw : processStartMs();
}
