import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { sleepSync } from "../lib/dir-lock-contract.mjs";
import { acquireMigrationLockAsync, acquireMigrationLockSync } from "../lib/migration-lock-contract.mjs";
import { isProcessRunning, readPid } from "./process-guard.js";

export type DaemonLaunch =
  | { ok: true; pid: number | undefined; confirmed: boolean; alreadyRunning?: boolean }
  | { ok: false; reason: string };

type LaunchOptions = { confirmMs?: number; pollMs?: number };

const DEFAULT_CONFIRM_MS = 10_000;
const DEFAULT_POLL_MS = 100;

export const LOCK_BUSY_REASON = "另一个 start 或 normalize:sessions 正在进行（维护锁被占用），请稍后重试";

export const DAEMON_DIR_MISSING_REASON =
  "会话目录已不存在（可能刚被 normalize:sessions 迁移/归档），未启动守护进程；请重新 start";

function spawnDetached(entry: string, dir: string): number | undefined {
  const out = fs.openSync(path.join(dir, "daemon.log"), "a");
  const child = spawn("node", [entry], {
    detached: true,
    stdio: ["ignore", out, out],
    env: { ...process.env, MUD_DIR: dir },
  });
  child.unref();
  fs.closeSync(out);
  return child.pid;
}

/**
 * 在维护锁（与 MudSessionStore / normalize:sessions 同一把 .migration.lock）内派生 daemon，并等到它的 PID 落盘才释放。
 * normalize 的 apply 在同一把锁里做"来源目录无活进程"检查：要么它先跑完（我们在锁内重查目录发现已被搬走 → 拒绝启动，
 * 不会把旧路径重建出来），要么它在 PID 落盘之后才拿到锁（看到活进程 → 拒绝搬迁）。
 * 超过 confirmMs 仍未见 PID 时照常返回（confirmed=false），由调用方提示用 status 查看。
 * 同步版给 mud-ctl（阻塞最多 confirmMs）；异步版给 OpenClaw 的命令/工具处理器，等待期间不占用网关事件循环。
 */
export function launchDaemonSync(
  storageRoot: string,
  dir: string,
  entry: string,
  opts: LaunchOptions = {},
): DaemonLaunch {
  let release: () => void;
  try {
    release = acquireMigrationLockSync(storageRoot, { timeoutMs: 5000 });
  } catch {
    return { ok: false, reason: LOCK_BUSY_REASON };
  }
  try {
    const started = spawnUnderLock(dir, entry);
    if (!started.ok) return started;
    if (started.alreadyRunning) return { ok: true, pid: started.pid, confirmed: true, alreadyRunning: true };
    const deadline = Date.now() + (opts.confirmMs ?? DEFAULT_CONFIRM_MS);
    while (Date.now() < deadline) {
      if (isProcessRunning(path.join(dir, "mud-daemon.pid"))) return { ok: true, pid: started.pid, confirmed: true };
      sleepSync(opts.pollMs ?? DEFAULT_POLL_MS);
    }
    return abortUnconfirmedChildSync(dir, started.pid);
  } finally {
    release();
  }
}

export async function launchDaemon(
  storageRoot: string,
  dir: string,
  entry: string,
  opts: LaunchOptions = {},
): Promise<DaemonLaunch> {
  // 网关进程里异步等锁：不阻塞事件循环；拿不到锁按普通启动失败返回，不抛
  let release: () => void;
  try {
    release = await acquireMigrationLockAsync(storageRoot, { timeoutMs: 5000 });
  } catch {
    return { ok: false, reason: LOCK_BUSY_REASON };
  }
  try {
    const started = spawnUnderLock(dir, entry);
    if (!started.ok) return started;
    if (started.alreadyRunning) return { ok: true, pid: started.pid, confirmed: true, alreadyRunning: true };
    const deadline = Date.now() + (opts.confirmMs ?? DEFAULT_CONFIRM_MS);
    while (Date.now() < deadline) {
      if (isProcessRunning(path.join(dir, "mud-daemon.pid"))) return { ok: true, pid: started.pid, confirmed: true };
      await new Promise((resolve) => setTimeout(resolve, opts.pollMs ?? DEFAULT_POLL_MS));
    }
    return await abortUnconfirmedChild(dir, started.pid);
  } finally {
    release();
  }
}

