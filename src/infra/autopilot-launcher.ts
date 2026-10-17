import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sleepSync } from "../lib/dir-lock-contract.mjs";
import { acquireMigrationLockAsync, acquireMigrationLockSync } from "../lib/migration-lock-contract.mjs";
import { clearStaleStopSignal, hasEffectiveStopSignal, LAUNCH_TS_ENV, readGameModeRecord } from "./control-signal.js";
import { isProcessRunning, readPid } from "./process-guard.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export type AutopilotLaunch = { ok: true; pid: number | undefined } | { ok: false; reason: string };

const DEFAULT_CONFIRM_MS = 10_000;
const DEFAULT_POLL_MS = 100;
const TERM_GRACE_MS = 3000;
const KILL_WAIT_MS = 2000;

export const AUTOPILOT_LOCK_BUSY_REASON =
  "另一个 start / set-mode 或 normalize:sessions 正在进行（维护锁被占用），请稍后重试";
export const AUTOPILOT_DIR_MISSING_REASON =
  "会话目录已不存在（可能刚被 normalize:sessions 迁移/归档），未启动 autopilot";
export const AUTOPILOT_DAEMON_GONE_REASON = "守护进程未运行，未启动 autopilot；请先 start";
export const AUTOPILOT_UNCONFIRMED_REASON = "autopilot 10 s 内未写入 PID，已终止该子进程；请查看 autopilot.log 后重试";

type LaunchOptions = { confirmMs?: number; pollMs?: number };

function spawnDetached(dir: string, launchTs: number): number | undefined {
  clearStaleStopSignal(path.join(dir, "autopilot-control.json"), { notNewerThan: launchTs });
  // 从项目根定位编译产物：本模块可能从 dist/infra 加载，也可能被宿主按 src/index.ts 直接加载（src/infra），两者的 ../../dist 都是项目根的 dist
  const entry = path.resolve(__dirname, "../../dist/cli/autopilot-entry.js");
  const out = fs.openSync(path.join(dir, "autopilot.log"), "a");
  const child = spawn("node", [entry], {
    detached: true,
    stdio: ["ignore", out, out],
    env: { ...process.env, MUD_DIR: dir, [LAUNCH_TS_ENV]: String(launchTs) },
  });
  child.unref();
  fs.closeSync(out);
  return child.pid;
}

// 与 daemon-launcher 同一协议：在维护锁内复查目录与 daemon、派生、等 autopilot.pid 落盘才释放；
// 未确认的子进程先终止再释放（normalize 在同一把锁里做"无活进程"检查，不能把一个可能还会起来的子进程留给它）。
function precheck(dir: string): { ok: true } | { ok: false; reason: string } {
  if (!fs.existsSync(path.join(dir, "config.json"))) return { ok: false, reason: AUTOPILOT_DIR_MISSING_REASON };
  if (!isProcessRunning(path.join(dir, "mud-daemon.pid"))) return { ok: false, reason: AUTOPILOT_DAEMON_GONE_REASON };
  return { ok: true };
}

/** CLI 用的同步版本（mud-ctl 进程里阻塞最多 confirmMs）。 */
export function launchAutopilot(
  storageRoot: string,
  dir: string,
  launchTs: number,
  opts: LaunchOptions = {},
): AutopilotLaunch {
  let release: () => void;
  try {
    release = acquireMigrationLockSync(storageRoot, { timeoutMs: 5000 });
  } catch {
    return { ok: false, reason: AUTOPILOT_LOCK_BUSY_REASON };
  }
  try {
    const pre = precheck(dir);
    if (!pre.ok) return pre;
    const pidFile = path.join(dir, "autopilot.pid");
    const existing = isProcessRunning(pidFile);
    if (existing) return { ok: true, pid: existing };
    const childPid = spawnDetached(dir, launchTs);
    const deadline = Date.now() + (opts.confirmMs ?? DEFAULT_CONFIRM_MS);
    while (Date.now() < deadline && childPid && isChildRunning(childPid)) {
      if (confirmedChild(pidFile, childPid)) return { ok: true, pid: childPid };
      sleepSync(opts.pollMs ?? DEFAULT_POLL_MS);
    }
    return abortUnconfirmedSync(pidFile, childPid);
  } finally {
    release();
  }
}

