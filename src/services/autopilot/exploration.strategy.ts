/**
 * 探索策略：look → pickup → move 循环。
 */

import { isAmbientChatLine, isEmoteNoiseLine, isLogNoiseLine, stripAsciiIds } from "../../core/noise-filter.js";
import {
  detectAlertType,
  detectCombat,
  parseExitsFromLines,
  parseItemsFromLines,
  parseRoomName,
} from "../../core/text-analyzer.js";
import type { GameState, IStrategy, OutputLine, StrategyAction, StrategyContext } from "../../core/types.js";

const DEFAULT_NOTIFY_ON = ["rare_item", "boss", "puzzle", "level_up"];

// 房间名候选里排除告警行与所有已知环境噪音（频道、他人移动播报、表情、装饰线）：
// 「妖王出现了」「张三走了过来」这种 2–10 个汉字的播报也满足房间名的形状，不能当房间
function roomNameFrom(lines: OutputLine[]): string | null {
  return parseRoomName(lines.filter((l) => !isLogNoiseLine(l.text) && detectAlertType([l]) === null));
}
// look 回包没有可识别的出口行时，最多等这么多轮（每轮 loopInterval）再按已到的内容处理
const LOOK_CONFIRM_TICKS = 3;

// 决策选项里只有"继续探索"（或明确提到捡/拾取）才视为允许拾取；带否定词（不要捡 / do not pick）一律不拾取；
// 没有 choice 文本时按允许处理（兼容只标 resolved 的旧决策）
// 任何「不/别/勿/拒绝/放弃…」+ 拾取类动词的组合都是拒绝（「不拾取」「不捡」「拒绝拾取」），单独的否定词也算
const PICKUP_NEGATION_RE =
  /(?:不|别|勿|拒绝|放弃|跳过|忽略|免|莫)\s*(?:要|想|用|必|能|可|准|许|去)?\s*(?:拾取|拾|捡|捡起|拿|取|pick|grab|take)|不要|不想|不用|不必|不能|不可|别|勿|拒绝|放弃|跳过|忽略|\bdon'?t\b|\bdo not\b|\bnot\b|\bno\b|\bnever\b|\bskip\b|\bleave\b|\bignore\b/i;
export function choiceAllowsPickup(choice: string | null): boolean {
  if (choice === null || choice.trim() === "") return true;
  if (PICKUP_NEGATION_RE.test(choice)) return false;
  return /继续|捡|拾取|pick|continue/i.test(choice);
}

const REVERSE_EXITS: Record<string, string> = {
  north: "south",
  south: "north",
  east: "west",
  west: "east",
  up: "down",
  down: "up",
  northeast: "southwest",
  southwest: "northeast",
  northwest: "southeast",
  southeast: "northwest",
  n: "s",
  s: "n",
  e: "w",
  w: "e",
  u: "d",
  d: "u",
  ne: "sw",
  sw: "ne",
  nw: "se",
  se: "nw",
  北: "南",
  南: "北",
  东: "西",
  西: "东",
  上: "下",
  下: "上",
  东北: "西南",
  西南: "东北",
  西北: "东南",
  东南: "西北",
  in: "out",
  out: "in",
  enter: "out",
  leave: "in",
  exit: "in",
  进: "出",
  出: "进",
  进入: "出去",
  出去: "进入",
};
// 同一方向的别名（长名 / 缩写 / 中文）：反向出口在当前房间实际提供的出口里挑一个（有的 MUD 只接受它列出的那种写法）
const EXIT_ALIAS_GROUPS: string[][] = [
  ["north", "n", "北"],
  ["south", "s", "南"],
  ["east", "e", "东"],
  ["west", "w", "西"],
  ["up", "u", "上"],
  ["down", "d", "下"],
  ["northeast", "ne", "东北"],
  ["southwest", "sw", "西南"],
  ["northwest", "nw", "西北"],
  ["southeast", "se", "东南"],
  ["in", "enter", "进", "进入"],
  ["out", "leave", "exit", "出", "出去"],
];
const EXIT_ALIASES: Record<string, string[]> = Object.fromEntries(
  EXIT_ALIAS_GROUPS.flatMap((group) => group.map((name) => [name, group])),
);

