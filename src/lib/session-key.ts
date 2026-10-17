import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { MudSessionStore } from "../storage/session-store.js";
import { encodeLegacySessionDirName, encodeSessionDirName, normalizeSessionRoutingKey } from "./session-dir-name.js";
import { listLiveSessionProcesses } from "./session-process.mjs";

// An encoded-branch resolution (see resolveSessionDir) is terminal and never
// needs revalidating. A fallback-branch guess is only valid as long as BOTH
// registry.json's own raw content AND the sessions/ directory listing still
// match what they were when the guess was cached -- registryContent is a
// real string | null, not overloaded with a sentinel, since the file can
// legitimately not exist yet (no registry write has ever happened).
type CachedResolution =
  | { kind: "encoded"; dir: string }
  // 推迟迁移的 v1 目录：只在它里面还有活进程时才继续沿用；进程一退出就要重新解析，让 prepareSessionStorage() 把它迁走
  | { kind: "deferred-v1"; dir: string }
  | { kind: "fallback"; dir: string; registryContent: string | null; sessionsDirSnapshot: string };

const sessionDirCache = new Map<string, CachedResolution>();

// Deliberately the registry's own content, not a separate coordination file
// (an earlier design tried a dedicated version-token sidecar file): whoever
// wrote registry.json -- any process, any version of this code, past or
// future -- did it via the same JSON.stringify(reg, null, 2) shape (that
// hasn't changed across any of these revisions, and isn't part of what's
// being fixed here), so a reader here always detects that write as a real
// content change with no protocol version to agree on. That's a one-way
// guarantee, not a mutual one: it says this reader notices any writer, not
// that a reader running some *other*, earlier design (one that checked a
// separate sidecar file instead of this content, as an earlier revision of
// this exact mechanism did) would notice a write made under this one. A
// dedicated sidecar file needs every reader to know its specific format;
// reading the data itself needs nothing beyond "it changed."
function readRegistryContent(store: MudSessionStore): string | null {
  try {
    return fs.readFileSync(store.getRegistryPath(), "utf8");
  } catch {
    return null;
  }
}

function sanitizeSessionSegment(segment: string): string {
  return segment.trim().replace(/[/\\]/g, "_").replace(/\.\./g, "_");
}

function sanitizeSessionKey(key: string): string {
  return key.replace(/[/\\]/g, "_").replace(/\.\./g, "_").trim();
}

function pickString(...values: unknown[]): string | null {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return null;
}

function normalizeChannelName(raw: string | null): string {
  if (!raw) return "unknown";
  const text = raw.trim().toLowerCase();
  if (text.includes("telegram")) return "telegram";
  return sanitizeSessionSegment(text.split(/[:/]/)[0] || "unknown");
}

function buildTelegramKey(scope: "group" | "direct", chatId: string, threadId?: string | null): string {
  const safeChatId = sanitizeSessionSegment(chatId);
  const safeThreadId = threadId ? sanitizeSessionSegment(threadId) : null;
  return `agent:main:telegram:${scope}:${safeChatId}${safeThreadId ? `:topic:${safeThreadId}` : ""}`;
}

export function normalizeSessionKey(sessionKey: string): string {
  return normalizeSessionRoutingKey(sessionKey);
}

export function listLegacySessionAliases(sessionKey: string): string[] {
  const canonical = normalizeSessionKey(sessionKey);
  const aliases = new Set<string>();
  const match = canonical.match(/^agent:main:telegram:(group|direct):([^:]+)(?::topic:([^:]+))?$/);
  if (!match) return [];

  const [, scope, chatId, threadId] = match;
  if (scope === "direct") {
    aliases.add(`telegram:direct:${chatId}`);
    return [...aliases];
  }

  // 群级别齐名只属于没有话题的群会话；话题会话共用它会让同群所有话题解析到同一个遗留目录，破坏话题隔离。
  if (!threadId) {
    aliases.add(`telegram:group:${chatId}`);
    return [...aliases];
  }
  aliases.add(`telegram:group:${chatId}:topic:${threadId}`);
  aliases.add(`telegram:${chatId}:${threadId}`);
  aliases.add(`topic-${threadId}`);
  return [...aliases];
}

