/**
 * 游戏文本分析工具（autopilot 策略使用）。
 */

import type { OutputLine } from "./types.js";

/** 从输出行中提取物品列表 */
export function parseItemsFromLines(lines: OutputLine[]): string[] {
  const items: string[] = [];
  const itemPattern = /^[\u4e00-\u9fa5\w]+\([\w\s]+\)/;
  const markerPattern = /^[□✦◆▶]\s*(.+?)\([\w\s]+\)/;
  for (const { text } of lines) {
    if (markerPattern.test(text)) {
      const m = text.match(/^[□✦◆▶]\s*(.+)/);
      if (m) items.push(m[1].trim());
    } else if (itemPattern.test(text.trim())) {
      items.push(text.trim());
    }
  }
  return items;
}

/** 检测战斗状态 */
export function detectCombat(lines: OutputLine[]): boolean {
  const combatPatterns = [
    /向你的.+发动/,
    /往你的.+/,
    /打了你一/,
    /刺了你一/,
    /踢了你一/,
    /正在战斗/,
    /向你发起/,
    /想杀死你/,
    /注视着你的行动/,
    /准备发动攻势/,
  ];
  return lines.some(({ text }) => combatPatterns.some((p) => p.test(text)));
}

/** 检测是否在看房间描述 */
export function detectRoomDescription(lines: OutputLine[]): boolean {
  return lines.some(({ text }) => /这里明显的出口是/.test(text) || /这里唯一的出口是/.test(text));
}

/** 从房间描述行提取出口 */
export function parseExitsFromLines(lines: OutputLine[]): string[] | null {
  for (const { text } of lines) {
    const m = text.match(/这里(?:明显的|唯一的)?出口是\s+(.+?)[。.]?$/);
    if (m) {
      return m[1]
        .split(/[、，,和\s]+/)
        .map((e) => e.trim())
        .filter(Boolean);
    }
  }
  return null;
}

/** 从行中提取室名 */
export function parseRoomName(lines: OutputLine[]): string | null {
  for (const { text } of lines) {
    const t = text.trim();
    if (
      t.length > 0 &&
      t.length < 25 &&
      !/[你我他它]/.test(t) &&
      !/[→←↑↓]/.test(t) &&
      !/^\[/.test(t) &&
      !/^【/.test(t)
    ) {
      if (/\s*-\s*$/.test(t) || /^[\u4e00-\u9fa5]{2,10}$/.test(t)) {
        return t.replace(/\s*-\s*$/, "").trim();
      }
    }
  }
  return null;
}

/** 检测触发器类事件 */
export function detectAlertType(lines: OutputLine[]): string | null {
  for (const { text } of lines) {
    if (/你升级了|道行境界|武学境界/.test(text)) return "level_up";
    if (/稀有|宝贝|天书|神器/.test(text)) return "rare_item";
    if (/谜题|机关|秘道|暗门/.test(text)) return "puzzle";
    if (/首领|妖王|boss|大王|魔王/.test(text.toLowerCase())) return "boss";
  }
  return null;
}
