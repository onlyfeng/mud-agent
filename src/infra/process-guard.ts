/**
 * PID 文件读写、isDaemonRunning、过期 PID 清理。
 */

import fs from "node:fs";
import {
  isDirLockAbandoned,
  processStartTimeMs,
  reclaimAbandonedDirLock,
  tryAcquireDirLock,
} from "../lib/dir-lock-contract.mjs";
import { formatPidRecord, livePidFromRecord } from "../lib/session-process.mjs";

export function writePid(pidFile: string): void {
  fs.writeFileSync(pidFile, formatPidRecord(pidFile, process.pid, processStartTimeMs()));
}

/**
 * 原子获取 PID 锁：用 O_CREAT | O_EXCL 保证同一时刻只有一个进程能创建文件。
 * - 成功 → 返回 true（已写入自己的 PID）
 * - 失败（文件已存在 + 进程仍活）→ 返回 false
 * - 文件已存在但为空且很新 → 视为另一个进程正在 openSync 和 writeSync 之间，返回 false
 * - 文件已存在但 PID 已死（或长时间为空）→ 删旧文件重试一次
 */
export const EMPTY_LOCK_GRACE_MS = 2000;

export function acquirePidLock(pidFile: string, _retried = false): boolean {
  try {
    const fd = fs.openSync(pidFile, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o644);
    fs.writeSync(fd, formatPidRecord(pidFile, process.pid, processStartTimeMs()));
    fs.closeSync(fd);
    return true;
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    const existing = readPid(pidFile);
    if (existing !== null) {
      // 号码活着还不够：记录里带启动时刻时要对得上，否则是崩溃后被别的进程复用的号码，锁是遗留物
      if (livePidFromRecord(pidFile) !== null) return false;
    } else if (lockAgeMs(pidFile) < EMPTY_LOCK_GRACE_MS) {
      return false;
    }
    if (_retried) return false;
    if (!reclaimStaleLock(pidFile, existing)) return false;
    return acquirePidLock(pidFile, true);
  }
}

/**
 * 回收死 PID 的残锁。所有回收者先争 `<pidFile>.reclaim`（崩溃可恢复的目录锁，见 lib/dir-lock-contract.mjs），
 * 只有拿到它的进程才能删锁文件，并且删之前再核对一次文件里仍是当初检查到的那个死 pid：
 * 新实例只能在文件被删后用 O_EXCL 建文件，而删除只发生在这个串行的回收段里，所以核对与删除之间内容不可能被换成活锁。
 * 没拿到回收锁的进程直接失败（由持锁者完成回收）；回收锁的持有者已死则回收它后在本次调用内重新争一次。
 * 活锁文件与活的回收锁在整个过程中从不被 rename / unlink。
 */
function reclaimStaleLock(pidFile: string, inspectedPid: number | null, _retriedReclaim = false): boolean {
  const reclaimLock = `${pidFile}.reclaim`;
  // <pidFile>.reclaim 从未有过旧版本的裸目录形式：用 atomic 模式（暂存 + rename），崩溃遗留的空目录会被 rename 直接取代
  const release = tryAcquireDirLock(reclaimLock, { atomic: true });
  if (!release) {
    if (_retriedReclaim || !isDirLockAbandoned(reclaimLock) || !reclaimAbandonedDirLock(reclaimLock)) return false;
    return reclaimStaleLock(pidFile, inspectedPid, true);
  }
  try {
    if (!fs.existsSync(pidFile)) return true;
    if (readPid(pidFile) !== inspectedPid) return false;
    if (inspectedPid === null && lockAgeMs(pidFile) < EMPTY_LOCK_GRACE_MS) return false;
    fs.unlinkSync(pidFile);
    return true;
  } catch {
    return false;
  } finally {
    release();
  }
}

function lockAgeMs(pidFile: string): number {
  try {
    return Date.now() - fs.statSync(pidFile).mtimeMs;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

export function removePid(pidFile: string): void {
  try {
    fs.unlinkSync(pidFile);
  } catch {}
}

/** 只删自己持有的锁：锁已被新进程拿走时（文件里是别的 pid）不动它。 */
export function removeOwnPid(pidFile: string): boolean {
  if (readPid(pidFile) !== process.pid) return false;
  removePid(pidFile);
  return true;
}

export function readPid(pidFile: string): number | null {
  try {
    const pid = parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10);
    if (Number.isNaN(pid)) return null;
    return pid;
  } catch {
    return null;
  }
}

/** 记录指向的进程实例仍活着时返回 pid（记录带身份时核对启动时刻，被复用的号码不算）。 */
export function isProcessRunning(pidFile: string): number | null {
  return livePidFromRecord(pidFile);
}

/**
 * 检测并清理过期 PID 文件。
 * 返回 true 表示 PID 已过期并已清理；false 表示进程仍在运行。
 */
export function cleanStalePid(pidFile: string): boolean {
  if (readPid(pidFile) === null) return true; // no PID file or invalid — treated as clean
  if (livePidFromRecord(pidFile) !== null) return false; // process instance is alive
  removePid(pidFile); // dead, or the number was reused by another process — stale
  return true;
}

/**
 * 读取心跳时间戳，返回距今秒数。null 表示无心跳文件。
 */
export function readHeartbeat(heartbeatFile: string): number | null {
  try {
    const ts = fs.readFileSync(heartbeatFile, "utf8").trim();
    const age = (Date.now() - new Date(ts).getTime()) / 1000;
    return Number.isFinite(age) ? age : null;
  } catch {
    return null;
  }
}
