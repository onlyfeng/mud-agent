import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 派生 mock：像真 autopilot 一样把自己的 PID 写进 autopilot.pid（用本进程 pid，保证"活着"），launcher 据此确认
const { spawnMock, spawnState } = vi.hoisted(() => {
  const spawnState = { dir: "", writePid: true };
  const spawnMock = vi.fn(() => {
    if (spawnState.writePid)
      require("node:fs").writeFileSync(require("node:path").join(spawnState.dir, "autopilot.pid"), String(process.pid));
    return { pid: process.pid, unref() {} };
  });
  return { spawnMock, spawnState };
});
vi.mock("node:child_process", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:child_process")>();
  return { ...real, default: { ...real, spawn: spawnMock }, spawn: spawnMock };
});

import { AUTOPILOT_DAEMON_GONE_REASON, launchAutopilot, respawnAutopilotWhenDaemonReady } from "./autopilot-launcher";
import {
  ensureGameModeGeneration,
  publishExplicitStop,
  readGameModeRecord,
  readStopSignal,
  signalAutopilotStop,
  writeGameMode,
  writeStopSignal,
} from "./control-signal";

const dirs: string[] = [];
function tempDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "mud-launcher-"));
  dirs.push(d);
  return d;
}
function sessionDir(root: string): string {
  const dir = path.join(root, "sessions", "v2_x");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "config.json"), "{}");
  spawnState.dir = dir;
  spawnState.writePid = true;
  return dir;
}

