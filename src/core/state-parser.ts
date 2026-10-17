/**
 * 游戏状态解析：从文本行提取 HP/MP/出口/等级/金币。
 */

import { isAmbientChatLine } from "./noise-filter.js";
import type { GameState } from "./types.js";

export function resetRuntimeState(state: Partial<GameState>): Partial<GameState> {
  // 连接标志和上次运行的战斗/房间字段都要清：登录完成到首份状态样本之间，autopilot 不能拿旧血量 flee、拿旧出口选路。
  const next: Partial<GameState> = {
    ...state,
    connected: false,
    loginDone: false,
    hp: null,
    maxHp: null,
    mp: null,
    maxMp: null,
    exits: [],
    location: "",
  };
  delete next.shutdownReason;
  delete next.shutdownAt;
  return next;
}

/** 单值样本（`生命值: 80`）没有上限：已知上限仍自洽（当前值不超过它）就保留，否则置空。 */
function keepKnownMax(current: number, knownMax: number | null | undefined): number | null {
  return knownMax != null && current <= knownMax ? knownMax : null;
}

// 单值样本里"当前值 ≤ 旧上限"不能证明上限没变（升级/换装后 40/200 看起来和 40/100 一样）。
// 能从文本里判断上限连续性的只有等级：本批出现升级播报、或解析到的等级与缓存不同，就放弃缓存的上限，
// 等下一份双值样本重新建立。换装备这类无播报的上限变化无法从文本识别，不在此处理。
// 只认"本角色"的升级事件，逐行判断：闲聊频道里恭喜别人、技能"升为"都不算（不然一条播报就清掉自己的血量上限）
const SELF_LEVEL_UP_RE =
  /(?:(?:^|[\s,，。！!：:]|恭喜)(?:你|您)(?:的)?(?:等级)?(?:升级了|(?:提升|上升|升到|升为|达到|升至)(?:了)?\s*(?:第\s*)?\d*\s*级?))|(?:\byou (?:gain a level|advance to level|are now level))/i;

function isSelfLevelUpBatch(text: string): boolean {
  for (const line of text.split("\n")) {
    if (isAmbientChatLine(line)) continue;
    if (NON_CHARACTER_LEVEL_RE.test(line) && !SELF_LEVEL_UP_RE.test(line.replace(NON_CHARACTER_LEVEL_SEGMENT_RE, " ")))
      continue;
    if (SELF_LEVEL_UP_RE.test(line)) return true;
  }
  return false;
}

function maxContinuityBroken(
  text: string,
  parsedLevel: number | null,
  currentLevel: number | null | undefined,
): boolean {
  if (isSelfLevelUpBatch(text)) return true;
  return parsedLevel != null && currentLevel != null && parsedLevel !== currentLevel;
}

// 明确的角色等级写法：行首/标点后的「等级：N」「角色等级 N」「Lv.N」「Level N」；前面紧跟其他名词（技能/武功/门派…）的不算
// 边界：行首；玩家状态标签 + 标点（「状态：」「属性，」）；白名单括号标签（「【状态】」「[status]」）。
// 实体名 + 标点（「山贼：等级：20」「山贼，等级：20」「山贼 | Level 20」）不算边界；
// 「|」分隔的字段只在玩家状态行（下面 PLAYER_STATUS_LINE_RE 判定）里接受
const CHARACTER_LEVEL_RE =
  /(?:^|(?:状态|属性|角色|人物|玩家|个人|自身|基本信息|基本|status|stats?|character|char|player|self|info)\s*[：:，,。；;、]|【(?:状态|属性|角色|人物|玩家|个人|自身)】|\[(?:status|stats?|char|player|self|状态|属性|角色|人物|玩家)\])\s*(?:(?:你|您|角色|人物|玩家)(?:的)?(?:当前|目前|现在)?|当前|目前)?\s*(?:等级[：:\s]*(\d+)|Lv\.?\s*(\d+)|Level\s*(\d+))/im;
// 玩家状态行（以本角色的状态字段开头，可带「【状态】」类标签）：字段之间只用空格分隔也算边界（「生命值：40 等级：11」）；
// 其他实体的描述（「山贼 HP 80 等级：20」）不以玩家状态字段开头，不走这条
const PLAYER_STATUS_LINE_RE =
  /^\s*(?:【(?:状态|属性|角色|人物|玩家|我的状态|个人|自身)】|\[(?:状态|属性|角色|人物|玩家|status|stats?|char|player|self)\])?\s*(?:生命值?|气血|血量|体力|精力|法力|内力|真气|魔法|经验值?|等级|HP|MP|SP|EXP|Lv\.?|Level)(?=[\s：:=]|\d)/i;
const CHARACTER_LEVEL_IN_STATUS_LINE_RE =
  /(?:^|[\s,，。；;、|[\]()（）【】：:])\s*(?:(?:你|您|角色|人物|玩家)(?:的)?(?:当前|目前|现在)?|当前|目前)?\s*(?:等级[：:\s]*(\d+)|Lv\.?\s*(\d+)|Level\s*(\d+))/i;
const NON_CHARACTER_LEVEL_RE =
  /(?:技能|武功|武学|门派|帮派|称号|装备|宠物|坐骑|任务|副本|熟练|修为|境界)\s*等级|\b(?:skill|guild|clan|pet|mount|weapon|spell|quest|title|job|class)\s+(?:level|lv)\b\.?/i;

