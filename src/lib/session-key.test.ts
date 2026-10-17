import { describe, expect, it } from "vitest";
import { normalizeSessionRoutingKey } from "./session-dir-name";
import { listLegacySessionAliases, normalizeSessionKey, resolveSessionKey } from "./session-key";

describe("normalizeSessionKey", () => {
  it.each([
    "topic:1",
    "topic-1",
    "user:42",
    "user-42",
    "telegram:-100:7",
    "agent:main:discord:channel:c1:thread:t1",
  ])("uses the shared routing normalizer for %s", (sessionKey) => {
    expect(normalizeSessionKey(sessionKey)).toBe(normalizeSessionRoutingKey(sessionKey));
  });

  it("keeps canonical telegram topic keys stable", () => {
    expect(normalizeSessionKey("agent:main:telegram:group:-1009000000000:topic:1234")).toBe(
      "agent:main:telegram:group:-1009000000000:topic:1234",
    );
  });

  it("upgrades telegram legacy aliases to canonical key", () => {
    expect(normalizeSessionKey("telegram:group:-1009000000000:topic:1234")).toBe(
      "agent:main:telegram:group:-1009000000000:topic:1234",
    );
    expect(normalizeSessionKey("telegram:-1009000000000:1234")).toBe(
      "agent:main:telegram:group:-1009000000000:topic:1234",
    );
  });

  it("keeps short topic alias as legacy alias", () => {
    expect(normalizeSessionKey("topic-1234")).toBe("topic-1234");
  });
});

describe("resolveSessionKey", () => {
  it("returns default for nullish ctx", () => {
    expect(resolveSessionKey(null)).toBe("default");
    expect(resolveSessionKey(undefined)).toBe("default");
  });

  it("prefers explicit sessionKey and normalizes it", () => {
    expect(resolveSessionKey({ sessionKey: "telegram:-1009000000000:1234" })).toBe(
      "agent:main:telegram:group:-1009000000000:topic:1234",
    );
  });

  it("builds canonical telegram topic key from chat + topic context", () => {
    expect(
      resolveSessionKey({
        channel: "telegram",
        chatId: "-1009000000000",
        topicId: "1234",
      }),
    ).toBe("agent:main:telegram:group:-1009000000000:topic:1234");
  });

  it("uses event values over outer ctx fallback", () => {
    expect(
      resolveSessionKey({
        userId: "u1",
        channel: "telegram",
        event: { chatId: "-1009000000000", topicId: "1234" },
      }),
    ).toBe("agent:main:telegram:group:-1009000000000:topic:1234");
  });

  it("falls back to generic channel user key outside telegram", () => {
    expect(resolveSessionKey({ channel: "discord", userId: "u1" })).toBe("agent:main:discord:user:u1");
  });

  it("sanitizes path traversal in session identifiers", () => {
    expect(resolveSessionKey({ channel: "telegram", chatId: "-100", topicId: "../../etc" })).toBe(
      "agent:main:telegram:group:-100:topic:____etc",
    );
  });
});

describe("listLegacySessionAliases", () => {
  it("returns topic-specific aliases only for a canonical telegram topic key (no group-wide alias)", () => {
    expect(listLegacySessionAliases("agent:main:telegram:group:-1009000000000:topic:1234")).toEqual([
      "telegram:group:-1009000000000:topic:1234",
      "telegram:-1009000000000:1234",
      "topic-1234",
    ]);
  });

  it("returns the group alias only for a group session without a topic", () => {
    expect(listLegacySessionAliases("agent:main:telegram:group:-1009000000000")).toEqual([
      "telegram:group:-1009000000000",
    ]);
  });
});