/** 网关进程里用的异步版本：等锁与等 PID 都不阻塞事件循环。 */
export async function launchAutopilotAsync(
  storageRoot: string,
  dir: string,
  launchTs: number,
  opts: LaunchOptions = {},
): Promise<AutopilotLaunch> {
  let release: () => void;
  try {
    release = await acquireMigrationLockAsync(storageRoot, { timeoutMs: 5000 });
  } catch {
    return { ok: false, reason: AUTOPILOT_LOCK_BUSY_REASON };
  }
  try {
    const pre = precheck(dir);
    if (!pre.ok) return pre;
    const pidFile = path.join(dir, "autopilot.pid");
    const existing = isProcessRunning(pidFile);
    if (existing) return { ok: true, pid: existing };
    const childPid = spawnDetached(dir, launchTs);
    const deadline = Date.now() + (opts.confirmMs ?? DEFAULT_CONFIRM_MS);
    const tick = () => new Promise((resolve) => setTimeout(resolve, opts.pollMs ?? DEFAULT_POLL_MS));
    while (Date.now() < deadline && childPid && isChildRunning(childPid)) {
      if (confirmedChild(pidFile, childPid)) return { ok: true, pid: childPid };
      await tick();
    }
    return await abortUnconfirmed(pidFile, childPid);
  } finally {
    release();
  }
}

/**
 * 启动确认走身份感知的 PID 记录（与 daemon 启动器一致）：裸 PID 相等不够——文件里可能还是上一个实例的陈旧记录，
 * 而 OS 恰好把同一个号分给了新子进程；此时迁移检查仍按启动时刻判它陈旧，提前放锁会让并发规范化挪走目录。
 */
function confirmedChild(pidFile: string, childPid: number): boolean {
  return readPid(pidFile) === childPid && isProcessRunning(pidFile) === childPid;
}

function abortUnconfirmedSync(pidFile: string, childPid: number | undefined): AutopilotLaunch {
  if (childPid && confirmedChild(pidFile, childPid) && isChildRunning(childPid)) return { ok: true, pid: childPid };
  signalChild(childPid, "SIGTERM");
  const deadline = Date.now() + TERM_GRACE_MS;
  while (childPid && isChildRunning(childPid) && Date.now() < deadline) sleepSync(DEFAULT_POLL_MS);
  signalChild(childPid, "SIGKILL");
  const killDeadline = Date.now() + KILL_WAIT_MS;
  while (childPid && isChildRunning(childPid) && Date.now() < killDeadline) sleepSync(DEFAULT_POLL_MS);
  clearChildPidFile(pidFile, childPid);
  return { ok: false, reason: AUTOPILOT_UNCONFIRMED_REASON };
}

async function abortUnconfirmed(pidFile: string, childPid: number | undefined): Promise<AutopilotLaunch> {
  if (childPid && confirmedChild(pidFile, childPid) && isChildRunning(childPid)) return { ok: true, pid: childPid };
  signalChild(childPid, "SIGTERM");
  const deadline = Date.now() + TERM_GRACE_MS;
  const tick = () => new Promise((resolve) => setTimeout(resolve, DEFAULT_POLL_MS));
  while (childPid && isChildRunning(childPid) && Date.now() < deadline) await tick();
  signalChild(childPid, "SIGKILL");
  const killDeadline = Date.now() + KILL_WAIT_MS;
  while (childPid && isChildRunning(childPid) && Date.now() < killDeadline) await tick();
  clearChildPidFile(pidFile, childPid);
  return { ok: false, reason: AUTOPILOT_UNCONFIRMED_REASON };
}

function clearChildPidFile(pidFile: string, childPid: number | undefined): void {
  if (!childPid || readPid(pidFile) !== childPid) return;
  try {
    fs.unlinkSync(pidFile);
  } catch {}
}

function signalChild(pid: number | undefined, sig: NodeJS.Signals): void {
  if (!pid) return;
  try {
    process.kill(pid, sig);
  } catch {}
}