const NON_CHARACTER_LEVEL_SEGMENT_RE =
  /(?:技能|武功|武学|门派|帮派|称号|装备|宠物|坐骑|任务|副本|熟练|修为|境界)\s*等级[：:\s]*\d*|\b(?:skill|guild|clan|pet|mount|weapon|spell|quest|title|job|class)\s+(?:level|lv\.?)[:\s]*\d*/gi;

function parseCharacterLevel(text: string): number | null {
  for (const line of text.split("\n")) {
    if (isAmbientChatLine(line)) continue; // 频道里别人的「等级：99」不是本角色
    // 只屏蔽被限定词直接修饰的「…等级：N」片段，同一行其余的角色等级照常识别（「角色等级：11 技能等级：3」）
    const masked = line.replace(NON_CHARACTER_LEVEL_SEGMENT_RE, " ");
    const m =
      masked.match(CHARACTER_LEVEL_RE) ??
      (PLAYER_STATUS_LINE_RE.test(masked) ? masked.match(CHARACTER_LEVEL_IN_STATUS_LINE_RE) : null);
    if (m) return +(m[1] || m[2] || m[3]);
  }
  return null;
}

/**
 * 为一批服务器输出计算触发器的输入。持久化的上次运行血量只用于展示：
 * 在本进程解析到实时血量之前，触发器看到的是没有血量的状态（登录横幅不会拿旧快照制造假告警）；
 * 首批带血量的样本没有边沿基线（重启时仍低血要上报）；之后才进入边沿模式。
 */
export function liveSampleGate(
  lines: string[],
  state: Partial<GameState>,
  hasLiveHp: boolean,
): {
  state: Partial<GameState>;
  triggerState: Partial<GameState>;
  prevState: Partial<GameState> | undefined;
  hasLiveHp: boolean;
} {
  const prevState = hasLiveHp ? state : undefined;
  const next = parseState(lines, state);
  const sawHp = parseState(lines, {}).hp != null;
  const live = hasLiveHp || sawHp;
  const triggerState = live ? next : { ...next, hp: null, maxHp: null };
  return { state: next, triggerState, prevState, hasLiveHp: live };
}

export function parseState(lines: string[], currentState: Partial<GameState>): Partial<GameState> {
  const text = lines.join("\n");
  const s = { ...currentState };

  const lvlMatch = text.match(/等级[：:\s]*(\d+)|Lv\.?\s*(\d+)|Level\s*(\d+)/i);
  const parsedLevel = lvlMatch ? +(lvlMatch[1] || lvlMatch[2] || lvlMatch[3]) : null;
  // 上限连续性只认"角色等级"：宽泛的等级正则也会匹配「技能等级：3」这类技能信息，不能拿它当角色升级；
  // 显示字段 level 仍沿用宽泛匹配（历史行为），只有能明确识别为角色等级的写法才参与失效判断
  // 基线用单独保存的已确认角色等级，不用宽泛匹配的展示值 level（「技能等级：3」会把它改成 3，下一批真实的「等级：10」就被误判为断裂）
  const characterLevel = parseCharacterLevel(text);
  // 滚动升级后旧 state.json 还没有 characterLevel（undefined）：第一次解析时把旧的 level 导入为基线并从此固定——
  // 之后宽泛匹配的 level 再怎么被「技能等级：3」改写都不影响基线；宁可这一次多清一次上限，也不能让旧上限撑过一次升级
  const baseline =
    currentState.characterLevel !== undefined ? currentState.characterLevel : (currentState.level ?? null);
  const continuityBroken = maxContinuityBroken(text, characterLevel, baseline);
  s.characterLevel = characterLevel ?? baseline;
  // 连续性断裂先清掉旧上限（本批没有血量样本也要清，否则下一批单值样本会再次复用它）；本批的双值样本可以重建
  if (continuityBroken) {
    s.maxHp = null;
    s.maxMp = null;
  }

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
      s.maxHp = m[2] ? +m[2] : continuityBroken ? null : keepKnownMax(+m[1], currentState.maxHp);
      break;
    }
  }

  const mpPatterns = [
    // 西游记/武侠类：内力是主 MP，法力是法术位资源，两者同屏出现时
    // 必须先取内力（双值或单值格式都算），否则 mp 会被法力带偏（实测 50/10 vs 内力 10/10）。
    // 没有内力时保持通用 MUD 的法力优先；精神只是最后的兑底。
    /内力\s*[：:]\s*(\d+)\s*[/／]\s*(\d+)/,
    /内力\s*[：:]\s*(\d+)/,
    /[法魔]力\s*[：:]\s*(\d+)\s*[/／]\s*(\d+)/,
    /MP\s*[：:]\s*(\d+)\s*[/／]\s*(\d+)/i,
    /精神\s*[：:]\s*(\d+)\s*[/／]\s*(\d+)/,
  ];
  for (const re of mpPatterns) {
    const m = text.match(re);
    if (m) {
      s.mp = +m[1];
      s.maxMp = m[2] ? +m[2] : continuityBroken ? null : keepKnownMax(+m[1], currentState.maxMp);
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
  if (parsedLevel != null) s.level = parsedLevel;

  const gold = text.match(/[银金][币两钱]?\s*[：:]\s*(\d+)|gold[：:\s]*(\d+)/i);
  if (gold) s.gold = +(gold[1] || gold[2]);

  return s;
}
