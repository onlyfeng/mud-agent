import { Buffer } from "node:buffer";
import { TextDecoder } from "node:util";

export const CURRENT_SESSION_DIR_PREFIX = "v2_";
export const LEGACY_SESSION_DIR_PREFIX = "v1_";
export const MAX_SESSION_DIR_BYTES = 240;

const LOWERCASE_HEX_PAYLOAD = /^(?:[0-9a-f]{2})+$/;
const BASE64URL_PAYLOAD = /^[A-Za-z0-9_-]+$/;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

/** @typedef {{ version: "v1" | "v2", sessionKey: string }} ParsedSessionDirName */
/** @typedef {{ ownerKey: string, sessionKey: string }} SessionDirOwnershipClaim */
/** @typedef {{ sessionKey: string, ownerKeys: string[] }} RegistrySessionKeyOwnershipConflict */
/**
 * @typedef {{
 *   foldedName: string,
 *   dirNames: string[],
 *   sessionKeys: string[],
 *   ownerKeys: string[],
 *   reason: "missing-owner" | "multiple-owners" | "unclaimed-decoded-key" | "noncanonical-name"
 * }} SessionDirOwnershipConflict
 */

/** @param {string} value */
function isWellFormedUtf16(value) {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      if (index + 1 >= value.length) return false;
      const nextCodeUnit = value.charCodeAt(index + 1);
      if (nextCodeUnit < 0xdc00 || nextCodeUnit > 0xdfff) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

/** @param {string} sessionKey */
function validateSessionKey(sessionKey) {
  if (typeof sessionKey !== "string") throw new TypeError("sessionKey must be a string");
  if (!sessionKey.trim()) throw new Error("sessionKey cannot be empty");
  if (sessionKey.trim() !== sessionKey) throw new Error("sessionKey cannot contain boundary whitespace");
  if (!isWellFormedUtf16(sessionKey)) throw new TypeError("sessionKey must be well-formed UTF-16");
}

/** @param {string} encoded */
function enforceComponentLimit(encoded) {
  if (Buffer.byteLength(encoded, "utf8") > MAX_SESSION_DIR_BYTES) {
    throw new RangeError(`encoded session directory exceeds ${MAX_SESSION_DIR_BYTES} bytes`);
  }
  return encoded;
}

/** @param {string} sessionKey */
export function encodeSessionDirName(sessionKey) {
  validateSessionKey(sessionKey);
  return enforceComponentLimit(`${CURRENT_SESSION_DIR_PREFIX}${Buffer.from(sessionKey, "utf8").toString("hex")}`);
}

/** @param {string} sessionKey */
export function encodeLegacySessionDirName(sessionKey) {
  validateSessionKey(sessionKey);
  return enforceComponentLimit(`${LEGACY_SESSION_DIR_PREFIX}${Buffer.from(sessionKey, "utf8").toString("base64url")}`);
}

/** @param {string} name */
export function isEncodedSessionDirNameCandidate(name) {
  const foldedName = caseFoldSessionDirName(name);
  return foldedName.startsWith(CURRENT_SESSION_DIR_PREFIX) || foldedName.startsWith(LEGACY_SESSION_DIR_PREFIX);
}

/**
 * The codec emits ASCII only. Folding ASCII explicitly models the equivalence
 * that made v1 unsafe on default Windows filesystems without locale drift.
 * @param {string} name
 */
export function caseFoldSessionDirName(name) {
  return name.replace(/[A-Z]/g, (character) => character.toLowerCase());
}

/** @param {string} value */
function sanitizeRoutingSegment(value) {
  return value.trim().replace(/[/\\]/g, "_").replace(/\.\./g, "_");
}

/** @param {string} value */
function sanitizeRoutingKey(value) {
  return value.replace(/[/\\]/g, "_").replace(/\.\./g, "_").trim();
}

/** @param {"group" | "direct"} scope @param {string} chatId @param {string} [topicId] */
function buildTelegramRoutingKey(scope, chatId, topicId) {
  const safeChatId = sanitizeRoutingSegment(chatId);
  const safeTopicId = topicId ? sanitizeRoutingSegment(topicId) : null;
  return `agent:main:telegram:${scope}:${safeChatId}${safeTopicId ? `:topic:${safeTopicId}` : ""}`;
}

/** @param {string} sessionKey */
export function normalizeSessionRoutingKey(sessionKey) {
  const raw = sanitizeRoutingKey(sessionKey);
  if (!raw || raw === "default") return "default";

  let match = raw.match(/^agent:main:telegram:(group|direct):([^:]+)(?::topic:([^:]+))?$/);
  if (match) return buildTelegramRoutingKey(match[1] === "group" ? "group" : "direct", match[2], match[3]);

  match = raw.match(/^telegram:group:([^:]+):topic:([^:]+)$/);
  if (match) return buildTelegramRoutingKey("group", match[1], match[2]);
  match = raw.match(/^telegram:group:([^:]+)$/);
  if (match) return buildTelegramRoutingKey("group", match[1]);
  match = raw.match(/^telegram:direct:([^:]+)$/);
  if (match) return buildTelegramRoutingKey("direct", match[1]);
  match = raw.match(/^telegram:([^:]+):([^:]+)$/);
  if (match) return buildTelegramRoutingKey("group", match[1], match[2]);

  match = raw.match(/^topic[:-](.+)$/);
  if (match) return `topic-${sanitizeRoutingSegment(match[1])}`;
  match = raw.match(/^user[:-](.+)$/);
  if (match) return `user-${sanitizeRoutingSegment(match[1])}`;

  match = raw.match(/^agent:main:([^:]+):channel:([^:]+):thread:([^:]+)$/);
  if (match) {
    return `agent:main:${sanitizeRoutingSegment(match[1])}:channel:${sanitizeRoutingSegment(match[2])}:thread:${sanitizeRoutingSegment(match[3])}`;
  }
  match = raw.match(/^agent:main:([^:]+):channel:([^:]+)$/);
  if (match) {
    return `agent:main:${sanitizeRoutingSegment(match[1])}:channel:${sanitizeRoutingSegment(match[2])}`;
  }
  match = raw.match(/^agent:main:([^:]+):user:([^:]+)$/);
  if (match) return `agent:main:${sanitizeRoutingSegment(match[1])}:user:${sanitizeRoutingSegment(match[2])}`;
  match = raw.match(/^agent:main:([^:]+):thread:([^:]+)$/);
  if (match) return `agent:main:${sanitizeRoutingSegment(match[1])}:thread:${sanitizeRoutingSegment(match[2])}`;

  return raw;
}

/**
 * A logical session key or alias may resolve to exactly one canonical owner.
 * Repeated claims by the same normalized owner are harmless.
 * @param {SessionDirOwnershipClaim[]} claims
 * @returns {RegistrySessionKeyOwnershipConflict[]}
 */
export function findRegistrySessionKeyOwnershipConflicts(claims) {
  const ownersBySessionKey = new Map();
  for (const claim of claims) {
    if (!claim.ownerKey || !claim.sessionKey) continue;
    const normalizedSessionKey = normalizeSessionRoutingKey(claim.sessionKey);
    const ownerKeys = ownersBySessionKey.get(normalizedSessionKey) ?? new Set();
    ownerKeys.add(claim.ownerKey);
    ownersBySessionKey.set(normalizedSessionKey, ownerKeys);
  }

  return [...ownersBySessionKey]
    .filter(([, ownerKeys]) => ownerKeys.size > 1)
    .map(([sessionKey, ownerKeys]) => ({ sessionKey, ownerKeys: [...ownerKeys].sort() }))
    .sort((left, right) => left.sessionKey.localeCompare(right.sessionKey));
}

/**
 * Registry ownership must be established in logical-key space before any
 * encoded directory is trusted or migrated. Direct raw-name claims are
 * included because a logical key may itself look like an encoded component.
 * @param {string[]} dirNames
 * @param {SessionDirOwnershipClaim[]} claims
 * @returns {SessionDirOwnershipConflict[]}
 */
export function findEncodedSessionDirOwnershipConflicts(dirNames, claims) {
  const groups = new Map();
  for (const dirName of dirNames) {
    const exact = parseSessionDirName(dirName);
    const foldedName = caseFoldSessionDirName(dirName);
    const foldedVersion = foldedName.startsWith(LEGACY_SESSION_DIR_PREFIX)
      ? "v1"
      : foldedName.startsWith(CURRENT_SESSION_DIR_PREFIX)
        ? "v2"
        : null;
    if (!exact && foldedVersion === null) continue;

    const foldedV2 = !exact && foldedVersion === "v2" ? parseSessionDirName(foldedName) : null;
    const parsed = exact ?? foldedV2;
    const version = parsed?.version ?? foldedVersion;
    const group = groups.get(foldedName) ?? {
      version,
      noncanonical: exact === null,
      dirNames: new Set(),
      decodedKeys: new Set(),
      claimedKeys: new Set(),
      ownerKeys: new Set(),
    };
    group.noncanonical ||= exact === null;
    group.dirNames.add(dirName);
    if (parsed) group.decodedKeys.add(parsed.sessionKey);
    groups.set(foldedName, group);
  }

  for (const claim of claims) {
    if (!claim.ownerKey || !claim.sessionKey) continue;
    for (const [foldedName, group] of groups) {
      let matches = caseFoldSessionDirName(claim.sessionKey) === foldedName;
      if (!matches) {
        try {
          const encoded =
            group.version === "v1"
              ? encodeLegacySessionDirName(claim.sessionKey)
              : encodeSessionDirName(claim.sessionKey);
          matches = caseFoldSessionDirName(encoded) === foldedName;
        } catch {
          matches = false;
        }
      }
      if (matches) {
        group.claimedKeys.add(claim.sessionKey);
        group.ownerKeys.add(claim.ownerKey);
      }
    }
  }

  /** @type {SessionDirOwnershipConflict[]} */
  const conflicts = [];
  for (const [foldedName, group] of groups) {
    const unclaimedDecodedKeys = [...group.decodedKeys].filter((key) => !group.claimedKeys.has(key));
    /** @type {SessionDirOwnershipConflict["reason"] | null} */
    let reason = null;
    if (group.noncanonical || group.decodedKeys.size === 0) reason = "noncanonical-name";
    else if (group.ownerKeys.size === 0 && group.version === "v1") reason = "missing-owner";
    else if (group.ownerKeys.size > 1) reason = "multiple-owners";
    else if (group.ownerKeys.size === 1 && unclaimedDecodedKeys.length > 0) reason = "unclaimed-decoded-key";
    if (reason === null) continue;

    conflicts.push({
      foldedName,
      dirNames: [...group.dirNames].sort(),
      sessionKeys: [...new Set([...group.decodedKeys, ...group.claimedKeys, ...group.ownerKeys])].sort(),
      ownerKeys: [...group.ownerKeys].sort(),
      reason,
    });
  }
  return conflicts.sort((left, right) => left.foldedName.localeCompare(right.foldedName));
}

/** @param {string} name @returns {ParsedSessionDirName | null} */
export function parseSessionDirName(name) {
  /** @type {"v1" | "v2"} */
  let version;
  let payload;
  let bytes;

  if (name.startsWith(CURRENT_SESSION_DIR_PREFIX)) {
    version = "v2";
    payload = name.slice(CURRENT_SESSION_DIR_PREFIX.length);
    if (!LOWERCASE_HEX_PAYLOAD.test(payload)) return null;
    bytes = Buffer.from(payload, "hex");
  } else if (name.startsWith(LEGACY_SESSION_DIR_PREFIX)) {
    version = "v1";
    payload = name.slice(LEGACY_SESSION_DIR_PREFIX.length);
    if (!BASE64URL_PAYLOAD.test(payload)) return null;
    bytes = Buffer.from(payload, "base64url");
  } else {
    return null;
  }

  try {
    const sessionKey = UTF8_DECODER.decode(bytes);
    if (!sessionKey) return null;
    const canonicalName = version === "v2" ? encodeSessionDirName(sessionKey) : encodeLegacySessionDirName(sessionKey);
    return canonicalName === name ? { version, sessionKey } : null;
  } catch {
    return null;
  }
}

/** @param {string} name */
export function decodeSessionDirName(name) {
  return parseSessionDirName(name)?.sessionKey ?? null;
}
