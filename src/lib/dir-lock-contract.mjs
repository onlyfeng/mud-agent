// @ts-check
// 崩溃可恢复的跨进程互斥锁（目录锁），MudSessionStore 的迁移/registry 锁与 process-guard 的 PID 回收锁共用。
//
// 协议里没有任何“按路径无条件删除”：
// - 持锁 = 路径上的目录里有自己的唯一标记 owner-<pid>-<ts>。两种获取方式：
//   * mkdir 模式：mkdir 是真正的 no-replace，成功后再写标记；无标记目录永不自动回收（失败关闭，等待超时后提示人工处理）。
//   * atomic 模式（PID 回收锁，这个路径从没有过旧格式）：先在暂存目录写好标记再 rename 到锁路径——目录 rename 只会
//     替换"空"目标，而持锁者的目录从创建起就非空，所以活锁永远不会被替换；能被替换的空目录只可能是崩溃遗留，顺手回收。
//     锁路径上从不存在无标记状态，也就没有标记落入别人目录的可能。
// - 回收遗弃锁 = 按唯一名字删掉已死 owner 的标记，再 rmdir；目录里还有活标记时 rmdir 必然 ENOTEMPTY，活锁永远删不掉。
//   多个回收者并发只会各自得到 ENOENT / ENOTEMPTY。
// - 释放 = 删自己的标记，再 rmdir（别人已 rename 占位则 ENOTEMPTY，忽略）。
import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// 标记名里的第二段是持锁进程的启动时刻（ms）：判断存活时不只看 pid 是否存在，还要核对该 pid 现在对应的进程
// 启动时刻是否一致——否则持锁者崩溃后 pid 被别的长期进程复用，这把遗弃锁会被永久当成活锁。
// 标记 owner-<pid>-<startedAt>：startedAt 是操作系统报告的启动时刻；写标记时探测不到就写 owner-<pid>-lease，
// 明确声明"身份不可核验"，核对方对它永远走租约路径（即使它那边的 ps 后来恢复了）——不能拿墙钟反推值冒充可核验身份。
const MARKER_RE = /^owner-(\d+)-(\d+|lease)$/;
const START_TIME_TOLERANCE_MS = 2000;

/** @type {number | null} */
let ownStartTimeMs = null;

/**
 * 本进程的启动身份：操作系统报告的启动时刻（与核对方同一来源，不受进程启动后墙钟校正影响）；
 * 取不到（无 ps / PowerShell、临时失败）返回 null，由调用方写成"不可核验"身份。只缓存成功结果，失败下次重探。
 * @returns {number | null}
 */
export function processStartTimeMs() {
  if (ownStartTimeMs === null) {
    const probe = probeProcessStartTime(process.pid);
    if (probe.kind === "known") ownStartTimeMs = probe.startedAt;
  }
  return ownStartTimeMs;
}

/** 本进程的锁标记名。 */
export function ownerMarkerName() {
  return `owner-${process.pid}-${processStartTimeMs() ?? "lease"}`;
}

/**
 * 通过 ps 取某个 pid 的启动时刻；取不到（无 ps、进程已退出）返回 null。
 * @param {number} pid
 * @returns {number | null}
 */
export function readProcessStartTimeMs(pid) {
  const probe = probeProcessStartTime(pid);
  return probe.kind === "known" ? probe.startedAt : null;
}

/**
 * 启动时刻探测只有两种结果：known（拿到了）与 unknown（工具不存在、不支持该选项、权限或临时失败）。
 * 非零退出 + 空输出不能证明进程不存在（ps 不支持 lstart、/proc 受限都长这样），所以从不据此判死——
 * 存活与否由调用方的 kill(pid, 0) 决定，unknown 只影响"实例身份"的核对（退到可续租的租约）。
 * @param {number} pid
 * @returns {{ kind: "known", startedAt: number } | { kind: "unknown" }}
 */
export function probeProcessStartTime(pid) {
  /** @type {string} */
  let file = "ps";
  /** @type {string[]} */
  let args = ["-o", "lstart=", "-p", String(pid)];
  if (process.platform === "win32") {
    file = "powershell";
    args = ["-NoProfile", "-Command", `(Get-Process -Id ${pid}).StartTime.ToUniversalTime().ToString('o')`];
  }
  try {
    const r = childProcess.spawnSync(file, args, { encoding: "utf8" });
    if (r.error) return { kind: "unknown" };
    const text = (r.stdout ?? "").trim();
    if (r.status === 0 && text) {
      const parsed = Date.parse(text);
      return Number.isFinite(parsed) ? { kind: "known", startedAt: parsed } : { kind: "unknown" };
    }
    return { kind: "unknown" };
  } catch {
    return { kind: "unknown" };
  }
}

