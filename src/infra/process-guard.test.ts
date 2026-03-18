import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanStalePid, isProcessRunning, readHeartbeat, readPid, removePid, writePid } from "./process-guard";

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
});
