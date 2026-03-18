import { describe, expect, it } from "vitest";
import { resolveSessionKey } from "./session-key";

describe("resolveSessionKey", () => {
  it("returns 'default' for null", () => {
    expect(resolveSessionKey(null)).toBe("default");
  });

  it("returns 'default' for undefined", () => {
    expect(resolveSessionKey(undefined)).toBe("default");
  });

  it("uses topicId from ctx", () => {
    expect(resolveSessionKey({ topicId: "abc123" })).toBe("topic-abc123");
  });

  it("uses channelId from ctx", () => {
    expect(resolveSessionKey({ channelId: "ch1" })).toBe("topic-ch1");
  });

  it("uses userId as fallback", () => {
    expect(resolveSessionKey({ userId: "u1" })).toBe("user-u1");
  });

  it("uses event.topicId over ctx.userId", () => {
    expect(
      resolveSessionKey({
        userId: "u1",
        event: { topicId: "t1" },
      }),
    ).toBe("topic-t1");
  });

  it("returns 'default' for empty object", () => {
    expect(resolveSessionKey({})).toBe("default");
  });

  it("sanitizes path traversal in topicId", () => {
    expect(resolveSessionKey({ topicId: "../../etc" })).toBe("topic-____etc");
  });

  it("sanitizes backslash in userId", () => {
    expect(resolveSessionKey({ userId: "foo\\bar" })).toBe("user-foo_bar");
  });
});
