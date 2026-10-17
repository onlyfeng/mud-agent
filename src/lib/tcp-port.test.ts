import { describe, expect, it } from "vitest";
import { parseTcpPort } from "./tcp-port";

describe("parseTcpPort", () => {
  it("accepts integers in the TCP range from strings and numbers", () => {
    expect(parseTcpPort("8081")).toBe(8081);
    expect(parseTcpPort(" 23 ")).toBe(23);
    expect(parseTcpPort(65535)).toBe(65535);
  });

  it("rejects anything that is not a finite port", () => {
    for (const bad of ["not-a-port", "0", "65536", "8081abc", "", undefined, null, 1.5, "-1", "1e3"]) {
      expect(parseTcpPort(bad)).toBeNull();
    }
  });
});
