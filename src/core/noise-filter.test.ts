import { describe, expect, it } from "vitest";
import {
  isAmbientChatLine,
  isDecorativeLine,
  isLoginPromptLine,
  isLogNoiseLine,
  isMovementNoiseLine,
  stripAsciiIds,
} from "./noise-filter";

describe("noise-filter", () => {
  it("flags room movement broadcasts (41% of a real daemon.log)", () => {
    for (const line of ["黑风老虎走了过来。", "示例玩家甲往南离开。", "示例玩家乙往东北离开。", "小猴来到了这里。"]) {
      expect(isMovementNoiseLine(line)).toBe(true);
    }
    expect(isMovementNoiseLine("黑风老虎对你喝道：站住！")).toBe(false);
    expect(isMovementNoiseLine("你往南走去。")).toBe(false);
    // 自己移动命令的响应不是环境播报，mud_act 要把它当作首批输出
    expect(isMovementNoiseLine("你往南离开。")).toBe(false);
    expect(isMovementNoiseLine("你离开了。")).toBe(false);
  });

  it("flags channel / chat broadcasts but not room speech", () => {
    expect(isAmbientChatLine("【闲聊】金圣宫(Jinsheng gong)：古古龙朱紫国施神力治愈万岁！")).toBe(true);
    expect(isAmbientChatLine("【帮派】某人：集合")).toBe(true);
    expect(isAmbientChatLine("祭赛国国王对你说：取回舍利子。")).toBe(false);
  });

  it("flags decorative lines", () => {
    expect(isDecorativeLine("")).toBe(true);
    expect(isDecorativeLine(" > ")).toBe(true);
    expect(isDecorativeLine("┏━━━━━━━━━━┓")).toBe(true);
    expect(isDecorativeLine("┃  内功心法 (force)  - 若有若无  1/ 0 ┃")).toBe(false);
  });

  it("keeps combat, system and gauge lines", () => {
    for (const line of [
      "巡山小妖一棍打在你的头上，你眼前一黑。",
      "[系统] 已连接到 xyj.thu.cn:6666",
      " 气血：  282/  282 (100%)    内力：   10 /   10 (100%) (+0)",
      "你死了！",
    ]) {
      expect(isLogNoiseLine(line)).toBe(false);
    }
    expect(isLogNoiseLine("示例玩家丁往南离开。")).toBe(true);
    expect(isLogNoiseLine("【闲聊】某人：首领来了")).toBe(true);
  });

  it("flags other players' flying emotes (136 lines in 10 min on xiyouji)", () => {
    expect(isLogNoiseLine("再吹一声口哨，随之往上冉冉地升起。。。")).toBe(true);
    expect(isLogNoiseLine("再吹一声口哨，随之飘去不见了。。。")).toBe(true);
    expect(isLogNoiseLine("你吹了一声口哨，什么都没发生。")).toBe(true);
  });

  it("flags the login banner ASCII art and undecodable lines (112 + 7 lines per day on xiyouji)", () => {
    expect(isLogNoiseLine("                                @   @    @              @          @")).toBe(true);
    expect(isLogNoiseLine("       @@@@@@@@@@@@@@@           @@  @   @@@@@           @@       @@")).toBe(true);
    expect(isLogNoiseLine("\uFFFD\uFFFD\uFFFD'\uFFFD鸙\uFFFD鸉")).toBe(true);
    expect(isLogNoiseLine("你的邮箱地址是 abc@example.com")).toBe(false);
  });

  it("flags other players' teleport arrivals (72.7% of GAME lines in a 2.5 h xiyouji run)", () => {
    expect(isLogNoiseLine("只见半空中降下一朵云彩，示例玩家甲从里面走了出来。")).toBe(true);
    expect(isLogNoiseLine("只见平地吹起一阵阴风，示例玩家乙从里面走了出来。")).toBe(true);
    expect(isLogNoiseLine("只见狂风大作，示例玩家丙从里面走了出来。")).toBe(true);
    expect(isLogNoiseLine("瘦老头脸上露出邪恶的笑容，不知道哪里想歪了。")).toBe(false);
  });

  it("recognises login password prompts and strips ASCII ids", () => {
    expect(isLoginPromptLine("请输入相应密码：??")).toBe(true);
    expect(isLoginPromptLine("石门上有一个密码锁。")).toBe(false);
    expect(stripAsciiIds("将军府第二代弟子 示例玩家(BossExample)")).toBe("将军府第二代弟子 示例玩家");
    expect(stripAsciiIds("七包金创药(Jinchuang yao)")).toBe("七包金创药");
  });

  it("keeps parenthesized boss / rarity annotations that are not player ids", () => {
    expect(stripAsciiIds("Goblin King (Boss) appears")).toBe("Goblin King (Boss) appears");
    expect(stripAsciiIds("你拾取了 龙鳞甲 (Legendary)")).toBe("你拾取了 龙鳞甲 (Legendary)");
    expect(stripAsciiIds("山贼头目(Boss)冲了过来")).toBe("山贼头目(Boss)冲了过来");
  });
});
