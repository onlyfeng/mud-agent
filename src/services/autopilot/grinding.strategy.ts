/**
 * 挂机策略：寻怪 → 战斗循环。
 */

import { detectCombat, detectCombatEnd } from "../../core/text-analyzer.js";
import type { GameState, IStrategy, OutputLine, StrategyAction, StrategyContext } from "../../core/types.js";

const LONG_FIGHT_ROUNDS = 6;
const COMBAT_QUIET_TICKS = 2;

/** 本批输出里最后一个战斗相关行是结束信号（而不是新的攻击）才算战斗结束：「野狼死了」之后「老虎向你发动攻击」仍在战斗 */
function combatEndedByOrder(lines: OutputLine[]): boolean {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (detectCombatEnd([lines[i]])) return true;
    if (detectCombat([lines[i]])) return false;
  }
  return false;
}

// 只有肯定的、未被否定词修饰的继续战斗选择才算（「停止战斗」「不要继续战斗」含 战斗/继续 但是否定）
const FIGHT_NEGATION_RE = /不|别|勿|停|止|放弃|放手|停止|stop|halt|cease|\bno\b|don'?t|do not|never/i;
export function choiceContinuesFight(choice: string): boolean {
  if (FIGHT_NEGATION_RE.test(choice)) return false;
  return /继续|战斗|打|fight|continue|keep/i.test(choice);
}

export class GrindingStrategy implements IStrategy {
  private phase: "seek" | "combat" = "seek";
  private roundCount = 0;
  private combatSerial = 0; // 每场战斗递增：同一场战斗的每轮 combat_long 共用一个实例键，轮数不进键
  private nextReminderRound = LONG_FIGHT_ROUNDS; // 下一次长战斗提醒的轮数阈值；「继续战斗」后再推迟 LONG_FIGHT_ROUNDS 轮
  private holdAttack = false; // 用户选了停止 / 否定类选择：本场战斗内不再主动发 fight，直到战斗结束或用户肯定地选择继续
  private quietTicks = 0; // 战斗中连续没有战斗文本的轮数：慢服务器一轮静默不算战斗结束
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

    // 长战斗决策：「主动撤退」立刻撤退；「继续战斗」把下次提醒推迟 LONG_FIGHT_ROUNDS 轮并继续打（用户的选择先于本批战斗判断）
    if (ctx.resolvedDecision) {
      const choice = ctx.resolvedDecision.choice ?? "";
      // 否定词先于撤退关键词：「不要撤退，继续战斗」是继续，不是撤退
      const retreatNegated =
        /(?:不要|不想|不用|不必|别|勿|don'?t|do not|never|no)\s*(?:撤退|逃跑?|flee|retreat|escape)/i.test(choice);
      if (!retreatNegated && /撤退|逃|flee|retreat|escape/i.test(choice)) {
        this.phase = "seek";
        this.roundCount = 0;
        this.narrativeParts.push("按用户决定，主动撤退。");
        return { command: "flee", narrative: this.flushNarrative(state) };
      }
      if (choiceContinuesFight(choice)) {
        this.holdAttack = false;
        // 等用户决定期间战斗可能已经结束（对手死了 / 跑了）：按行序看最后一个战斗信号——结束行之后又有新对手攻击则仍在战斗
        if (combatEndedByOrder(newLines)) {
          this.narrativeParts.push("用户选择继续战斗，但战斗已经结束。");
          this.roundCount = 0;
          this.quietTicks = 0;
          this.phase = "seek";
          return { command: null, narrative: null };
        }
        this.nextReminderRound = this.roundCount + LONG_FIGHT_ROUNDS;
        this.narrativeParts.push("按用户决定，继续战斗。");
        return { command: "fight", narrative: null };
      }
      if (/停|止|不|别|勿|stop|halt|cease|\bno\b|don'?t|do not/i.test(choice)) {
        // 否定 / 停止类选择：本场战斗内不再主动攻击（状态持续到战斗结束或用户肯定地选择继续），也不主动撤退
        this.holdAttack = true;
        this.narrativeParts.push("按用户决定，停止主动攻击。");
        this.nextReminderRound = this.roundCount + LONG_FIGHT_ROUNDS;
        return { command: null, narrative: null };
      }
    }

    const inCombat = detectCombat(newLines);

    if (inCombat) {
      if (this.phase !== "combat") {
        this.combatSerial++;
        this.nextReminderRound = LONG_FIGHT_ROUNDS;
        this.holdAttack = false;
      }
      this.phase = "combat";
      this.roundCount++;
      this.narrativeParts.push(`战斗第${this.roundCount}轮。`);

      if (this.roundCount >= this.nextReminderRound) {
        return {
          command: null,
          narrative: null,
          pauseEvent: {
            eventType: "combat_long",
            instanceKey: `combat_long|${this.combatSerial}`,
            priority: "high",
            summary: `已战斗 ${this.roundCount} 轮，HP ${Math.round(hpPct)}%。`,
            context: `当前位置：${state.location || "未知"}。`,
            options: ["继续战斗", "主动撤退"],
          },
        };
      }

      this.quietTicks = 0;
      return { command: this.holdAttack ? null : "fight", narrative: null };
    }

    if (this.phase === "combat") {
      // 战斗结束只认明确的结束信号，或连续 COMBAT_QUIET_TICKS 轮没有战斗文本；单轮静默时保持战斗状态（含停止攻击的选择）
      const ended = combatEndedByOrder(newLines) || ++this.quietTicks >= COMBAT_QUIET_TICKS;
      if (!ended) return { command: null, narrative: null };
      this.narrativeParts.push("战斗结束。");
      this.roundCount = 0;
      this.quietTicks = 0;
      this.phase = "seek";
      this.holdAttack = false;
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
