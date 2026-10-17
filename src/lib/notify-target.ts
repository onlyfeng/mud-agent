import fs from "node:fs";
import path from "node:path";
import type { OpenClawCommandContext } from "../core/types.js";
import { decodeSessionDirName, isEncodedSessionDirNameCandidate } from "./session-dir-name.js";

export interface NotifyTarget {
  channel: string;
  chatId: string;
  threadId?: string;
}

/**
 * 对从磁盘 / 外部来源拿到的未知 JSON 做结构校验，确保它符合 NotifyTarget 形状。
 * 不做类型 coercion：写盘侧（writeNotifyTargetFile）本就只会写入 string，
 * 如果读到 number / bool / null 等奇怪类型，一定是人手改坏了，直接拒绝更安全——
 * 下游 `execFile("openclaw", args)` 里 args 必须是纯 string[]，传非 string
 * 会在运行时 TypeError。
 */
export function parseStoredNotifyTarget(raw: unknown): NotifyTarget | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;

  const channel = obj.channel;
  const chatId = obj.chatId;
  if (typeof channel !== "string" || !channel.trim()) return null;
  if (typeof chatId !== "string" || !chatId.trim()) return null;

  const threadId = obj.threadId;
  if (threadId !== undefined && (typeof threadId !== "string" || !threadId.trim())) return null;

  return {
    channel,
    chatId,
    ...(threadId !== undefined ? { threadId: threadId as string } : {}),
  };
}

export function parseNotifyTargetFromSessionKey(sessionKey: string): NotifyTarget | null {
  const match = sessionKey.match(/(?:^|:)telegram:(group|direct):(-?\d+)(?::topic:(\d+))?/);
  if (!match) return null;

  const [, , chatId, threadId] = match;
  return {
    channel: "telegram",
    chatId,
    ...(threadId ? { threadId } : {}),
  };
}

export function extractNotifyTargetFromCommandContext(ctx: OpenClawCommandContext): NotifyTarget | null {
  const channel = (ctx.channel || "").toString();
  if (!channel.includes("telegram")) return null;

  const sessionKey = (ctx as Record<string, unknown>).sessionKey as string | undefined;
  if (sessionKey) {
    const target = parseNotifyTargetFromSessionKey(sessionKey);
    if (target) return target;
  }

  const chatId = (ctx.chatId as string | undefined) ?? (ctx.chat_id as string | undefined);
  if (!chatId) return null;

  const threadId =
    (ctx.messageThreadId as string | number | undefined) ??
    (ctx.topicId as string | number | undefined) ??
    (ctx.topic_id as string | number | undefined);

  return {
    channel: "telegram",
    chatId: String(chatId),
    ...(threadId != null ? { threadId: String(threadId) } : {}),
  };
}

export function writeNotifyTargetFile(dir: string, target: NotifyTarget): void {
  fs.writeFileSync(path.join(dir, "notify-target.json"), JSON.stringify(target, null, 2));
}

export function saveNotifyTargetFromCommandContext(dir: string, ctx: OpenClawCommandContext): boolean {
  const target = extractNotifyTargetFromCommandContext(ctx);
  if (!target) return false;
  writeNotifyTargetFile(dir, target);
  return true;
}

export function ensureNotifyTargetFromSessionKey(dir: string, sessionKey: string): boolean {
  const target = parseNotifyTargetFromSessionKey(sessionKey);
  if (!target) return false;
  writeNotifyTargetFile(dir, target);
  return true;
}

export function loadNotifyTargetFromSessionDir(targetFile: string): NotifyTarget | null {
  const basename = path.basename(path.dirname(targetFile));
  const sessionKey = decodeSessionDirName(basename);
  if (isEncodedSessionDirNameCandidate(basename) && sessionKey === null) return null;
  return parseNotifyTargetFromSessionKey(sessionKey ?? basename);
}
