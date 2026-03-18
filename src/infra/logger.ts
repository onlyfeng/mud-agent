/**
 * 统一日志：写文件 + stdout。
 */

import fs from "node:fs";

export type LogLevel = "INFO" | "WARN" | "ERROR" | "SEND" | "LOGIN" | "TRIGGER";

export class Logger {
  private stream: fs.WriteStream | null = null;

  constructor(logFile?: string) {
    if (logFile) {
      this.stream = fs.createWriteStream(logFile, { flags: "a" });
    }
  }

  log(level: LogLevel, msg: string): void {
    const line = `[${new Date().toISOString()}] [${level}] ${msg}`;
    if (this.stream) {
      // 有文件 stream 时只写文件（避免 stdout 被 spawn 重定向后双写）
      this.stream.write(`${line}\n`);
    } else {
      console.log(line);
    }
  }

  close(): void {
    try {
      this.stream?.end();
    } catch {}
  }
}
