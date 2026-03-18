/**
 * 文件 IO 工具：loadJSON / writeJSON / appendOutput / readRecentOutput
 * 包含原子写入（write-tmp + rename）防止竞态。
 */

import fs from "node:fs";
import path from "node:path";

export function loadJSON<T>(file: string, fallback: T): T {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err: unknown) {
    // ENOENT is expected — file not created yet
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(`[file-store] 读取失败 ${file}: ${(err as Error).message}`);
    }
    return fallback;
  }
  try {
    return JSON.parse(raw);
  } catch {
    console.warn(`[file-store] JSON 解析失败，文件可能损坏: ${file}`);
    // backup corrupted file
    try {
      fs.copyFileSync(file, `${file}.corrupt.${Date.now()}`);
    } catch {}
    return fallback;
  }
}

/**
 * 原子写入 JSON：先写临时文件再 rename，防止读写竞态导致数据损坏。
 */
export function writeJSON(file: string, data: unknown): void {
  const content = JSON.stringify(data, null, 2);
  const tmpFile = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  fs.writeFileSync(tmpFile, content);
  fs.renameSync(tmpFile, file);
}

const MAX_OUTPUT_LINES = 500;

export function appendOutput(outputFile: string, lines: string[]): void {
  if (!lines.length) return;
  const ts = new Date().toISOString();
  const newEntries = lines.map((text) => `${JSON.stringify({ ts, text })}\n`).join("");
  fs.appendFileSync(outputFile, newEntries);

  // 修剪到最新 MAX_OUTPUT_LINES 行（原子写入）
  try {
    const content = fs.readFileSync(outputFile, "utf8");
    const allLines = content.trim().split("\n").filter(Boolean);
    if (allLines.length > MAX_OUTPUT_LINES) {
      const trimmed = `${allLines.slice(-MAX_OUTPUT_LINES).join("\n")}\n`;
      const tmpFile = `${outputFile}.${process.pid}.tmp`;
      fs.writeFileSync(tmpFile, trimmed);
      fs.renameSync(tmpFile, outputFile);
    }
  } catch {}
}

export function readRecentOutput(outputFile: string, n = 50): Array<{ ts: string; text: string }> {
  try {
    const content = fs.readFileSync(outputFile, "utf8");
    return content
      .trim()
      .split("\n")
      .filter(Boolean)
      .slice(-n)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}
