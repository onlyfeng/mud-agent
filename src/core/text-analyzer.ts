/**
 * 游戏文本分析工具（autopilot 策略使用）。所有模式来自游戏画像（`game-profile.ts`）。
 */

import { type GameProfile, getGameProfile } from "./game-profile.js";
import { splitExits } from "./state-parser.js";
import type { OutputLine } from "./types.js";

export function parseItemsFromLines(lines: OutputLine[], profile: GameProfile = getGameProfile()): string[] {
  const items: string[] = [];
  for (const { text } of lines) {
    const marked = profile.items.marker.map((re) => text.match(re)).find((m) => m !== null);
    if (marked) {
      const item = (marked[1] ?? "").trim();
      if (item) items.push(item);
    } else if (profile.items.plain.some((re) => re.test(text.trim()))) {
      items.push(text.trim());
    }
  }
  return items;
}

export function detectCombat(lines: OutputLine[], profile: GameProfile = getGameProfile()): boolean {
  return lines.some(({ text }) => profile.combat.start.some((re) => re.test(text)));
}

export function detectCombatEnd(lines: OutputLine[], profile: GameProfile = getGameProfile()): boolean {
  return lines.some(({ text }) => profile.combat.end.some((re) => re.test(text)));
}

export function detectRoomDescription(lines: OutputLine[], profile: GameProfile = getGameProfile()): boolean {
  return lines.some(({ text }) => profile.exits.room.some((re) => re.test(text)));
}

export function parseExitsFromLines(lines: OutputLine[], profile: GameProfile = getGameProfile()): string[] | null {
  for (const { text } of lines) {
    for (const re of profile.exits.room) {
      const m = text.match(re);
      if (m) return splitExits(m[1], profile.exits.splitter);
    }
  }
  return null;
}

export function parseRoomName(lines: OutputLine[], profile: GameProfile = getGameProfile()): string | null {
  for (const { text } of lines) {
    const t = text.trim();
    if (t.length === 0 || t.length >= profile.room.maxLength) continue;
    if (profile.room.exclude.some((re) => re.test(t))) continue;
    if (!profile.room.name.some((re) => re.test(t))) continue;
    const name = profile.room.strip
      .reduce((acc, re) => acc.replace(new RegExp(re.source, `${re.flags}g`), ""), t)
      .trim();
    return name || t;
  }
  return null;
}

export function detectAlertType(lines: OutputLine[], profile: GameProfile = getGameProfile()): string | null {
  for (const { text } of lines) {
    for (const event of profile.events) {
      if (event.patterns.some((re) => re.test(text))) return event.type;
    }
  }
  return null;
}