// 活着且不是僵尸：僵尸进程 kill(pid,0) 仍成功，但 ps 状态位为 Z；ps 不可用时退回 kill(pid,0)
function isChildRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
  try {
    const r = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" });
    // 只有 ps 正常运行且明确报告 Z 才推翻 kill(0) 的存活结论；没有 ps（Windows / 精简容器）、非零退出、空输出都沿用它
    if (r.error || r.status !== 0) return true;
    return !(r.stdout ?? "").trim().startsWith("Z");
  } catch {
    return true;
  }
}

/**
 * daemon 刚派生后按持久化模式恢复 autopilot：模式仍是 semi-auto / full-auto 且没有 autopilot 在跑就派生一个
 * （它会自己等 daemon 登录）。清理边界 launchTs 取在读模式之前：读模式之后写入的 companion stop 不会被当成遗留物清掉。
 */
export function respawnAutopilotIfAutoMode(
  storageRoot: string,
  dir: string,
): { mode: string; launch?: AutopilotLaunch } | null {
  const launchTs = Date.now();
  const mode = readGameModeRecord(dir)?.mode;
  if (mode !== "semi-auto" && mode !== "full-auto") return null;
  if (isProcessRunning(path.join(dir, "autopilot.pid"))) return { mode };
  return { mode, launch: launchAutopilot(storageRoot, dir, launchTs) };
}

export async function respawnAutopilotIfAutoModeAsync(
  storageRoot: string,
  dir: string,
): Promise<{ mode: string; launch?: AutopilotLaunch } | null> {
  const launchTs = Date.now();
  const mode = readGameModeRecord(dir)?.mode;
  if (mode !== "semi-auto" && mode !== "full-auto") return null;
  if (isProcessRunning(path.join(dir, "autopilot.pid"))) return { mode };
  return { mode, launch: await launchAutopilotAsync(storageRoot, dir, launchTs) };
}

// 旧 autopilot 认领联停信号（rename 走控制文件）到删 PID 退出之间有窗口：此时"PID 活着且看不到 force"并不代表健康，
// 要连续几次观察都活着（且仍看不到联停）才算稳定。
export const STABLE_ALIVE_POLLS = 4;

/**
 * daemon 刚派生时 `mud-daemon.pid` 还未必写入，而 autopilot 启动第一步就检查它：先等 pid 文件出现且进程存活（有界）再恢复。
 * 不阻塞调用方（命令/工具立即返回），结果写到 autopilot.log。网关进程里跑，派生走异步维护锁。
 */
export function respawnAutopilotWhenDaemonReady(
  storageRoot: string,
  dir: string,
  timeoutMs = 15_000,
  pollMs = 500,
): void {
  const deadline = Date.now() + timeoutMs;
  let stableAlive = 0;
  const logFile = path.join(dir, "autopilot.log");
  const note = (msg: string) => {
    try {
      fs.appendFileSync(logFile, `[${new Date().toISOString()}] [respawn] ${msg}\n`);
    } catch {}
  };
  const attempt = () => {
    const mode = readGameModeRecord(dir)?.mode;
    if (mode !== "semi-auto" && mode !== "full-auto") return;
    if (isProcessRunning(path.join(dir, "autopilot.pid"))) {
      // 任何仍会生效的 stop（force、无标签、或代际与当前自动模式一致）都意味着它稍后必退：重置计数，等 PID 消失
      stableAlive = hasEffectiveStopSignal(path.join(dir, "autopilot-control.json"), dir) ? 0 : stableAlive + 1;
      if (stableAlive >= STABLE_ALIVE_POLLS) return;
      if (Date.now() < deadline) setTimeout(attempt, pollMs).unref();
      else note("旧 autopilot 仍未退出，放弃恢复");
      return;
    }
    stableAlive = 0;
    if (!isProcessRunning(path.join(dir, "mud-daemon.pid"))) {
      if (Date.now() < deadline) setTimeout(attempt, pollMs).unref();
      else note("daemon pid 未就绪，放弃恢复 autopilot");
      return;
    }
    void respawnAutopilotIfAutoModeAsync(storageRoot, dir).then((r) => {
      if (!r?.launch) return;
      if (r.launch.ok) note(`模式为 ${r.mode}，已重新启动 autopilot (PID ${r.launch.pid})`);
      else note(`模式为 ${r.mode}，恢复 autopilot 失败：${r.launch.reason}`);
    });
  };
  setTimeout(attempt, Math.min(300, pollMs)).unref();
}
