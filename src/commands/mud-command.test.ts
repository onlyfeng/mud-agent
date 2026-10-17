import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

type CommandDef = { handler: (ctx: Record<string, unknown>) => Promise<{ text: string }> };

async function loadCommand(homeDir: string) {
  process.env.HOME = homeDir;
  vi.resetModules();
  const cmd = await import("./mud-command");
  const store = await import("../storage/session-store");
  const sessionKey = await import("../lib/session-key");
  let def: CommandDef | undefined;
  cmd.registerMudCommand({
    registerCommand: (d: CommandDef) => {
      def = d;
    },
  } as unknown as import("../core/types.js").OpenClawPluginApi);
  if (!def) throw new Error("command not registered");
  return { handler: def.handler, ...store, ...sessionKey };
}

const SESSION_KEY = "agent:main:telegram:group:-1009000000000:topic:7";
function ctx(args: string): Record<string, unknown> {
  return {
    channel: "telegram",
    sessionKey: SESSION_KEY,
    args,
    commandBody: `/mud ${args}`,
    config: {},
    isAuthorizedSender: true,
  };
}

describe("/mud start registration", () => {
  const originalHome = process.env.HOME;
  const dirs = new Set<string>();
  function tempHome(): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "mud-agent-mud-command-"));
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

  it("does not register the topic when start is rejected (bad host:port, or no args without a config)", async () => {
    const mods = await loadCommand(tempHome());
    const dir = mods.resolveSessionDir(mods.getMudSessionStore(), SESSION_KEY);

    expect((await mods.handler(ctx("start"))).text).toMatch(/no server configured/);
    expect(fs.existsSync(dir)).toBe(false);
    expect((await mods.handler(ctx("start nohostport"))).text).toMatch(/host:port/);
    expect(fs.existsSync(dir)).toBe(false);
    expect((await mods.handler(ctx("start example.com:not-a-port"))).text).toMatch(/port 1-65535/);
    expect(fs.existsSync(dir)).toBe(false);
    expect((await mods.handler(ctx("start example.com:70000"))).text).toMatch(/port 1-65535/);
    expect(fs.existsSync(dir)).toBe(false);
    expect(mods.getMudSessionStore().get(SESSION_KEY)).toBeUndefined();
  });

  it("refuses /mud mode on a never-initialized topic without creating its directory", async () => {
    const mods = await loadCommand(tempHome());
    const dir = mods.resolveSessionDir(mods.getMudSessionStore(), SESSION_KEY);

    expect((await mods.handler(ctx("mode semi-auto"))).text).toMatch(/no MUD session yet/);
    expect(fs.existsSync(dir)).toBe(false);
  });
});
