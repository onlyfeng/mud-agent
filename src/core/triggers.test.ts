import { describe, expect, it } from "vitest";
import { checkTriggers, TRIGGERS } from "./triggers";
import type { Alert, GameState } from "./types";

describe("triggers", () => {
  const baseState: GameState = {
    connected: true,
    loginDone: true,
    hp: 100,
    maxHp: 100,
    mp: 50,
    maxMp: 100,
    level: 10,
    gold: 500,
    exits: ["north"],
    location: "town",
    lastSeen: null,
  };

  it("detects death trigger", () => {
    const result = checkTriggers(["你死了！"], baseState, []);
    expect(result.changed).toBe(true);
    expect(result.alerts[0].id).toBe("death");
    expect(result.alerts[0].priority).toBe("critical");
  });

  it("detects hp_critical via checkFn", () => {
    const lowHpState = { ...baseState, hp: 15, maxHp: 100 };
    const result = checkTriggers(["some text"], lowHpState, []);
    expect(result.changed).toBe(true);
    const critAlert = result.alerts.find((a) => a.id === "hp_critical");
    expect(critAlert).toBeTruthy();
  });

  it("detects boss trigger", () => {
    const result = checkTriggers(["前方出现了一个boss！"], baseState, []);
    expect(result.changed).toBe(true);
    expect(result.alerts.find((a) => a.id === "boss")).toBeTruthy();
  });

  it("detects level up", () => {
    const result = checkTriggers(["恭喜！你升级了！"], baseState, []);
    expect(result.changed).toBe(true);
    expect(result.alerts.find((a) => a.id === "level_up")).toBeTruthy();
  });

  it("does not duplicate recent alerts", () => {
    const existing: Alert[] = [
      {
        id: "death",
        priority: "critical",
        label: "你死了",
        advice: "",
        context: "你死了",
        time: new Date().toISOString(),
        read: false,
      },
    ];
    const result = checkTriggers(["你死了"], baseState, existing);
    expect(result.changed).toBe(false);
  });

  it("returns unchanged when no triggers match", () => {
    const result = checkTriggers(["天气很好"], baseState, []);
    expect(result.changed).toBe(false);
  });

  it("limits alerts to 50", () => {
    const manyAlerts: Alert[] = Array.from({ length: 55 }, (_, i) => ({
      id: `test_${i}`,
      priority: "low" as const,
      label: `Alert ${i}`,
      advice: "",
      context: "",
      time: new Date(Date.now() - 100000).toISOString(),
      read: false,
    }));
    const result = checkTriggers(["你死了"], baseState, manyAlerts);
    expect(result.alerts.length).toBe(50);
  });

  it("TRIGGERS array has expected count", () => {
    expect(TRIGGERS.length).toBe(9);
  });

  it("does not fire text triggers on ambient chat lines (【闲聊】 boss noise 回归)", () => {
    // 西游记服务器把剧情播报塞进【闲聊】，曾造成 boss 警报每几秒一条刷屏。
    const chatty = ["【闲聊】祭赛国国王(Jisai guowang)：首领 快来看！"];
    expect(checkTriggers(chatty, baseState, []).alerts.find((a) => a.id === "boss")).toBeUndefined();
    // 非闲聊行里的同样关键词仍然上报
    const real = ["首领出现了"];
    expect(checkTriggers(real, baseState, []).alerts.find((a) => a.id === "boss")).toBeTruthy();
  });

  it("ignores ASCII player ids and login password prompts (示例玩家(BossExample) / 请输入密码 误报回归)", () => {
    const named = checkTriggers(["将军府第二代弟子 示例玩家(BossExample)"], baseState, []);
    expect(named.alerts.find((a) => a.id === "boss")).toBeUndefined();
    const login = checkTriggers(["请输入相应密码：??"], { ...baseState, loginDone: false }, []);
    expect(login.alerts.find((a) => a.id === "puzzle")).toBeUndefined();
    const real = checkTriggers(["石门上有一个密码锁。"], baseState, []);
    expect(real.alerts.find((a) => a.id === "puzzle")?.context).toBe("石门上有一个密码锁。");
    // 登录完成后的密码提示是游戏里的机关谜题，不能再当登录提示吞掉
    const inGame = checkTriggers(["请输入机关密码："], baseState, []);
    expect(inGame.alerts.find((a) => a.id === "puzzle")?.context).toBe("请输入机关密码：");
  });

  it("state triggers fire only on the false -> true edge (hp_low 刷屏回归)", () => {
    const safe = { ...baseState, hp: 40, maxHp: 100 };
    const low = { ...baseState, hp: 34, maxHp: 100 };
    const lower = { ...baseState, hp: 33, maxHp: 100 };
    // 安全 → 低血：边沿，上报
    const first = checkTriggers(["x"], low, [], safe);
    expect(first.alerts.find((a) => a.id === "hp_low")).toBeTruthy();
    // 持续低血（34 → 33）：不再重复上报
    const again = checkTriggers(["y"], lower, first.alerts, low);
    expect(again.alerts.find((a) => a.id === "hp_low" && a.time === first.alerts[0].time)).toBeTruthy();
    expect(again.alerts.filter((a) => a.id === "hp_low").length).toBe(1);
    expect(again.changed).toBe(false);
    // 低血 → 危急：临界边沿，上报 hp_critical
    const crit = checkTriggers(["z"], { ...baseState, hp: 18, maxHp: 100 }, first.alerts, low);
    expect(crit.alerts.find((a) => a.id === "hp_critical")).toBeTruthy();
    // 恢复后再次跌破：重新上报
    const refire = checkTriggers(["w"], low, first.alerts, safe);
    expect(refire.alerts.filter((a) => a.id === "hp_low").length).toBe(2);
    // 不传 prevState：保持旧行为（每次命中都报，受 5 分钟窗口抑制）
    const legacy = checkTriggers(["x"], low, first.alerts);
    expect(legacy.changed).toBe(false);
  });

  it("first live sample after a restart has no edge baseline (persisted low HP 回归)", () => {
    // daemon 重启后 state.json 里还是上次停机时的低血快照；首批样本不传 prevState，
    // 仍然低血就要上报，而不是被 true → true 吃掉。
    const low = { ...baseState, hp: 30, maxHp: 100 };
    const first = checkTriggers(["气血：30/100"], low, [], undefined);
    expect(first.alerts.find((a) => a.id === "hp_low")).toBeTruthy();
  });

  it("first live sample after a reconnect bypasses the dedup window (断线前的同类告警不压制它)", () => {
    const low = { ...baseState, hp: 30, maxHp: 100 };
    const beforeDisconnect: Alert = {
      id: "hp_low",
      priority: "high",
      label: "血量偏低",
      advice: "",
      context: "气血：30/100",
      time: new Date(Date.now() - 60_000).toISOString(),
      read: true,
    };
    const suppressed = checkTriggers(["气血：30/100"], low, [beforeDisconnect], undefined);
    expect(suppressed.changed).toBe(false); // 旧调用语义：无基线且不声明首样本 → 窗口去重
    const reconnected = checkTriggers(["气血：30/100"], low, [beforeDisconnect], undefined, { firstLiveSample: true });
    expect(reconnected.changed).toBe(true);
    expect(reconnected.alerts.filter((a) => a.id === "hp_low").length).toBe(2);
  });

  it("a read death alert does not suppress a new death within the dedup window", () => {
    const oneMinuteAgo = new Date(Date.now() - 60_000).toISOString();
    const readDeath: Alert = {
      id: "death",
      priority: "critical",
      label: "你死了",
      advice: "",
      context: "你死了！",
      time: oneMinuteAgo,
      read: true,
    };
    const again = checkTriggers(["你死了！"], baseState, [readDeath]);
    expect(again.changed).toBe(true);
    expect(again.alerts.filter((a) => a.id === "death").length).toBe(2);
    expect(again.alerts[0].read).toBe(false);
    // 未读的同类告警只在服务器短时重发窗口（几秒）内压制同文本；一分钟后同样的「你死了！」是又一次真实死亡
    const unreadOld = checkTriggers(["你死了！"], baseState, [{ ...readDeath, read: false }]);
    expect(unreadOld.changed).toBe(true);
    const unreadFresh = checkTriggers(["你死了！"], baseState, [
      { ...readDeath, read: false, time: new Date(Date.now() - 3_000).toISOString() },
    ]);
    expect(unreadFresh.changed).toBe(false);
  });

  it("text triggers still dedup against read alerts inside the window (boss 清阅后不刷屏)", () => {
    const readBoss: Alert = {
      id: "boss",
      priority: "high",
      label: "首领",
      advice: "",
      context: "首领出现了",
      time: new Date(Date.now() - 60_000).toISOString(),
      read: true,
    };
    const again = checkTriggers(["首领出现了"], baseState, [readBoss]);
    expect(again.changed).toBe(false);
    expect(again.alerts.filter((a) => a.id === "boss").length).toBe(1);
  });

  it("discrete progress events with a different context are not merged by the window (连续升级)", () => {
    const first = checkTriggers(["你升级了！你现在是 24 级。"], baseState, []);
    expect(first.alerts.filter((a) => a.id === "level_up").length).toBe(1);
    const second = checkTriggers(["你升级了！你现在是 25 级。"], baseState, first.alerts);
    expect(second.changed).toBe(true);
    expect(second.alerts.filter((a) => a.id === "level_up").length).toBe(2);
    // 同一事件文本在窗口内重复出现（服务器重发）仍算重复
    const dup = checkTriggers(["你升级了！你现在是 25 级。"], baseState, second.alerts);
    expect(dup.changed).toBe(false);
    // 固定文本的离散事件（「你升级了！」）半分钟后再次发生是新事件，不被 5 分钟窗口吞掉
    const earlier = checkTriggers(["你升级了！"], baseState, []).alerts.map((a) => ({
      ...a,
      time: new Date(Date.now() - 30_000).toISOString(),
    }));
    const realAgain = checkTriggers(["你升级了！"], baseState, earlier);
    expect(realAgain.changed).toBe(true);
    expect(realAgain.alerts.filter((a) => a.id === "level_up").length).toBe(2);
  });
});
