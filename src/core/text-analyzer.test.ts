import { describe, expect, it } from "vitest";
import { reverseExit } from "../services/autopilot/exploration.strategy";
import { activateGameProfile, compileGameProfile, DEFAULT_PROFILE_JSON, mergeGameProfileJson } from "./game-profile";
import { isLogNoiseLine } from "./noise-filter";
import {
  detectAlertType,
  detectCombat,
  detectCombatEnd,
  parseExitsFromLines,
  parseItemsFromLines,
  parseRoomName,
} from "./text-analyzer";
import type { OutputLine } from "./types";

const line = (text: string): OutputLine => ({ ts: "2026-10-17T00:00:00.000Z", text });

describe("text analyzer (default profile)", () => {
  it("parses exits, items and the room name from a look reply", () => {
    const reply = [
      line("南城客栈"),
      line("□ 青瓷大海碗(Hai wan)"),
      line("酒葫芦(Hu lu)"),
      line("这里明显的出口是 north、east 和 south。"),
    ];
    expect(parseExitsFromLines(reply)).toEqual(["north", "east", "south"]);
    expect(parseItemsFromLines(reply)).toEqual(["青瓷大海碗(Hai wan)", "酒葫芦(Hu lu)"]);
    expect(parseRoomName(reply)).toBe("南城客栈");
    expect(parseRoomName([line("The Town Square -")])).toBe("The Town Square");
  });

  it("classifies combat and events", () => {
    expect(detectCombat([line("野狼向你的胸口发动攻击")])).toBe(true);
    expect(detectCombatEnd([line("野狼死了。")])).toBe(true);
    expect(detectCombatEnd([line("野狼向你的胸口发动攻击")])).toBe(false);
    expect(detectAlertType([line("一只妖王出现了")])).toBe("boss");
    expect(detectAlertType([line("你升级了！"), line("一只妖王出现了")])).toBe("level_up"); // 事件按画像顺序逐行判定
  });
});

describe("text analyzer (custom profile)", () => {
  it("every analyzer reads the active profile, so a per-server profile changes behaviour without code changes", () => {
    const custom = compileGameProfile(
      mergeGameProfileJson(DEFAULT_PROFILE_JSON, {
        combat: { start: ["ATTACKS YOU"], end: ["is DEAD"] },
        exits: { room: ["^\\[Exits: (.+)\\]$"], splitter: "[,\\s]+" },
        events: [{ type: "boss", patterns: ["DRAGON"] }],
        noise: { ambientChat: ["^\\[OOC\\]"] },
        directions: { reverse: { NORTH: "south" }, aliases: [["SOUTH", "S"]] },
        room: { name: ["Town", "<.+>"], exclude: [], strip: ["[<>]"] },
      }),
      "test",
    );
    const previous = activateGameProfile(custom);
    try {
      expect(detectCombat([line("A goblin ATTACKS YOU!")])).toBe(true);
      expect(detectCombat([line("野狼向你的胸口发动攻击")])).toBe(false);
      expect(detectCombatEnd([line("The goblin is DEAD.")])).toBe(true);
      expect(parseExitsFromLines([line("[Exits: north, west]")])).toEqual(["north", "west"]);
      expect(detectAlertType([line("A DRAGON lands here")])).toBe("boss");
      expect(detectAlertType([line("一只妖王出现了")])).toBeNull();
      expect(isLogNoiseLine("[OOC] hello")).toBe(true);
      expect(isLogNoiseLine("【闲聊】hello")).toBe(false);
      expect(parseRoomName([line("Town Square")])).toBe("Town Square"); // 分类规则只分类，不剥文本
      expect(parseRoomName([line("<Great Hall>")])).toBe("Great Hall"); // strip 是替换规则：全局替换
      expect(reverseExit("north", ["S", "E"])).toBe("S"); // 反向表键与别名组都不区分大小写，返回房间实际列出的写法
      expect(reverseExit("North", [])).toBe("south");
      expect(reverseExit("north", ["South", "E"])).toBe("South"); // 返回房间实际列出的写法，不是画像里的
    } finally {
      activateGameProfile(previous);
    }
  });
});
