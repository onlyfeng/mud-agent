/**
 * 游戏状态解析：从文本行提取 HP/MP/出口/等级/金币。模式来自游戏画像（`game-profile.ts`）。
 *
 * 上限只由双值样本（`气血：80/100`）建立；单值样本（`生命值：80`、ROM 风格的 `<80 hp>` 提示符）只更新当前值，
 * 已知上限在"当前值不超过它"时沿用、被超过时置为未知——核心不再从升级播报 / 等级变化去猜上限是否失效
 * （那是服务器文本语义，不属于公共核心）。上限未知时 autopilot 发画像里的状态查询，由下一份双值样本重建；
 * 隐性的上限变化（升级 / 换装）由 autopilot 的周期性状态刷新兜底。
 */

import { type GameProfile, getGameProfile } from "./game-profile.js";
import type { GameState } from "./types.js";

export function resetRuntimeState(state: Partial<GameState>): Partial<GameState> {
  // 连接标志和上次运行的战斗/房间字段都要清：登录完成到首份状态样本之间，autopilot 不能拿旧血量 flee、拿旧出口选路。
  const next: Partial<GameState> = {
    ...state,
    connected: false,
    loginDone: false,
    hp: null,
    maxHp: null,
    maxHpSampledAt: null,
    mp: null,
    maxMp: null,
    exits: [],
    location: "",
  };
  delete next.shutdownReason;
  delete next.shutdownAt;
  return next;
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
  profile: GameProfile = getGameProfile(),
  now: Date = new Date(),
): {
  state: Partial<GameState>;
  triggerState: Partial<GameState>;
  prevState: Partial<GameState> | undefined;
  hasLiveHp: boolean;
} {
  const next = parseState(lines, state, profile, now);
  const sawHp = parseState(lines, {}, profile, now).hp != null;
  const live = hasLiveHp || sawHp;
  const prevState = hasLiveHp ? state : undefined;
  const triggerState = live ? next : { ...next, hp: null, maxHp: null };
  return { state: next, triggerState, prevState, hasLiveHp: live };
}

// 隐性的上限变化（升级 / 换装没有双值样本）靠上限的保鲜期兜底：双值样本超过这么久就当作不可信
export const MAX_HP_SAMPLE_TTL_MS = 5 * 60_000;

/**
 * 血量基线不可信：还没有任何血量样本（刚登录、服务器登录时不打印血量）、上限未知、没有样本时刻（旧 state）、超过保鲜期。
 * autopilot 在这些情况下都不能按它做安全线判断，要先刷新状态。
 * 上限只在玩家活动（升级 / 换装）时变化，而活动本身就会带来新样本（陪伴模式由驾驭模型发状态命令，自动模式由 autopilot 刷新）；
 * 闲置时上限不会变，所以 daemon 的血量触发器继续用它已有的上限，不做保鲜判断。
 */
export function maxHpUntrusted(state: Partial<GameState>, now = Date.now()): boolean {
  if (state.hp == null || state.maxHp == null) return true;
  const sampledAt = state.maxHpSampledAt ? Date.parse(state.maxHpSampledAt) : Number.NaN;
  return !Number.isFinite(sampledAt) || now - sampledAt > MAX_HP_SAMPLE_TTL_MS;
}

/** 单值样本沿用已知上限；当前值超过它时上限已被证伪，置为未知 */
function keepKnownMax(current: number, knownMax: number | null | undefined): number | null {
  return knownMax != null && current <= knownMax ? knownMax : null;
}

/** 画像规则一律逐行应用（`^…$` 锚定的规则在多行批次里也能命中）；按规则顺序、第一条命中的行生效 */
function firstMatch(lines: readonly string[], patterns: RegExp[]): RegExpMatchArray | null {
  for (const re of patterns) {
    for (const line of lines) {
      const m = line.match(re);
      if (m) return m;
    }
  }
  return null;
}

function isNumeric(v: string | undefined): v is string {
  return v !== undefined && v !== "" && Number.isFinite(+v);
}

/** 捕获组存在但本次未参与匹配（`(?:…(.*))?` 的可选分支）时值为 undefined：按"没有出口"处理，不解引用 */
export function splitExits(group: string | undefined, splitter: RegExp): string[] {
  return (group ?? "")
    .split(splitter)
    .map((e) => e.trim())
    .filter(Boolean);
}

function firstGroup(m: RegExpMatchArray): number | null {
  const g = m.slice(1).find((v) => v !== undefined && v !== "");
  return isNumeric(g) ? +g : null;
}

export function parseState(
  lines: string[],
  currentState: Partial<GameState>,
  profile: GameProfile = getGameProfile(),
  now: Date = new Date(),
): Partial<GameState> {
  const s = { ...currentState };

  const hp = firstMatch(lines, profile.status.hp);
  if (hp && isNumeric(hp[1])) {
    s.hp = +hp[1];
    if (isNumeric(hp[2])) {
      s.maxHp = +hp[2];
      s.maxHpSampledAt = now.toISOString();
    } else {
      s.maxHp = keepKnownMax(+hp[1], currentState.maxHp);
    }
  }

  const mp = firstMatch(lines, profile.status.mp);
  if (mp && isNumeric(mp[1])) {
    s.mp = +mp[1];
    s.maxMp = isNumeric(mp[2]) ? +mp[2] : keepKnownMax(+mp[1], currentState.maxMp);
  }

  const exits = firstMatch(lines, profile.exits.state);
  if (exits) s.exits = splitExits(exits[1], profile.exits.splitter);

  const level = firstMatch(lines, profile.status.level);
  if (level) {
    const value = firstGroup(level);
    if (value != null) s.level = value;
  }

  const gold = firstMatch(lines, profile.status.gold);
  if (gold) {
    const value = firstGroup(gold);
    if (value != null) s.gold = value;
  }

  return s;
}
