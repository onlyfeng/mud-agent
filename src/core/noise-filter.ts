/**
 * 噪音行判定：共享给 daemon 日志回显与触发器。规则来自游戏画像（`game-profile.ts`）；
 * 装饰行 / 不可解码行与服务器无关，留在这里。只负责"判定"，不改变 output.jsonl（AI 读取的游戏输出缓冲）。
 */

import { type GameProfile, getGameProfile } from "./game-profile.js";

const DECORATIVE_RE = /^[\s>]*$|^[\s@┃┏┗┓┛━─│├┤┬┴┼═║╔╗╚╝]+$/;
const UNDECODABLE_RE = /\uFFFD/;

function anyMatch(patterns: RegExp[], text: string): boolean {
  return patterns.some((re) => re.test(text));
}

export function isAmbientChatLine(line: string, profile: GameProfile = getGameProfile()): boolean {
  return anyMatch(profile.noise.ambientChat, line.trim());
}

export function isMovementNoiseLine(line: string, profile: GameProfile = getGameProfile()): boolean {
  const t = line.trim();
  if (anyMatch(profile.noise.movementSelf, t)) return false;
  return anyMatch(profile.noise.movement, t);
}

export function isDecorativeLine(line: string): boolean {
  return DECORATIVE_RE.test(line) || UNDECODABLE_RE.test(line);
}

export function isEmoteNoiseLine(line: string, profile: GameProfile = getGameProfile()): boolean {
  return anyMatch(profile.noise.emote, line);
}

export function isLoginPromptLine(line: string, profile: GameProfile = getGameProfile()): boolean {
  return anyMatch(profile.noise.loginPrompt, line.trim());
}

export function stripAsciiIds(line: string, profile: GameProfile = getGameProfile()): string {
  const re = new RegExp(profile.noise.inlineId.source, `${profile.noise.inlineId.flags}g`);
  return line.replace(re, (match, inner: string) =>
    profile.noise.keepAnnotations.test(String(inner ?? "").trim()) ? match : "",
  );
}

export function isLogNoiseLine(line: string, profile: GameProfile = getGameProfile()): boolean {
  return (
    isDecorativeLine(line) ||
    isMovementNoiseLine(line, profile) ||
    isAmbientChatLine(line, profile) ||
    isEmoteNoiseLine(line, profile)
  );
}
