#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
TARGET_DIR="${MUD_DIR:-$HOME/.mud-agent}"

log() {
  printf '[install] %s\n' "$1"
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf '缺少依赖命令: %s\n' "$1" >&2
    exit 1
  fi
}

write_wrapper() {
  local target="$1"
  local entry="$2"
  cat >"$target" <<EOF
#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

if (!process.env.MUD_DIR) {
  process.env.MUD_DIR = __dirname;
}

await import(pathToFileURL(path.join(__dirname, "${entry}")).href);
EOF
  chmod +x "$target"
}

# 按 Node 的解析规则定位运行时依赖：npm 安装的发布包里依赖通常被提升到上层 node_modules，不在 $ROOT_DIR/node_modules
resolve_runtime_dep() {
  node -e 'const p=require("path");try{process.stdout.write(p.dirname(require.resolve(process.argv[1]+"/package.json",{paths:[process.argv[2]]})))}catch{process.exit(1)}' "$1" "$ROOT_DIR"
}

copy_runtime_dep() {
  local name="$1"
  local src
  src="$(resolve_runtime_dep "$name")" || {
    printf '无法解析运行时依赖 %s（从 %s 起）。源码仓库请先 npm install；发布包请重新安装该包\n' "$name" "$ROOT_DIR" >&2
    exit 1
  }
  local dest="$TARGET_DIR/node_modules/$name"
  rm -rf "$dest"
  mkdir -p "$(dirname "$dest")"
  cp -R "$src" "$dest"
}

require_cmd node

# 只有源码 checkout（没有已发布的 dist）才在这里 npm install；发布包自带 dist，依赖由上层 node_modules 提供，不做嵌套安装
if [ ! -d "$ROOT_DIR/node_modules" ] && [ ! -d "$ROOT_DIR/dist" ]; then
  require_cmd npm
  log "node_modules 不存在且无已发布 dist，先执行 npm install"
  (cd "$ROOT_DIR" && npm install)
fi

log "构建最新 dist 产物"
# 只有项目本地的编译依赖齐全（tsc + @types/node 都在 node_modules 里）才重建；
# 宿主机碰巧有全局 tsc 不算：它没有本项目的 @types，构建会失败。否则直接部署包内已发布的 dist。
if [ -f "$ROOT_DIR/node_modules/.bin/tsc" ] && [ -d "$ROOT_DIR/node_modules/@types/node" ]; then
  (cd "$ROOT_DIR" && npm run build)
elif [ -d "$ROOT_DIR/dist" ]; then
  log "本地编译依赖不全（发布包安装），跳过构建，使用包内已发布的 dist"
else
  printf '既没有 tsc 也没有已构建的 dist/：请在源码仓库内执行 npm install && npm run build，或安装包含 dist/ 的发布包\n' >&2
  exit 1
fi

# 目标目录就是源码 checkout（仓库放在 ~/.mud-agent，或 MUD_DIR="$PWD"）：下面的 rm -rf 会删掉刚构建的 dist 再自拷贝，必须拒绝
mkdir -p "$TARGET_DIR"
if [ "$(cd -- "$TARGET_DIR" && pwd -P)" = "$(cd -- "$ROOT_DIR" && pwd -P)" ]; then
  printf '运行时目录与源码目录相同（%s）：请把 MUD_DIR 指向另一个目录，或把仓库移出 ~/.mud-agent\n' "$TARGET_DIR" >&2
  exit 1
fi

log "同步运行时目录到 $TARGET_DIR"
rm -rf "$TARGET_DIR/dist"
cp -R "$ROOT_DIR/dist" "$TARGET_DIR/dist"

mkdir -p "$TARGET_DIR/node_modules"
copy_runtime_dep "iconv-lite"
copy_runtime_dep "safer-buffer"

cat >"$TARGET_DIR/package.json" <<'EOF'
{
  "name": "mud-agent-runtime",
  "private": true,
  "type": "module"
}
EOF

write_wrapper "$TARGET_DIR/mud-ctl.js" "dist/cli/main.js"
write_wrapper "$TARGET_DIR/mud-daemon.js" "dist/cli/daemon-entry.js"
write_wrapper "$TARGET_DIR/autopilot.js" "dist/cli/autopilot-entry.js"

log "安装完成"
log "  目标目录: $TARGET_DIR"
log "  控制入口: node $TARGET_DIR/mud-ctl.js"
log "  已正式支持: node $TARGET_DIR/mud-ctl.js status --session '<sessionKey>'"
