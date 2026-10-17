import { describe, expect, it } from "vitest";
import { decodeSessionDirName, encodeSessionDirName } from "./session-dir-name";

const WINDOWS_FORBIDDEN_CHARACTERS = /[<>:"/\\|?*]/;

describe("session directory codec", () => {
  for (const key of [
    "agent:main:telegram:direct:100000001",
    "agent:main:telegram:group:-1009000000000:topic:1",
    "中文:角色/一号",
  ]) {
    it(`roundtrips ${key}`, () => {
      const encoded = encodeSessionDirName(key);

      expect(encoded).toMatch(/^v2_[0-9a-f]+$/);
      expect(encoded).not.toMatch(WINDOWS_FORBIDDEN_CHARACTERS);
      expect(decodeSessionDirName(encoded)).toBe(key);
    });
  }

  it("uses deterministic lowercase UTF-8 hex with the v2 prefix", () => {
    expect(encodeSessionDirName("a")).toBe("v2_61");
    expect(encodeSessionDirName("中文")).toBe("v2_e4b8ade69687");
    expect(encodeSessionDirName("中文")).toBe(encodeSessionDirName("中文"));
  });

  it("remains distinct after ASCII case folding for legacy base64url collision keys", () => {
    const upper = encodeSessionDirName("AAG");
    const mixed = encodeSessionDirName("AAa");

    expect(upper).toBe("v2_414147");
    expect(mixed).toBe("v2_414161");
    expect(upper).toBe(upper.toLowerCase());
    expect(mixed).toBe(mixed.toLowerCase());
    expect(upper.toLowerCase()).not.toBe(mixed.toLowerCase());
  });

  it.each([
    "CON",
    "PRN",
    "AUX",
    "NUL",
    "COM1",
    "LPT9",
  ])("does not emit the Windows reserved device name %s", (reservedName) => {
    const encoded = encodeSessionDirName(reservedName);

    expect(encoded.toUpperCase()).not.toBe(reservedName);
    expect(encoded).not.toMatch(WINDOWS_FORBIDDEN_CHARACTERS);
    expect(encoded).not.toMatch(/[. ]$/);
    expect(decodeSessionDirName(encoded)).toBe(reservedName);
  });

  it("encodes path separators, a colon, and other Windows-forbidden characters", () => {
    const key = 'agent:main/path\\child?<name>|"state"*';
    const encoded = encodeSessionDirName(key);

    expect(encoded).toMatch(/^v2_[0-9a-f]+$/);
    expect(encoded).not.toMatch(WINDOWS_FORBIDDEN_CHARACTERS);
    expect(decodeSessionDirName(encoded)).toBe(key);
  });

  it("rejects empty logical keys", () => {
    expect(() => encodeSessionDirName("")).toThrow(/empty/i);
    expect(() => encodeSessionDirName("   ")).toThrow(/empty/i);
  });

  it.each([" a ", "\ta", "a\t", "\na", "a\n"])("rejects a nonempty key with boundary whitespace: %j", (key) => {
    expect(() => encodeSessionDirName(key)).toThrow(/whitespace/i);
  });

  it("does not collapse boundary-whitespace keys onto a valid key", () => {
    expect(encodeSessionDirName("a")).toBe("v2_61");
    expect(() => encodeSessionDirName(" a ")).toThrow(/whitespace/i);
  });

  it.each([
    ["lone high surrogate", "\uD800"],
    ["lone low surrogate", "\uDC00"],
    ["two high surrogates", "\uD800\uD800"],
    ["high surrogate followed by a non-low surrogate", "\uD800a"],
  ])("rejects an ill-formed UTF-16 key containing a %s", (_description, key) => {
    expect(() => encodeSessionDirName(key)).toThrow(/UTF-16/i);
  });

  it("does not encode lone surrogates to the same component as U+FFFD", () => {
    const replacementCharacterName = encodeSessionDirName("\uFFFD");

    expect(() => encodeSessionDirName("\uD800")).toThrow(/UTF-16/i);
    expect(() => encodeSessionDirName("\uDC00")).toThrow(/UTF-16/i);
    expect(decodeSessionDirName(replacementCharacterName)).toBe("\uFFFD");
  });

  it("roundtrips a valid paired surrogate", () => {
    const emoji = "😀";
    const encoded = encodeSessionDirName(emoji);

    expect(decodeSessionDirName(encoded)).toBe(emoji);
  });

  it.each([
    "legacy:raw",
    "v2_YQ",
    "v2_",
    "v2_0",
    "v2_6g",
    "v1_",
    "v1_not valid",
    "v1_YQ==",
    "v1_wA",
  ])("returns null for malformed encoded name %s", (encoded) => {
    expect(decodeSessionDirName(encoded)).toBeNull();
  });

  it("decodes canonical v1 base64url names for migration only", () => {
    expect(decodeSessionDirName("v1_YQ")).toBe("a");
    expect(decodeSessionDirName("v1_5Lit5paH")).toBe("中文");
  });

  it("rejects a non-canonical legacy base64url spelling of a valid payload", () => {
    expect(decodeSessionDirName("v1_YR")).toBeNull();
  });

  it("rejects encoded names that decode to an invalid empty logical key", () => {
    expect(decodeSessionDirName("v1_IA")).toBeNull();
  });

  it("accepts only directory components at or below the 240 UTF-8 byte contract", () => {
    const largestAcceptedAsciiKey = "x".repeat(118);
    const encoded = encodeSessionDirName(largestAcceptedAsciiKey);

    expect(Buffer.byteLength(encoded, "utf8")).toBe(239);
    expect(decodeSessionDirName(encoded)).toBe(largestAcceptedAsciiKey);
    expect(() => encodeSessionDirName("x".repeat(119))).toThrow(/240/);
    expect(() => encodeSessionDirName("x".repeat(300))).toThrow(/240/);
  });

  it("measures the 240-byte contract in UTF-8 bytes rather than code points", () => {
    const largestAcceptedUnicodeKey = "中".repeat(39);
    const encoded = encodeSessionDirName(largestAcceptedUnicodeKey);

    expect(Buffer.byteLength(largestAcceptedUnicodeKey, "utf8")).toBe(117);
    expect(Buffer.byteLength(encoded, "utf8")).toBe(237);
    expect(decodeSessionDirName(encoded)).toBe(largestAcceptedUnicodeKey);
    expect(() => encodeSessionDirName("中".repeat(40))).toThrow(/240/);
  });

  it("does not silently truncate or collide near the component-size limit", () => {
    const firstKey = `${"x".repeat(117)}a`;
    const secondKey = `${"x".repeat(117)}b`;
    const firstEncoded = encodeSessionDirName(firstKey);
    const secondEncoded = encodeSessionDirName(secondKey);

    expect(firstEncoded).not.toBe(secondEncoded);
    expect(decodeSessionDirName(firstEncoded)).toBe(firstKey);
    expect(decodeSessionDirName(secondEncoded)).toBe(secondKey);
  });
});
