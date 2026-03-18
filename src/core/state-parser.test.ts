import { describe, expect, it } from "vitest";
import { parseState } from "./state-parser";

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
    expect(s).toEqual(emptyState);
  });
});