/**
 * 通过 ps 取某个 pid 的完整命令行；取不到返回 null。
 * @param {number} pid
 * @returns {string | null}
 */
export function readProcessCommand(pid) {
  /** @type {string} */
  let file = "ps";
  /** @type {string[]} */
  let args = ["-o", "command=", "-p", String(pid)];
  if (process.platform === "win32") {
    file = "powershell";
    args = ["-NoProfile", "-Command", `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CommandLine`];
  }
  try {
    const r = childProcess.spawnSync(file, args, { encoding: "utf8" });
    if (r.error || r.status !== 0) return null;
    const text = (r.stdout ?? "").trim();
    return text ? text : null;
  } catch {
    return null;
  }
}

/**
 * @param {string} lockDir
 * @param {{ name: string, pid: number, startedAt: number | null }} owner
 */
function isOwnerAlive(lockDir, owner) {
  if (!isPidAlive(owner.pid)) return false;
  if (owner.startedAt !== null) {
    const probe = probeProcessStartTime(owner.pid);
    if (probe.kind === "known") return Math.abs(probe.startedAt - owner.startedAt) <= START_TIME_TOLERANCE_MS;
  }
  try {
    return Date.now() - fs.statSync(path.join(lockDir, owner.name)).mtimeMs < UNVERIFIABLE_OWNER_LEASE_MS;
  } catch {
    return false;
  }
}
// 没有 ps / PowerShell 的环境核对不了进程启动时刻：pid 被复用时无法区分实例，退到租约——标记 mtime 超过此时长
// 仍在就视为遗弃。持锁者在长操作里通过 release.renew() 续租（normalize 每个步骤续一次），
// 所以只有"持锁者已经消失"才会真的过期；活着的持锁者不会因为临界区长而失去锁。
const UNVERIFIABLE_OWNER_LEASE_MS = 60 * 60 * 1000;

/** @param {number} pid */
function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return /** @type {NodeJS.ErrnoException} */ (error).code === "EPERM";
  }
}

/** @typedef {(() => void) & { renew: () => void }} ReleaseFn */

/** @param {string | undefined} code */
function isBusyCode(code) {
  return code === "EEXIST" || code === "ENOTEMPTY" || code === "EISDIR" || code === "EPERM";
}

/** 只删空目录（rmdir 对非空目录失败）。 @param {string} dir */
function removeEmptyDir(dir) {
  try {
    if (fs.readdirSync(dir).length > 0) return false;
    fs.rmdirSync(dir);
    return true;
  } catch {
    return false;
  }
}

/** @param {unknown} error */
function codeOf(error) {
  return /** @type {NodeJS.ErrnoException} */ (error).code;
}

/**
 * @param {string} lockDir
 * @returns {{ name: string, pid: number, startedAt: number | null }[]}
 */
export function readDirLockOwners(lockDir) {
  let names;
  try {
    names = fs.readdirSync(lockDir);
  } catch {
    return [];
  }
  const owners = [];
  for (const name of names) {
    const m = MARKER_RE.exec(name);
    if (m) owners.push({ name, pid: Number(m[1]), startedAt: m[2] === "lease" ? null : Number(m[2]) });
  }
  return owners;
}

/**
 * 无标记目录永不按年龄回收：mkdir 模式下它可能是旧版本进程的裸 mkdir 锁或新进程 mkdir 后被暂停，都无法证明已退出；
 * atomic 模式下路径上不存在无标记状态，空目录只可能是崩溃遗留，由 rename 直接取代、不走这里。
 * @param {string} lockDir
 */
export function isDirLockAbandoned(lockDir) {
  const owners = readDirLockOwners(lockDir);
  return owners.length > 0 && owners.every((owner) => !isOwnerAlive(lockDir, owner));
}

/**
 * @param {string} lockDir
 * @returns {boolean} 路径上已没有这把遗弃锁（本进程删掉了，或别的回收者已删掉）
 */
export function reclaimAbandonedDirLock(lockDir) {
  for (const owner of readDirLockOwners(lockDir)) {
    if (isOwnerAlive(lockDir, owner)) return false;
    try {
      fs.unlinkSync(path.join(lockDir, owner.name));
    } catch (error) {
      if (codeOf(error) !== "ENOENT") return false;
    }
  }
  try {
    fs.rmdirSync(lockDir);
    return true;
  } catch (error) {
    return codeOf(error) === "ENOENT";
  }
}

