import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { probeProcessStartTime, processStartTimeMs } from "../lib/dir-lock-contract.mjs";
import { formatPidRecord } from "../lib/session-process.mjs";
import {
  acquirePidLock,
  cleanStalePid,
  EMPTY_LOCK_GRACE_MS,
  isProcessRunning,
  readHeartbeat,
  readPid,
  removeOwnPid,
  removePid,
  writePid,
} from "./process-guard";

describe("process-guard", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mud-pid-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes and reads PID", () => {
    const file = path.join(tmpDir, "test.pid");
    writePid(file);
    expect(readPid(file)).toBe(process.pid);
  });

  it("returns null for missing PID file", () => {
    expect(readPid(path.join(tmpDir, "nope.pid"))).toBeNull();
  });

  it("removes PID file", () => {
    const file = path.join(tmpDir, "test.pid");
    writePid(file);
    removePid(file);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("isProcessRunning returns PID for current process", () => {
    const file = path.join(tmpDir, "test.pid");
    writePid(file);
    expect(isProcessRunning(file)).toBe(process.pid);
  });

  it("isProcessRunning returns null for stale PID", () => {
    const file = path.join(tmpDir, "test.pid");
    fs.writeFileSync(file, "999999");
    // PID 999999 is almost certainly not running
    expect(isProcessRunning(file)).toBeNull();
  });

  it("cleanStalePid removes stale PID and returns true", () => {
    const file = path.join(tmpDir, "test.pid");
    fs.writeFileSync(file, "999999");
    expect(cleanStalePid(file)).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("cleanStalePid returns false for running process", () => {
    const file = path.join(tmpDir, "test.pid");
    writePid(file);
    expect(cleanStalePid(file)).toBe(false);
  });

  it("cleanStalePid returns true when no PID file", () => {
    expect(cleanStalePid(path.join(tmpDir, "nope.pid"))).toBe(true);
  });

  describe("acquirePidLock", () => {
    it("acquires a fresh lock and refuses a second attempt while the holder is alive", () => {
      const file = path.join(tmpDir, "lock.pid");
      expect(acquirePidLock(file)).toBe(true);
      expect(readPid(file)).toBe(process.pid);
      expect(acquirePidLock(file)).toBe(false);
    });

    it("treats a fresh empty lock as held (O_EXCL succeeded, PID not yet written)", () => {
      const file = path.join(tmpDir, "racing.pid");
      fs.writeFileSync(file, "");
      expect(acquirePidLock(file)).toBe(false);
      expect(fs.existsSync(file)).toBe(true);
    });

    it("reclaims an empty lock older than the grace window", () => {
      const file = path.join(tmpDir, "abandoned.pid");
      fs.writeFileSync(file, "");
      const old = new Date(Date.now() - EMPTY_LOCK_GRACE_MS - 5000);
      fs.utimesSync(file, old, old);
      expect(acquirePidLock(file)).toBe(true);
      expect(readPid(file)).toBe(process.pid);
    });

    it("reclaims a lock whose PID number is alive but belongs to a different process instance", () => {
      const file = path.join(tmpDir, "autopilot.pid");
      if (probeProcessStartTime(process.pid).kind !== "known") return; // 无 ps 的平台无法核对
      fs.writeFileSync(file, formatPidRecord(file, process.pid, Date.now() - 3_600_000)); // 同号码、启动时刻对不上
      expect(isProcessRunning(file)).toBeNull();
      expect(acquirePidLock(file)).toBe(true);
      expect(readPid(file)).toBe(process.pid);
      expect(isProcessRunning(file)).toBe(process.pid); // 新记录带真实启动时刻
    });

    it("reclaims a lock whose PID is dead", () => {
      const file = path.join(tmpDir, "dead.pid");
      fs.writeFileSync(file, "999999");
      expect(acquirePidLock(file)).toBe(true);
      expect(readPid(file)).toBe(process.pid);
    });

    it("does not remove a live lock that replaced the dead one between inspection and reclamation", () => {
      const file = path.join(tmpDir, "raced.pid");
      fs.writeFileSync(file, "999999"); // 第一次检查看到死 pid
      const realMkdir = fs.mkdirSync;
      // 并发方在我们拿回收锁之前已回收并建立了自己的活锁（这里用本进程 pid 模拟）
      const spy = vi.spyOn(fs, "mkdirSync").mockImplementation(((p: fs.PathLike, opts?: fs.MakeDirectoryOptions) => {
        if (String(p).includes(".reclaim")) fs.writeFileSync(file, String(process.pid)); // atomic 模式先建暂存目录
        return realMkdir(p, opts);
      }) as typeof fs.mkdirSync);
      try {
        expect(acquirePidLock(file)).toBe(false);
        expect(readPid(file)).toBe(process.pid); // 活锁从未被 rename / unlink
        expect(fs.existsSync(`${file}.reclaim`)).toBe(false);
      } finally {
        spy.mockRestore();
      }
    });

    it("reclaims a crashed reclaimer's reclaim lock (dead owner marker) and completes the acquisition in the same call", () => {
      const file = path.join(tmpDir, "stale-reclaim.pid");
      fs.writeFileSync(file, "999999");
      const reclaim = `${file}.reclaim`;
      fs.mkdirSync(reclaim);
      fs.writeFileSync(path.join(reclaim, `owner-999999-${Date.now() - 60_000}`), ""); // 回收者已死
      expect(acquirePidLock(file)).toBe(true);
      expect(readPid(file)).toBe(process.pid);
      expect(fs.existsSync(reclaim)).toBe(false);
    });

    it("fails fast while another live process holds the reclaim lock", () => {
      const file = path.join(tmpDir, "contended.pid");
      fs.writeFileSync(file, "999999");
      const reclaim = `${file}.reclaim`;
      fs.mkdirSync(reclaim);
      const marker = path.join(reclaim, `owner-${process.pid}-${processStartTimeMs()}`); // 活持有者：pid + 真实启动时刻
      fs.writeFileSync(marker, ""); // 另一个（活着的）回收者正在处理
      expect(acquirePidLock(file)).toBe(false);
      expect(readPid(file)).toBe(999999); // 没拿到回收锁的进程不碰锁文件
      expect(fs.existsSync(marker)).toBe(true); // 活的回收锁也不会被删
      fs.unlinkSync(marker);
      fs.rmdirSync(reclaim);
      expect(acquirePidLock(file)).toBe(true);
      expect(fs.existsSync(reclaim)).toBe(false);
    });
  });

  describe("readHeartbeat", () => {
    it("returns age in seconds for valid heartbeat", () => {
      const file = path.join(tmpDir, "heartbeat");
      fs.writeFileSync(file, new Date().toISOString());
      const age = readHeartbeat(file);
      expect(age).not.toBeNull();
      expect(age as number).toBeLessThan(2);
    });

    it("returns null for missing file", () => {
      expect(readHeartbeat(path.join(tmpDir, "nope"))).toBeNull();
    });

    it("returns null for invalid content", () => {
      const file = path.join(tmpDir, "heartbeat");
      fs.writeFileSync(file, "not a date");
      expect(readHeartbeat(file)).toBeNull();
    });
  });

  describe("removeOwnPid", () => {
    it("removes the pid file only when it holds this process's pid", () => {
      const file = path.join(tmpDir, "autopilot.pid");
      fs.writeFileSync(file, String(process.pid));
      expect(removeOwnPid(file)).toBe(true);
      expect(fs.existsSync(file)).toBe(false);

      // 锁已被新进程拿走：不动它
      fs.writeFileSync(file, "424242");
      expect(removeOwnPid(file)).toBe(false);
      expect(fs.readFileSync(file, "utf8")).toBe("424242");

      expect(removeOwnPid(path.join(tmpDir, "missing.pid"))).toBe(false);
    });
  });
});
