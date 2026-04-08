/**
 * 挂机策略：寻怪 → 战斗循环。
 */

import { detectCombat } from "../../core/text-analyzer.js";
import type { GameState, IStrategy, StrategyAction, StrategyContext } from "../../core/types.js";

export class GrindingStrategy implements IStrategy {
  private phase: "seek" | "combat" = "seek";
  private roundCount = 0;
  private narrativeParts: string[] = [];
  private stepCount = 0;

  decide(ctx: StrategyContext): StrategyAction {
    const { state, newLines, config } = ctx;
    const hpPct = state.maxHp ? ((state.hp ?? 0) / state.maxHp) * 100 : 100;

    if (hpPct < config.safetyBoundary.minHpPercent) {
      this.phase = "seek";
      this.roundCount = 0;
      this.narrativeParts.push(`HP 告急（${Math.round(hpPct)}%），撤退。`);
      return {
        command: "flee",
        narrative: this.flushNarrative(state),
      };
    }

    const inCombat = detectCombat(newLines);

    if (inCombat) {
      this.phase = "combat";
      this.roundCount++;
      this.narrativeParts.push(`战斗第${this.roundCount}轮。`);

      if (this.roundCount >= 6) {
        return {
          command: null,
          narrative: null,
          pauseEvent: {
            eventType: "combat_long",
            priority: "high",
            summary: `已战斗 ${this.roundCount} 轮，HP ${Math.round(hpPct)}%。`,
            context: `当前位置：${state.location || "未知"}。`,
            options: ["继续战斗", "主动撤退"],
          },
        };
      }

      return { command: "fight", narrative: null };
    }

    if (this.phase === "combat") {
      this.narrativeParts.push("战斗结束。");
      this.roundCount = 0;
      this.phase = "seek";
    }

    this.stepCount++;
    const narrative = this.stepCount % (config.reportInterval || 4) === 0 ? this.flushNarrative(state) : null;

    return { command: "look", narrative };
  }

  private flushNarrative(state: GameState): string | null {
    if (this.narrativeParts.length === 0) return null;
    const hpInfo = state.maxHp ? `HP ${state.hp}/${state.maxHp}。` : "";
    const text = this.narrativeParts.join("") + hpInfo;
    this.narrativeParts = [];
    return text;
  }
}