/**
 * 尝试获取一次，不等待。
 * @param {string} lockDir
 * @param {{ atomic?: boolean }} [options] atomic=true 用"暂存目录 + rename"（见文件头），只能用于从未有过旧格式的锁路径
 * @returns {(ReleaseFn) | null} 释放函数（带 renew()）；锁被占用时返回 null
 */
export function tryAcquireDirLock(lockDir, options = {}) {
  const marker = ownerMarkerName();
  if (options.atomic) {
    const stage = `${lockDir}.stage-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    fs.mkdirSync(stage);
    try {
      fs.writeFileSync(path.join(stage, marker), "");
      try {
        fs.renameSync(stage, lockDir);
      } catch (error) {
        // atomic 路径上持锁者的目录从来非空；空目录只可能是"删了标记、还没 rmdir"就崩溃的遗留。
        // POSIX 的 rename 会直接覆盖空目标，Windows 不会：这里显式 rmdir（非空会失败，不会误删活锁）后再试一次。
        if (!isBusyCode(codeOf(error)) || !removeEmptyDir(lockDir)) throw error;
        fs.renameSync(stage, lockDir);
      }
    } catch (error) {
      fs.rmSync(stage, { recursive: true, force: true });
      if (isBusyCode(codeOf(error))) return null;
      throw error;
    }
  } else {
    try {
      fs.mkdirSync(lockDir);
    } catch (error) {
      if (codeOf(error) === "EEXIST") return null;
      throw error;
    }
    try {
      fs.writeFileSync(path.join(lockDir, marker), "");
    } catch (error) {
      if (codeOf(error) === "ENOENT") return null;
      try {
        fs.rmdirSync(lockDir);
      } catch {}
      throw error;
    }
  }
  const markerPath = path.join(lockDir, marker);
  const release = () => {
    try {
      fs.unlinkSync(markerPath);
    } catch {}
    try {
      fs.rmdirSync(lockDir);
    } catch {}
  };
  /** 续租：刷新标记 mtime（不可核对启动时刻的环境靠它判断持锁者仍在） */
  release.renew = () => {
    const now = new Date();
    try {
      fs.utimesSync(markerPath, now, now);
    } catch {}
  };
  return release;
}

/** @param {number} ms */
export function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * 异步获取（网关进程里用：等待期间不阻塞事件循环，另一个在途的 launchDaemon 才能继续轮询并释放锁）。
 * @param {string} lockDir
 * @param {{ timeoutMs?: number, pollMs?: number, atomic?: boolean }} [options]
 * @returns {Promise<ReleaseFn>}
 */
export async function acquireDirLockAsync(lockDir, options = {}) {
  const timeoutMs = options.timeoutMs ?? 2000;
  const pollMs = options.pollMs ?? 10;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const release = tryAcquireDirLock(lockDir, options);
    if (release) return release;
    if (isDirLockAbandoned(lockDir) && reclaimAbandonedDirLock(lockDir)) continue;
    if (Date.now() >= deadline) throw new LockTimeoutError(lockDir);
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

/** 锁被别的活进程占用到超时：可重试的争用，与权限 / 磁盘等 I/O 失败区分开。 */
export class LockTimeoutError extends Error {
  /** @param {string} lockDir */
  constructor(lockDir) {
    super(lockTimeoutMessage(lockDir));
    this.name = "LockTimeoutError";
    this.code = "ELOCKTIMEOUT";
  }
}

/** @param {string} lockDir */
function lockTimeoutMessage(lockDir) {
  return (
    `timed out waiting for lock at ${lockDir}; another process is holding it -- retry after it finishes ` +
    "(a lock whose recorded owner has exited is reclaimed automatically; a lock directory without an owner marker " +
    "is never reclaimed automatically -- remove it manually after confirming no mud-agent process is running)"
  );
}

/**
 * 同步获取；等待超时抛错（此时锁确实被活着的进程持有）。
 * @param {string} lockDir
 * @param {{ timeoutMs?: number, pollMs?: number, atomic?: boolean }} [options]
 * @returns {ReleaseFn}
 */
export function acquireDirLockSync(lockDir, options = {}) {
  const timeoutMs = options.timeoutMs ?? 2000;
  const pollMs = options.pollMs ?? 10;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const release = tryAcquireDirLock(lockDir, options);
    if (release) return release;
    if (isDirLockAbandoned(lockDir) && reclaimAbandonedDirLock(lockDir)) continue;
    if (Date.now() >= deadline) throw new LockTimeoutError(lockDir);
    sleepSync(pollMs);
  }
}
