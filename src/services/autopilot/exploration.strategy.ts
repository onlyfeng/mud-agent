/**
 * 探索策略：look → pickup → move 循环。
 */

import {
  detectAlertType,
  detectCombat,
  parseExitsFromLines,
  parseItemsFromLines,
  parseRoomName,
} from "../../core/text-analyzer.js";
import type { GameState, IStrategy, StrategyAction, StrategyContext } from "../../core/types.js";

export class ExplorationStrategy implements IStrategy {
  private phase: "look" | "move" | "pickup" = "look";
  private visitedRooms = new Set<string>();
  private lastExits: string[] = [];
  private stepCount = 0;
  private narrativeParts: string[] = [];
  private lookWaiting = false;

  decide(ctx: StrategyContext): StrategyAction {
    const { state, newLines, config } = ctx;
    const inCombat = detectCombat(newLines);

    if (inCombat) {
      const hpPct = state.maxHp ? ((state.hp ?? 0) / state.maxHp) * 100 : 100;
      if (!config.combatEnabled || hpPct < config.safetyBoundary.minHpPercent + 10) {
        this.narrativeParts.push("遭遇战斗，选择撤退。");
        return { command: "flee", narrative: null };
      }
    }

    const alertType = detectAlertType(newLines);
    if (alertType && config.pauseOn.includes(alertType)) {
      const texts = newLines
        .map((l) => l.text)
        .join("；")
        .slice(0, 200);
      return {
        command: null,
        narrative: null,
        pauseEvent: {
          eventType: alertType,
          priority: "high",
          summary: `发现 ${alertType} 事件`,
          context: `位置：${state.location || "未知"}。相关文本：${texts}`,
          options: ["继续探索", "停下查看", "返回"],
        },
      };
    }

    if (this.phase === "look" && !this.lookWaiting) {
      this.lookWaiting = true;
      return { command: "look", narrative: null };
    }

    if (this.lookWaiting && newLines.length > 0) {
      this.lookWaiting = false;
      const roomName = parseRoomName(newLines) || state.location || "未知地点";
      const exits = parseExitsFromLines(newLines) || state.exits || [];
      const items = parseItemsFromLines(newLines);

      this.lastExits = exits;
      this.narrativeParts.push(`来到${roomName}。`);
      if (items.length > 0) {
        this.narrativeParts.push(`地上有：${items.slice(0, 3).join("、")}。`);
      }

      if (items.length > 0 && config.autoPickup) {
        this.phase = "pickup";
        return { command: "get all", narrative: null };
      }
      this.phase = "move";
    }

    if (this.phase === "pickup") {
      if (newLines.length > 0) {
        const pickedLines = newLines.filter((l) => /你捡起/.test(l.text));
        if (pickedLines.length > 0) {
          this.narrativeParts.push(`捡起了${pickedLines.length}样物品。`);
        }
      }
      this.phase = "move";
      return { command: null, narrative: null };
    }

    if (this.phase === "move") {
      const exits = this.lastExits.length > 0 ? this.lastExits : state.exits || [];
      if (exits.length === 0) {
        this.narrativeParts.push("没有找到出口，原地等待。");
        this.phase = "look";
        this.stepCount++;
        return { command: null, narrative: this.flushNarrative(state) };
      }

      const room = state.location || "?";
      const unvisited = exits.filter((e) => !this.visitedRooms.has(`${room}:${e}`));
      const exit =
        unvisited.length > 0
          ? unvisited[Math.floor(Math.random() * unvisited.length)]
          : exits[Math.floor(Math.random() * exits.length)];

      this.visitedRooms.add(`${room}:${exit}`);
      this.phase = "look";
      this.stepCount++;

      const narrative = this.stepCount % (config.reportInterval || 4) === 0 ? this.flushNarrative(state) : null;

      return { command: exit, narrative };
    }

    return { command: null, narrative: null };
  }

  private flushNarrative(state: GameState): string | null {
    if (this.narrativeParts.length === 0) return null;
    const hpInfo = state.maxHp ? `HP ${state.hp}/${state.maxHp}。` : "";
    const text = this.narrativeParts.join("") + hpInfo;
    this.narrativeParts = [];
    return text;
  }
}