export const DAEMON_UNCONFIRMED_REASON = "守护进程 10 s 内未写入 PID，已终止该子进程；请查看 daemon.log 后重新 start";
const TERM_GRACE_MS = 3000;
const KILL_WAIT_MS = 2000;

// 确认超时后不能带着"子进程可能还会起来"释放维护锁（normalize 会在锁内看到无活进程就搬目录）：
// 先 SIGTERM，宽限内仍未退出就 SIGKILL——信号送达即意味着它再也写不了任何文件；期间若它恰好写出了 PID 则按确认成功返回。
// SIGTERM 一旦发出就不再有"成功"：迟到的 PID 属于一个马上要退出的进程，报成功只会留下死 PID 和误派的 autopilot。
// 等它真正退出（宽限后 SIGKILL），清掉它可能写出的 PID 文件（在维护锁内、进程已死，安全），返回失败。
function abortUnconfirmedChildSync(dir: string, childPid: number | undefined): DaemonLaunch {
  const pidFile = path.join(dir, "mud-daemon.pid");
  const confirmed = isProcessRunning(pidFile);
  if (confirmed) return { ok: true, pid: confirmed, confirmed: true };
  signalChild(childPid, "SIGTERM");
  const deadline = Date.now() + TERM_GRACE_MS;
  while (childPid && isChildRunning(childPid) && Date.now() < deadline) sleepSync(DEFAULT_POLL_MS);
  signalChild(childPid, "SIGKILL");
  // SIGKILL 送达后它再也写不了文件；再等一小段只是为了尽量在清 PID 文件前让它退出。
  // 同步路径里本进程的事件循环不转，子进程退出后会以僵尸形态留着（kill(pid,0) 仍成功），所以用 ps 的状态位判断，且必须有界。
  const killDeadline = Date.now() + KILL_WAIT_MS;
  while (childPid && isChildRunning(childPid) && Date.now() < killDeadline) sleepSync(DEFAULT_POLL_MS);
  clearChildPidFile(pidFile, childPid);
  return { ok: false, reason: DAEMON_UNCONFIRMED_REASON };
}

async function abortUnconfirmedChild(dir: string, childPid: number | undefined): Promise<DaemonLaunch> {
  const pidFile = path.join(dir, "mud-daemon.pid");
  const confirmed = isProcessRunning(pidFile);
  if (confirmed) return { ok: true, pid: confirmed, confirmed: true };
  signalChild(childPid, "SIGTERM");
  const deadline = Date.now() + TERM_GRACE_MS;
  const tick = () => new Promise((resolve) => setTimeout(resolve, DEFAULT_POLL_MS));
  while (childPid && isChildRunning(childPid) && Date.now() < deadline) await tick();
  signalChild(childPid, "SIGKILL");
  const killDeadline = Date.now() + KILL_WAIT_MS;
  while (childPid && isChildRunning(childPid) && Date.now() < killDeadline) await tick();
  clearChildPidFile(pidFile, childPid);
  return { ok: false, reason: DAEMON_UNCONFIRMED_REASON };
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

function spawnUnderLock(
  dir: string,
  entry: string,
): { ok: true; pid: number | undefined; alreadyRunning?: boolean } | { ok: false; reason: string } {
  if (!fs.existsSync(path.join(dir, "config.json"))) return { ok: false, reason: DAEMON_DIR_MISSING_REASON };
  // 两个 start 并发都过了调用方的 PID 检查：锁内再查一次，已有 daemon 就直接返回它，不派生一个必然撞 PID 锁退出的子进程
  const running = isProcessRunning(path.join(dir, "mud-daemon.pid"));
  if (running) return { ok: true, pid: running, alreadyRunning: true };
  return { ok: true, pid: spawnDetached(entry, dir) };
}
