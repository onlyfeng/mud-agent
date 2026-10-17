import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  claimStopSignal,
  publishExplicitStop,
  readStopSignal,
  writeGameMode,
  writeStopSignal,
} from "../../infra/control-signal";
import { readPid } from "../../infra/process-guard";
import { acquireDirLockSync, LockTimeoutError } from "../../lib/dir-lock-contract.mjs";
import {
  clearStaleStopSignal,
  createStrategy,
  resolveChoiceText,
  resolveDisconnectTickLimit,
  resolveStopSignal,
  selectLiveConfig,
  sendCommand,
  shouldSwitchStrategy,
  waitForLogin,
  waitForLoginWhileDaemonAlive,
} from "./autopilot.service";
import { ExplorationStrategy } from "./exploration.strategy";
import { GrindingStrategy } from "./grinding.strategy";

// DISCONNECT_TICK_MS 当前是 5000，150s ≈ 30 tick。测试绑定这层折算关系。
// 如果未来把 tick 长度调成别的值，这份测试也会提醒一并复核。

describe("selectLiveConfig / shouldSwitchStrategy", () => {
  it("uses the file when it matches the mode generation (or has none) and the record snapshot when a set-mode is in flight", () => {
    const record = { generation: "g2", autopilotConfig: { style: "exploration", pauseOn: ["boss"], generation: "g2" } };
    expect(selectLiveConfig(null, record)).toEqual(record.autopilotConfig); // 文件缺失 → 快照
    expect(selectLiveConfig({ style: "grinding", generation: "g2" }, record).style).toBe("grinding"); // 同代 → 文件（热改生效）
    expect(selectLiveConfig({ style: "grinding" }, record).style).toBe("grinding"); // 无 generation（旧格式）→ 文件
    expect(selectLiveConfig({ style: "grinding", generation: "g3" }, record).style).toBe("exploration"); // 不同代 → 记录快照
    expect(selectLiveConfig({ style: "grinding" }, null).style).toBe("grinding");
  });

  it("defers a strategy switch while a freshly resolved decision is being handed to the old strategy", () => {
    expect(shouldSwitchStrategy("grinding", "exploration", null)).toBe(true);
    expect(shouldSwitchStrategy("grinding", "exploration", { choice: "继续探索" })).toBe(false);
    expect(shouldSwitchStrategy("exploration", "exploration", null)).toBe(false);
    expect(shouldSwitchStrategy(undefined, "exploration", null)).toBe(false);
  });
});

