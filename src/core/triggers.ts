/**
 * 触发器定义 + checkTriggers()
 * zMUD triggers 的 AI 版本。文本触发器来自游戏画像；纯数值的血量触发器与服务器无关，定义在这里。
 */

import { type GameProfile, getGameProfile } from "./game-profile.js";
import { isAmbientChatLine, isLoginPromptLine, stripAsciiIds } from "./noise-filter.js";
import type { Alert, AlertPriority, GameState, TriggerDefinition } from "./types.js";

const STATE_TRIGGERS: TriggerDefinition[] = [
  {
    id: "hp_critical",
    checkFn: (_: string[], state: GameState) =>
      state.hp != null && state.maxHp != null && state.maxHp > 0 && state.hp / state.maxHp < 0.2,
    priority: "critical",
    label: "血量危急",
    advice: "血量低于20%，建议立即逃跑或使用治疗！",
  },
  {
    id: "hp_low",
    checkFn: (_: string[], state: GameState) =>
      state.hp != null && state.maxHp != null && state.maxHp > 0 && state.hp / state.maxHp < 0.35,
    priority: "high",
    label: "血量偏低",
    advice: "血量低于35%，注意安全，考虑治疗。",
  },
];

export function activeTriggers(profile: GameProfile = getGameProfile()): TriggerDefinition[] {
  return [...STATE_TRIGGERS, ...profile.triggers];
}

export interface CheckTriggersResult {
  alerts: Alert[];
  changed: boolean;
}

// 闲聊/频道播报是环境噪音：西游记等服务器会把剧情内容塞进【闲聊】，
// 让 boss / puzzle / npc_talk 等文本触发器反复误报。登录密码提示会命中 puzzle 的「密码」，
// 玩家 ASCII id（如 示例玩家(BossExample)）会命中 boss，所以文本触发器在去掉这两类后的文本上评估。
const isAmbientLine = isAmbientChatLine;

// 登录密码提示只在登录未完成时过滤：登录后出现的「请输入机关密码：」「密码：」是真正的谜题，要留给 puzzle 触发器
function triggerText(line: string, loginDone: boolean, profile: GameProfile): string | null {
  if (isAmbientLine(line, profile) || (!loginDone && isLoginPromptLine(line, profile))) return null;
  return stripAsciiIds(line, profile);
}

// 每类警报的重复抑制窗口（短冷却，兜底）。
const ALERT_DEDUP_WINDOW_MS = 5 * 60 * 1000;
// 离散事件（升级 / 死亡 / 任务 / 稀有物品）的文本在服务器上往往固定不变（「你升级了！」），5 分钟内两次真实发生不能被合并：
// 只抑制服务器短时重发（同文本、仍未读、几秒内）
const DISCRETE_RETRANSMIT_WINDOW_MS = 10 * 1000;
// 离散事件：每次发生都是独立进展（再次死亡、再升一级、另一任务、另一件稀有物品）：
// 已读告警不压制，未读告警也只在上下文相同时才算重复；持续性场景（boss / puzzle / npc_talk）按 id 在窗口内去重，否则一清就刷屏。

export function checkTriggers(
  lines: string[],
  state: Partial<GameState>,
  existingAlerts: Alert[],
  prevState?: Partial<GameState>,
  opts: { firstLiveSample?: boolean; profile?: GameProfile } = {},
): CheckTriggersResult {
  const profile = opts.profile ?? getGameProfile();
  const loginDone = state.loginDone === true;
  const candidates = lines
    .map((line) => ({ line, text: triggerText(line, loginDone, profile) }))
    .filter((c): c is { line: string; text: string } => c.text !== null);
  const alerts = [...existingAlerts];
  const now = new Date().toISOString();
  let changed = false;

  for (const trigger of activeTriggers(profile)) {
    let fired = false;
    // 文本触发器逐行匹配（与其他画像规则一致）：行首行尾锚定的规则在多行批次里也能命中
    if (trigger.re) fired = candidates.some((c) => trigger.re?.test(c.text));
    if (trigger.checkFn) {
      const nowFired = trigger.checkFn(lines, state as GameState);
      // 状态类触发器（hp_critical / hp_low）：只在条件 false → true 的
      // 转换边沿上报一次。持续满足状态时，每次输出刷新都会重新命中，
      // 挂机聊天刷屏时几分钟内就能灌满 50 条警报队列。
      // 恢复后再跌破阈值会重新命中（中间必然出现过 false）。
      // 调用方不传 prevState（旧测试/外部调用）时保持原行为。
      fired = fired || (prevState ? nowFired && !trigger.checkFn(lines, prevState as GameState) : nowFired);
    }

    if (fired) {
      // 边沿模式（传了 prevState 的状态触发器）自带防抖，不再套时间窗口；
      // （重）连接后的首个实时血量样本没有基线，但它就是这次连接的第一个边沿：断线前的同类告警不能压制它。
      // 文本触发器与旧调用（未传 prevState）用窗口抑制刷屏。
      const isEdgeFired = Boolean(trigger.checkFn && !trigger.re && (prevState || opts.firstLiveSample));
      if (!isEdgeFired) {
        const discrete = trigger.discrete === true;
        const context = trigger.re ? (candidates.find((c) => trigger.re?.test(c.text))?.line ?? "") : "";
        const window = discrete ? DISCRETE_RETRANSMIT_WINDOW_MS : ALERT_DEDUP_WINDOW_MS;
        const recent = alerts.find(
          (a) =>
            a.id === trigger.id &&
            (!discrete || (!a.read && a.context === context)) &&
            Date.now() - new Date(a.time).getTime() < window,
        );
        if (recent) continue;
      }
      alerts.unshift({
        id: trigger.id,
        priority: trigger.priority as AlertPriority,
        label: trigger.label,
        advice: trigger.advice,
        context:
          (trigger.re
            ? candidates.find((c) => trigger.re?.test(c.text))?.line
            : lines.find((l) => !isAmbientLine(l, profile))) || "",
        time: now,
        read: false,
      });
      changed = true;
    }
  }

  return { alerts: alerts.slice(0, 50), changed };
}
