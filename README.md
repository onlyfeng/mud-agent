# mud-agent

AI 驱动的 MUD 文字游戏助手。通过自然语言对话体验 MUD 游戏，无需学习任何命令。

> "就像和一个资深 MUD 玩家朋友对话，他帮你操作，你只管享受游戏世界。"

## 快速安装

```bash
git clone https://github.com/onlyfeng/mud-agent
cd mud-agent && npm install && npm run build
```

**要求**：Node.js >= 18

## 快速上手

```bash
# 1. 配置服务器（以北大侠客行为例）
npx mud-ctl setup "mud.pkuxkx.net" 8081 "utf8"

# 2. 启动守护进程
npx mud-ctl start

# 3. 查看服务器输出
npx mud-ctl read 30

# 4. 发送命令
npx mud-ctl send "look"
```

## 架构

```
五层架构（依赖方向 →）

core ─→ infra ─→ services ─→ cli
                            ─→ plugin (OpenClaw)
```

| 层 | 职责 | 示例 |
|----|------|------|
| **core** | 纯逻辑，零依赖 | types, encoding, state-parser, triggers, login-handler |
| **infra** | IO 与系统交互 | file-store, logger, paths, process-guard, notifier |
| **services** | 业务流程 | daemon.service, autopilot.service, strategies |
| **cli** | CLI 入口 | main.ts (mud-ctl), daemon-entry, autopilot-entry |
| **plugin** | OpenClaw 插件入口 | index.ts, tools/, commands/, hooks/ |

## 目录结构

```
mud-agent/
├── src/
│   ├── core/           ← 纯逻辑（types, encoding, triggers, state-parser）
│   ├── infra/          ← IO 层（file-store, logger, paths, process-guard）
│   ├── services/       ← 业务（daemon, autopilot + strategies）
│   ├── cli/            ← CLI 入口（mud-ctl, daemon-entry, autopilot-entry）
│   ├── index.ts        ← OpenClaw 插件入口
│   ├── commands/       ← /mud 斜杠命令
│   ├── hooks/          ← 系统提示注入
│   ├── tools/          ← MUD 工具（mud_act / mud_send 等）
│   ├── storage/        ← 多会话存储
│   └── lib/            ← 共享工具函数
├── dist/               ← 编译输出
├── docs/               ← 文档
├── skills/             ← Host skill 定义
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

## 运行时数据（默认 `~/.mud-agent/`）

| 文件 | 用途 |
|------|------|
| `config.json` | 服务器配置、账号凭证 |
| `output.jsonl` | 游戏输出流（最新 500 行） |
| `state.json` | 角色状态（HP/MP/位置/出口） |
| `alerts.json` | 触发器警报队列 |
| `daemon.log` | 守护进程日志 |
| `.heartbeat` | 进程心跳（每 30 秒更新） |

## 命令速查

```bash
# 配置
mud-ctl setup <host> <port> [encoding] [username] [password]
mud-ctl config-update-creds <username> <password>
mud-ctl config-show
mud-ctl login-step <触发正则> <发送内容>

# 守护进程
mud-ctl start / stop / restart / status

# 游戏交互
mud-ctl send <命令>
mud-ctl send-multi '["cmd1","cmd2"]'
mud-ctl read [行数]
mud-ctl state / alerts / alerts-clear

# 自动驾驶
mud-ctl autopilot start [exploration|grinding]
mud-ctl autopilot stop / status
mud-ctl decisions / decisions-resolve <id> <choice>
mud-ctl report [行数]
```

## 作为 AI Skill / 插件使用

**Claude Code**

```bash
ln -s /path/to/mud-agent ~/.claude/skills/mud-agent
```

**OpenClaw（多平台 IM 插件）**

```bash
openclaw plugins install path:/path/to/mud-agent
```

## 开发

```bash
npm install          # 安装依赖
npm run build        # 编译 TypeScript
npm run watch        # 监听编译
npm test             # 运行测试
npm run test:coverage # 覆盖率报告
npm run lint         # Biome 检查
npm run typecheck    # TypeScript 类型检查
```

## License

[MIT](LICENSE)
