import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readGameModeRecord, writeGameMode } from "./control-signal";

describe("writeGameMode", () => {
  it("derives the target mode inside the mode lock from the current record", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mud-mode-"));
    const select = (current: { mode: string } | null) => (current?.mode === "full-auto" ? "full-auto" : "semi-auto");
    writeGameMode(dir, select); // 无记录 → semi-auto
    expect(readGameModeRecord(dir)?.mode).toBe("semi-auto");
    writeGameMode(dir, "full-auto");
    writeGameMode(dir, select); // full-auto 保留
    expect(readGameModeRecord(dir)?.mode).toBe("full-auto");
    writeGameMode(dir, "companion");
    writeGameMode(dir, select); // companion → semi-auto
    expect(readGameModeRecord(dir)?.mode).toBe("semi-auto");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("the config updater sees the mode the selector chose from (companion→semi-auto restores pauseOn; semi-auto keeps custom pauseOn)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mud-mode-"));
    const defaults = ["rare_item", "boss", "puzzle", "level_up"];
    const start = () => {
      let fromMode: string | undefined;
      writeGameMode(
        dir,
        (current) => {
          fromMode = current?.mode;
          return fromMode === "full-auto" ? "full-auto" : "semi-auto";
        },
        (cfg: Record<string, unknown>) => ({
          ...cfg,
          ...(fromMode !== "full-auto" && fromMode !== "semi-auto" ? { pauseOn: defaults } : {}),
        }),
      );
    };
    writeGameMode(dir, "companion", { pauseOn: [] }); // full-auto 残留的空规则
    start();
    expect(readGameModeRecord(dir)?.autopilotConfig?.pauseOn).toEqual(defaults);
    writeGameMode(dir, "semi-auto", { pauseOn: ["boss"] }); // 操作者自定义
    start();
    expect(readGameModeRecord(dir)?.autopilotConfig?.pauseOn).toEqual(["boss"]); // 已是 semi-auto：原样保留
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
