import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acquireDirLockSync,
  isDirLockAbandoned,
  processStartTimeMs,
  readDirLockOwners,
  readProcessStartTimeMs,
  reclaimAbandonedDirLock,
  tryAcquireDirLock,
} from "./dir-lock-contract.mjs";
import { acquireMigrationLockSync } from "./migration-lock-contract.mjs";

const roots: string[] = [];
function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mud-lock-"));
  roots.push(root);
  return root;
}
function lockWithOwner(root: string, pid: number, startedAt = processStartTimeMs(), name = ".migration.lock"): string {
  const lockDir = path.join(root, name);
  fs.mkdirSync(lockDir);
  fs.writeFileSync(path.join(lockDir, `owner-${pid}-${startedAt}`), "");
  return lockDir;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("dir lock", () => {
  it("is held via no-replace mkdir and leaves nothing behind on release", () => {
    const root = tempRoot();
    const lockDir = path.join(root, "x.lock");
    const release = tryAcquireDirLock(lockDir);
    expect(release).not.toBeNull();
    expect(readDirLockOwners(lockDir).map((o) => o.pid)).toEqual([process.pid]);
    expect(tryAcquireDirLock(lockDir)).toBeNull();
    release?.();
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it("never removes a lock whose owner is alive, even when a reclaimer tries", () => {
    const root = tempRoot();
    const lockDir = lockWithOwner(root, process.pid, undefined, ".migration.lock.v2");
    expect(isDirLockAbandoned(lockDir)).toBe(false);
    expect(reclaimAbandonedDirLock(lockDir)).toBe(false);
    expect(readDirLockOwners(lockDir)).toHaveLength(1);
    expect(() => acquireMigrationLockSync(root, { timeoutMs: 60, pollMs: 5 })).toThrow(
      /timed out waiting for session migration lock/,
    );
    expect(readDirLockOwners(lockDir)).toHaveLength(1);
  });

  it("reclaims a lock whose owner is dead and acquires in the same call", () => {
    const root = tempRoot();
    const lockDir = lockWithOwner(root, 999999, undefined, ".migration.lock.v2");
    expect(isDirLockAbandoned(lockDir)).toBe(true);
    const release = acquireMigrationLockSync(root, { timeoutMs: 500, pollMs: 5 });
    expect(readDirLockOwners(lockDir).map((o) => o.pid)).toEqual([process.pid]);
    release();
    expect(fs.existsSync(lockDir)).toBe(false);
  });

  it("rmdir-based reclamation cannot delete a live replacement that appeared after the dead marker was removed", () => {
    const root = tempRoot();
    const lockDir = path.join(root, "y.lock");
    fs.mkdirSync(lockDir);
    fs.writeFileSync(path.join(lockDir, `owner-999999-${Date.now() - 60_000}`), "");
    const realUnlink = fs.unlinkSync;
    let interposed = false;
    // 回收者删掉死标记之后、rmdir 之前，另一个进程 rename 自己的（非空）锁目录到同一路径
    const spy = Object.assign(fs, {
      unlinkSync: (p: fs.PathLike) => {
        realUnlink(p);
        if (!interposed) {
          interposed = true;
          fs.rmdirSync(lockDir);
          const stage = path.join(root, "stage");
          fs.mkdirSync(stage);
          fs.writeFileSync(path.join(stage, `owner-${process.pid}-${Date.now()}`), "");
          fs.renameSync(stage, lockDir);
        }
      },
    });
    try {
      expect(reclaimAbandonedDirLock(lockDir)).toBe(false);
    } finally {
      spy.unlinkSync = realUnlink;
    }
    expect(readDirLockOwners(lockDir).map((o) => o.pid)).toEqual([process.pid]);
  });

  it("derives the process start identity from the OS when available, not from the wall clock", () => {
    const fromOs = readProcessStartTimeMs(process.pid);
    if (fromOs === null) return; // 没有 ps 的平台退回墙钟反推
    expect(processStartTimeMs()).toBe(fromOs); // 与核对方同一来源，墙钟校正不会让活 owner 被判为 pid 复用
  });

  it("a lease marker (writer could not probe its start time) is never compared against ps, only leased", () => {
    const root = tempRoot();
    const lockDir = path.join(root, "lease.lock");
    fs.mkdirSync(lockDir);
    const marker = path.join(lockDir, `owner-${process.pid}-lease`); // 活进程、身份不可核验
    fs.writeFileSync(marker, "");
    expect(isDirLockAbandoned(lockDir)).toBe(false); // 租约未过期：视为活锁，即使本机 ps 能查到不同的"真实"启动时刻
    const old = Date.now() - 2 * 60 * 60 * 1000;
    fs.utimesSync(marker, old / 1000, old / 1000);
    expect(isDirLockAbandoned(lockDir)).toBe(true); // 租约过期才算遗弃
  });

  it("treats a marker whose pid was reused by a different process instance as dead", () => {
    const root = tempRoot();
    const ours = readProcessStartTimeMs(process.pid);
    expect(ours === null || Math.abs(ours - processStartTimeMs()) <= 2000).toBe(true);
    if (ours === null) return; // 没有 ps 的平台退回 pid 判定，无法区分实例
    const lockDir = lockWithOwner(root, process.pid, processStartTimeMs() - 3_600_000, ".migration.lock.v2");
    expect(isDirLockAbandoned(lockDir)).toBe(true);
    const release = acquireMigrationLockSync(root, { timeoutMs: 500, pollMs: 5 });
    expect(readDirLockOwners(lockDir).map((o) => o.pid)).toEqual([process.pid]);
    release();
  });

  it("does not replace an empty directory lock held by an older version (mkdir fails closed)", () => {
    const root = tempRoot();
    const lockDir = path.join(root, "legacy.lock");
    fs.mkdirSync(lockDir); // 旧版本进程用裸 mkdir 持有的空目录锁
    expect(tryAcquireDirLock(lockDir)).toBeNull();
    expect(fs.readdirSync(lockDir)).toEqual([]);
    expect(() => acquireDirLockSync(lockDir, { timeoutMs: 60, pollMs: 5 })).toThrow(/timed out/);
    expect(fs.existsSync(lockDir)).toBe(true);
  });

  it("never reclaims a markerless directory in mkdir mode, however old (fail closed)", () => {
    const root = tempRoot();
    const lockDir = path.join(root, "z.lock");
    fs.mkdirSync(lockDir);
    const old = new Date(Date.now() - 11 * 60_000);
    fs.utimesSync(lockDir, old, old);
    expect(isDirLockAbandoned(lockDir)).toBe(false);
    expect(() => acquireDirLockSync(lockDir, { timeoutMs: 60, pollMs: 5 })).toThrow(/never reclaimed automatically/);
    expect(fs.existsSync(lockDir)).toBe(true);
  });

  it("migration lock: holds .migration.lock.v2 atomically and occupies the legacy .migration.lock path for old versions", () => {
    const root = tempRoot();
    const release = acquireMigrationLockSync(root, { timeoutMs: 200, pollMs: 5 });
    expect(readDirLockOwners(path.join(root, ".migration.lock.v2")).map((o) => o.pid)).toEqual([process.pid]);
    expect(readDirLockOwners(path.join(root, ".migration.lock")).map((o) => o.pid)).toEqual([process.pid]); // 旧路径也带本版本标记；旧版本进程的 mkdir 会 EEXIST
    release();
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it("migration lock: reclaims a legacy-path directory left by a crashed current-version holder (dead owner marker)", () => {
    const root = tempRoot();
    const legacy = path.join(root, ".migration.lock");
    fs.mkdirSync(legacy);
    fs.writeFileSync(path.join(legacy, `owner-999999-${processStartTimeMs() - 60_000}`), ""); // 本版本持有者在释放前被杀
    const release = acquireMigrationLockSync(root, { timeoutMs: 200, pollMs: 5 });
    expect(readDirLockOwners(legacy).map((o) => o.pid)).toEqual([process.pid]);
    release();
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it("migration lock: fails closed on a legacy bare-mkdir holder and releases v2 again", () => {
    const root = tempRoot();
    fs.mkdirSync(path.join(root, ".migration.lock")); // 旧版本持有者（可能被挂起任意久）或其崩溃遗留：无法核验，不自动回收
    expect(() => acquireMigrationLockSync(root, { timeoutMs: 100, pollMs: 5 })).toThrow(
      /never reclaimed automatically/,
    );
    expect(fs.existsSync(path.join(root, ".migration.lock"))).toBe(true);
    expect(fs.existsSync(path.join(root, ".migration.lock.v2"))).toBe(false); // 失败时 v2 已释放
    fs.rmdirSync(path.join(root, ".migration.lock")); // 人工确认后删除
    acquireMigrationLockSync(root, { timeoutMs: 100, pollMs: 5 })();
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it("atomic mode takes over an empty crash-leftover directory but never a live holder's non-empty one", () => {
    const root = tempRoot();
    const lockDir = path.join(root, "reclaim.lock");
    fs.mkdirSync(lockDir); // 释放时删了标记、rmdir 前崩溃留下的空目录（该路径没有旧格式持有者）
    const realRename = fs.renameSync;
    // 模拟 Windows：rename 不覆盖已存在的空目标目录，必须由显式 rmdir 回收
    const spy = vi.spyOn(fs, "renameSync").mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
      if (fs.existsSync(to)) throw Object.assign(new Error("EPERM"), { code: "EPERM" });
      return realRename(from, to);
    }) as typeof fs.renameSync);
    let release: ReturnType<typeof tryAcquireDirLock>;
    try {
      release = tryAcquireDirLock(lockDir, { atomic: true });
    } finally {
      spy.mockRestore();
    }
    expect(release).not.toBeNull();
    expect(readDirLockOwners(lockDir).map((o) => o.pid)).toEqual([process.pid]);
    expect(tryAcquireDirLock(lockDir, { atomic: true })).toBeNull(); // 非空目录：rename 失败，活锁不被替换
    expect(readDirLockOwners(lockDir)).toHaveLength(1);
    release?.();
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it("falls back to a renewable lease only when the start-time probe is unavailable", () => {
    const root = tempRoot();
    const lockDir = path.join(root, "lease.lock");
    fs.mkdirSync(lockDir);
    const marker = path.join(lockDir, `owner-${process.pid}-${processStartTimeMs()}`);
    fs.writeFileSync(marker, "");
    const spy = vi
      .spyOn(childProcess, "spawnSync")
      .mockReturnValue({ error: new Error("ENOENT"), status: null, stdout: "", stderr: "" } as never); // 没有 ps 的平台
    try {
      expect(isDirLockAbandoned(lockDir)).toBe(false);
      const old = new Date(Date.now() - 61 * 60_000);
      fs.utimesSync(marker, old, old);
      expect(isDirLockAbandoned(lockDir)).toBe(true); // 一小时没续租：持锁者已不在（活着的持锁者会 renew）
      const now = new Date();
      fs.utimesSync(marker, now, now); // 续租
      expect(isDirLockAbandoned(lockDir)).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it("never treats a live pid as dead because ps failed (unsupported lstart / restricted proc / transient error)", () => {
    const root = tempRoot();
    const lockDir = path.join(root, "psfail.lock");
    fs.mkdirSync(lockDir);
    fs.writeFileSync(path.join(lockDir, `owner-${process.pid}-${processStartTimeMs()}`), "");
    const spy = vi
      .spyOn(childProcess, "spawnSync")
      .mockReturnValue({ status: 1, stdout: "", stderr: "ps: lstart: keyword not found" } as never);
    try {
      expect(isDirLockAbandoned(lockDir)).toBe(false); // kill(0) 说活着，ps 失败只是"身份未知"→ 新鲜标记按活处理
    } finally {
      spy.mockRestore();
    }
  });

  it("release.renew() refreshes the owner marker", () => {
    const root = tempRoot();
    const lockDir = path.join(root, "renew.lock");
    const release = tryAcquireDirLock(lockDir);
    expect(release).not.toBeNull();
    const marker = path.join(lockDir, readDirLockOwners(lockDir)[0].name);
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(marker, old, old);
    release?.renew();
    expect(Date.now() - fs.statSync(marker).mtimeMs).toBeLessThan(5_000);
    release?.();
  });
});
