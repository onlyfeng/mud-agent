/**
 * 通知推送：macOS 本地通知 + Telegram channel 推送。
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { NotifyTarget } from "../lib/notify-target.js";
import {
  loadNotifyTargetFromSessionDir,
  parseStoredNotifyTarget,
  writeNotifyTargetFile,
} from "../lib/notify-target.js";

export function notify(title: string, message: string): void {
  const safe = message.replace(/"/g, '\\"').slice(0, 120);
  const safeTitle = title.replace(/"/g, '\\"');
  if (process.platform === "darwin") {
    execFile("osascript", ["-e", `display notification "${safe}" with title "${safeTitle}"`], (err) => {
      if (err) console.warn(`Notification failed: ${err.message}`);
    });
  }
}

/**
 * 读取 notify-target.json，返回 Telegram 推送目标。
 * 结构不合法（字段缺失 / 类型错 / 空字符串）时走 sessionKey 反推 fallback。
 */
export function loadNotifyTarget(targetFile: string): NotifyTarget | null {
  try {
    const raw = fs.readFileSync(targetFile, "utf8");
    const parsed = parseStoredNotifyTarget(JSON.parse(raw));
    if (parsed) return parsed;
  } catch {}

  const fallback = loadNotifyTargetFromSessionDir(targetFile);
  if (!fallback) return null;
  try {
    writeNotifyTargetFile(path.dirname(targetFile), fallback);
  } catch {}
  return fallback;
}

/**
 * 通过 openclaw message send CLI 发送消息到 Telegram topic。
 * 非阻塞：fire-and-forget，失败只打日志不影响主循环。
 */
export function sendToChannel(targetFile: string, message: string, log?: (msg: string) => void): void {
  const target = loadNotifyTarget(targetFile);
  if (!target) return;

  const args = ["message", "send", "--channel", target.channel, "-t", target.chatId, "-m", message];
  // Telegram General topic 的 thread_id 为 1，Bot API 不接受显式传 1，需省略
  if (target.threadId && target.threadId !== "1") {
    args.push("--thread-id", target.threadId);
  }
  // 静默发送，避免频繁打扰
  args.push("--silent");

  execFile("openclaw", args, (err) => {
    if (err) {
      log?.(`[notify] openclaw message send failed: ${err.message}`);
    }
  });
}
