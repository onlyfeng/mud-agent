import { describe, expect, it } from "vitest";
import { compileGameProfile, DEFAULT_PROFILE_JSON, mergeGameProfileJson } from "./game-profile";
import { liveSampleGate, maxHpUntrusted, parseState, resetRuntimeState } from "./state-parser";
import { parseExitsFromLines } from "./text-analyzer";

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

  it("an optional exits capture group that did not participate means no exits, not a crash", () => {
    const profile = compileGameProfile(
      mergeGameProfileJson(DEFAULT_PROFILE_JSON, {
        exits: { state: ["^Exits(?:[: ]+(.*))?$"], room: ["^Exits(?:[: ]+(.*))?$"] },
      }),
      "test",
    );
    expect(parseState(["Exits"], emptyState, profile).exits).toEqual([]);
    expect(parseState(["Exits: north south"], emptyState, profile).exits).toEqual(["north", "south"]);
    expect(parseExitsFromLines([{ ts: "t", text: "Exits" }], profile)).toEqual([]);
    // 分隔符不含空白（","）：每个片段各自 trim，不把 " east" 原样当命令
    const comma = compileGameProfile(
      mergeGameProfileJson(DEFAULT_PROFILE_JSON, { exits: { state: ["^Exits: (.+)$"], splitter: "," } }),
      "test",
    );
    expect(parseState(["Exits: north, east ,south"], emptyState, comma).exits).toEqual(["north", "east", "south"]);
  });

  it("hp/mp ignore a non-finite capture (Infinity, overflow) instead of persisting null", () => {
    const profile = compileGameProfile(
      mergeGameProfileJson(DEFAULT_PROFILE_JSON, { status: { hp: ["HP: (\\S+)/(\\S+)"] } }),
      "test",
    );
    const prev = { ...emptyState, hp: 80, maxHp: 100 };
    expect(parseState(["HP: Infinity/100"], prev, profile)).toMatchObject({ hp: 80, maxHp: 100 });
    expect(parseState(["HP: 90/1e999"], prev, profile)).toMatchObject({ hp: 90, maxHp: 100 }); // 上限非有限：当作单值样本，沿用已知上限
  });

  it("level and gold ignore a non-numeric capture instead of writing NaN", () => {
    const profile = compileGameProfile(
      mergeGameProfileJson(DEFAULT_PROFILE_JSON, {
        status: { level: ["Level: (unknown|\\d+)"], gold: ["Gold: (\\S+)"] },
      }),
      "test",
    );
    const prev = { ...emptyState, level: 10, gold: 50 };
    expect(parseState(["Level: unknown", "Gold: lots"], prev, profile)).toMatchObject({ level: 10, gold: 50 });
    expect(parseState(["Level: 12", "Gold: 7"], prev, profile)).toMatchObject({ level: 12, gold: 7 });
  });

  it("maxHpUntrusted (autopilot's refresh rule): unknown, untimestamped (pre-upgrade state) or older than the TTL", () => {
    const now = new Date("2026-10-17T10:00:00.000Z");
    const fresh = new Date(now.getTime() - 60_000).toISOString();
    const stale = new Date(now.getTime() - 6 * 60_000).toISOString();
    expect(maxHpUntrusted({ hp: 80, maxHp: null }, now.getTime())).toBe(true);
    expect(maxHpUntrusted({ hp: 80, maxHp: 100, maxHpSampledAt: fresh }, now.getTime())).toBe(false);
    expect(maxHpUntrusted({ hp: 80, maxHp: 100, maxHpSampledAt: stale }, now.getTime())).toBe(true);
    expect(maxHpUntrusted({ hp: 80, maxHp: 100 }, now.getTime())).toBe(true); // 旧 state.json 没有样本时刻
    expect(maxHpUntrusted({ hp: null, maxHp: null }, now.getTime())).toBe(true); // 刚登录还没有任何血量样本：先查状态再动
    // daemon 的触发器继续用已有上限（闲置时上限不会变；活动时样本会刷新）：liveSampleGate 不做保鲜判断
    const staleState = { ...emptyState, hp: 30, maxHp: 100, maxHpSampledAt: stale };
    expect(liveSampleGate(["生命值：30"], staleState, true, undefined, now).triggerState.maxHp).toBe(100);
  });

  it("applies status and exits rules per line, so ^…$-anchored profile rules match inside a multi-line batch", () => {
    const profile = compileGameProfile(
      mergeGameProfileJson(DEFAULT_PROFILE_JSON, {
        status: { hp: ["^HP: (\\d+)/(\\d+)$"] },
        exits: { state: ["^Exits: (.+)$"] },
      }),
      "test",
    );
    const s = parseState(["The Town Square", "HP: 40/100", "Exits: north, east", "< prompt >"], emptyState, profile);
    expect(s).toMatchObject({ hp: 40, maxHp: 100, exits: ["north", "east"] });
  });

  it("handles empty lines", () => {
    expect(parseState([], emptyState)).toEqual(emptyState);
  });

  it("clears stale maxMp when new pattern has no max group (mp > maxMp 回归)", () => {
    // 历史 bug：A 轮匹配"法力：10/10"写入 mp=10 maxMp=10；
    // B 轮匹配"内力：50"只更新 mp=50 但 maxMp 残留为 10 → mp > maxMp
    const prevState = { ...emptyState, mp: 10, maxMp: 10 };
    const s = parseState(["内力：50"], prevState);
    expect(s.mp).toBe(50);
    expect(s.maxMp).toBeNull();
  });

  it("a current-only HP sample keeps the known maximum (a trailing prompt must not erase a fresh max); exceeding it proves the max wrong", () => {
    const prevState = { ...emptyState, hp: 100, maxHp: 200 };
    const s = parseState(["生命值：80"], prevState);
    expect(s.hp).toBe(80);
    expect(s.maxHp).toBe(200);
    expect(parseState(["生命值：250"], prevState).maxHp).toBeNull(); // 当前值超过上限：上限已被证伪
    expect(parseState(["<  90 hp"], { ...emptyState, hp: 50, maxHp: 100 }).maxHp).toBe(100); // ROM 提示符只更新当前值
    expect(parseState(["气血：80/300"], s).maxHp).toBe(300); // 双值样本总是重建上限
    const at = new Date("2026-10-17T10:00:00.000Z");
    const stamped = parseState(["气血：80/300"], s, undefined, at);
    expect(stamped.maxHpSampledAt).toBe(at.toISOString()); // 双值样本打上时刻（autopilot 据此判断保鲜）
    expect(parseState(["生命值：70"], stamped, undefined, new Date(at.getTime() + 1000)).maxHpSampledAt).toBe(
      at.toISOString(),
    ); // 单值样本不刷新它
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
