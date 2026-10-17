/**
 * 统一日志：写文件 + stdout。
 *
 * 文件模式带大小上限：超过 maxBytes 时把当前文件轮转为 <log>.1（只保留一份），
 * 单个会话的日志占用恒定不超过约 2 x maxBytes。真实会话曾在 11 小时内写出 112MB，
 * 原因是游戏原文无过滤地回显；回显现在走 GAME 级别并由调用方先过噪音过滤。
 */

import fs from "node:fs";

export type LogLevel = "INFO" | "WARN" | "ERROR" | "SEND" | "LOGIN" | "TRIGGER" | "GAME";

export interface LoggerOptions {
  /** 轮转阈值（字节），默认 2 MiB。 */
  maxBytes?: number;
}

export const DEFAULT_LOG_MAX_BYTES = 2 * 1024 * 1024;

export class Logger {
  private readonly file: string | null;
  private readonly maxBytes: number;
  private bytes = 0;

  constructor(logFile?: string, opts: LoggerOptions = {}) {
    this.file = logFile ?? null;
    this.maxBytes = opts.maxBytes ?? DEFAULT_LOG_MAX_BYTES;
    if (this.file) {
      try {
        this.bytes = fs.statSync(this.file).size;
      } catch {
        this.bytes = 0;
      }
    }
  }

  log(level: LogLevel, msg: string): void {
    const rawLine = `[${new Date().toISOString()}] [${level}] ${msg}\n`;
    if (!this.file) {
      // 无文件时写 stdout（有文件时只写文件，避免 stdout 被 spawn 重定向后双写）
      process.stdout.write(rawLine);
      return;
    }
    // 单条超过上限的记录（超长服务器行、巨型错误）先截断到上限以内，否则轮转也守不住 maxBytes
    const line = this.boundLine(rawLine);
    const size = Buffer.byteLength(line);
    // 派生时 stdout/stderr 被重定向到同一文件，console.warn 等不经本类的写入也会让它变大：按真实大小判断上限
    try {
      this.bytes = fs.statSync(this.file).size;
    } catch {
      this.bytes = 0;
    }
    if (this.bytes > 0 && this.bytes + size > this.maxBytes && !this.rotate()) {
      // 轮转失败（备份路径不可覆盖等）：截断当前文件保住上限；截断也失败就丢弃本条，不能让超限文件继续涨
      try {
        fs.truncateSync(this.file, 0);
        this.bytes = 0;
      } catch {
        return;
      }
    }
    try {
      fs.appendFileSync(this.file, line);
      this.bytes += size;
    } catch {
      // 日志不可写不应影响守护进程本身
    }
  }

  private boundLine(line: string): string {
    const marker = "…[truncated]\n";
    const limit = Math.max(this.maxBytes - Buffer.byteLength(marker), 0);
    if (Buffer.byteLength(line) <= this.maxBytes) return line;
    return Buffer.from(line).subarray(0, limit).toString() + marker;
  }

  private rotate(): boolean {
    if (!this.file) return true;
    const backup = `${this.file}.1`;
    let rotated = false;
    try {
      // 升级前的日志可能已远超阈值（实测 112 MB）：备份只留最后 maxBytes，否则“总量约 2×maxBytes”的上限在首次轮转后不成立。
      const size = fs.statSync(this.file).size;
      if (size > this.maxBytes) {
        const fd = fs.openSync(this.file, "r");
        try {
          const tail = Buffer.alloc(this.maxBytes);
          const read = fs.readSync(fd, tail, 0, this.maxBytes, size - this.maxBytes);
          const firstNewline = tail.indexOf(0x0a);
          const start = firstNewline >= 0 && firstNewline + 1 < read ? firstNewline + 1 : 0;
          fs.writeFileSync(backup, tail.subarray(start, read));
        } finally {
          fs.closeSync(fd);
        }
      } else {
        fs.copyFileSync(this.file, backup);
      }
      // 截断而不是 rename：daemon 的 stdout/stderr 被 spawn 重定向到这个文件的 fd（O_APPEND），rename 后它们会继续写进
      // 旧 inode（备份或已删除文件）而逃出轮转统计；截断让同一 inode 继续承接所有写入。复制与截断之间写入的少量字节会丢失。
      fs.truncateSync(this.file, 0);
      rotated = true;
    } catch (err) {
      // 文件已不存在时可以从头计数；其他失败（备份路径不可覆盖等）保留计数器，下次写入再试，不让超限文件被当成空文件继续涨。
      rotated = (err as NodeJS.ErrnoException)?.code === "ENOENT";
    }
    if (rotated) this.bytes = 0;
    return rotated;
  }

  close(): void {
    // appendFileSync 无需收尾；保留方法以兼容调用方
  }
}
