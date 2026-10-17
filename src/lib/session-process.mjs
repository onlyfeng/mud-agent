// @ts-check
// 会话进程（daemon / autopilot）存活判定，运行时 MudSessionStore 与 scripts/normalize-sessions.mjs 共用：
// 搬动一个会话目录前必须确认没有进程还在从它里面读写（它们不走迁移锁，目录被搬走后手里的路径就失效）。
import fs from "node:fs";
import path from "node:path";
import { probeProcessStartTime, readProcessCommand } from "./dir-lock-contract.mjs";

export const SESSION_PID_FILES = ["mud-daemon.pid", "autopilot.pid"];

// 按角色区分入口：源码入口（dist/cli/*-entry.js）与 install.sh 生成的运行时 shim（mud-daemon.js / autopilot.js）。
// 参数边界接受空白、行尾与引号（Windows 上路径含空格时 CommandLine 形如 "...\autopilot-entry.js"）。
const ROLE_ENTRY_RE = {
  daemon: /(?:^|[\\/\s"'])(daemon-entry|mud-daemon)\.js(?:["'\s]|$)/,
  autopilot: /(?:^|[\\/\s"'])(autopilot-entry|autopilot)\.js(?:["'\s]|$)/,
};
const START_TIME_TOLERANCE_MS = 2000;

/**
 * PID 文件的角色由文件名决定：mud-daemon.pid → daemon，autopilot.pid → autopilot。
 * @param {string} pidFile
 * @returns {"daemon" | "autopilot"}
 */
export function pidFileRole(pidFile) {
  return path.basename(pidFile) === "mud-daemon.pid" ? "daemon" : "autopilot";
}

/**
 * PID 文件内容：第一行是 pid（所有 parseInt 读者兼容），第二行是实例身份 {role, startedAt}。
 * 身份把这份文件绑定到"写它的那个进程实例"：同一入口脚本的另一个会话进程复用了这个号码也对不上启动时刻。
 * startedAt 为 null 表示写入方探测不到自己的启动时刻（身份不可核验），核对方只能按角色核对、不发 SIGTERM。
 * @param {string} pidFile
 * @param {number} pid
 * @param {number | null} startedAt
 */
export function formatPidRecord(pidFile, pid, startedAt) {
  return `${pid}\n${JSON.stringify({ role: pidFileRole(pidFile), startedAt })}`;
}

/**
 * @param {string} pidFile
 * @returns {{ pid: number, startedAt: number | null, identity: "legacy" | "known" | "unverifiable" } | null}
 */
function readPidRecord(pidFile) {
  let raw;
  try {
    raw = fs.readFileSync(pidFile, "utf8");
  } catch {
    return null;
  }
  const [first, second] = raw.split(/\r?\n/);
  const pid = Number.parseInt((first ?? "").trim(), 10);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  // legacy：没有第二行（升级前的进程写的）；unverifiable：写入方明确记录 startedAt 为 null
  let startedAt = null;
  /** @type {"legacy" | "known" | "unverifiable"} */
  let identity = "legacy";
  if (second?.trim()) {
    try {
      const parsed = JSON.parse(second);
      identity = Number.isFinite(parsed?.startedAt) ? "known" : "unverifiable";
      if (identity === "known") startedAt = Number(parsed.startedAt);
    } catch {}
  }
  return { pid, startedAt, identity };
}

/**
 * PID 文件里的进程存活情况：
 * - null：没有进程，或能核对出它不是写这份文件的那个实例——号码被无关进程、另一种角色、或另一个会话的同类进程复用
 * - { pid, verified: true }：活着，命令行是本角色的入口，且（文件带身份时）操作系统报告的启动时刻与记录一致
 * - { pid, verified: false }：活着但身份无法核验（读不到命令行 / 启动时刻）
 * 调用方按风险选边：搬目录（迁移/归档）把"无法核验"当作在用，失败关闭；发 SIGTERM 只认 verified。
 * 旧格式文件（只有 pid，升级前的进程写的）没有实例身份：只能作为迁移时的保守存活证据，不授权发信号。
 * @param {string} pidFile
 * @returns {{ pid: number, verified: boolean } | null}
 */
export function inspectSessionPid(pidFile) {
  const record = readPidRecord(pidFile);
  if (record === null) return null;
  const { pid, startedAt, identity } = record;
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== "EPERM") return null;
  }
  const command = readProcessCommand(pid);
  if (command === null) return { pid, verified: false };
  if (!ROLE_ENTRY_RE[pidFileRole(pidFile)].test(command)) return null;
  if (identity !== "known" || startedAt === null) return { pid, verified: false };
  const probe = probeProcessStartTime(pid);
  if (probe.kind !== "known") return { pid, verified: false };
  return Math.abs(probe.startedAt - startedAt) <= START_TIME_TOLERANCE_MS ? { pid, verified: true } : null;
}

/**
 * PID 记录是否仍指向写它的那个进程实例（不看命令行，PID 锁与存活判定用）：
 * - 进程不存在 → null
 * - 记录带启动时刻且操作系统报告的启动时刻对不上 → null（号码已被别的进程复用，锁是遗留物）
 * - 其他（旧格式 / 不可核验 / 一致）→ pid
 * @param {string} pidFile
 * @returns {number | null}
 */
export function livePidFromRecord(pidFile) {
  const record = readPidRecord(pidFile);
  if (record === null) return null;
  const { pid, startedAt, identity } = record;
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== "EPERM") return null;
  }
  if (identity !== "known" || startedAt === null) return pid;
  const probe = probeProcessStartTime(pid);
  if (probe.kind !== "known") return pid;
  return Math.abs(probe.startedAt - startedAt) <= START_TIME_TOLERANCE_MS ? pid : null;
}

/**
 * 保守语义（给迁移 / 归档用）：活着就算在用，身份无法核验也算。
 * @param {string} pidFile
 * @returns {number | null}
 */
export function readLiveSessionPid(pidFile) {
  return inspectSessionPid(pidFile)?.pid ?? null;
}

/**
 * 严格语义（给发信号用）：只有命令行确认是会话入口的才返回 pid。
 * @param {string} pidFile
 * @returns {number | null}
 */
export function readVerifiedSessionPid(pidFile) {
  const inspected = inspectSessionPid(pidFile);
  return inspected?.verified ? inspected.pid : null;
}

/**
 * @param {string} dir
 * @returns {{ file: string, pid: number }[]} 目录里仍活着的会话进程
 */
export function listLiveSessionProcesses(dir) {
  const live = [];
  for (const name of SESSION_PID_FILES) {
    const pid = readLiveSessionPid(path.join(dir, name));
    if (pid !== null) live.push({ file: name, pid });
  }
  return live;
}
