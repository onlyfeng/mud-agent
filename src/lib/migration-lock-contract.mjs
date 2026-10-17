// @ts-check
// 运行时 MudSessionStore 与 scripts/normalize-sessions.mjs 共用的跨进程迁移/registry 锁；锁本体见 dir-lock-contract.mjs。
//
// 两段式：
// 1. `.migration.lock.v2`：atomic 模式的目录锁（暂存目录 + rename，带 owner 标记）。这个路径从未有过旧格式，
//    rename 能替换的空目录只可能是崩溃遗留，持锁者目录从创建起就非空永远不会被替换；路径上不存在无标记状态。
// 2. `.migration.lock`（旧版本的裸 mkdir 锁路径）：拿到 v2 后再以 mkdir 模式拿它（mkdir + owner 标记），
//    与滚动升级期间仍在跑的旧版本进程互斥。路径上的目录分两种：带本版本 owner 标记的（持有者死了就回收——
//    崩溃遗留不会永久卡住所有人）；没有标记的只可能是旧版本持有者，无法核验身份，永不自动回收：等到超时就失败关闭，
//    提示确认没有 mud-agent 进程后再人工删除——与旧版本自身遇到残留锁时的行为一致。
import fs from "node:fs";
import path from "node:path";
import {
  acquireDirLockAsync,
  acquireDirLockSync,
  isDirLockAbandoned,
  reclaimAbandonedDirLock,
  sleepSync,
  tryAcquireDirLock,
} from "./dir-lock-contract.mjs";

export const MIGRATION_LOCK_DIRNAME = ".migration.lock";
export const MIGRATION_LOCK_V2_DIRNAME = ".migration.lock.v2";
const LEGACY_POLL_MS = 10;

/**
 * 同步获取；返回释放函数（带 renew()）。等待超时抛错（此时锁确实被活着的进程持有）。
 * @param {string} storageRoot
 * @param {{ timeoutMs?: number, pollMs?: number }} [options]
 * @returns {import("./dir-lock-contract.mjs").ReleaseFn}
 */
export function acquireMigrationLockSync(storageRoot, options = {}) {
  fs.mkdirSync(storageRoot, { recursive: true });
  const v2 = path.join(storageRoot, MIGRATION_LOCK_V2_DIRNAME);
  let release;
  try {
    release = acquireDirLockSync(v2, { ...options, atomic: true });
  } catch (error) {
    throw wrapTimeout(error, v2);
  }
  let legacyRelease;
  try {
    legacyRelease = acquireLegacyPathSync(path.join(storageRoot, MIGRATION_LOCK_DIRNAME), options.timeoutMs ?? 2000);
  } catch (error) {
    release();
    throw error;
  }
  return combineRelease(release, legacyRelease);
}

/**
 * 异步获取（网关进程里的 /mud start、mud_admin start 用）。
 * @param {string} storageRoot
 * @param {{ timeoutMs?: number, pollMs?: number }} [options]
 * @returns {Promise<import("./dir-lock-contract.mjs").ReleaseFn>}
 */
export async function acquireMigrationLockAsync(storageRoot, options = {}) {
  fs.mkdirSync(storageRoot, { recursive: true });
  const v2 = path.join(storageRoot, MIGRATION_LOCK_V2_DIRNAME);
  let release;
  try {
    release = await acquireDirLockAsync(v2, { ...options, atomic: true });
  } catch (error) {
    throw wrapTimeout(error, v2);
  }
  let legacyRelease;
  try {
    legacyRelease = await acquireLegacyPathAsync(
      path.join(storageRoot, MIGRATION_LOCK_DIRNAME),
      options.timeoutMs ?? 2000,
    );
  } catch (error) {
    release();
    throw error;
  }
  return combineRelease(release, legacyRelease);
}

/**
 * @param {import("./dir-lock-contract.mjs").ReleaseFn} release v2
 * @param {import("./dir-lock-contract.mjs").ReleaseFn} legacyRelease 旧路径
 * @returns {import("./dir-lock-contract.mjs").ReleaseFn}
 */
function combineRelease(release, legacyRelease) {
  /** @type {import("./dir-lock-contract.mjs").ReleaseFn} */
  const combined = Object.assign(
    () => {
      legacyRelease();
      release();
    },
    {
      renew: () => {
        legacyRelease.renew();
        release.renew();
      },
    },
  );
  return combined;
}

/**
 * 在已持有 v2 的前提下占住旧版锁路径（mkdir 模式，带 owner 标记）。EEXIST 时：带本版本标记且持有者已死 → 回收后重试；
 * 无标记（旧版本持有者）→ 等到超时失败关闭。
 * @param {string} legacyDir
 * @param {number} timeoutMs
 * @returns {import("./dir-lock-contract.mjs").ReleaseFn}
 */
function acquireLegacyPathSync(legacyDir, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const release = tryAcquireDirLock(legacyDir);
    if (release) return release;
    if (isDirLockAbandoned(legacyDir) && reclaimAbandonedDirLock(legacyDir)) continue;
    if (Date.now() >= deadline) throw new Error(legacyPathError(legacyDir));
    sleepSync(LEGACY_POLL_MS);
  }
}

/**
 * @param {string} legacyDir
 * @param {number} timeoutMs
 * @returns {Promise<import("./dir-lock-contract.mjs").ReleaseFn>}
 */
async function acquireLegacyPathAsync(legacyDir, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const release = tryAcquireDirLock(legacyDir);
    if (release) return release;
    if (isDirLockAbandoned(legacyDir) && reclaimAbandonedDirLock(legacyDir)) continue;
    if (Date.now() >= deadline) throw new Error(legacyPathError(legacyDir));
    await new Promise((resolve) => setTimeout(resolve, LEGACY_POLL_MS));
  }
}

/** @param {string} legacyDir */
function legacyPathError(legacyDir) {
  return (
    `timed out waiting for session migration lock at ${legacyDir}; ` +
    "a process (possibly an older mud-agent version) is holding it or crashed while holding it -- " +
    "it is never reclaimed automatically; remove the directory manually after confirming no mud-agent process is running"
  );
}

/**
 * @param {unknown} error
 * @param {string} lockDir
 */
function wrapTimeout(error, lockDir) {
  if (!/timed out waiting for lock/.test(String(error))) return error;
  return new Error(
    `timed out waiting for session migration lock at ${lockDir}; ` +
      "another mud-agent process is holding it -- retry after it finishes " +
      "(a lock whose recorded owner has exited is reclaimed automatically)",
    { cause: error },
  );
}