export function reverseExit(exit: string, availableExits: readonly string[] = []): string | null {
  const key = exit.trim();
  const primary = REVERSE_EXITS[key.toLowerCase()] ?? REVERSE_EXITS[key] ?? null;
  if (primary === null) return null;
  const candidates = EXIT_ALIASES[primary] ?? EXIT_ALIASES[primary.toLowerCase()] ?? [primary];
  const offered = new Set(availableExits.map((e) => e.trim().toLowerCase()));
  return candidates.find((c) => offered.has(c.toLowerCase())) ?? primary;
}

/** 决策文本的导航语义：hold = 停下查看 / 等待；back = 返回 / 原路退回；null = 继续或无导航含义 */
export function classifyNavigationChoice(choice: string | null): "hold" | "back" | null {
  if (choice === null) return null;
  const c = choice.trim();
  if (/^(停下|停下查看|查看|停止|等待|观望|暂停|stop|wait|hold|look)/i.test(c)) return "hold";
  if (/^(返回|退回|回去|后退|撤回|back|return|retreat)/i.test(c)) return "back";
  return null;
}

export class ExplorationStrategy implements IStrategy {
  private phase: "look" | "move" | "pickup" = "look";
  private visitedRooms = new Set<string>();
  private lastExits: string[] = [];
  private stepCount = 0;
  private narrativeParts: string[] = [];
  private lookWaiting = false;
  private pendingPickup: StrategyAction | null = null; // 半自动暂停时压住的拾取命令，恢复后先发
  private lastRoomName: string | null = null;
  private lastExit: string | null = null; // 最近一次移动走的出口，"返回"时走它的反方向
  private holdAfterLook = false; // 「停下查看」：先发 look 等回包，回包消费完再暂停等指示
  private lookWaitTicks = 0; // 等 look 回包的轮数（空轮也计）：没有出口行确认时最多等这么多轮再按已到的内容处理
  private lookBuffer: OutputLine[] = []; // 等待期间到达的行：确认或超时后一并当作回包处理

