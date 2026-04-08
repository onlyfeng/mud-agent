import fs from "node:fs";
import type { MudSessionStore } from "../storage/session-store.js";

/**
 * 解析 sessionKey 对应的数据目录。
 * 兼容长格式 key（如 "agent:main:telegram:...topic:1627"）与
 * 短格式目录名（如 "topic-1627"）之间的不匹配。
 * 结果按 sessionKey 缓存，避免每次工具调用重复 fs.existsSync。
 */
const sessionDirCache = new Map<string, string>();

export function resolveSessionDir(store: MudSessionStore, sessionKey: string): string {
  const cached = sessionDirCache.get(sessionKey);
  if (cached !== undefined) return cached;

  const dir = store.getSessionDataDir(sessionKey);
  if (fs.existsSync(dir)) {
    sessionDirCache.set(sessionKey, dir);
    return dir;
  }
  // 从长格式提取 topic ID: "...topic:1627" → "topic-1627"
  const m = sessionKey.match(/topic[:-](\d+)/);
  if (m) {
    const shortDir = store.getSessionDataDir(`topic-${m[1]}`);
    if (fs.existsSync(shortDir)) {
      sessionDirCache.set(sessionKey, shortDir);
      return shortDir;
    }
  }
  sessionDirCache.set(sessionKey, dir);
  return dir; // 回退到原始路径
}

function sanitizeKey(key: string): string {
  // Remove path separators and parent-directory traversal
  return key.replace(/[/\\]/g, "_").replace(/\.\./g, "_");
}

export function resolveSessionKey(ctx: Record<string, unknown> | null | undefined): string {
  if (!ctx) return "default";

  const evt = (ctx.event as Record<string, unknown> | undefined) ?? ctx;

  const priorityKeys = [
    "topicId",
    "topic_id",
    "messageThreadId",
    "message_thread_id",
    "channelId",
    "channel_id",
    "chatId",
    "chat_id",
  ];

  for (const k of priorityKeys) {
    const val = evt[k] ?? ctx[k];
    if (val !== undefined && val !== null) {
      return sanitizeKey(`topic-${val}`);
    }
  }

  const fallbackKeys = ["from", "senderId", "sender_id", "userId", "user_id"];
  for (const k of fallbackKeys) {
    const val = evt[k] ?? ctx[k];
    if (val !== undefined && val !== null) {
      return sanitizeKey(`user-${val}`);
    }
  }

  return "default";
}
