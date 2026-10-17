import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { probeProcessStartTime, processStartTimeMs } from "./dir-lock-contract.mjs";
import { formatPidRecord, inspectSessionPid, readLiveSessionPid, readVerifiedSessionPid } from "./session-process.mjs";

const dirs: string[] = [];
function pidFileWith(pid: number): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "mud-sp-"));
  dirs.push(d);
  const f = path.join(d, "autopilot.pid");
  fs.writeFileSync(f, String(pid));
  return f;
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("session process identity", () => {
  it("a live pid whose command line is not a session entry is treated as reused (null)", () => {
    const f = pidFileWith(process.pid); // vitest 工作进程不是 daemon/autopilot 入口
    expect(inspectSessionPid(f)).toBeNull();
    expect(readLiveSessionPid(f)).toBeNull();
    expect(readVerifiedSessionPid(f)).toBeNull();
  });

  it("an unverifiable live pid (no ps) counts as in use for migration but never as a signal target", () => {
    const f = pidFileWith(process.pid);
    const spy = vi.spyOn(childProcess, "spawnSync").mockReturnValue({
      error: Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
      status: null,
      stdout: "",
      stderr: "",
    } as never);
    try {
      expect(inspectSessionPid(f)).toEqual({ pid: process.pid, verified: false });
      expect(readLiveSessionPid(f)).toBe(process.pid); // 迁移/归档：保守，当作在用
      expect(readVerifiedSessionPid(f)).toBeNull(); // 发 SIGTERM：不可核验就不发
    } finally {
      spy.mockRestore();
    }
  });

  it("binds a pid record to the writing instance: a same-role process with a different start time is a reuse", () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "mud-sp-"));
    dirs.push(d);
    const f = path.join(d, "autopilot.pid");
    // 命令行当作 autopilot 入口来看（本测试进程不是），启动时刻记录成 1 小时前：角色对、实例不对 → null
    fs.writeFileSync(f, formatPidRecord(f, process.pid, Date.now() - 3_600_000));
    const spy = vi.spyOn(childProcess, "spawnSync").mockImplementation(((file: string, args: string[]) => {
      if (args.includes("command="))
        return { status: 0, stdout: "node /x/dist/cli/autopilot-entry.js\n", stderr: "" } as never;
      return childProcess.spawnSync(file, args, { encoding: "utf8" }) as never; // lstart 走真实 ps
    }) as typeof childProcess.spawnSync);
    try {
      if (probeProcessStartTime(process.pid).kind !== "known") return; // 无 ps 的平台无法核对
      expect(inspectSessionPid(f)).toBeNull();
      // 记录的是真实启动时刻 → 就是这个实例
      fs.writeFileSync(f, formatPidRecord(f, process.pid, processStartTimeMs()));
      expect(inspectSessionPid(f)).toEqual({ pid: process.pid, verified: true });
      // 角色不对（daemon 文件里记着 autopilot 命令行的进程）→ null
      const dFile = path.join(d, "mud-daemon.pid");
      fs.writeFileSync(dFile, formatPidRecord(dFile, process.pid, processStartTimeMs()));
      expect(inspectSessionPid(dFile)).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  it("accepts quoted Windows-style command lines", () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "mud-sp-"));
    dirs.push(d);
    const f = path.join(d, "autopilot.pid");
    fs.writeFileSync(f, String(process.pid)); // 旧格式：没有实例身份——按角色入口算存活，但不可核验（不授权 SIGTERM）
    const spy = vi.spyOn(childProcess, "spawnSync").mockReturnValue({
      status: 0,
      stdout:
        '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\Some One\\.mud-agent\\dist\\cli\\autopilot-entry.js"\n',
      stderr: "",
    } as never);
    try {
      expect(inspectSessionPid(f)).toEqual({ pid: process.pid, verified: false });
      expect(readLiveSessionPid(f)).toBe(process.pid);
      expect(readVerifiedSessionPid(f)).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  it("a dead pid is null in every mode", () => {
    const f = pidFileWith(999999);
    expect(inspectSessionPid(f)).toBeNull();
  });
});
