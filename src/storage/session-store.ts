import fs from "node:fs";
import path from "node:path";
import type { MudSession } from "../core/types";

export type { MudSession };

export interface MudSessionConfig {
  host: string;
  port: number;
  encoding: string;
  username?: string;
  password?: string;
}

let storageRoot = path.join(process.env.HOME || "", ".mud-agent");

export function configureMudStorage(dir?: string) {
  if (dir) {
    storageRoot = dir;
  }
}

export function getStorageRoot(): string {
  return storageRoot;
}

export class MudSessionStore {
  public getStorageRoot() {
    return storageRoot;
  }

  public getSessionDataDir(sessionKey: string): string {
    return path.join(storageRoot, "sessions", sessionKey);
  }

  public getRegistryPath(): string {
    return path.join(storageRoot, "registry.json");
  }

  private loadRegistry(): Record<string, MudSession> {
    try {
      const p = this.getRegistryPath();
      if (!fs.existsSync(p)) return {};
      return JSON.parse(fs.readFileSync(p, "utf8"));
    } catch {
      return {};
    }
  }

  private saveRegistry(reg: Record<string, MudSession>) {
    const p = this.getRegistryPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(reg, null, 2));
  }

  public ensure(sessionKey: string): MudSession {
    const reg = this.loadRegistry();
    if (!reg[sessionKey]) {
      reg[sessionKey] = { sessionKey, mode: "active" };
      this.saveRegistry(reg);
    }
    const dir = this.getSessionDataDir(sessionKey);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return reg[sessionKey];
  }

  public get(sessionKey: string): MudSession | undefined {
    const reg = this.loadRegistry();
    return reg[sessionKey];
  }

  public setMode(sessionKey: string, mode: "active" | "paused" | "archived"): MudSession | undefined {
    const reg = this.loadRegistry();
    if (!reg[sessionKey]) return undefined;
    reg[sessionKey].mode = mode;
    this.saveRegistry(reg);
    return reg[sessionKey];
  }
}

let _store: MudSessionStore | null = null;
export function getMudSessionStore(): MudSessionStore {
  if (!_store) {
    _store = new MudSessionStore();
  }
  return _store;
}