function encodeLegacyDirOrNull(store: MudSessionStore, candidate: string): string | null {
  try {
    return path.join(store.getStorageRoot(), "sessions", encodeLegacySessionDirName(candidate));
  } catch {
    return null;
  }
}

function findLiveLegacyDir(store: MudSessionStore, candidates: Set<string>): string | null {
  for (const candidate of candidates) {
    const legacyEncoded = encodeLegacyDirOrNull(store, candidate);
    if (legacyEncoded && isDirectory(legacyEncoded) && listLiveSessionProcesses(legacyEncoded).length > 0)
      return legacyEncoded;
  }
  return null;
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function getLegacySessionDir(store: MudSessionStore, candidate: string): string | null {
  if (!candidate || candidate === "." || candidate === ".." || candidate.includes("/") || candidate.includes("\\")) {
    return null;
  }
  return path.join(store.getStorageRoot(), "sessions", candidate);
}

/**
 * 解析 sessionKey 对应的数据目录。
 * 新规范统一落到 canonical key；legacy alias 仅做兼容读取，不再作为新目录创建目标。
 */
export function resolveSessionDir(store: MudSessionStore, sessionKey: string): string {
  const raw = sanitizeSessionKey(sessionKey);
  const cacheKey = `${store.getStorageRoot()}::${raw}`;
  // Check the cache before re-preparing storage, not after: prepareSessionStorage()
  // re-scans the sessions directory and re-validates registry/directory
  // ownership on every call, which is real work; running it unconditionally
  // ahead of the cache lookup defeated the whole point of caching and, under
  // contention or a stale lock, could turn every call into a synchronous
  // multi-second wait. This matters most for a key that never resolves to a
  // materialized directory (an inactive Topic that never ran /mud start) --
  // every message hits this function once, so that lookup must stay O(1).
  //
  // The two branches below need different cache-validity rules. Once a
  // key's own directory is materialized (the "encoded" branch), registry
  // ownership checks already forbid a directory owner from later becoming
  // someone else's alias, so the only way a hit can go stale is the directory
  // itself vanishing from that path -- normalize:sessions:apply renames a sole
  // alias-v2 directory into the canonical slot, and a long-running gateway
  // would otherwise keep returning the vanished path (topic looks unregistered,
  // /mud start cannot find its config) until restart. One existsSync() on a
  // hit is the whole price; a missing directory drops the entry and re-resolves.
  // An unmaterialized key (the "fallback" branch) has no such
  // guarantee: it can still be linked to a different canonical session
  // later, by this process or any other. Trusting a cached fallback guess
  // forever was observed to resolve a freshly-aliased key to its own
  // orphaned directory forever; never caching it at all was observed to
  // defeat the O(1) guarantee above for every inactive Topic. Splitting the
  // difference: a fallback guess stays cached only as long as registry.json's
  // own raw content matches what it was when the guess was made -- one
  // cheap file read, far short of a full prepareSessionStorage() re-scan,
  // and a real cross-process (and cross-version -- see readRegistryContent()
  // above) signal.
  //
  // This deliberately does not use registry.json's mtime: mtime is a
  // wall-clock timestamp with OS/filesystem-dependent resolution (as coarse
  // as one second on some), so two writes landing in the same tick --
  // entirely plausible under the rapid, repeated ensure() calls this cache
  // exists to survive -- would be indistinguishable, silently reopening the
  // exact staleness bug this mechanism exists to close. It also does not use
  // a derived value from a separate coordination file (a counter, or a
  // random token) that changes independently of the registry's actual
  // content: a locally-incremented counter is vulnerable to an ABA hazard
  // (an unlocked writer that reads an old value and then stalls while other
  // writers race ahead of it can finish by writing that value back,
  // reverting the counter to something an earlier reader already cached),
  // and even a per-write-random token still needs its own coordination
  // protocol that every process sharing a storageRoot must agree on, which
  // breaks the moment two different versions of this code run at once (e.g.
  // a rolling restart). Content equality has neither problem: it can only
  // "revert" to a value a reader already cached if the registry's actual
  // data reverted to that same state too, in which case the earlier cached
  // answer is correct again, not stale; and it needs nothing beyond "did
  // registry.json's bytes change" to notice any writer, of any version.
  //
  // Content alone still isn't the whole story, though: a directory can
  // appear, disappear, or get renamed in sessions/ without registry.json's
  // content ever changing (a v1->v2 migration source; a raw, unencoded
  // legacy alias directory that the candidate loop below reads directly via
  // getLegacySessionDir() -- an even older naming scheme than v1, which
  // parseSessionDirName() doesn't recognize at all; anything else). See
  // getSessionsDirSnapshot() in session-store.ts for why the fallback check
  // below also revalidates against that listing, cheaply, instead of
  // trusting registry content equality alone.
  const cached = sessionDirCache.get(cacheKey);
  if (cached !== undefined && cached.kind === "encoded") {
    if (fs.existsSync(cached.dir)) return cached.dir;
    sessionDirCache.delete(cacheKey);
  }
  if (cached !== undefined && cached.kind === "deferred-v1") {
    if (isDirectory(cached.dir) && listLiveSessionProcesses(cached.dir).length > 0) return cached.dir;
    sessionDirCache.delete(cacheKey);
  }

  // Both read here -- before prepareSessionStorage(), getCanonicalSessionKey(),
  // and getAliases() below, each of which does its own separate
  // loadRegistry() read -- and reused as-is for the fallback cache-hit
  // check just below AND, if this call falls through to a fresh
  // resolution, as the stamp on any new fallback entry it caches. Reading
  // them later (originally: right before caching, after all those reads)
  // can race a concurrent write landing in between: the guess would be
  // computed from the OLD state while a signal read afterward already
  // reflects a NEW write, tagging a stale guess as fresh. A signal that
  // already reads as current-as-of-caching never gets flagged stale by a
  // later lookup, so that wrong answer would stick until some *other* write
  // happened to change it again. Reading them first instead means any
  // concurrent write, whenever it lands during this call, changes the real
  // state to something the stamp captured here can no longer equal, so the
  // next lookup (by this process or any other) is guaranteed to see a
  // mismatch and re-resolve for real.
  const registryContent = readRegistryContent(store);
  const sessionsDirSnapshot = store.getSessionsDirSnapshot();
  if (
    cached !== undefined &&
    cached.kind === "fallback" &&
    cached.registryContent === registryContent &&
    cached.sessionsDirSnapshot === sessionsDirSnapshot
  ) {
    return cached.dir;
  }

  if (store.prepareSessionStorage()) sessionDirCache.clear();

  const canonical = store.getCanonicalSessionKey(raw);
  const candidates = new Set<string>([
    canonical,
    raw,
    normalizeSessionKey(raw),
    ...store.getAliases(canonical),
    ...listLegacySessionAliases(canonical),
  ]);

  // 推迟迁移期间（v2 还不存在）同一会话可能有多个 v1 来源（canonical 本身 + 别名）：优先选里面有活进程的那个，
  // 否则网关看不到活 daemon 的 PID / 配置 / 队列，/mud start 还会在空闲目录里再起一个 daemon。
  const liveLegacy = findLiveLegacyDir(store, candidates);
  if (liveLegacy) {
    sessionDirCache.set(cacheKey, { kind: "deferred-v1", dir: liveLegacy });
    return liveLegacy;
  }

  for (const candidate of candidates) {
    let encodedName: string | null = null;
    try {
      encodedName = encodeSessionDirName(candidate);
    } catch {
      // An unencodable legacy candidate cannot have a v2 representation, but
      // its safe raw form below can still be a readable compatibility path.
    }
    if (encodedName) {
      const encoded = path.join(store.getStorageRoot(), "sessions", encodedName);
      if (fs.existsSync(encoded)) {
        sessionDirCache.set(cacheKey, { kind: "encoded", dir: encoded });
        return encoded;
      }
    }
    const legacy = getLegacySessionDir(store, candidate);
    if (legacy && fs.existsSync(legacy)) {
      return legacy;
    }
    // 升级期间仍有活 daemon / autopilot 的 v1 目录会被推迟迁移：在它迁走之前必须还能按 v1 名字找到
    // （否则钩子和工具看不到它的 config / PID / 队列）。它一旦被迁走，上面 encoded 缓存的 existsSync 复核会重新解析。
    const legacyEncoded = encodeLegacyDirOrNull(store, candidate);
    if (legacyEncoded && isDirectory(legacyEncoded)) {
      sessionDirCache.set(cacheKey, { kind: "deferred-v1", dir: legacyEncoded });
      return legacyEncoded;
    }
  }

  let fallback: string;
  try {
    fallback = store.getSessionDataDir(canonical);
  } catch {
    // 超长（UTF-8 > 118 字节）等编码不了的键：普通话题也会走到这里，必须保持透明——返回一个永不存在的路径，
    // 只读路径看到"未注册"；真正要注册它的写操作会在 ensure() 的 encodeSessionDirName 处得到明确报错
    fallback = path.join(
      store.getStorageRoot(),
      "sessions",
      ".unencodable",
      createHash("sha256").update(canonical).digest("hex"),
    );
  }
  sessionDirCache.set(cacheKey, { kind: "fallback", dir: fallback, registryContent, sessionsDirSnapshot });
  return fallback;
}

export function clearSessionDirCache(): void {
  sessionDirCache.clear();
}

export function resolveSessionKey(ctx: Record<string, unknown> | null | undefined): string {
  if (!ctx) return "default";

  const evt = (ctx.event as Record<string, unknown> | undefined) ?? ctx;
  const explicitKey = pickString(ctx.sessionKey, evt.sessionKey);
  if (explicitKey) return normalizeSessionKey(explicitKey);

  const channelName = normalizeChannelName(pickString(ctx.channel, evt.channel));
  const chatId = pickString(evt.chatId, evt.chat_id, ctx.chatId, ctx.chat_id, evt.channelId, ctx.channelId);
  const threadId = pickString(
    evt.messageThreadId,
    evt.message_thread_id,
    evt.topicId,
    evt.topic_id,
    ctx.messageThreadId,
    ctx.message_thread_id,
    ctx.topicId,
    ctx.topic_id,
  );
  const userId = pickString(
    evt.senderId,
    evt.sender_id,
    evt.userId,
    evt.user_id,
    evt.from,
    ctx.senderId,
    ctx.userId,
    ctx.from,
  );

  if (channelName === "telegram") {
    if (chatId && threadId) return buildTelegramKey("group", chatId, threadId);
    if (chatId) {
      const scope = chatId.startsWith("-") ? "group" : "direct";
      return buildTelegramKey(scope, chatId);
    }
  }

  if (chatId && threadId) {
    return normalizeSessionKey(`agent:main:${channelName}:channel:${chatId}:thread:${threadId}`);
  }
  if (chatId) {
    return normalizeSessionKey(`agent:main:${channelName}:channel:${chatId}`);
  }
  if (userId) {
    return normalizeSessionKey(`agent:main:${channelName}:user:${userId}`);
  }
  if (threadId) {
    return normalizeSessionKey(`agent:main:${channelName}:thread:${threadId}`);
  }

  return "default";
}
