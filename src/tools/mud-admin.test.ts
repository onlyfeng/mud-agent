import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

type ToolDef = { execute: (id: string, params: Record<string, unknown>) => Promise<{ content: { text: string }[] }> };

async function loadTool(homeDir: string) {
  process.env.HOME = homeDir;
  vi.resetModules();
  const tool = await import("./mud-admin");
  const store = await import("../storage/session-store");
  const sessionKey = await import("../lib/session-key");
  let def: ToolDef | undefined;
  tool.registerMudAdminTool({
    registerTool: (d: ToolDef) => {
      def = d;
    },
  } as unknown as import("../core/types.js").OpenClawPluginApi);
  if (!def) throw new Error("tool not registered");
  return { execute: def.execute, ...store, ...sessionKey };
}

const SESSION_KEY = "agent:main:telegram:group:-1009000000000:topic:8";

describe("mud_admin registration", () => {
  const originalHome = process.env.HOME;
  const dirs = new Set<string>();
  function tempHome(): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "mud-agent-mud-admin-"));
    dirs.add(d);
    return d;
  }
  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    vi.resetModules();
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
    dirs.clear();
  });

  it("does not register the session when setup is rejected or when a non-setup action hits an unknown key", async () => {
    const mods = await loadTool(tempHome());
    const dir = mods.resolveSessionDir(mods.getMudSessionStore(), SESSION_KEY);

    for (const setupArgs of [
      undefined,
      { host: "example.com" },
      { host: "example.com", port: "nope" },
      { port: 8081 },
    ]) {
      const res = await mods.execute("1", { sessionKey: SESSION_KEY, action: "setup", setupArgs });
      expect(res.content[0].text).toMatch(/缺少 host 或 port/);
      expect(fs.existsSync(dir)).toBe(false);
    }
    const stop = await mods.execute("2", { sessionKey: SESSION_KEY, action: "stop" });
    expect(stop.content[0].text).toMatch(/尚未初始化/);
    expect(fs.existsSync(dir)).toBe(false);
    expect(mods.getMudSessionStore().get(SESSION_KEY)).toBeUndefined();
  });

  it("registers the session on a valid setup and stores the numeric port", async () => {
    const mods = await loadTool(tempHome());
    const res = await mods.execute("3", {
      sessionKey: SESSION_KEY,
      action: "setup",
      setupArgs: { host: "example.com", port: 8081 },
    });
    expect(res.content[0].text).toMatch(/配置已保存/);
    const dir = mods.resolveSessionDir(mods.getMudSessionStore(), SESSION_KEY);
    expect(JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8")).server.port).toBe(8081);
  });
});