  decide(ctx: StrategyContext): StrategyAction {
    const { state, newLines, config } = ctx;
    const inCombat = detectCombat(newLines);

    if (inCombat) {
      const hpPct = state.maxHp ? ((state.hp ?? 0) / state.maxHp) * 100 : 100;
      if (!config.combatEnabled || hpPct < config.safetyBoundary.minHpPercent + 10) {
        this.narrativeParts.push("遭遇战斗，选择撤退。");
        // 刚解决的决策在这里被撤退取代：撤退本身就离开了房间，压住的拾取作废
        this.pendingPickup = null;
        return { command: "flee", narrative: null };
      }
    }

    // 用户刚解决的决策先于本批的告警处理（否则暂停期间积累的新告警会抢在导航语义之前返回，用户的选择就丢了）
    const directed = this.applyResolvedDecision(ctx);
    if (directed) return directed;

    // 先消费 look 的回包（房间名 / 出口 / 物品），再决定是否播报：否则播报分支先返回，lookWaiting 永远清不掉，探索停摆
    let pickupAction: StrategyAction | null = null;
    let holdNow = false;
    // 任何带出口行的回包（look 或移动后的房间描述）都更新当前房间：实例键按事件发生的房间区分
    if (newLines.length > 0 && parseExitsFromLines(newLines)) {
      const described = roomNameFrom(newLines);
      if (described) this.lastRoomName = described;
    }
    // look 回包以出口行确认：先到的闲聊 / 移动播报不算回包（先缓存），不然出口与物品不会被刷新；
    // 每轮（包括静默轮）都推进计数，LOOK_CONFIRM_TICKS 轮后按缓存里已到的内容处理；什么都没到就放弃这次 look（下一轮重发）
    let lookLines: OutputLine[] | null = null;
    if (this.lookWaiting) {
      this.lookBuffer.push(...newLines);
      this.lookWaitTicks += 1;
      if (parseExitsFromLines(newLines) !== null) lookLines = this.lookBuffer;
      else if (this.lookWaitTicks >= LOOK_CONFIRM_TICKS)
        lookLines = this.lookBuffer.length > 0 ? this.lookBuffer : null;
      if (lookLines !== null || this.lookWaitTicks >= LOOK_CONFIRM_TICKS) {
        this.lookWaiting = false;
        this.lookWaitTicks = 0;
        this.lookBuffer = [];
      }
    }
    // 实例键用的房间：回包被拆成多批时（首批房间名 + boss，出口行稍后到）从累计缓冲 / 本批解析，不能用移动前的房间
    const roomForKey: string =
      (this.lookBuffer.length > 0 ? roomNameFrom(this.lookBuffer) : null) ??
      (lookLines ? roomNameFrom(lookLines) : null) ??
      (this.phase === "look" && newLines.length > 0 ? roomNameFrom(newLines) : null) ??
      this.lastRoomName ??
      state.location ??
      "";
    if (lookLines !== null) {
      const roomName = roomNameFrom(lookLines) || state.location || "未知地点";
      this.lastRoomName = roomName;
      const exits = parseExitsFromLines(lookLines) || state.exits || [];
      const items = parseItemsFromLines(lookLines);

      this.lastExits = exits;
      this.narrativeParts.push(`来到${roomName}。`);
      if (items.length > 0) {
        this.narrativeParts.push(`地上有：${items.slice(0, 3).join("、")}。`);
      }

      // 阶段先推进到 move；真正发出拾取命令的那一刻才进入 pickup（暂停压住的命令不能让阶段先跑）
      this.phase = "move";
      if (items.length > 0 && config.autoPickup) pickupAction = { command: "get all", narrative: null };
      // 「停下查看」的 look 回包已消费（出口 / 物品都是新的）：现在再暂停等指示
      if (this.holdAfterLook) {
        this.holdAfterLook = false;
        holdNow = true;
      }
    }
    // 触发行先过噪音：频道闲聊里提到的 boss、玩家 ASCII id 里的 boss 都不是事件
    const triggerLines = newLines
      .filter((l) => !isAmbientChatLine(l.text) && !isEmoteNoiseLine(l.text))
      .map((l) => ({ ...l, text: stripAsciiIds(l.text) }));
    const alertType = detectAlertType(triggerLines);
    const shouldPause = alertType !== null && config.pauseOn.includes(alertType);
    const shouldNotify = alertType !== null && (config.notifyOn ?? DEFAULT_NOTIFY_ON).includes(alertType);
    if (alertType && (shouldPause || shouldNotify)) {
      const texts = triggerLines
        .map((l) => l.text)
        .join("；")
        .slice(0, 200);
      // 实例身份 = 类型 + 触发行 + 位置：换一个 boss / 另一件稀有物品是新实例，同一条播报重复命中是同一实例
      const triggerLine = triggerLines.find((l) => detectAlertType([l]) === alertType)?.text ?? "";
      // 位置用本批 / 最近一次 look 解析出的房间名（state.location 没有运行时写入方）：不同房间的同一句播报是不同实例
      const instanceKey = `${alertType}|${roomForKey}|${triggerLine.slice(0, 80)}`;
      // 只播报不暂停时，本轮已消费的 look 回包决定的拾取命令照常发出（command 与播报同一回合返回）；
      // 要暂停时把它压到 pendingPickup，用户决策后恢复的第一轮先发。
      // 「停下查看」的回包里出现关键事件：该事件的决策取代泛化的 hold 决策（用户在事件决策里选继续 / 停下 / 返回）。
      // 回包分片时事件行可能先于出口行到达——此时 look 还没确认，但用户要的"停下等指示"已由这个事件决策承担，
      // 清掉待办的 hold，后到的出口分片不再追加第二个 hold 决策
      if (shouldPause) this.holdAfterLook = false;
      if (shouldPause || holdNow) this.pendingPickup = pickupAction ?? this.pendingPickup;
      else if (pickupAction) this.phase = "pickup";
      return {
        command: shouldPause || holdNow ? null : (pickupAction?.command ?? null),
        narrative: null,
        pauseEvent: {
          eventType: alertType,
          instanceKey,
          pause: shouldPause || holdNow,
          priority: "high",
          summary: `发现 ${alertType} 事件`,
          context: `位置：${state.location || "未知"}。相关文本：${texts}`,
          options: ["继续探索", "停下查看", "返回"],
        },
      };
    }
    // 「停下查看」的回包里没有关键事件：现在再暂停等指示（出口 / 物品已刷新，拾取意图保留到用户决定）
    if (holdNow) {
      this.pendingPickup = pickupAction ?? this.pendingPickup;
      return { command: null, narrative: null, pauseEvent: this.holdEvent() };
    }

    const pickup = this.pendingPickup ?? pickupAction;
    if (pickup) {
      this.pendingPickup = null;
      this.phase = "pickup";
      return pickup;
    }

    if (this.phase === "look" && !this.lookWaiting) {
      this.lookWaiting = true;
      return { command: "look", narrative: null };
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
      this.lastExit = exit;
      this.phase = "look";
      this.stepCount++;

      const narrative = this.stepCount % (config.reportInterval || 4) === 0 ? this.flushNarrative(state) : null;

      return { command: exit, narrative };
    }

    return { command: null, narrative: null };
  }

