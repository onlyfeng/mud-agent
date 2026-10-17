import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

// 背景：package.json 是 `"type": "module"`，运行时没有 CJS 的 __dirname /
// __filename 全局；但 @types/node 把它们声明为全局，tsc / biome / vitest
// 都不会在编译期抱怨。真跑到对应代码路径才会 ReferenceError。
//
// 历史事故：`commands/mud-command.ts` 与 `tools/mud-admin.ts` 曾经都在
// spawn daemon / autopilot-entry 的路径里裸写 __dirname，导致 `/mud start`
// 与 `/mud mode semi-auto` 进入 handler 就炸。单元测试没有走到 handler
// 内部，也无法复现这个 bug。
//
// 本测试以语法层 grep 充当最小回归护盾：只要源码里出现 __dirname 或
// __filename，整份文件就必须同时导入 `fileURLToPath` 并引用 `import.meta.url`
// 完成 ESM polyfill（或整份是 `.cts` / `.cjs`）。如果将来想引入新的裸用法，
// 就必须先找到这个测试再绕开它，算一道显式闸门。

const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "dist") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(full));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("ESM __dirname / __filename polyfill regression guard", () => {
  test("every src file using __dirname or __filename must derive them from import.meta.url", () => {
    const files = walk(srcDir);
    const offenders: string[] = [];

    for (const file of files) {
      const content = fs.readFileSync(file, "utf8");
      // 只扫代码，不扫注释里的文字
      const codeOnly = content.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

      const mentionsDirname = /\b__dirname\b/.test(codeOnly);
      const mentionsFilename = /\b__filename\b/.test(codeOnly);
      if (!mentionsDirname && !mentionsFilename) continue;

      const hasFileURLToPathImport = /from\s+["']node:url["']/.test(codeOnly) && /fileURLToPath/.test(codeOnly);
      const referencesImportMetaUrl = /import\.meta\.url/.test(codeOnly);
      if (hasFileURLToPathImport && referencesImportMetaUrl) continue;

      offenders.push(path.relative(srcDir, file));
    }

    expect(
      offenders,
      `ESM 下这些文件裸用了 __dirname/__filename，需要 fileURLToPath(import.meta.url) polyfill：\n  - ${offenders.join("\n  - ")}`,
    ).toEqual([]);
  });
});
