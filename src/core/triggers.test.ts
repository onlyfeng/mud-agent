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
        context: "",
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
});