  /**
   * 用户刚解决的决策：拾取许可（只有"继续 / 拾取"类选择保留压住的拾取）与导航语义
   * （「停下查看」原地 look 并在回包消费后再暂停；「返回」走最近一次移动的反方向）。返回非 null 表示本轮由它决定动作。
   */
  private applyResolvedDecision(ctx: StrategyContext): StrategyAction | null {
    if (!ctx.resolvedDecision) return null;
    if (this.pendingPickup && !choiceAllowsPickup(ctx.resolvedDecision.choice)) {
      this.narrativeParts.push("按用户决定，未拾取。");
      this.pendingPickup = null;
    }
    const nav = classifyNavigationChoice(ctx.resolvedDecision.choice);
    if (nav === "hold") {
      // 先 look、等回包消费完（出口 / 物品刷新）再创建暂停决策；暂停期间服务层不会调用 decide，所以不能同轮返回决策。
      // 阶段同时切回 look：暂停事件来自已确认的 look 回包时 phase 已是 move，不切回去下一轮就会沿出口走掉
      this.phase = "look";
      this.lookWaiting = true;
      this.lookWaitTicks = 0;
      this.lookBuffer = [];
      this.holdAfterLook = true;
      return { command: "look", narrative: null };
    }
    if (nav === "back") {
      const back = this.lastExit ? reverseExit(this.lastExit, this.lastExits) : null;
      if (back) {
        this.narrativeParts.push(`按用户决定返回（${back}）。`);
        // 取消未完成的 look：暂停来自拆包回包时 lookBuffer 里还有当前房间的前半段，不能和返回后的房间描述拼在一起
        this.lookWaiting = false;
        this.lookWaitTicks = 0;
        this.lookBuffer = [];
        this.holdAfterLook = false;
        this.lastExit = back;
        this.phase = "look";
        this.stepCount++;
        return { command: back, narrative: null };
      }
      return { command: null, narrative: null, pauseEvent: this.holdEvent("不知道来路，已停下") };
    }
    return null;
  }

  private holdEvent(summary = "已停下查看，等待指示"): NonNullable<StrategyAction["pauseEvent"]> {
    return {
      eventType: "hold",
      instanceKey: `hold|${this.lastRoomName ?? ""}|${Date.now()}`,
      pause: true,
      priority: "normal",
      summary,
      context: `位置：${this.lastRoomName ?? "未知"}。`,
      options: ["继续探索", "返回"],
    };
  }

  private flushNarrative(state: GameState): string | null {
    if (this.narrativeParts.length === 0) return null;
    const hpInfo = state.maxHp ? `HP ${state.hp}/${state.maxHp}。` : "";
    const text = this.narrativeParts.join("") + hpInfo;
    this.narrativeParts = [];
    return text;
  }
}
