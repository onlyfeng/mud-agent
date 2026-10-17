import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_LOG_MAX_BYTES, Logger } from "./logger";

describe("Logger rotation", () => {
  const dirs = new Set<string>();
  function tempLog(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mud-agent-logger-"));
    dirs.add(dir);
    return path.join(dir, "daemon.log");
  }
  afterEach(() => {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
    dirs.clear();
  });

  it("defaults to a 2 MiB cap", () => {
    expect(DEFAULT_LOG_MAX_BYTES).toBe(2 * 1024 * 1024);
  });

  it("rotates to <file>.1 once the cap is exceeded and keeps only one backup", () => {
    const file = tempLog();
    const logger = new Logger(file, { maxBytes: 400 });
    // 每行约 60 字节；写 30 行必然跨过 400 字节至少三次
    for (let i = 0; i < 30; i++) logger.log("GAME", `line-${i.toString().padStart(2, "0")} ${"x".repeat(20)}`);

    expect(fs.existsSync(file)).toBe(true);
    expect(fs.existsSync(`${file}.1`)).toBe(true);
    expect(fs.existsSync(`${file}.2`)).toBe(false);
    expect(fs.statSync(file).size).toBeLessThanOrEqual(400);
    expect(fs.statSync(`${file}.1`).size).toBeLessThanOrEqual(400);
    const current = fs.readFileSync(file, "utf8").trim().split("\n");
    const backup = fs.readFileSync(`${file}.1`, "utf8").trim().split("\n");
    expect(current.at(-1)).toContain("line-29");
    expect(backup.at(-1) ?? "").toMatch(/line-\d+/);
    expect(backup.at(-1) ?? "").not.toContain("line-29");
  });

  it("counts the existing file size when reopened", () => {
    const file = tempLog();
    fs.writeFileSync(file, "x".repeat(390));
    const logger = new Logger(file, { maxBytes: 400 });
    logger.log("INFO", "after reopen this line must rotate first");
    expect(fs.existsSync(`${file}.1`)).toBe(true);
    expect(fs.readFileSync(`${file}.1`, "utf8")).toBe("x".repeat(390));
    expect(fs.readFileSync(file, "utf8")).toContain("[INFO] after reopen");
  });

  it("trims an oversized pre-existing log to the cap on first rotation instead of keeping it whole", () => {
    const file = tempLog();
    const lines = Array.from({ length: 200 }, (_, i) => `old-${i.toString().padStart(3, "0")} ${"y".repeat(30)}`);
    fs.writeFileSync(file, `${lines.join("\n")}\n`); // ~8 KB, far above the 400-byte cap
    const logger = new Logger(file, { maxBytes: 400 });
    logger.log("INFO", "first line after upgrade");
    expect(fs.statSync(`${file}.1`).size).toBeLessThanOrEqual(400);
    const backup = fs.readFileSync(`${file}.1`, "utf8");
    expect(backup.startsWith("old-")).toBe(true); // 切在行边界
    expect(backup.trim().split("\n").at(-1)).toContain("old-199");
    expect(fs.readFileSync(file, "utf8")).toContain("[INFO] first line after upgrade");
  });
  it("truncates the current file when rotation fails instead of growing it past the cap", () => {
    const file = tempLog();
    fs.mkdirSync(`${file}.1`); // 备份路径被目录占住：rename 必然失败
    const logger = new Logger(file, { maxBytes: 400 });
    for (let i = 0; i < 40; i++) logger.log("GAME", `line-${i.toString().padStart(2, "0")} ${"x".repeat(20)}`);
    expect(fs.statSync(file).size).toBeLessThanOrEqual(400); // 轮转失败也不放任当前文件超限
    expect(fs.readFileSync(file, "utf8")).toContain("line-39");
  });
  it("bounds a single oversized entry so the file never exceeds the cap", () => {
    const file = tempLog();
    const logger = new Logger(file, { maxBytes: 400 });
    logger.log("GAME", "x".repeat(5000)); // 单条就超过上限：空日志不会触发轮转，必须先截断
    expect(fs.statSync(file).size).toBeLessThanOrEqual(400);
    expect(fs.readFileSync(file, "utf8")).toContain("[truncated]");
    logger.log("GAME", "y".repeat(5000)); // 非空日志：轮转后追加的也是截断过的
    expect(fs.statSync(file).size).toBeLessThanOrEqual(400);
  });
  it("accounts for bytes written to the file by someone else (redirected stderr) when enforcing the cap", () => {
    const file = tempLog();
    const logger = new Logger(file, { maxBytes: 400 });
    logger.log("GAME", "first");
    fs.appendFileSync(file, "x".repeat(390)); // 像 console.warn 经 spawn 重定向写进来的内容
    logger.log("GAME", "second");
    expect(fs.statSync(file).size).toBeLessThanOrEqual(400);
    expect(fs.readFileSync(file, "utf8")).toContain("second");
    expect(fs.existsSync(`${file}.1`)).toBe(true);
  });
  it("keeps a pre-rotation O_APPEND descriptor (spawn-redirected stderr) writing into the live file after rotation", () => {
    const file = tempLog();
    const logger = new Logger(file, { maxBytes: 400 });
    const fd = fs.openSync(file, "a"); // 像 spawnDetached 那样在轮转前打开
    try {
      for (let i = 0; i < 30; i++) logger.log("GAME", `line-${i} ${"x".repeat(20)}`); // 触发至少一次轮转
      fs.writeSync(fd, "redirected-after-rotation\n");
      expect(fs.readFileSync(file, "utf8")).toContain("redirected-after-rotation"); // 落在当前文件，而不是 .1 / 已删 inode
      expect(fs.existsSync(`${file}.1`)).toBe(true);
      logger.log("GAME", "after");
      expect(fs.statSync(file).size).toBeLessThanOrEqual(400);
    } finally {
      fs.closeSync(fd);
    }
  });
});
