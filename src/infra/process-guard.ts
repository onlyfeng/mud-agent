/**
 * PID 文件读写、isDaemonRunning、过期 PID 清理。
 */

import fs from "node:fs";

export function writePid(pidFile: string): void {
  fs.writeFileSync(pidFile, String(process.pid));
}

export function removePid(pidFile: string): void {
  try {
    fs.unlinkSync(pidFile);
  } catch {}
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

export function isProcessRunning(pidFile: string): number | null {
  const pid = readPid(pidFile);
  if (pid === null) return null;
  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

/**
 * 检测并清理过期 PID 文件。
 * 返回 true 表示 PID 已过期并已清理；false 表示进程仍在运行。
 */
export function cleanStalePid(pidFile: string): boolean {
  const pid = readPid(pidFile);
  if (pid === null) return true; // no PID file or invalid — treated as clean
  try {
    process.kill(pid, 0);
    return false; // process is alive
  } catch {
    // process not running — stale PID
    removePid(pidFile);
    return true;
  }
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