describe("respawnAutopilotWhenDaemonReady", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    spawnMock.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it("keeps polling through an old autopilot that exits after its stop was already claimed, then respawns", async () => {
    const root = tempDir();
    const dir = sessionDir(root);
    writeGameMode(dir, "semi-auto");
    fs.writeFileSync(path.join(dir, "mud-daemon.pid"), String(process.pid));
    fs.writeFileSync(path.join(dir, "autopilot.pid"), String(process.pid)); // 旧 autopilot 还活着，联停信号已被它认领（控制文件不可见）

    respawnAutopilotWhenDaemonReady(root, dir, 15_000, 100);
    await vi.advanceTimersByTimeAsync(100); // 第一次观察：活着、无信号 —— 不能据此认定健康
    await vi.advanceTimersByTimeAsync(100);
    expect(spawnMock).not.toHaveBeenCalled();
    fs.rmSync(path.join(dir, "autopilot.pid")); // 旧进程退出
    await vi.advanceTimersByTimeAsync(100);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("treats an old autopilot as healthy only after several stable live observations", async () => {
    const root = tempDir();
    const dir = sessionDir(root);
    writeGameMode(dir, "full-auto");
    fs.writeFileSync(path.join(dir, "mud-daemon.pid"), String(process.pid));
    fs.writeFileSync(path.join(dir, "autopilot.pid"), String(process.pid));

    respawnAutopilotWhenDaemonReady(root, dir, 15_000, 100);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(spawnMock).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0); // 稳定存活后停止轮询
  });

  it("keeps waiting while a non-force stop that still applies is pending, then respawns once the old process exits", async () => {
    const root = tempDir();
    const dir = sessionDir(root);
    const generation = writeGameMode(dir, "semi-auto");
    fs.writeFileSync(path.join(dir, "mud-daemon.pid"), String(process.pid));
    fs.writeFileSync(path.join(dir, "autopilot.pid"), String(process.pid));
    writeStopSignal(path.join(dir, "autopilot-control.json"), { modeGeneration: generation }); // mud-ctl autopilot stop：无 force 但代际一致，仍会生效

    respawnAutopilotWhenDaemonReady(root, dir, 15_000, 100);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(spawnMock).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1); // 没有被判为健康，仍在轮询
    fs.rmSync(path.join(dir, "autopilot.pid"));
    fs.rmSync(path.join(dir, "autopilot-control.json"));
    await vi.advanceTimersByTimeAsync(100);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("treats a stop superseded by a newer mode generation as harmless and stops polling", async () => {
    const root = tempDir();
    const dir = sessionDir(root);
    writeStopSignal(path.join(dir, "autopilot-control.json"), { modeGeneration: "stale-generation" });
    writeGameMode(dir, "full-auto");
    fs.writeFileSync(path.join(dir, "mud-daemon.pid"), String(process.pid));
    fs.writeFileSync(path.join(dir, "autopilot.pid"), String(process.pid));

    respawnAutopilotWhenDaemonReady(root, dir, 15_000, 100);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(spawnMock).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("waits for the daemon pid before launching", async () => {
    const root = tempDir();
    const dir = sessionDir(root);
    writeGameMode(dir, "semi-auto");

    respawnAutopilotWhenDaemonReady(root, dir, 15_000, 100);
    await vi.advanceTimersByTimeAsync(300);
    expect(spawnMock).not.toHaveBeenCalled();
    fs.writeFileSync(path.join(dir, "mud-daemon.pid"), String(process.pid));
    await vi.advanceTimersByTimeAsync(100);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });
});

describe("launchAutopilot under the maintenance lock", () => {
  afterEach(() => {
    spawnMock.mockClear();
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it("holds the lock until autopilot.pid is on disk, then releases it", () => {
    const root = tempDir();
    const dir = sessionDir(root);
    fs.writeFileSync(path.join(dir, "mud-daemon.pid"), String(process.pid));
    const result = launchAutopilot(root, dir, Date.now(), { confirmMs: 2000, pollMs: 5 });
    expect(result).toEqual({ ok: true, pid: process.pid });
    expect(fs.existsSync(path.join(root, ".migration.lock.v2"))).toBe(false);
    expect(fs.existsSync(path.join(root, ".migration.lock"))).toBe(false);
  });

  it("refuses when the daemon is gone or the directory was migrated away, without spawning", () => {
    const root = tempDir();
    const dir = sessionDir(root);
    expect(launchAutopilot(root, dir, Date.now())).toEqual({ ok: false, reason: AUTOPILOT_DAEMON_GONE_REASON });
    fs.rmSync(dir, { recursive: true });
    expect(launchAutopilot(root, dir, Date.now()).ok).toBe(false);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("kills and reports failure when the child never confirms its pid", () => {
    const root = tempDir();
    const dir = sessionDir(root);
    fs.writeFileSync(path.join(dir, "mud-daemon.pid"), String(process.pid));
    const entry = path.join(root, "autopilot-entry.js");
    fs.writeFileSync(entry, "setTimeout(() => {}, 60_000);\n");
    const childProcess = require("node:child_process") as typeof import("node:child_process");
    const real = childProcess.spawn(process.execPath, [entry], { stdio: "ignore" });
    spawnMock.mockImplementationOnce(() => ({ pid: real.pid, unref() {} }));
    try {
      const result = launchAutopilot(root, dir, Date.now(), { confirmMs: 50, pollMs: 5 });
      expect(result.ok).toBe(false);
      expect(fs.existsSync(path.join(root, ".migration.lock.v2"))).toBe(false);
    } finally {
      try {
        real.kill("SIGKILL");
      } catch {}
    }
  }, 15_000);
});

describe("signalAutopilotStop", () => {
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it("does not signal a pid that is not a verified autopilot process", () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, "autopilot.pid"), String(process.pid)); // 遗留 PID 被无关进程（本测试进程）复用
    expect(signalAutopilotStop(dir)).toBeNull();
    expect(fs.existsSync(path.join(dir, "autopilot-control.json"))).toBe(false);
  });

  it("still publishes the cooperative stop when the identity cannot be verified, but never SIGTERMs", () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, "autopilot.pid"), String(process.pid));
    const ps = vi.spyOn(childProcess, "spawnSync").mockReturnValue({
      error: Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
      status: null,
      stdout: "",
      stderr: "",
    } as never);
    const kill = vi.spyOn(process, "kill");
    vi.useFakeTimers();
    try {
      expect(signalAutopilotStop(dir)).toBe(process.pid);
      expect(readStopSignal(path.join(dir, "autopilot-control.json"))?.force).toBe(true); // 协作 stop 已写
      vi.advanceTimersByTime(1000);
      expect(kill.mock.calls.filter(([, sig]) => sig === "SIGTERM")).toHaveLength(0); // 不发 SIGTERM
    } finally {
      vi.useRealTimers();
      kill.mockRestore();
      ps.mockRestore();
    }
  });
});

describe("explicit stop on a legacy game-mode record", () => {
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it("assigns a generation to a mode-only record so the stop is tagged and can be superseded", () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, "game-mode.json"), JSON.stringify({ mode: "semi-auto" })); // 旧版记录：没有 generation
    const control = path.join(dir, "autopilot-control.json");

    publishExplicitStop(control, dir);

    const record = readGameModeRecord(dir);
    expect(record?.mode).toBe("semi-auto");
    expect(record?.generation).toBeTruthy();
    expect(readStopSignal(control)?.modeGeneration).toBe(record?.generation);
    expect(ensureGameModeGeneration(dir)).toBe(record?.generation); // 已有代际时不再改写
  });

  it("reports failure when the mode generation keeps changing for the whole budget", () => {
    const dir = tempDir();
    writeGameMode(dir, "semi-auto");
    const control = path.join(dir, "autopilot-control.json");
    const realRead = fs.readFileSync;
    // 每次复核时模式都已被并发 set-mode 改写：预算耗尽必须返回 false，而不是把带旧代际的 stop 当成已发送
    const spy = vi.spyOn(fs, "readFileSync").mockImplementation(((p: fs.PathOrFileDescriptor, o?: unknown) => {
      if (String(p).endsWith("game-mode.json")) writeGameMode(dir, "semi-auto");
      return realRead(p, o as never);
    }) as typeof fs.readFileSync);
    try {
      expect(publishExplicitStop(control, dir, 100)).toBe(false);
    } finally {
      spy.mockRestore();
    }
    expect(publishExplicitStop(control, dir, 100)).toBe(true);
  });
});
