import { describe, expect, it } from "vitest";
import type { AutopilotConfig, GameState, OutputLine } from "../../core/types";
import { choiceAllowsPickup, classifyNavigationChoice, ExplorationStrategy, reverseExit } from "./exploration.strategy";
import { choiceContinuesFight, GrindingStrategy } from "./grinding.strategy";

const state = { hp: 100, maxHp: 100, location: "荒野" } as GameState;
const config = {
  pauseOn: ["boss", "rare_item"],
  combatEnabled: true,
  safetyBoundary: { minHpPercent: 30 },
} as unknown as AutopilotConfig;
const line = (text: string): OutputLine => ({ ts: new Date().toISOString(), text }) as OutputLine;

describe("pause event instance identity", () => {
  it("two different bosses within the cooldown get different instance keys; the same broadcast repeats the key", () => {
    const strategy = new ExplorationStrategy();
    const a = strategy.decide({ state, config, alerts: [], newLines: [line("一只妖王 (yao wang) 出现了")] }).pauseEvent;
    const b = strategy.decide({ state, config, alerts: [], newLines: [line("一只魔王 (mo wang) 出现了")] }).pauseEvent;
    const a2 = strategy.decide({
      state,
      config,
      alerts: [],
      newLines: [line("一只妖王 (yao wang) 出现了")],
    }).pauseEvent;
    expect(a?.instanceKey).toBeDefined();
    expect(a?.instanceKey).not.toBe(b?.instanceKey);
    expect(a?.instanceKey).toBe(a2?.instanceKey);
  });

  it("full-auto exploration (pauseOn empty) still emits notice-only events for bosses", () => {
    const strategy = new ExplorationStrategy();
    const fullAuto = { ...config, pauseOn: [], notifyOn: ["boss", "rare_item"] } as unknown as AutopilotConfig;
    const evt = strategy.decide({ state, config: fullAuto, alerts: [], newLines: [line("一只妖王出现了")] }).pauseEvent;
    expect(evt?.eventType).toBe("boss");
    expect(evt?.pause).toBe(false); // 只播报不暂停
    const semi = strategy.decide({ state, config, alerts: [], newLines: [line("一只妖王出现了")] }).pauseEvent;
    expect(semi?.pause).toBe(true);
  });

  it("the same generic boss line in two different rooms yields two instance keys", () => {
    const strategy = new ExplorationStrategy();
    const fullAuto = { ...config, pauseOn: [], notifyOn: ["boss"], autoPickup: false } as unknown as AutopilotConfig;
    const keys: string[] = [];
    for (const room of ["荒野", "山洞"]) {
      strategy.decide({ state, config: fullAuto, alerts: [], newLines: [] }); // look
      const lookReply = [line(room), line("妖王出现了"), line("这里明显的出口是 north。")];
      keys.push(
        strategy.decide({ state, config: fullAuto, alerts: [], newLines: lookReply }).pauseEvent?.instanceKey ?? "",
      );
      strategy.decide({ state, config: fullAuto, alerts: [], newLines: [] }); // move
    }
    expect(keys[0]).not.toBe(keys[1]);
  });

  it("ambient chat mentioning a boss and ASCII ids containing boss do not trigger notices", () => {
    const strategy = new ExplorationStrategy();
    const fullAuto = { ...config, pauseOn: [], notifyOn: ["boss"] } as unknown as AutopilotConfig;
    expect(
      strategy.decide({ state, config: fullAuto, alerts: [], newLines: [line("【闲聊】有人提到魔王")] }).pauseEvent,
    ).toBeUndefined();
    expect(
      strategy.decide({ state, config: fullAuto, alerts: [], newLines: [line("玩家张三(bossman)走了过来")] })
        .pauseEvent,
    ).toBeUndefined();
  });

  it("a look response that also carries a notice is consumed: exploration keeps moving afterwards", () => {
    const strategy = new ExplorationStrategy();
    const fullAuto = { ...config, pauseOn: [], notifyOn: ["boss"], autoPickup: false } as unknown as AutopilotConfig;
    expect(strategy.decide({ state, config: fullAuto, alerts: [], newLines: [] }).command).toBe("look"); // 发 look
    const lookReply = [line("荒野"), line("这里有一只妖王。"), line("这里明显的出口是 north 和 south。")];
    const noticed = strategy.decide({ state, config: fullAuto, alerts: [], newLines: lookReply });
    expect(noticed.pauseEvent?.eventType).toBe("boss");
    // 下一轮没有新行：look 回包已消费，应该继续移动而不是停摆
    const next = strategy.decide({ state, config: fullAuto, alerts: [], newLines: [] });
    expect(next.command).toMatch(/^(north|south)$/);
  });

  it("a pickup prepared from the look response survives a semi-auto pause and is issued on resume", () => {
    const strategy = new ExplorationStrategy();
    const semi = { ...config, pauseOn: ["rare_item"], autoPickup: true } as unknown as AutopilotConfig;
    expect(strategy.decide({ state, config: semi, alerts: [], newLines: [] }).command).toBe("look");
    const lookReply = [line("荒野"), line("□ 天书(tian shu)"), line("这里明显的出口是 north。")];
    const paused = strategy.decide({ state, config: semi, alerts: [], newLines: lookReply });
    expect(paused.pauseEvent?.pause).toBe(true);
    expect(paused.command).toBeNull(); // 暂停：不发命令
    // 用户选择"继续探索"后恢复：先补发拾取，而不是直接走人
    const resumed = strategy.decide({
      state,
      config: semi,
      alerts: [],
      newLines: [],
      resolvedDecision: { eventType: "rare_item", choice: "继续探索" },
    });
    expect(resumed.command).toBe("get all");
    const after = strategy.decide({ state, config: semi, alerts: [], newLines: [line("你捡起了一本书。")] });
    expect(after.command).toBeNull(); // pickup 阶段消费回包
    expect(strategy.decide({ state, config: semi, alerts: [], newLines: [] }).command).toBe("north");
  });

  it("a pending pickup is dropped when the user resolves the pause with 返回 / 停下查看", () => {
    const strategy = new ExplorationStrategy();
    const semi = { ...config, pauseOn: ["rare_item"], autoPickup: true } as unknown as AutopilotConfig;
    strategy.decide({ state, config: semi, alerts: [], newLines: [] });
    const lookReply = [line("荒野"), line("□ 天书(tian shu)"), line("这里明显的出口是 north。")];
    expect(strategy.decide({ state, config: semi, alerts: [], newLines: lookReply }).pauseEvent?.pause).toBe(true);
    const resumed = strategy.decide({
      state,
      config: semi,
      alerts: [],
      newLines: [],
      resolvedDecision: { eventType: "rare_item", choice: "返回" },
    });
    expect(resumed.command).not.toBe("get all"); // 不拾取
  });

  it("negated choices never allow the pickup; plain continue / pick choices do", () => {
    for (const c of [
      "不要拾取",
      "不要捡",
      "不拾取",
      "不捡",
      "拒绝拾取",
      " 不拾取",
      "do not pick",
      "don't pick it up",
      "skip the pickup",
      "别捡",
    ]) {
      expect(choiceAllowsPickup(c)).toBe(false);
    }
    for (const c of ["继续探索", "捡起来", "pick it up", "continue"]) expect(choiceAllowsPickup(c)).toBe(true);
    expect(choiceAllowsPickup("返回")).toBe(false);
    expect(choiceAllowsPickup(null)).toBe(true);
  });

  it("返回 walks back through the reverse of the last exit; 停下查看 looks and pauses again", () => {
    expect(reverseExit("north")).toBe("south");
    expect(reverseExit("东北")).toBe("西南");
    expect(reverseExit("in")).toBe("out");
    expect(reverseExit("out", ["enter", "north"])).toBe("enter"); // 来路叫 enter 就走 enter
    expect(reverseExit("out", ["in"])).toBe("in");
    expect(reverseExit("enter", ["leave"])).toBe("leave");
    expect(reverseExit("进入", ["出去"])).toBe("出去");
    expect(reverseExit("north", ["s", "e"])).toBe("s"); // 房间只列缩写
    expect(reverseExit("n", ["south"])).toBe("south");
    expect(reverseExit("东北", ["sw"])).toBe("sw");
    expect(reverseExit("north", [])).toBe("south"); // 不知道房间出口：用长名
    expect(classifyNavigationChoice("停下查看")).toBe("hold");
    expect(classifyNavigationChoice("返回")).toBe("back");
    expect(classifyNavigationChoice("继续探索")).toBeNull();

    const strategy = new ExplorationStrategy();
    const semi = { ...config, pauseOn: ["boss"], autoPickup: false } as unknown as AutopilotConfig;
    strategy.decide({ state, config: semi, alerts: [], newLines: [] }); // look
    // look 回包被消费后同一轮就选出口移动
    expect(
      strategy.decide({ state, config: semi, alerts: [], newLines: [line("荒野"), line("这里明显的出口是 north。")] })
        .command,
    ).toBe("north");
    const paused = strategy.decide({
      state,
      config: semi,
      alerts: [],
      newLines: [line("山洞"), line("一只妖王出现了"), line("这里明显的出口是 south。")],
    });
    expect(paused.pauseEvent?.pause).toBe(true);
    // 用户选"返回"：走 north 的反方向
    const back = strategy.decide({
      state,
      config: semi,
      alerts: [],
      newLines: [],
      resolvedDecision: { eventType: "boss", choice: "返回" },
    });
    expect(back.command).toBe("south");
    // 用户选"停下查看"：先 look（本轮不带决策），回包消费后才再次暂停（新决策：继续探索 / 返回）
    const hold = strategy.decide({
      state,
      config: semi,
      alerts: [],
      newLines: [],
      resolvedDecision: { eventType: "boss", choice: "停下查看" },
    });
    expect(hold.command).toBe("look");
    expect(hold.pauseEvent).toBeUndefined();
    const afterLook = strategy.decide({
      state,
      config: semi,
      alerts: [],
      newLines: [line("荒野"), line("这里明显的出口是 east。")],
    });
    expect(afterLook.command).toBeNull();
    expect(afterLook.pauseEvent?.eventType).toBe("hold");
    expect(afterLook.pauseEvent?.options).toEqual(["继续探索", "返回"]);
    // 继续探索：用的是刚 look 到的新出口
    const resume = strategy.decide({
      state,
      config: semi,
      alerts: [],
      newLines: [],
      resolvedDecision: { eventType: "hold", choice: "继续探索" },
    });
    expect(resume.command).toBe("east");
  });

  it("the room used for the instance key follows a movement reply that carries the room description", () => {
    const strategy = new ExplorationStrategy();
    const fullAuto = { ...config, pauseOn: [], notifyOn: ["boss"], autoPickup: false } as unknown as AutopilotConfig;
    const exits = line("这里明显的出口是 north 和 south。");
    strategy.decide({ state, config: fullAuto, alerts: [], newLines: [] }); // look
    strategy.decide({ state, config: fullAuto, alerts: [], newLines: [line("枢纽"), exits] }); // 消费 look 回包并移动
    const keys: string[] = [];
    for (const room of ["北屋", "南屋"]) {
      // 移动回包（不是 look 回包）：新房间描述 + 同一句 boss 播报
      const reply = [line(room), line("妖王出现了"), exits];
      keys.push(
        strategy.decide({ state, config: fullAuto, alerts: [], newLines: reply }).pauseEvent?.instanceKey ?? "",
      );
      strategy.decide({ state, config: fullAuto, alerts: [], newLines: [] }); // look
      strategy.decide({ state, config: fullAuto, alerts: [], newLines: [line(room), exits] }); // 消费 look 回包并移动
    }
    expect(keys[0]).toContain("北屋");
    expect(keys[1]).toContain("南屋");
  });

  it("a boss in the 停下查看 look reply takes precedence over the generic hold decision", () => {
    const strategy = new ExplorationStrategy();
    const semi = { ...config, pauseOn: ["boss"], autoPickup: false } as unknown as AutopilotConfig;
    strategy.decide({ state, config: semi, alerts: [], newLines: [] }); // look
    strategy.decide({ state, config: semi, alerts: [], newLines: [line("荒野"), line("这里明显的出口是 north。")] }); // move
    strategy.decide({
      state,
      config: semi,
      alerts: [],
      newLines: [line("山洞"), line("一只妖王出现了"), line("这里明显的出口是 south。")],
    }); // boss → 暂停
    expect(
      strategy.decide({
        state,
        config: semi,
        alerts: [],
        newLines: [],
        resolvedDecision: { eventType: "boss", choice: "停下查看" },
      }).command,
    ).toBe("look");
    const reply = strategy.decide({
      state,
      config: semi,
      alerts: [],
      newLines: [line("山洞"), line("一只魔王出现了"), line("这里明显的出口是 south。")],
    });
    expect(reply.pauseEvent?.eventType).toBe("boss"); // 关键事件的决策，而不是泛化的 hold
    expect(reply.pauseEvent?.pause).toBe(true);
    expect(reply.command).toBeNull();
  });

  it("a split 停下查看 reply (boss line before the exits line) asks the user once, not twice", () => {
    const strategy = new ExplorationStrategy();
    const semi = { ...config, pauseOn: ["boss"], autoPickup: false } as unknown as AutopilotConfig;
    strategy.decide({ state, config: semi, alerts: [], newLines: [] }); // look
    strategy.decide({ state, config: semi, alerts: [], newLines: [line("荒野"), line("这里明显的出口是 north。")] }); // move
    strategy.decide({
      state,
      config: semi,
      alerts: [],
      newLines: [line("山洞"), line("一只妖王出现了"), line("这里明显的出口是 south。")],
    }); // boss → 暂停
    strategy.decide({
      state,
      config: semi,
      alerts: [],
      newLines: [],
      resolvedDecision: { eventType: "boss", choice: "停下查看" },
    }); // look
    const first = strategy.decide({
      state,
      config: semi,
      alerts: [],
      newLines: [line("山洞"), line("一只魔王出现了")],
    }); // 分片 1：事件行先到
    expect(first.pauseEvent?.eventType).toBe("boss");
    expect(first.pauseEvent?.pause).toBe(true);
    const resumed = strategy.decide({
      state,
      config: semi,
      alerts: [],
      newLines: [line("这里明显的出口是 south。")], // 分片 2：出口行确认 look
      resolvedDecision: { eventType: "boss", choice: "继续探索" },
    });
    expect(resumed.pauseEvent).toBeUndefined(); // 不再追加第二个 hold 决策
  });

  it("a pending look is confirmed by the exits line: earlier chat / movement lines do not count as the reply", () => {
    const strategy = new ExplorationStrategy();
    const semi = { ...config, pauseOn: ["boss"], autoPickup: false } as unknown as AutopilotConfig;
    strategy.decide({ state, config: semi, alerts: [], newLines: [] }); // look
    strategy.decide({ state, config: semi, alerts: [], newLines: [line("荒野"), line("这里明显的出口是 north。")] }); // move
    strategy.decide({
      state,
      config: semi,
      alerts: [],
      newLines: [line("山洞"), line("一只妖王出现了"), line("这里明显的出口是 south。")],
    });
    strategy.decide({
      state,
      config: semi,
      alerts: [],
      newLines: [],
      resolvedDecision: { eventType: "boss", choice: "停下查看" },
    }); // look 发出
    // 先到的是闲聊 / 别人的移动播报：不是回包，继续等，不暂停
    const noise = strategy.decide({
      state,
      config: semi,
      alerts: [],
      newLines: [line("【闲聊】有人在聊天"), line("张三走了过来。")],
    });
    expect(noise.pauseEvent).toBeUndefined();
    expect(noise.command).toBeNull();
    // 真正的房间描述到达：刷新出口并暂停
    const real = strategy.decide({
      state,
      config: semi,
      alerts: [],
      newLines: [line("山洞"), line("这里明显的出口是 west。")],
    });
    expect(real.pauseEvent?.eventType).toBe("hold");
    const resume = strategy.decide({
      state,
      config: semi,
      alerts: [],
      newLines: [],
      resolvedDecision: { eventType: "hold", choice: "继续探索" },
    });
    expect(resume.command).toBe("west");
  });

  it("a look reply without a recognisable exits line is still processed after the confirm window, even through silent ticks", () => {
    const strategy = new ExplorationStrategy();
    const fullAuto = { ...config, pauseOn: [], notifyOn: [], autoPickup: false } as unknown as AutopilotConfig;
    expect(strategy.decide({ state, config: fullAuto, alerts: [], newLines: [] }).command).toBe("look");
    // 回包没有出口行（格式不识别），之后服务器静默
    expect(
      strategy.decide({ state, config: fullAuto, alerts: [], newLines: [line("荒野"), line("四周空无一物。")] })
        .command,
    ).toBeNull();
    expect(strategy.decide({ state, config: fullAuto, alerts: [], newLines: [] }).command).toBeNull();
    // 第 3 轮：超时，按缓存内容处理；没有出口 → 原地等待后回到 look 阶段
    const timedOut = strategy.decide({ state, config: fullAuto, alerts: [], newLines: [] });
    expect(timedOut.command).toBeNull();
    expect(strategy.decide({ state, config: fullAuto, alerts: [], newLines: [] }).command).toBe("look"); // 不会永久停住
  });

  it("a split room reply (room + boss first, exits later) keys the notice by the new room", () => {
    const strategy = new ExplorationStrategy();
    const fullAuto = { ...config, pauseOn: [], notifyOn: ["boss"], autoPickup: false } as unknown as AutopilotConfig;
    const exits = line("这里明显的出口是 north 和 south。");
    strategy.decide({ state, config: fullAuto, alerts: [], newLines: [] }); // look
    strategy.decide({ state, config: fullAuto, alerts: [], newLines: [line("枢纽"), exits] }); // 消费并移动
    const keys: string[] = [];
    for (const room of ["北屋", "南屋"]) {
      // 移动回包拆成两批：先房间名 + boss，出口行下一批才到
      keys.push(
        strategy.decide({ state, config: fullAuto, alerts: [], newLines: [line(room), line("妖王出现了")] }).pauseEvent
          ?.instanceKey ?? "",
      );
      strategy.decide({ state, config: fullAuto, alerts: [], newLines: [exits] });
      strategy.decide({ state, config: fullAuto, alerts: [], newLines: [] }); // look
      strategy.decide({ state, config: fullAuto, alerts: [], newLines: [line(room), exits] }); // 消费并移动
    }
    expect(keys[0]).toContain("北屋");
    expect(keys[1]).toContain("南屋");
  });

  it("a resolved 返回 is honoured even when a new boss line arrived during the pause", () => {
    const strategy = new ExplorationStrategy();
    const semi = { ...config, pauseOn: ["boss"], autoPickup: false } as unknown as AutopilotConfig;
    strategy.decide({ state, config: semi, alerts: [], newLines: [] }); // look
    strategy.decide({ state, config: semi, alerts: [], newLines: [line("荒野"), line("这里明显的出口是 north。")] }); // move
    strategy.decide({
      state,
      config: semi,
      alerts: [],
      newLines: [line("山洞"), line("一只妖王出现了"), line("这里明显的出口是 south。")],
    }); // boss → 暂停
    // 暂停期间又来了一条 boss 文本；用户选"返回"：先返回，不被新告警抢先
    const back = strategy.decide({
      state,
      config: semi,
      alerts: [],
      newLines: [line("一只魔王出现了")],
      resolvedDecision: { eventType: "boss", choice: "返回" },
    });
    expect(back.command).toBe("south");
    expect(back.pauseEvent).toBeUndefined();
  });

  it("grinding honours 主动撤退 from the long-fight decision", () => {
    const strategy = new GrindingStrategy();
    const fight = [line("野狼向你的胸口发动攻击")];
    for (let i = 0; i < 6; i++) strategy.decide({ state, config, alerts: [], newLines: fight });
    const out = strategy.decide({
      state,
      config,
      alerts: [],
      newLines: fight,
      resolvedDecision: { eventType: "combat_long", choice: "主动撤退" },
    });
    expect(out.command).toBe("flee");
  });

  it("a movement broadcast arriving before the room description is not taken as the room name", () => {
    const strategy = new ExplorationStrategy();
    const fullAuto = { ...config, pauseOn: [], notifyOn: ["boss"], autoPickup: false } as unknown as AutopilotConfig;
    const exits = line("这里明显的出口是 north 和 south。");
    strategy.decide({ state, config: fullAuto, alerts: [], newLines: [] }); // look
    strategy.decide({ state, config: fullAuto, alerts: [], newLines: [line("枢纽"), exits] }); // 消费并移动
    const evt = strategy.decide({
      state,
      config: fullAuto,
      alerts: [],
      newLines: [line("张三走了过来。"), line("北屋"), line("妖王出现了"), exits],
    }).pauseEvent;
    expect(evt?.instanceKey).toContain("|北屋|");
  });

  it("an alert line arriving alone after a move is not taken as the room name", () => {
    const strategy = new ExplorationStrategy();
    const fullAuto = { ...config, pauseOn: [], notifyOn: ["boss"], autoPickup: false } as unknown as AutopilotConfig;
    const exits = line("这里明显的出口是 north 和 south。");
    strategy.decide({ state, config: fullAuto, alerts: [], newLines: [] }); // look
    strategy.decide({ state, config: fullAuto, alerts: [], newLines: [line("枢纽"), exits] }); // 消费并移动
    const first = strategy.decide({ state, config: fullAuto, alerts: [], newLines: [line("妖王出现了")] }).pauseEvent;
    expect(first?.instanceKey).toContain("|枢纽|"); // 房间沿用上一个已知房间，而不是把告警行当房间
  });

  it("grinding 继续战斗 keeps fighting and defers the next long-fight reminder", () => {
    const strategy = new GrindingStrategy();
    const fight = [line("野狼向你的胸口发动攻击")];
    let paused = null as ReturnType<GrindingStrategy["decide"]> | null;
    for (let i = 0; i < 6; i++) paused = strategy.decide({ state, config, alerts: [], newLines: fight });
    expect(paused?.pauseEvent?.eventType).toBe("combat_long");
    const resumed = strategy.decide({
      state,
      config,
      alerts: [],
      newLines: fight,
      resolvedDecision: { eventType: "combat_long", choice: "继续战斗" },
    });
    expect(resumed.command).toBe("fight");
    for (let i = 0; i < 5; i++)
      expect(strategy.decide({ state, config, alerts: [], newLines: fight }).pauseEvent).toBeUndefined();
    expect(strategy.decide({ state, config, alerts: [], newLines: fight }).pauseEvent?.eventType).toBe("combat_long"); // 再过 6 轮才提醒
  });

  it("negated or stop-like fight choices never send fight", () => {
    for (const c of ["停止战斗", "不要继续战斗", "别打了", "stop fighting", "don't continue"]) {
      expect(choiceContinuesFight(c)).toBe(false);
    }
    for (const c of ["继续战斗", "继续", "fight on", "keep fighting"]) expect(choiceContinuesFight(c)).toBe(true);
    // 等用户决定期间战斗已经结束：「继续战斗」不再对不存在的目标发 fight
    const s3 = new GrindingStrategy();
    for (let i = 0; i < 6; i++) s3.decide({ state, config, alerts: [], newLines: [line("野狼向你的胸口发动攻击")] });
    const ended = s3.decide({
      state,
      config,
      alerts: [],
      newLines: [line("野狼死了。")],
      resolvedDecision: { eventType: "combat_long", choice: "继续战斗" },
    });
    expect(ended.command).toBeNull();
    // 结束行之后又有新对手攻击：仍在战斗，「继续战斗」照发 fight
    const s4 = new GrindingStrategy();
    for (let i = 0; i < 6; i++) s4.decide({ state, config, alerts: [], newLines: [line("野狼向你的胸口发动攻击")] });
    expect(
      s4.decide({
        state,
        config,
        alerts: [],
        newLines: [line("野狼死了。"), line("老虎向你的胸口发动攻击")],
        resolvedDecision: { eventType: "combat_long", choice: "继续战斗" },
      }).command,
    ).toBe("fight");
    // 「不要撤退，继续战斗」：否定先于撤退关键词，不发 flee
    const s2 = new GrindingStrategy();
    for (let i = 0; i < 6; i++) s2.decide({ state, config, alerts: [], newLines: [line("野狼向你的胸口发动攻击")] });
    expect(
      s2.decide({
        state,
        config,
        alerts: [],
        newLines: [line("野狼向你的胸口发动攻击")],
        resolvedDecision: { eventType: "combat_long", choice: "不要撤退，继续战斗" },
      }).command,
    ).not.toBe("flee");
    const strategy = new GrindingStrategy();
    const fight = [line("野狼向你的胸口发动攻击")];
    for (let i = 0; i < 6; i++) strategy.decide({ state, config, alerts: [], newLines: fight });
    const stopped = strategy.decide({
      state,
      config,
      alerts: [],
      newLines: fight,
      resolvedDecision: { eventType: "combat_long", choice: "停止战斗" },
    });
    expect(stopped.command).not.toBe("fight");
    // 之后的战斗轮次仍不主动攻击，直到战斗结束；中间一轮静默（慢服务器）不算战斗结束
    for (let i = 0; i < 3; i++)
      expect(strategy.decide({ state, config, alerts: [], newLines: fight }).command).not.toBe("fight");
    expect(strategy.decide({ state, config, alerts: [], newLines: [] }).command).toBeNull();
    expect(strategy.decide({ state, config, alerts: [], newLines: fight }).command).not.toBe("fight");
    strategy.decide({ state, config, alerts: [], newLines: [line("野狼死了。")] }); // 战斗结束
    for (let i = 0; i < 2; i++) strategy.decide({ state, config, alerts: [], newLines: fight }); // 新一场
    expect(strategy.decide({ state, config, alerts: [], newLines: fight }).command).toBe("fight");
  });

  it("停下查看 after a pause raised from a confirmed look reply does not walk off while waiting for the look", () => {
    const strategy = new ExplorationStrategy();
    const semi = { ...config, pauseOn: ["boss"], autoPickup: false } as unknown as AutopilotConfig;
    strategy.decide({ state, config: semi, alerts: [], newLines: [] }); // look
    // 已确认的 look 回包里就有 boss：阶段此时已推进到 move，然后暂停
    const paused = strategy.decide({
      state,
      config: semi,
      alerts: [],
      newLines: [line("山洞"), line("一只妖王出现了"), line("这里明显的出口是 south。")],
    });
    expect(paused.pauseEvent?.pause).toBe(true);
    const hold = strategy.decide({
      state,
      config: semi,
      alerts: [],
      newLines: [],
      resolvedDecision: { eventType: "boss", choice: "停下查看" },
    });
    expect(hold.command).toBe("look");
    // look 回包还没到：不能沿出口 south 走掉
    const waiting = strategy.decide({ state, config: semi, alerts: [], newLines: [] });
    expect(waiting.command).toBeNull();
    expect(waiting.pauseEvent).toBeUndefined();
  });

  it("one long fight keeps a single key across rounds; the next fight gets a new one", () => {
    const strategy = new GrindingStrategy();
    const combat = [line("野狼向你的胸口发动攻击")];
    const keys: string[] = [];
    for (let i = 0; i < 8; i++) {
      const key = strategy.decide({ state, config, alerts: [], newLines: combat }).pauseEvent?.instanceKey;
      if (key) keys.push(key);
    }
    expect(keys.length).toBeGreaterThan(1);
    expect(new Set(keys).size).toBe(1); // 同一场战斗：轮数变了键不变
    strategy.decide({ state, config, alerts: [], newLines: [line("野狼死了。")] }); // 战斗结束
    const next: string[] = [];
    for (let i = 0; i < 8; i++) {
      const key = strategy.decide({ state, config, alerts: [], newLines: combat }).pauseEvent?.instanceKey;
      if (key) next.push(key);
    }
    expect(next[0]).not.toBe(keys[0]); // 下一场战斗：新实例
  });
});
