import { describe, expect, it } from "vitest";
import { decode, encode, stripAnsi } from "./encoding";

describe("encoding", () => {
  describe("decode", () => {
    it("decodes utf8 buffer", () => {
      const buf = Buffer.from("hello 世界");
      expect(decode(buf, "utf8")).toBe("hello 世界");
    });
    it("falls back to utf8 for empty encoding", () => {
      const buf = Buffer.from("test");
      expect(decode(buf, "")).toBe("test");
    });
  });

  describe("encode", () => {
    it("encodes utf8 string to buffer", () => {
      const buf = encode("hello", "utf8");
      expect(buf.toString("utf8")).toBe("hello");
    });
  });

  describe("stripAnsi", () => {
    it("strips ANSI color codes", () => {
      expect(stripAnsi("\x1b[31mred\x1b[0m")).toBe("red");
    });
    it("strips carriage returns", () => {
      expect(stripAnsi("hello\r\nworld")).toBe("hello\nworld");
    });
    it("strips control characters", () => {
      expect(stripAnsi("he\x07llo")).toBe("hello");
    });
    it("strips Telnet IAC sequences", () => {
      expect(stripAnsi("hi\xff\xfb\x01there")).toBe("hithere");
    });
    it("handles empty string", () => {
      expect(stripAnsi("")).toBe("");
    });
    it("preserves normal Chinese text", () => {
      expect(stripAnsi("你好世界")).toBe("你好世界");
    });
  });
});
