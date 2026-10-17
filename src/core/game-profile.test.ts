import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  activateGameProfile,
  compileGameProfile,
  DEFAULT_PROFILE_JSON,
  defaultGameProfile,
  GameProfileError,
  gameProfileCandidates,
  getGameProfile,
  loadGameProfile,
  mergeGameProfileJson,
  profileFileNameForHost,
} from "./game-profile";

const REPO_EXAMPLE = path.resolve(__dirname, "../../profiles/example.json");

describe("game profile", () => {
  it("ships profiles/example.json identical to the bundled default", () => {
    expect(JSON.parse(fs.readFileSync(REPO_EXAMPLE, "utf8"))).toEqual(DEFAULT_PROFILE_JSON);
  });

  it("falls back to the bundled default when no profile file exists", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mud-profile-"));
    const { profile, source } = loadGameProfile(dir, dir);
    expect(source).toBeNull();
    expect(profile).toBe(defaultGameProfile());
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("session profile.json wins over <root>/profiles/<host>.json, which wins over the default; sections merge field-wise", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mud-profile-"));
    const session = path.join(root, "sessions", "v2_abc");
    fs.mkdirSync(session, { recursive: true });
    fs.mkdirSync(path.join(root, "profiles"));
    fs.writeFileSync(
      path.join(session, "config.json"),
      JSON.stringify({ server: { host: "mud.example.org", port: 4000 } }),
    );
    expect(gameProfileCandidates(session, root)).toEqual([
      path.join(session, "profile.json"),
      path.join(root, "profiles", "mud.example.org.json"),
    ]);

    fs.writeFileSync(
      path.join(root, "profiles", "mud.example.org.json"),
      JSON.stringify({ name: "host", status: { query: "score" } }),
    );
    const byHost = loadGameProfile(session, root);
    expect(byHost.source).toBe(path.join(root, "profiles", "mud.example.org.json"));
    expect(byHost.profile.name).toBe("host");
    expect(byHost.profile.status.query).toBe("score"); // 覆盖的字段
    expect(byHost.profile.status.hp.length).toBe((DEFAULT_PROFILE_JSON.status.hp ?? []).length); // 同分区其他字段沿用默认
    expect(byHost.profile.triggers.length).toBe(DEFAULT_PROFILE_JSON.triggers.length);

    fs.writeFileSync(
      path.join(session, "profile.json"),
      JSON.stringify({ name: "session", combat: { end: ["^FIGHT OVER$"] }, triggers: [] }),
    );
    const bySession = loadGameProfile(session, root);
    expect(bySession.source).toBe(path.join(session, "profile.json"));
    expect(bySession.profile.name).toBe("session");
    expect(bySession.profile.combat.end.map(String)).toEqual(["/^FIGHT OVER$/"]); // 数组整体替换
    expect(bySession.profile.combat.start.length).toBe((DEFAULT_PROFILE_JSON.combat.start ?? []).length);
    expect(bySession.profile.triggers).toEqual([]); // 显式清空文本触发器
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("rejects an invalid profile file loudly instead of silently using the default", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mud-profile-"));
    fs.writeFileSync(path.join(dir, "profile.json"), JSON.stringify({ status: { hp: ["(unclosed"] } }));
    expect(() => loadGameProfile(dir, dir)).toThrow(GameProfileError);
    fs.writeFileSync(path.join(dir, "profile.json"), "{ not json");
    expect(() => loadGameProfile(dir, dir)).toThrow(GameProfileError);
    fs.writeFileSync(
      path.join(dir, "profile.json"),
      JSON.stringify({ triggers: [{ id: "x", pattern: "a", priority: "urgent", label: "x" }] }),
    );
    expect(() => loadGameProfile(dir, dir)).toThrow(/priority/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("strips stateful g / y flags so captures and repeated .test() calls stay reliable", () => {
    const profile = compileGameProfile(
      mergeGameProfileJson(DEFAULT_PROFILE_JSON, { status: { hp: [{ pattern: "HP (\\d+)/(\\d+)", flags: "gi" }] } }),
      "test",
    );
    expect(profile.status.hp[0].flags).toBe("i");
    expect("hp 10/20".match(profile.status.hp[0])?.slice(1)).toEqual(["10", "20"]);
    expect(profile.status.hp[0].test("HP 1/2")).toBe(true);
    expect(profile.status.hp[0].test("HP 1/2")).toBe(true); // 没有 lastIndex 交替漏报
  });

  it("uses the launcher-provided storage root (MUD_STORAGE_ROOT) and never guesses from the directory name", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "mud-profile-"));
    const sessionDir = path.join(base, "sessions", "game"); // 父目录恰好叫 sessions，但它不是多会话存储根
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionDir, "config.json"),
      JSON.stringify({ server: { host: "mud.example.org", port: 4000 } }),
    );
    const previous = process.env.MUD_STORAGE_ROOT;
    try {
      delete process.env.MUD_STORAGE_ROOT;
      expect(gameProfileCandidates(sessionDir)[1]).toBe(path.join(sessionDir, "profiles", "mud.example.org.json")); // 不猜：会话目录自己
      process.env.MUD_STORAGE_ROOT = base;
      expect(gameProfileCandidates(sessionDir)[1]).toBe(path.join(base, "profiles", "mud.example.org.json")); // 启动器显式传入
      expect(gameProfileCandidates(sessionDir, "/explicit")[1]).toBe(
        path.join("/explicit", "profiles", "mud.example.org.json"),
      );
    } finally {
      if (previous === undefined) delete process.env.MUD_STORAGE_ROOT;
      else process.env.MUD_STORAGE_ROOT = previous;
    }
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("a flat default session (no --session: the session dir is the storage root) still finds <root>/profiles/<host>.json", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mud-profile-"));
    fs.writeFileSync(
      path.join(root, "config.json"),
      JSON.stringify({ server: { host: "mud.example.org", port: 4000 } }),
    );
    expect(gameProfileCandidates(root)).toEqual([
      path.join(root, "profile.json"),
      path.join(root, "profiles", "mud.example.org.json"),
    ]);
    fs.mkdirSync(path.join(root, "profiles"));
    fs.writeFileSync(path.join(root, "profiles", "mud.example.org.json"), JSON.stringify({ name: "flat-host" }));
    expect(loadGameProfile(root).profile.name).toBe("flat-host");
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("counts capture groups with the rule's own flags (v-mode syntax stays valid) and rejects a mistyped room.maxLength", () => {
    const vMode = compileGameProfile(
      mergeGameProfileJson(DEFAULT_PROFILE_JSON, { status: { hp: [{ pattern: "HP ([\\d--[0]]+)", flags: "v" }] } }),
      "test",
    );
    expect(vMode.status.hp[0].flags).toBe("v");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mud-profile-"));
    fs.writeFileSync(path.join(dir, "profile.json"), JSON.stringify({ room: { maxLength: "40" } }));
    expect(() => loadGameProfile(dir, dir)).toThrow(/room\.maxLength: 需要正整数/);
    fs.writeFileSync(path.join(dir, "profile.json"), JSON.stringify({ room: { maxLength: 40 } }));
    expect(loadGameProfile(dir, dir).profile.room.maxLength).toBe(40);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("normalises reverse-table keys (trim + lowercase) and rejects blank ones", () => {
    const profile = compileGameProfile(
      mergeGameProfileJson(DEFAULT_PROFILE_JSON, { directions: { reverse: { "NORTH ": " south " }, aliases: [] } }),
      "test",
    );
    expect(profile.directions.reverse).toEqual({ north: "south" });
    const aliased = compileGameProfile(
      mergeGameProfileJson(DEFAULT_PROFILE_JSON, { directions: { reverse: {}, aliases: [["south", " s "]] } }),
      "test",
    );
    expect(aliased.directions.aliases).toEqual([["south", "s"]]);
    expect(() =>
      compileGameProfile(
        mergeGameProfileJson(DEFAULT_PROFILE_JSON, { directions: { reverse: { "  ": "x" }, aliases: [] } }),
        "test",
      ),
    ).toThrow(/directions\.reverse 的键/);
  });

  it("rejects capture-consuming rules without the required capture groups at compile time", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mud-profile-"));
    fs.writeFileSync(path.join(dir, "profile.json"), JSON.stringify({ exits: { state: ["^Exits: .+$"] } }));
    expect(() => loadGameProfile(dir, dir)).toThrow(/exits\.state\[0\].*捕获组/);
    fs.writeFileSync(path.join(dir, "profile.json"), JSON.stringify({ status: { hp: ["HP \\d+/\\d+"] } }));
    expect(() => loadGameProfile(dir, dir)).toThrow(/status\.hp\[0\]/);
    fs.writeFileSync(path.join(dir, "profile.json"), JSON.stringify({ items: { marker: ["^\\* .+"] } }));
    expect(() => loadGameProfile(dir, dir)).toThrow(/items\.marker\[0\]/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("names the host-level profile file reversibly and path-safely (IPv6 hosts included)", () => {
    expect(profileFileNameForHost("mud.example.org")).toBe("mud.example.org.json");
    expect(profileFileNameForHost("2001:db8::1")).toBe("2001%3Adb8%3A%3A1.json");
    expect(decodeURIComponent(profileFileNameForHost("2001:db8::1").replace(/\.json$/, ""))).toBe("2001:db8::1");
    expect(profileFileNameForHost("../evil")).not.toContain("/");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mud-profile-"));
    fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ server: { host: "::1", port: 4000 } }));
    expect(gameProfileCandidates(root)).toEqual([
      path.join(root, "profile.json"),
      path.join(root, "profiles", "%3A%3A1.json"),
    ]);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("compiles pattern specs with flags and exposes the active profile", () => {
    const json = mergeGameProfileJson(DEFAULT_PROFILE_JSON, {
      status: { hp: [{ pattern: "hp (\\d+)/(\\d+)", flags: "i" }] },
    });
    const profile = compileGameProfile(json, "test");
    expect(profile.status.hp[0].flags).toBe("i");
    expect("HP 10/20".match(profile.status.hp[0])?.slice(1)).toEqual(["10", "20"]);
    const previous = activateGameProfile(profile);
    try {
      expect(getGameProfile()).toBe(profile);
    } finally {
      activateGameProfile(previous);
    }
    expect(getGameProfile()).toBe(previous);
  });
});
