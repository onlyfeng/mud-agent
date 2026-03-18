import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendOutput, loadJSON, readRecentOutput, writeJSON } from "./file-store";

describe("file-store", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mud-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("loadJSON", () => {
    it("returns fallback for missing file", () => {
      expect(loadJSON(path.join(tmpDir, "missing.json"), { x: 1 })).toEqual({
        x: 1,
      });
    });

    it("reads valid JSON", () => {
      const file = path.join(tmpDir, "data.json");
      fs.writeFileSync(file, '{"key":"value"}');
      expect(loadJSON(file, {})).toEqual({ key: "value" });
    });

    it("returns fallback and backs up corrupted file", () => {
      const file = path.join(tmpDir, "bad.json");
      fs.writeFileSync(file, "{invalid json!!!");
      const result = loadJSON(file, { fallback: true });
      expect(result).toEqual({ fallback: true });
      // Check backup was created
      const files = fs.readdirSync(tmpDir);
      expect(files.some((f) => f.startsWith("bad.json.corrupt."))).toBe(true);
    });
  });

  describe("writeJSON", () => {
    it("writes valid JSON atomically", () => {
      const file = path.join(tmpDir, "out.json");
      writeJSON(file, { hello: "world" });
      expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({
        hello: "world",
      });
    });

    it("no temp files left after write", () => {
      const file = path.join(tmpDir, "out.json");
      writeJSON(file, { a: 1 });
      const files = fs.readdirSync(tmpDir);
      expect(files.filter((f) => f.endsWith(".tmp"))).toEqual([]);
    });
  });

  describe("appendOutput + readRecentOutput", () => {
    it("appends and reads back lines", () => {
      const file = path.join(tmpDir, "output.jsonl");
      appendOutput(file, ["hello", "world"]);
      const result = readRecentOutput(file, 10);
      expect(result.length).toBe(2);
      expect(result[0].text).toBe("hello");
      expect(result[1].text).toBe("world");
    });

    it("returns empty for missing file", () => {
      expect(readRecentOutput(path.join(tmpDir, "nope.jsonl"), 10)).toEqual([]);
    });

    it("trims to MAX_OUTPUT_LINES on overflow", () => {
      const file = path.join(tmpDir, "big.jsonl");
      // Write 510 lines
      for (let i = 0; i < 510; i++) {
        appendOutput(file, [`line-${i}`]);
      }
      const content = fs.readFileSync(file, "utf8").trim().split("\n");
      expect(content.length).toBeLessThanOrEqual(500);
    });
  });

  describe("concurrent access", () => {
    it("writeJSON does not corrupt on rapid writes", () => {
      const file = path.join(tmpDir, "race.json");
      for (let i = 0; i < 50; i++) {
        writeJSON(file, { count: i });
      }
      const result = loadJSON<{ count: number }>(file, { count: -1 });
      expect(result.count).toBe(49);
    });
  });
});
