import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const { spawnMock, psState } = vi.hoisted(() => ({
  spawnMock: vi.fn(() => ({ pid: 4242, unref() {} })),
  psState: { unavailable: false }, // true = 模拟没有 ps 的平台：spawnSync 返回 error=ENOENT
}));
vi.mock("node:child_process", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:child_process")>();
  const spawnSync: typeof real.spawnSync = ((...args: Parameters<typeof real.spawnSync>) =>
    psState.unavailable
      ? ({
          error: Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
          status: null,
          stdout: "",
          stderr: "",
        } as never)
      : real.spawnSync(...args)) as typeof real.spawnSync;
  return { ...real, default: { ...real, spawn: spawnMock, spawnSync }, spawn: spawnMock, spawnSync };
});
const childProcess = await vi.importActual<typeof import("node:child_process")>("node:child_process");

import { processStartTimeMs, readDirLockOwners } from "../lib/dir-lock-contract.mjs";
import {
  DAEMON_DIR_MISSING_REASON,
  DAEMON_UNCONFIRMED_REASON,
  LOCK_BUSY_REASON,
  launchDaemon,
  launchDaemonSync,
} from "./daemon-launcher";

const roots: string[] = [];
function fixture(): { root: string; dir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mud-launch-"));
  roots.push(root);
  const dir = path.join(root, "sessions", "v2_x");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "config.json"), "{}");
  return { root, dir };
}

afterEach(() => {
  spawnMock.mockReset();
  spawnMock.mockImplementation(() => ({ pid: 4242, unref() {} }));
  psState.unavailable = false;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("launchDaemon under the maintenance lock", () => {
  it("refuses to spawn when the session directory vanished (normalize moved it) and leaves no lock behind", async () => {
    const { root, dir } = fixture();
    fs.rmSync(dir, { recursive: true });
    expect(await launchDaemon(root, dir, "/entry.js")).toEqual({ ok: false, reason: DAEMON_DIR_MISSING_REASON });
    expect(launchDaemonSync(root, dir, "/entry.js")).toEqual({ ok: false, reason: DAEMON_DIR_MISSING_REASON });
    expect(spawnMock).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(root, ".migration.lock"))).toBe(false);
  });

  it("holds the lock until the daemon pid is on disk, then releases it", async () => {
    const { root, dir } = fixture();
    const lockDir = path.join(root, ".migration.lock.v2");
    spawnMock.mockImplementationOnce(() => {
      expect(readDirLockOwners(lockDir).map((o) => o.pid)).toEqual([process.pid]); // 派生时锁在手里
      fs.writeFileSync(path.join(dir, "mud-daemon.pid"), String(process.pid));
      return { pid: 4242, unref() {} };
    });
    expect(await launchDaemon(root, dir, "/entry.js", { confirmMs: 2000, pollMs: 10 })).toEqual({
      ok: true,
      pid: 4242,
      confirmed: true,
    });
    expect(fs.existsSync(lockDir)).toBe(false);
  });

  it("returns a normal launch failure instead of throwing when the maintenance lock is held by a live process", async () => {
    const { root, dir } = fixture();
    const lockDir = path.join(root, ".migration.lock.v2");
    fs.mkdirSync(lockDir);
    fs.writeFileSync(path.join(lockDir, `owner-${process.pid}-${processStartTimeMs()}`), "");
    const ticks: number[] = [];
    const ticker = setInterval(() => ticks.push(Date.now()), 20); // 事件循环必须一直在转
    try {
      const started = Date.now();
      const result = await launchDaemon(root, dir, "/entry.js");
      expect(result).toEqual({ ok: false, reason: LOCK_BUSY_REASON });
      expect(Date.now() - started).toBeGreaterThanOrEqual(4_000);
      expect(ticks.length).toBeGreaterThan(50);
    } finally {
      clearInterval(ticker);
    }
    expect(spawnMock).not.toHaveBeenCalled();
  }, 15_000);

  it("keeps trusting kill(0) when ps is unavailable (Windows / minimal containers) instead of killing a live child", () => {
    const { root, dir } = fixture();
    spawnMock.mockImplementationOnce(() => {
      fs.writeFileSync(path.join(dir, "mud-daemon.pid"), String(process.pid));
      return { pid: process.pid, unref() {} };
    });
    psState.unavailable = true;
    expect(launchDaemonSync(root, dir, "/entry.js", { confirmMs: 500, pollMs: 5 })).toEqual({
      ok: true,
      pid: process.pid,
      confirmed: true,
    });
  });

  it("returns the already-running daemon instead of spawning when a concurrent start won the race", async () => {
    const { root, dir } = fixture();
    fs.writeFileSync(path.join(dir, "mud-daemon.pid"), String(process.pid)); // 另一个 start 已在锁内派生并落盘
    expect(await launchDaemon(root, dir, "/entry.js")).toEqual({
      ok: true,
      pid: process.pid,
      confirmed: true,
      alreadyRunning: true,
    });
    expect(launchDaemonSync(root, dir, "/entry.js")).toEqual({
      ok: true,
      pid: process.pid,
      confirmed: true,
      alreadyRunning: true,
    });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("never reports success for a PID that appears after SIGTERM was sent; waits for exit and clears the stale pid file", () => {
    const { root, dir } = fixture();
    const entry = path.join(root, "daemon-entry.js");
    const pidFile = path.join(dir, "mud-daemon.pid");
    // 收到 SIGTERM 后才写出 PID，然后退出——模拟"刚好在确认超时后落盘"的 daemon
    fs.writeFileSync(
      entry,
      `process.on("SIGTERM", () => { require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => process.exit(0), 50); }); setTimeout(() => {}, 60_000);`,
    );
    const real = childProcess.spawn(process.execPath, [entry], { stdio: "ignore" });
    spawnMock.mockImplementationOnce(() => ({ pid: real.pid, unref() {} }));
    try {
      expect(launchDaemonSync(root, dir, "/entry.js", { confirmMs: 300, pollMs: 5 })).toEqual({
        ok: false,
        reason: DAEMON_UNCONFIRMED_REASON,
      });
      expect(fs.existsSync(pidFile)).toBe(false); // 迟到写出的 PID 文件被清掉，不留死 PID
    } finally {
      try {
        real.kill("SIGKILL");
      } catch {}
    }
  }, 15_000);

  it("kills an unconfirmed child before releasing the lock instead of reporting it as started", () => {
    const { root, dir } = fixture();
    const entry = path.join(root, "daemon-entry.js");
    fs.writeFileSync(entry, "setTimeout(() => {}, 60_000);\n"); // 永远不写 PID 的子进程
    const real = childProcess.spawn(process.execPath, [entry], { stdio: "ignore" });
    spawnMock.mockImplementationOnce(() => ({ pid: real.pid, unref() {} }));
    try {
      expect(launchDaemonSync(root, dir, "/entry.js", { confirmMs: 50, pollMs: 5 })).toEqual({
        ok: false,
        reason: DAEMON_UNCONFIRMED_REASON,
      });
      let gone = false;
      try {
        process.kill(real.pid as number, 0);
      } catch {
        gone = true;
      }
      expect(
        gone ||
          childProcess
            .spawnSync("ps", ["-o", "stat=", "-p", String(real.pid)], { encoding: "utf8" })
            .stdout.trim()
            .startsWith("Z"),
      ).toBe(true);
    } finally {
      try {
        real.kill("SIGKILL");
      } catch {}
    }
    expect(fs.existsSync(path.join(root, ".migration.lock"))).toBe(false);
  });
});
