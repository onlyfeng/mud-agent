/**
 * 触发器定义 + checkTriggers()
 * zMUD triggers 的 AI 版本。
 */

import { isAmbientChatLine, isLoginPromptLine, stripAsciiIds } from "./noise-filter.js";
import type { Alert, AlertPriority, GameState, TriggerDefinition } from "./types.js";

export const TRIGGERS: TriggerDefinition[] = [
  {
    id: "death",
    re: /你死了|你已死亡|你倒下了|you (?:are dead|have died|die\b)|\*{3}dead\*{3}/i,
    priority: "critical",
    label: "你死了",
    advice: "角色已死亡！需要找到复活点或等待处理。",
  },
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
  {
    id: "boss",
    re: /boss|首领|魔王|大妖|龙王|神兽|古神|守护者|boss战|强敌/i,
    priority: "high",
    label: "检测到Boss",
    advice: "发现强力敌人！建议做好准备再战。",
  },
  {
    id: "puzzle",
    re: /谜题|机关|符文|解锁|密码|puzzle|riddle|钥匙.*锁|锁.*需要/i,
    priority: "high",
    label: "发现谜题/机关",
    advice: "这里有谜题或机关，需要思考或找线索。",
  },
  {
    id: "level_up",
    re: /你升级了|恭喜.*升|你现在是.*级|you gain a level|升为/i,
    priority: "normal",
    label: "升级了！",
    advice: "恭喜升级！可以查看新属性和技能。",
  },
  {
    id: "quest_update",
    re: /任务完成|完成了任务|任务更新|quest complete|任务.*进度/i,
    priority: "normal",
    label: "任务更新",
    advice: "任务有进展，可以查看任务日志。",
  },
  {
    id: "rare_item",
    re: /神器|传说|稀有|极品|legendary|ancient.*weapon|你发现了.*珍贵/i,
    priority: "normal",
    label: "发现稀有物品",
    advice: "发现了珍贵物品！",
  },
  {
    id: "npc_talk",
    re: /对你说[：:]|告诉你[：:]|whispers?|says? to you/i,
    priority: "low",
    label: "NPC 在说话",
    advice: "NPC 有话说，可能是任务或线索。",
  },
];

export interface CheckTriggersResult {
  alerts: Alert[];
  changed: boolean;
}

// 闲聊/频道播报是环境噪音：西游记等服务器会把剧情内容塞进【闲聊】，
// 让 boss / puzzle / npc_talk 等文本触发器反复误报。登录密码提示会命中 puzzle 的「密码」，
// 玩家 ASCII id（如 示例玩家(BossExample)）会命中 boss，所以文本触发器在去掉这两类后的文本上评估。
const isAmbientLine = isAmbientChatLine;

// 登录密码提示只在登录未完成时过滤：登录后出现的「请输入机关密码：」「密码：」是真正的谜题，要留给 puzzle 触发器
function triggerText(line: string, loginDone: boolean): string | null {
  if (isAmbientLine(line) || (!loginDone && isLoginPromptLine(line))) return null;
  return stripAsciiIds(line);
}

// 每类警报的重复抑制窗口（短冷却，兜底）。
const ALERT_DEDUP_WINDOW_MS = 5 * 60 * 1000;
// 离散事件（升级 / 死亡 / 任务 / 稀有物品）的文本在服务器上往往固定不变（「你升级了！」），5 分钟内两次真实发生不能被合并：
// 只抑制服务器短时重发（同文本、仍未读、几秒内）
const DISCRETE_RETRANSMIT_WINDOW_MS = 10 * 1000;
// 离散事件：每次发生都是独立进展（再次死亡、再升一级、另一任务、另一件稀有物品）：
// 已读告警不压制，未读告警也只在上下文相同时才算重复；持续性场景（boss / puzzle / npc_talk）按 id 在窗口内去重，否则一清就刷屏。
const DISCRETE_EVENT_IDS = new Set(["death", "level_up", "quest_update", "rare_item"]);

export function checkTriggers(
  lines: string[],
  state: Partial<GameState>,
  existingAlerts: Alert[],
  prevState?: Partial<GameState>,
  opts: { firstLiveSample?: boolean } = {},
): CheckTriggersResult {
  const loginDone = state.loginDone === true;
  const candidates = lines
    .map((line) => ({ line, text: triggerText(line, loginDone) }))
    .filter((c): c is { line: string; text: string } => c.text !== null);
  const fireText = candidates.map((c) => c.text).join("\n");
  const alerts = [...existingAlerts];
  const now = new Date().toISOString();
  let changed = false;

  for (const trigger of TRIGGERS) {
    let fired = false;
    if (trigger.re) fired = trigger.re.test(fireText);
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
        const discrete = DISCRETE_EVENT_IDS.has(trigger.id);
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
            : lines.find((l) => !isAmbientLine(l))) || "",
        time: now,
        read: false,
      });
      changed = true;
    }
  }

  return { alerts: alerts.slice(0, 50), changed };
}
