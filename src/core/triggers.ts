/**
 * 触发器定义 + checkTriggers()
 * zMUD triggers 的 AI 版本。
 */

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

export function checkTriggers(
  lines: string[],
  state: Partial<GameState>,
  existingAlerts: Alert[],
): CheckTriggersResult {
  const text = lines.join("\n");
  const alerts = [...existingAlerts];
  const now = new Date().toISOString();
  let changed = false;

  for (const trigger of TRIGGERS) {
    let fired = false;
    if (trigger.re) fired = trigger.re.test(text);
    if (trigger.checkFn) fired = fired || trigger.checkFn(lines, state as GameState);

    if (fired) {
      const recent = alerts.find((a) => a.id === trigger.id && Date.now() - new Date(a.time).getTime() < 3000);
      if (!recent) {
        alerts.unshift({
          id: trigger.id,
          priority: trigger.priority as AlertPriority,
          label: trigger.label,
          advice: trigger.advice,
          context: lines.find((l) => (trigger.re ? trigger.re.test(l) : true)) || "",
          time: now,
          read: false,
        });
        changed = true;
      }
    }
  }

  return { alerts: alerts.slice(0, 50), changed };
}
