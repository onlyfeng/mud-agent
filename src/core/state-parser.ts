/**
 * 游戏状态解析：从文本行提取 HP/MP/出口/等级/金币。
 */

import type { GameState } from "./types.js";

export function parseState(lines: string[], currentState: Partial<GameState>): Partial<GameState> {
  const text = lines.join("\n");
  const s = { ...currentState };

  // HP/MP 通用格式集合
  const hpPatterns = [
    /[生精体气血][命力量精气]?\s*[：:]\s*(\d+)\s*[/／]\s*(\d+)/,
    /HP\s*[：:]\s*(\d+)\s*[/／]\s*(\d+)/i,
    /<\s*(\d+)\s*hp/i,
    /生命[值点]?\s*[：:]\s*(\d+)/,
  ];
  for (const re of hpPatterns) {
    const m = text.match(re);
    if (m) {
      s.hp = +m[1];
      if (m[2]) s.maxHp = +m[2];
      break;
    }
  }

  const mpPatterns = [
    /[法魔]力\s*[：:]\s*(\d+)\s*[/／]\s*(\d+)/,
    /MP\s*[：:]\s*(\d+)\s*[/／]\s*(\d+)/i,
    /内力\s*[：:]\s*(\d+)/,
  ];
  for (const re of mpPatterns) {
    const m = text.match(re);
    if (m) {
      s.mp = +m[1];
      if (m[2]) s.maxMp = +m[2];
      break;
    }
  }

  // 出口
  const exitCN = text.match(/(?:明显的?)?出[口路][：:\s]+([东南西北上下出入、,，\s]+)/);
  const exitEN = text.match(/\[Exits?:\s*([^\]]+)\]/i);
  if (exitCN)
    s.exits = exitCN[1]
      .trim()
      .split(/[、,，\s]+/)
      .filter(Boolean);
  else if (exitEN)
    s.exits = exitEN[1]
      .trim()
      .split(/[\s,]+/)
      .filter(Boolean);

  // 等级/经验
  const lvl = text.match(/等级[：:\s]*(\d+)|Lv\.?\s*(\d+)|Level\s*(\d+)/i);
  if (lvl) s.level = +(lvl[1] || lvl[2] || lvl[3]);

  const gold = text.match(/[银金][币两钱]?\s*[：:]\s*(\d+)|gold[：:\s]*(\d+)/i);
  if (gold) s.gold = +(gold[1] || gold[2]);

  return s;
}