describe("sendCommand", () => {
  it("waits for a busy queue lock instead of dropping the command, and fails loudly on a persistent stall", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mud-ap-send-"));
    const queueFile = path.join(dir, "send-queue.json");
    const lockDir = `${queueFile}.lock`;
    const contract = path.resolve(__dirname, "../../lib/dir-lock-contract.mjs");
    // 另一个进程持锁 150 ms 后释放（同步等锁会阻塞本进程的事件循环，所以持锁者必须是别的进程）
    const holder = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { acquireDirLockSync, sleepSync } from ${JSON.stringify(pathToFileURL(contract).href)}; const release = acquireDirLockSync(${JSON.stringify(lockDir)}, { atomic: true, timeoutMs: 1000, pollMs: 5 }); sleepSync(150); release();`,
      ],
      { stdio: "ignore" },
    );
    try {
      for (let i = 0; i < 200 && !fs.existsSync(lockDir); i++)
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      expect(fs.existsSync(lockDir)).toBe(true);
      const started = Date.now();
      sendCommand(queueFile, "get all", () => {}, { lockTimeoutMs: 5000 }); // 等到锁释放，命令不丢
      expect(Date.now() - started).toBeGreaterThanOrEqual(50);
      expect(JSON.parse(fs.readFileSync(queueFile, "utf8")).items.map((i: { cmd: string }) => i.cmd)).toEqual([
        "get all",
      ]);
    } finally {
      holder.kill("SIGKILL");
    }
    // 持续卡死：超过等待上限抛 LockTimeoutError（致命，进程带原因退出）
    const hold = acquireDirLockSync(lockDir, { atomic: true, timeoutMs: 1000, pollMs: 5 });
    try {
      expect(() => sendCommand(queueFile, "look", () => {}, { lockTimeoutMs: 60 })).toThrow(LockTimeoutError);
    } finally {
      hold();
    }
    // 等锁期间用户发了 stop：拿到锁后不再写入
    sendCommand(queueFile, "east", () => {}, { lockTimeoutMs: 60, unless: () => true });
    expect(JSON.parse(fs.readFileSync(queueFile, "utf8")).items.map((i: { cmd: string }) => i.cmd)).toEqual([
      "get all",
    ]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("createStrategy", () => {
  it("maps the persisted style to the strategy class (hot-switched by the loop when the style changes)", () => {
    expect(createStrategy("grinding")).toBeInstanceOf(GrindingStrategy);
    expect(createStrategy("exploration")).toBeInstanceOf(ExplorationStrategy);
    expect(createStrategy("anything-else")).toBeInstanceOf(ExplorationStrategy);
  });
});

describe("resolveChoiceText", () => {
  it("maps a numeric choice to the decision's option text and keeps free text as is", () => {
    const options = ["继续探索", "停下查看", "返回"];
    expect(resolveChoiceText("1", options)).toBe("继续探索");
    expect(resolveChoiceText(" 3 ", options)).toBe("返回");
    expect(resolveChoiceText("9", options)).toBe("9"); // 越界：按原文
    expect(resolveChoiceText("继续", options)).toBe("继续");
    expect(resolveChoiceText(null, options)).toBeNull();
  });
});

describe("resolveDisconnectTickLimit", () => {
  it("undefined 走默认 150s → 30 tick", () => {
    expect(resolveDisconnectTickLimit(undefined)).toBe(30);
  });

  it("非数字（NaN / Infinity）走默认 150s → 30 tick", () => {
    expect(resolveDisconnectTickLimit(Number.NaN)).toBe(30);
    expect(resolveDisconnectTickLimit(Number.POSITIVE_INFINITY)).toBe(30);
  });

  it("正常值按 5s/tick 折算 + 向上取整", () => {
    expect(resolveDisconnectTickLimit(5)).toBe(1);
    expect(resolveDisconnectTickLimit(10)).toBe(2);
    expect(resolveDisconnectTickLimit(7)).toBe(2); // ceil(7/5)
    expect(resolveDisconnectTickLimit(150)).toBe(30);
    expect(resolveDisconnectTickLimit(600)).toBe(120);
  });

  it("0 或负数立刻退出（1 tick）", () => {
    expect(resolveDisconnectTickLimit(0)).toBe(1);
    expect(resolveDisconnectTickLimit(-1)).toBe(1);
    expect(resolveDisconnectTickLimit(-9999)).toBe(1);
  });

  it("超过 3600s 硬上限 → 720 tick", () => {
    expect(resolveDisconnectTickLimit(3600)).toBe(720);
    expect(resolveDisconnectTickLimit(3601)).toBe(720);
    expect(resolveDisconnectTickLimit(86400)).toBe(720);
  });

  it("很小的正数也至少 1 tick（不会因取整变 0）", () => {
    expect(resolveDisconnectTickLimit(0.5)).toBe(1);
    expect(resolveDisconnectTickLimit(1)).toBe(1);
  });
});

describe("startup guards", () => {
  let tmpDir: string;
  const logs: string[] = [];
  const log = (m: string) => {
    logs.push(m);
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mud-autopilot-test-"));
    logs.length = 0;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("waitForLogin resolves ok once state.json reports connected + loginDone", async () => {
    const state = path.join(tmpDir, "state.json");
    const pid = path.join(tmpDir, "mud-daemon.pid");
    const autopilotControl = path.join(tmpDir, "autopilot-control.json");
    fs.writeFileSync(pid, String(process.pid));
    fs.writeFileSync(state, JSON.stringify({ connected: true, loginDone: false }));
    const pending = waitForLogin({ state, pid, autopilotControl }, 5000, log, 10);
    fs.writeFileSync(state, JSON.stringify({ connected: true, loginDone: true }));
    await expect(pending).resolves.toBe("ok");
  });

  it("waitForLoginWhileDaemonAlive keeps waiting past a slice while the daemon is alive, then resolves ok on login", async () => {
    const state = path.join(tmpDir, "state.json");
    const pid = path.join(tmpDir, "mud-daemon.pid");
    const autopilotControl = path.join(tmpDir, "autopilot-control.json");
    fs.writeFileSync(pid, String(process.pid)); // daemon 活着
    fs.writeFileSync(state, JSON.stringify({ connected: true, loginDone: false }));
    const log = vi.fn();
    const pending = waitForLoginWhileDaemonAlive({ state, pid, autopilotControl }, log, {
      capMs: 2000,
      sliceMs: 30,
      pollMs: 5,
    });
    await new Promise((r) => setTimeout(r, 120)); // 已经过了好几个 slice
    fs.writeFileSync(state, JSON.stringify({ connected: true, loginDone: true }));
    await expect(pending).resolves.toBe("ok");
    expect(log).toHaveBeenCalledWith("daemon 仍在重连 / 登录中，继续等待…");
    // daemon 不在：立刻放弃
    fs.rmSync(pid);
    fs.writeFileSync(state, JSON.stringify({ connected: false, loginDone: false }));
    await expect(
      waitForLoginWhileDaemonAlive({ state, pid, autopilotControl }, log, { capMs: 2000, sliceMs: 30, pollMs: 5 }),
    ).resolves.toBe("daemon-gone");
  });

  it("waitForLogin reports timeout when the deadline passes without login", async () => {
    const state = path.join(tmpDir, "state.json");
    const pid = path.join(tmpDir, "mud-daemon.pid");
    const autopilotControl = path.join(tmpDir, "autopilot-control.json");
    fs.writeFileSync(pid, String(process.pid));
    fs.writeFileSync(state, JSON.stringify({ connected: true, loginDone: false }));
    await expect(waitForLogin({ state, pid, autopilotControl }, 30, log, 5)).resolves.toBe("timeout");
  });

  it("waitForLogin reports daemon-gone as soon as the daemon is gone", async () => {
    const state = path.join(tmpDir, "state.json");
    const pid = path.join(tmpDir, "mud-daemon.pid");
    const autopilotControl = path.join(tmpDir, "autopilot-control.json");
    fs.writeFileSync(pid, "999999");
    fs.writeFileSync(state, JSON.stringify({ connected: false, loginDone: false }));
    await expect(waitForLogin({ state, pid, autopilotControl }, 5000, log, 5)).resolves.toBe("daemon-gone");
    expect(logs.some((l) => l.includes("daemon 已退出"))).toBe(true);
  });

  it("waitForLogin honours a stop request issued while waiting (user switched back to companion)", async () => {
    const state = path.join(tmpDir, "state.json");
    const pid = path.join(tmpDir, "mud-daemon.pid");
    const autopilotControl = path.join(tmpDir, "autopilot-control.json");
    fs.writeFileSync(pid, String(process.pid));
    fs.writeFileSync(state, JSON.stringify({ connected: true, loginDone: false }));
    const pending = waitForLogin({ state, pid, autopilotControl }, 5000, log, 10);
    fs.writeFileSync(autopilotControl, JSON.stringify({ action: "stop" }));
    await expect(pending).resolves.toBe("stopped");
  });

  it("clearStaleStopSignal removes a leftover stop marker and leaves other actions alone", () => {
    const control = path.join(tmpDir, "autopilot-control.json");
    fs.writeFileSync(control, JSON.stringify({ action: "stop" }));
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(control, old, old);
    expect(clearStaleStopSignal(control, log)).toBe(true);
    expect(fs.existsSync(control)).toBe(false);
    expect(fs.readdirSync(tmpDir).filter((f) => f.includes(".stale-"))).toEqual([]);

    fs.writeFileSync(control, JSON.stringify({ action: "pause" }));
    expect(clearStaleStopSignal(control, log)).toBe(false);
    expect(fs.existsSync(control)).toBe(true);
    expect(clearStaleStopSignal(path.join(tmpDir, "missing.json"), log)).toBe(false);
  });

  it("clearStaleStopSignal keeps a stop written after this process started (派生后立即切回陪伴模式)", () => {
    const control = path.join(tmpDir, "autopilot-control.json");
    fs.writeFileSync(control, JSON.stringify({ action: "stop", modeGeneration: "g1" }));
    expect(clearStaleStopSignal(control, log)).toBe(false);
    // 认领后放回：内容不变，没有残留的认领文件
    expect(JSON.parse(fs.readFileSync(control, "utf8"))).toEqual({ action: "stop", modeGeneration: "g1" });
    expect(fs.readdirSync(tmpDir).filter((f) => f.includes(".stale-"))).toEqual([]);
  });

  it("clearStaleStopSignal uses the spawner's launch timestamp as the boundary when provided", () => {
    const control = path.join(tmpDir, "autopilot-control.json");
    const original = process.env.MUD_AUTOPILOT_LAUNCH_TS;
    try {
      // 派生方在 PID 检查前记下的时刻：比它早的标记是遗留物，比它晚的（并发 set-mode companion）要保留
      const launchTs = Date.now() - 5_000;
      process.env.MUD_AUTOPILOT_LAUNCH_TS = String(launchTs);
      fs.writeFileSync(control, JSON.stringify({ action: "stop" }));
      expect(clearStaleStopSignal(control, log)).toBe(false);
      expect(fs.existsSync(control)).toBe(true);

      const old = new Date(launchTs - 10_000);
      fs.utimesSync(control, old, old);
      expect(clearStaleStopSignal(control, log)).toBe(true);
      expect(fs.existsSync(control)).toBe(false);
    } finally {
      if (original === undefined) delete process.env.MUD_AUTOPILOT_LAUNCH_TS;
      else process.env.MUD_AUTOPILOT_LAUNCH_TS = original;
    }
  });

  const stopPaths = () => ({
    root: tmpDir,
    autopilotPid: path.join(tmpDir, "autopilot.pid"),
    autopilotControl: path.join(tmpDir, "autopilot-control.json"),
  });

  it("resolveStopSignal exits when the mode is still companion and releases pid + control", () => {
    const p = stopPaths();
    const generation = writeGameMode(tmpDir, "companion");
    fs.writeFileSync(p.autopilotPid, String(process.pid));
    writeStopSignal(p.autopilotControl, { modeGeneration: generation });
    expect(resolveStopSignal(p, log)).toBe("exit");
    expect(fs.existsSync(p.autopilotPid)).toBe(false);
    expect(fs.existsSync(p.autopilotControl)).toBe(false);
  });

  it("resolveStopSignal exits when no mode file exists", () => {
    const p = stopPaths();
    fs.writeFileSync(p.autopilotPid, String(process.pid));
    writeStopSignal(p.autopilotControl, { modeGeneration: "gen-companion" });
    expect(resolveStopSignal(p, log)).toBe("exit");
  });

  it("resolveStopSignal continues (re-acquiring the lock) when a later set-mode switched back to auto", () => {
    const p = stopPaths();
    const companionGeneration = writeGameMode(tmpDir, "companion");
    writeStopSignal(p.autopilotControl, { modeGeneration: companionGeneration });
    writeGameMode(tmpDir, "semi-auto"); // 并发的 set-mode semi-auto 在 stop 之后写入新代际
    fs.writeFileSync(p.autopilotPid, String(process.pid));
    expect(resolveStopSignal(p, log)).toBe("continue");
    expect(readPid(p.autopilotPid)).toBe(process.pid);
    expect(fs.existsSync(p.autopilotControl)).toBe(false);
  });

  it("resolveStopSignal exits when the auto mode record still carries the stop's own generation", () => {
    const p = stopPaths();
    fs.writeFileSync(path.join(tmpDir, "game-mode.json"), JSON.stringify({ mode: "semi-auto", generation: "same" }));
    fs.writeFileSync(p.autopilotPid, String(process.pid));
    writeStopSignal(p.autopilotControl, { modeGeneration: "same" });
    expect(resolveStopSignal(p, log)).toBe("exit");
  });

  it("resolveStopSignal exits on an explicit stop that carries no mode generation even while the mode is auto (旧格式 / 无模式文件时发出)", () => {
    const p = stopPaths();
    writeGameMode(tmpDir, "semi-auto");
    fs.writeFileSync(p.autopilotPid, String(process.pid));
    writeStopSignal(p.autopilotControl);
    expect(resolveStopSignal(p, log)).toBe("exit");
    expect(fs.existsSync(p.autopilotPid)).toBe(false);
  });

  it("resolveStopSignal exits when an explicit stop saw the current auto-mode generation (stop 是最新意图，与时间戳无关)", () => {
    const p = stopPaths();
    const current = writeGameMode(tmpDir, "semi-auto");
    fs.writeFileSync(p.autopilotPid, String(process.pid));
    // mud-ctl autopilot stop 记下它看到的代际；即使同一毫秒写入也不会被误判为被取代
    writeStopSignal(p.autopilotControl, { modeGeneration: current });
    expect(resolveStopSignal(p, log)).toBe("exit");
  });

  it("resolveStopSignal continues when the mode was switched back to auto after an explicit stop was issued (set-mode 见旧 PID 未派生)", () => {
    const p = stopPaths();
    const seen = writeGameMode(tmpDir, "semi-auto");
    fs.writeFileSync(p.autopilotPid, String(process.pid));
    writeStopSignal(p.autopilotControl, { modeGeneration: seen });
    writeGameMode(tmpDir, "full-auto"); // 更晚的自动模式请求改写了代际
    expect(resolveStopSignal(p, log)).toBe("continue");
    expect(readPid(p.autopilotPid)).toBe(process.pid);
  });

  it("resolveStopSignal always exits on a forced stop (整体下线带 SIGTERM 后手) even if a newer auto-mode request exists", () => {
    const p = stopPaths();
    fs.writeFileSync(p.autopilotPid, String(process.pid));
    writeStopSignal(p.autopilotControl, { force: true, issuedAt: Date.now() - 5_000 });
    writeGameMode(tmpDir, "full-auto");
    expect(resolveStopSignal(p, log)).toBe("exit");
    expect(fs.existsSync(p.autopilotPid)).toBe(false);
  });

  it("writeStopSignal / writeGameMode leave no temp files behind (atomic rename)", () => {
    const p = stopPaths();
    writeStopSignal(p.autopilotControl);
    writeGameMode(tmpDir, "companion");
    expect(fs.readdirSync(tmpDir).filter((f) => f.includes(".tmp-"))).toEqual([]);
    expect(JSON.parse(fs.readFileSync(p.autopilotControl, "utf8")).action).toBe("stop");
  });

  it("claimStopSignal consumes exactly the claimed stop and restores a non-stop control file", () => {
    const control = path.join(tmpDir, "autopilot-control.json");
    writeStopSignal(control, { modeGeneration: "g1" });
    expect(claimStopSignal(control)).toEqual({ modeGeneration: "g1", issuedAt: expect.any(Number) });
    expect(fs.existsSync(control)).toBe(false);
    expect(claimStopSignal(control)).toBeNull();

    fs.writeFileSync(control, JSON.stringify({ action: "pause" }));
    expect(claimStopSignal(control)).toBeNull();
    expect(JSON.parse(fs.readFileSync(control, "utf8"))).toEqual({ action: "pause" });
    expect(fs.readdirSync(tmpDir).filter((f) => f.includes(".claim-"))).toEqual([]);
  });
  it("publishExplicitStop re-tags the stop when a concurrent set-mode changed the generation between read and publish", () => {
    const p = stopPaths();
    writeGameMode(tmpDir, "semi-auto");
    const realWrite = fs.writeFileSync;
    let intercepted = false;
    // 第一次发布 stop 时（写临时文件），并发的 set-mode 改写了模式代际
    const spy = vi.spyOn(fs, "writeFileSync").mockImplementation((file, data, opts) => {
      realWrite(file, data as string, opts as fs.WriteFileOptions);
      if (!intercepted && String(file).includes("autopilot-control.json")) {
        intercepted = true;
        writeGameMode(tmpDir, "full-auto");
      }
    });
    try {
      publishExplicitStop(p.autopilotControl, tmpDir);
    } finally {
      spy.mockRestore();
    }
    const current = JSON.parse(fs.readFileSync(path.join(tmpDir, "game-mode.json"), "utf8")).generation;
    expect(readStopSignal(p.autopilotControl)?.modeGeneration).toBe(current); // stop 带的是落盘后观察到的代际
    fs.writeFileSync(p.autopilotPid, String(process.pid));
    expect(resolveStopSignal(p, log)).toBe("exit"); // 因而是最新意图，退出
  });
});
