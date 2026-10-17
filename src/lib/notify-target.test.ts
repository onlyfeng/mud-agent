import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensureNotifyTargetFromSessionKey,
  loadNotifyTargetFromSessionDir,
  parseNotifyTargetFromSessionKey,
  parseStoredNotifyTarget,
} from "./notify-target";
import { encodeSessionDirName } from "./session-dir-name";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop() as string, { recursive: true, force: true });
  }
});

describe("notify target helpers", () => {
  it("parses a legacy raw Telegram group topic sessionKey", () => {
    expect(parseNotifyTargetFromSessionKey("agent:main:telegram:group:-1009000000000:topic:1234")).toEqual({
      channel: "telegram",
      chatId: "-1009000000000",
      threadId: "1234",
    });
  });

  it("writes notify-target.json from sessionKey", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mud-agent-notify-"));
    tempDirs.push(dir);

    expect(ensureNotifyTargetFromSessionKey(dir, "agent:main:telegram:group:-1009000000000:topic:1234")).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(dir, "notify-target.json"), "utf8"))).toEqual({
      channel: "telegram",
      chatId: "-1009000000000",
      threadId: "1234",
    });
  });

  it("decodes the encoded session directory before notify fallback", () => {
    const key = "agent:main:telegram:group:-1009000000000:topic:1234";
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mud-agent-session-"));
    const dir = path.join(root, encodeSessionDirName(key));
    fs.mkdirSync(dir, { recursive: true });
    tempDirs.push(root);

    expect(loadNotifyTargetFromSessionDir(path.join(dir, "notify-target.json"))).toEqual({
      channel: "telegram",
      chatId: "-1009000000000",
      threadId: "1234",
    });
  });

  it("rejects an invalid encoded basename instead of parsing it as a logical key", () => {
    const invalidEncoded = "v1_agent:main:telegram:group:-1009000000000:topic:1234";
    const targetFile = path.join(os.tmpdir(), invalidEncoded, "notify-target.json");

    expect(loadNotifyTargetFromSessionDir(targetFile)).toBeNull();
  });

  it("rejects an invalid v2 basename instead of parsing it as a logical key", () => {
    const invalidEncoded = "v2_agent:main:telegram:group:-1009000000000:topic:1234";
    const targetFile = path.join(os.tmpdir(), invalidEncoded, "notify-target.json");

    expect(loadNotifyTargetFromSessionDir(targetFile)).toBeNull();
  });

  it.each(["V1_", "V2_"])("rejects an invalid case-variant %s basename before notify fallback", (prefix) => {
    const invalidEncoded = `${prefix}agent:main:telegram:group:-1009000000000:topic:1234`;
    const targetFile = path.join(os.tmpdir(), invalidEncoded, "notify-target.json");

    expect(loadNotifyTargetFromSessionDir(targetFile)).toBeNull();
  });
});

describe("parseStoredNotifyTarget (结构校验)", () => {
  it("接受最小合法对象", () => {
    expect(parseStoredNotifyTarget({ channel: "telegram", chatId: "-123" })).toEqual({
      channel: "telegram",
      chatId: "-123",
    });
  });

  it("接受带 threadId 的合法对象", () => {
    expect(parseStoredNotifyTarget({ channel: "telegram", chatId: "-123", threadId: "42" })).toEqual({
      channel: "telegram",
      chatId: "-123",
      threadId: "42",
    });
  });

  it("拒绝 chatId 为 number 的对象（下游 execFile args 需要纯 string[]）", () => {
    expect(parseStoredNotifyTarget({ channel: "telegram", chatId: 123 })).toBeNull();
  });

  it("拒绝 channel 为空字符串", () => {
    expect(parseStoredNotifyTarget({ channel: "", chatId: "-123" })).toBeNull();
  });

  it("拒绝 chatId 为空字符串", () => {
    expect(parseStoredNotifyTarget({ channel: "telegram", chatId: "   " })).toBeNull();
  });

  it("拒绝 threadId 为 number", () => {
    expect(parseStoredNotifyTarget({ channel: "telegram", chatId: "-123", threadId: 42 })).toBeNull();
  });

  it("拒绝 threadId 为空字符串", () => {
    expect(parseStoredNotifyTarget({ channel: "telegram", chatId: "-123", threadId: "" })).toBeNull();
  });

  it("拒绝 null / undefined / primitive", () => {
    expect(parseStoredNotifyTarget(null)).toBeNull();
    expect(parseStoredNotifyTarget(undefined)).toBeNull();
    expect(parseStoredNotifyTarget("telegram")).toBeNull();
    expect(parseStoredNotifyTarget(123)).toBeNull();
  });

  it("拒绝缺字段的对象", () => {
    expect(parseStoredNotifyTarget({ channel: "telegram" })).toBeNull();
    expect(parseStoredNotifyTarget({ chatId: "-123" })).toBeNull();
  });

  it("忽略多余字段，只返回白名单", () => {
    const result = parseStoredNotifyTarget({
      channel: "telegram",
      chatId: "-123",
      extra: "should-not-leak",
      secret: "password",
    });
    expect(result).toEqual({ channel: "telegram", chatId: "-123" });
    expect((result as unknown as Record<string, unknown>)?.extra).toBeUndefined();
  });
});
