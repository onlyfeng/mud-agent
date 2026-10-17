import { describe, expect, it } from "vitest";
import { liveSampleGate, parseState, resetRuntimeState } from "./state-parser";

describe("parseState", () => {
  const emptyState = {
    connected: true,
    loginDone: true,
    hp: null,
    maxHp: null,
    mp: null,
    maxMp: null,
    level: null,
    gold: null,
    exits: [] as string[],
    location: "",
    lastSeen: null,
  };

  it("parses Chinese HP format", () => {
    const s = parseState(["生命：150/200"], emptyState);
    expect(s.hp).toBe(150);
    expect(s.maxHp).toBe(200);
  });

  it("parses English HP format", () => {
    const s = parseState(["HP: 80/100"], emptyState);
    expect(s.hp).toBe(80);
    expect(s.maxHp).toBe(100);
  });

  it("parses MP", () => {
    const s = parseState(["法力：50/100"], emptyState);
    expect(s.mp).toBe(50);
    expect(s.maxMp).toBe(100);
  });

  it("parses Chinese exits", () => {
    const s = parseState(["出口：东、南、西"], emptyState);
    expect(s.exits).toEqual(["东", "南", "西"]);
  });

  it("parses English exits", () => {
    const s = parseState(["[Exits: north south east]"], emptyState);
    expect(s.exits).toEqual(["north", "south", "east"]);
  });

  it("parses level", () => {
    const s = parseState(["等级：15"], emptyState);
    expect(s.level).toBe(15);
  });

  it("parses gold", () => {
    const s = parseState(["金币：5000"], emptyState);
    expect(s.gold).toBe(5000);
  });

  it("preserves existing state when no match", () => {
    const prev = { ...emptyState, hp: 100, maxHp: 200 };
    const s = parseState(["一些无关文本"], prev);
    expect(s.hp).toBe(100);
    expect(s.maxHp).toBe(200);
  });

  it("handles empty lines", () => {
    const s = parseState([], emptyState);
    // 第一次解析固定角色等级基线（没有旧等级时为 null），其余字段不变
    expect(s).toEqual({ ...emptyState, characterLevel: null });
  });

  it("clears stale maxMp when new pattern has no max group (mp > maxMp 回归)", () => {
    // 历史 bug：A 轮匹配"法力：10/10"写入 mp=10 maxMp=10；
    // B 轮匹配"内力：50"只更新 mp=50 但 maxMp 残留为 10 → mp > maxMp
    const prevState = { ...emptyState, mp: 10, maxMp: 10 };
    const s = parseState(["内力：50"], prevState);
    expect(s.mp).toBe(50);
    expect(s.maxMp).toBeNull();
  });

  it("keeps a plausible known maxHp when the new pattern has no max group, clears it only when exceeded", () => {
    const prevState = { ...emptyState, hp: 100, maxHp: 200 };
    const s = parseState(["生命值：80"], prevState);
    expect(s.hp).toBe(80);
    expect(s.maxHp).toBe(200); // 触发器与安全边界都需要 maxHp，不能因为一次单值样本就丢掉
    expect(parseState(["生命值：250"], prevState).maxHp).toBeNull(); // 上限已不可信
  });

  it("updates both mp and maxMp when pattern has max group", () => {
    const prevState = { ...emptyState, mp: 50, maxMp: null };
    const s = parseState(["法力：30/80"], prevState);
    expect(s.mp).toBe(30);
    expect(s.maxMp).toBe(80);
  });

  it("prefers 内力 over 法力 when the wuxia gauge shows both (西游记 50/10 回归)", () => {
    // 实测输出：mp 被解析成法力 50/10，而内力 10/10 才是主 MP。
    const s = parseState(
      [
        " 气血：  282/  282 (100%)    内力：   10 /   10 (100%) (+0)",
        " 精神：  352/  352 (100%)    法力：   50 /   10 (100%) (+0)",
      ],
      emptyState,
    );
    expect(s.hp).toBe(282);
    expect(s.maxHp).toBe(282);
    expect(s.mp).toBe(10);
    expect(s.maxMp).toBe(10);
  });

  it("keeps 法力 as MP when there is no 内力 gauge (generic MUD, 精神 must not win)", () => {
    const s = parseState([" 精神：  352/  352 (100%)    法力：   50 /   60 (83%)"], emptyState);
    expect(s.mp).toBe(50);
    expect(s.maxMp).toBe(60);
  });

  it("single-value 内力 also wins over 法力 on the same screen", () => {
    const s = parseState(["内力：10    法力： 50 / 60"], emptyState);
    expect(s.mp).toBe(10);
    expect(s.maxMp).toBeNull();
  });

  it("falls back to 精神 only when neither 内力 nor 法力/MP is present", () => {
    const s = parseState([" 精神：  352/  352 (100%)"], emptyState);
    expect(s.mp).toBe(352);
    expect(s.maxMp).toBe(352);
  });

  it("drops the cached maximum on a current-only sample once level continuity is broken", () => {
    const full = parseState(["气血：100/100", "等级：10"], emptyState);
    expect(full.maxHp).toBe(100);
    // 升级播报 + 单值样本：40/100 看起来像 40%，真实上限已变，必须放弃缓存
    const levelled = parseState(["你升级了！", "生命值：40"], full);
    expect(levelled.hp).toBe(40);
    expect(levelled.maxHp).toBeNull();
    // 解析到的等级与缓存不同，同样视为上限不连续
    const otherLevel = parseState(["等级：11", "生命值：40"], full);
    expect(otherLevel.maxHp).toBeNull();
    expect(otherLevel.level).toBe(11);
    // 等级未变的单值样本仍沿用上限
    expect(parseState(["等级：10", "生命值：40"], full).maxHp).toBe(100);
    // 别人升级的频道播报、技能"升为"都不是本角色升级：不能清掉上限
    expect(parseState(["【闲聊】恭喜 示例玩家 升到了 30 级！", "生命值：40"], full).maxHp).toBe(100);
    expect(parseState(["你的基本剑法升为第 5 级", "生命值：40"], full).maxHp).toBe(100);
    expect(parseState(["恭喜你升级了！"], full).maxHp).toBeNull(); // 自己的升级仍算
    expect(parseState(["你的等级升到了 11 级", "生命值：40"], full).maxHp).toBeNull(); // 所有格 + 升到
    expect(parseState(["您的等级提升了"], full).maxHp).toBeNull();
    expect(parseState(["你升到了 12 级"], full).maxHp).toBeNull();
    // 带所有格/当前前缀的角色等级也算明确写法：10 → 11 是断裂，旧上限清掉
    expect(parseState(["你的等级：11", "生命值：40"], full).maxHp).toBeNull();
    expect(parseState(["您当前等级：11", "生命值：40"], full).maxHp).toBeNull();
    expect(parseState(["您的当前等级：11", "生命值：40"], full).maxHp).toBeNull();
    expect(parseState(["你的当前等级：11", "生命值：40"], full).maxHp).toBeNull();
    expect(parseState(["You gain a level!", "生命值：40"], full).maxHp).toBeNull();
    // 英文技能/公会等级同样不是角色等级
    expect(parseState(["Skill Level 3", "生命值：40"], full).maxHp).toBe(100);
    expect(parseState(["Guild Level 2 | Level 11", "生命值：40"], full).maxHp).toBe(100); // 没有玩家状态标签的「|」字段：不认
    expect(parseState(["HP 100/100 | Level 11", "生命值：40"], full).maxHp).toBeNull(); // 玩家状态行里的「|」字段：认
    expect(parseState(["山贼 | Level 20", "生命值：40"], full).maxHp).toBe(100); // 实体信息
    expect(parseState(["Goblin | Lv. 20", "生命值：40"], full).maxHp).toBe(100);
    expect(parseState(["Skill Lv. 3", "生命值：40"], full).maxHp).toBe(100);
    expect(parseState(["HP 100/100 | Guild Lv 2 | Level 11", "生命值：40"], full).maxHp).toBeNull(); // 状态行里技能片段屏蔽后仍识别角色 Level
    // 其他实体的等级（技能名 / 怪物 / 玩家名 + 空格 + 等级）不是本角色的：空格不是边界
    expect(parseState(["基本剑法 等级：5", "生命值：40"], full).maxHp).toBe(100);
    expect(parseState(["怪物 等级：20", "生命值：40"], full).maxHp).toBe(100);
    expect(parseState(["张三 等级：99", "生命值：40"], full).maxHp).toBe(100);
    expect(parseState(["【状态】 等级：11", "生命值：40"], full).maxHp).toBeNull(); // 标签后的字段仍算
    expect(parseState(["生命值：40 等级：11"], full).maxHp).toBeNull(); // 空格分隔的字段：前一个字段的数值后面算边界
    expect(parseState(["HP 100/100 等级 10"], full).maxHp).toBe(100); // 等级没变
    expect(parseState(["山贼 HP 80 等级：20", "生命值：40"], full).maxHp).toBe(100); // 其他实体的状态：不以玩家状态字段开头
    expect(parseState(["【状态】生命值：40 等级：11"], full).maxHp).toBeNull(); // 带标签的玩家状态行
    expect(parseState(["[山贼] HP 80 等级：20", "生命值：40"], full).maxHp).toBe(100); // 实体名标签不是玩家状态标签
    expect(parseState(["[status] HP 80/100 等级：11"], full).maxHp).toBeNull();
    // 频道里别人的等级不是本角色的：不清上限
    expect(parseState(["【闲聊】甲：等级：99", "生命值：40"], full).maxHp).toBe(100);
    expect(parseState(["【世界】路人：角色等级：99", "生命值：40"], full).maxHp).toBe(100);
    // 旧 state（升级前，只有 level/maxHp 没有 characterLevel）：第一批 10 → 11 也要清上限
    const legacyState = { ...full, characterLevel: undefined } as GameState;
    expect(parseState(["等级：11", "生命值：40"], legacyState).maxHp).toBeNull();
    expect(parseState(["等级：10", "生命值：40"], legacyState).maxHp).toBe(100);
    // 导入一次后基线固定：先来一批技能等级把 level 改成 3，再来真实的 等级：10 也不算断裂
    const imported = parseState(["生命值：80/100"], legacyState);
    expect(imported.characterLevel).toBe(10);
    const skillPolluted = parseState(["技能等级：3"], imported);
    expect(skillPolluted.level).toBe(3);
    expect(skillPolluted.characterLevel).toBe(10);
    expect(parseState(["等级：10", "生命值：40"], skillPolluted).maxHp).toBe(100);
    // 标签式状态行：冒号也是边界
    expect(parseState(["状态：等级：11", "生命值：40"], full).maxHp).toBeNull();
    expect(parseState(["属性：角色等级：11", "生命值：40"], full).maxHp).toBeNull();
    // 实体名 + 标点不是边界：查看目标得到的等级不是本角色的
    expect(parseState(["山贼：等级：20", "生命值：40"], full).maxHp).toBe(100);
    expect(parseState(["山贼，等级：20", "生命值：40"], full).maxHp).toBe(100);
    expect(parseState(["属性：技能等级：11", "生命值：40"], full).maxHp).toBe(100); // 技能行仍排除
    // 同一行既有技能等级又有角色等级：只屏蔽技能片段，角色等级 11 仍被识别
    expect(parseState(["角色等级：11 技能等级：3 生命值：40"], full).maxHp).toBeNull();
    expect(parseState(["技能等级：3 等级：10 生命值：40"], full).maxHp).toBe(100); // 角色等级没变
    // 先收「技能等级：3」（污染展示值 level），再收真实的「等级：10」：基线是已确认的角色等级 10，不算断裂
    const polluted = parseState(["技能等级：3"], full);
    expect(polluted.level).toBe(3);
    expect(parseState(["等级：10", "生命值：40"], polluted).maxHp).toBe(100);
    // 「技能等级：3」是技能信息，不是角色等级：不能当成连续性断裂清掉上限
    const skill = parseState(["技能等级：3", "生命值：40"], full);
    expect(skill.maxHp).toBe(100);
    expect(parseState(["你的基本拳脚 技能等级：7"], full).maxHp).toBe(100);
    // 升级播报单独到达（本批无血量样本）：旧上限也要清掉，下一批单值样本不能再复用
    const levelOnly = parseState(["你升级了！"], full);
    expect(levelOnly.maxHp).toBeNull();
    expect(parseState(["生命值：40"], levelOnly).maxHp).toBeNull();
  });

  it("keeps the known maximum on a current-only HP sample that fits under it", () => {
    const full = parseState([" 气血：  200/  282 (70%)"], emptyState);
    expect(full.maxHp).toBe(282);
    const partial = parseState(["生命值：80"], full);
    expect(partial.hp).toBe(80);
    expect(partial.maxHp).toBe(282);
    // 当前值超过已知上限：上限不再可信，置空
    const over = parseState(["生命值：900"], full);
    expect(over.maxHp).toBeNull();
  });

  it("resetRuntimeState drops stale shutdown marks, connection flags and last run's gameplay fields", () => {
    const stale = {
      ...emptyState,
      connected: true,
      loginDone: true,
      hp: 282,
      maxHp: 282,
      shutdownReason: "control-stop" as const,
      shutdownAt: "2026-04-22T14:51:29.527Z",
    };
    const s = resetRuntimeState(stale);
    expect(s.connected).toBe(false);
    expect(s.loginDone).toBe(false);
    expect(s.hp).toBeNull();
    expect(s.maxHp).toBeNull();
    expect(s.exits).toEqual([]);
    expect("shutdownReason" in s).toBe(false);
    expect("shutdownAt" in s).toBe(false);
  });

  describe("liveSampleGate", () => {
    const persistedLow = { ...emptyState, hp: 30, maxHp: 100 };

    it("hides the persisted HP from triggers until this process parses a live gauge", () => {
      const g = liveSampleGate(["欢迎回到西游记", "请输入指令："], persistedLow, false);
      expect(g.hasLiveHp).toBe(false);
      expect(g.state.hp).toBe(30); // 展示用的状态保留旧值
      expect(g.triggerState.hp).toBeNull(); // 触发器看不到旧值，不会制造假告警
      expect(g.prevState).toBeUndefined();
    });

    it("first live gauge has no edge baseline, later batches compare against the live previous state", () => {
      const first = liveSampleGate([" 气血：  30/  100 (30%)"], persistedLow, false);
      expect(first.hasLiveHp).toBe(true);
      expect(first.prevState).toBeUndefined();
      expect(first.triggerState.hp).toBe(30);

      const second = liveSampleGate(["你向北走去。"], first.state, first.hasLiveHp);
      expect(second.prevState).toBe(first.state);
      expect(second.triggerState.hp).toBe(30);
    });
  });
});
