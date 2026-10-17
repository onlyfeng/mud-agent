# mud-agent

AI 驱动的 MUD 文字游戏助手。通过自然语言对话体验 MUD 游戏，无需学习任何命令。

> "就像和一个资深 MUD 玩家朋友对话，他帮你操作，你只管享受游戏世界。"

## 快速安装

```bash
git clone https://github.com/onlyfeng/mud-agent
cd mud-agent && npm install && bash install.sh
```

**要求**：Node.js >= 20.19.0

安装脚本会：

- 编译最新 `dist/`
- 同步运行时 bundle 到 `~/.mud-agent/`
- 写入 `mud-ctl.js` / `mud-daemon.js` / `autopilot.js` shim
- 复制最小运行时依赖（`iconv-lite`、`safer-buffer`）

这样 `~/.mud-agent/mud-ctl.js` 不再依赖一份过时的手工脚本，安装态会直接跟随仓库里的 TypeScript CLI。

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
| `daemon.log` | 守护进程日志（2 MiB 上限，满了轮转到 `daemon.log.1`；游戏原文只保留非噪音行） |
| `.heartbeat` | 进程心跳（每 30 秒更新） |
| `profile.json` | （可选）本会话的游戏画像：服务器文本语义，见下节 |

## 游戏画像（`profile.json`）

公共核心不内置任何服务器的文本写法。HP/MP/等级/金币怎么写、出口怎么列、什么算战斗开始/结束、哪些播报是事件、
哪些行是噪音、方向词怎么反向，全部来自**游戏画像**，按这个顺序查找第一个存在的文件：

1. `<会话目录>/profile.json`（本会话专用）
2. `<存储根>/profiles/<server.host>.json`（同一服务器的所有会话共用；存储根由启动器通过 `MUD_STORAGE_ROOT` 交给子进程，默认 `~/.mud-agent`，不带 `--session` 的扁平会话就是会话目录本身；`server.host` 取自 `config.json`；主机名小写，DNS 名 / IPv4 原样，IPv6 等含特殊字符的按 URL 百分号编码，如 `2001%3Adb8%3A%3A1.json`）
3. 内置默认画像（随包发布为 `profiles/example.json`，是一台中文 LPMud 的示例，不是通用规则）

画像文件只需写要改的部分：按"顶层分区 → 字段"两级合并到默认画像上，数组整体替换。正则写成字符串，
需要 flags 时写 `{ "pattern": "...", "flags": "i" }`。文件存在但不合法（类型错误、缺捕获组、拼错的键）时 daemon 会带着出错的键拒绝启动，不会悄悄退回默认。

```json
{
  "name": "my-mud",
  "status": { "query": "score", "hp": ["HP\\s*(\\d+)/(\\d+)"] },
  "combat": { "start": ["attacks you"], "end": ["is DEAD"] },
  "exits": { "room": ["^\\[Exits: (.+)\\]$"], "splitter": "[,\\s]+" },
  "triggers": [{ "id": "death", "pattern": "You are DEAD", "priority": "critical", "label": "你死了", "advice": "找复活点", "discrete": true }]
}
```

字段含义（捕获组约定等）见 `src/core/game-profile.ts` 的类型注释；完整示例见 `profiles/example.json`。
画像由驾驭模型在实际游戏中观察回包生成、持续迭代——换服务器时复制示例按回包改，而不是改核心代码。

血量上限只由双值样本建立：单值样本（`生命值：80`、`<80 hp>` 提示符）沿用已知上限、超过时置为未知；上限未知、或双值样本超过 5 分钟保鲜期时，
autopilot 发画像里的 `status.query` 刷新并暂停策略直到新的双值样本到来（陪伴模式由驾驭模型自己发状态命令）——升级 / 换装靠保鲜期兜底，核心不从文本猜。

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

Topic 级会话也可直接用安装态入口：

```bash
node ~/.mud-agent/mud-ctl.js status --session 'agent:main:telegram:group:-100xxxxxxxxxx:topic:<id>'
```

SessionKey 新规范：

- Telegram 群 Topic：`agent:main:telegram:group:<chatId>:topic:<topicId>`
- Telegram 私聊：`agent:main:telegram:direct:<chatId>`
- 历史别名（如 `topic-<id>`、`telegram:-100...:<id>`）只做兼容解析，不再作为新目录创建目标

Session 目录治理：

```bash
# 审计当前 session 命名与 alias 情况（dry-run）
npm run normalize:sessions

# 备份后迁移 ownership 明确的 v1，并归档可判定的 legacy alias 目录
npm run normalize:sessions:apply

# 若确认要连其他 unmanaged raw 旧目录一起归档（ownerless v2 始终保留）
node scripts/normalize-sessions.mjs --apply --archive-unmanaged
```

### OpenClaw 工具参数

`mud_act` 参数：

- `waitMs`：等待上限，默认 2500 ms
- `quietMs`：静默窗，默认 500 ms，首批新输出到达后静默这么久即返回
- `fallbackLines`：没有新输出时回读的行数，默认 20

### Session 存储与 transcript 边界

Mud 自身管理的 session 数据位于 `~/.mud-agent/sessions/`，目录名使用跨平台编码，不依赖
`sessionKey` 中的冒号能否直接用于文件名。新写目录使用
`v2_<lowercase hex(UTF-8 sessionKey)>`；只包含 ASCII 小写字母和数字，在默认大小写不敏感的
Windows 文件系统上仍保持一一对应。`decodeSessionDirName()` 继续识别旧的 `v1_<base64url>`，
但 v1 只用于兼容迁移，不再用于新写入。

Store 初始化或访问时会校验 registry 条目完整性与 logical key / alias 的唯一 owner；alias ownership
使用与实际路由一致的共享归一化规则，因此 `topic:1` / `topic-1` 等等价形式不能属于不同 owner。Store
还会在写入前同时预检当前目录和 planned final-state。只有 registry 证明 owner 唯一、且 v2 目标安全时，
canonical 或显式 alias 的 v1 才会在同一 `sessions/` 下原子 rename。`AAG -> v1_QUFH` /
`AAa -> v1_QUFh` 这类 case-fold
歧义、损坏或 key / `sessionKey` 漂移的 registry、重复 alias owner、非规范 encoded-looking 名、字面
`v1_*` / `v2_*` raw key 竞争或 v1/v2 并存，都会在首个 mkdir / copy / rename 前失败并保留数据。
任何写入口调用 `ensure()` 时，如果 canonical、注册 alias 或算法派生的 Telegram 历史 alias 仍存在 raw / alias-v2
fallback 目录，也会在创建 canonical v2 目录和写 registry 前失败关闭，避免空目录按解析优先级静默遮蔽旧状态；
先运行 `npm run normalize:sessions` 审核迁移 / 归档计划，处理冲突后再重试写入口。

没有 registry owner 的规范 canonical / alias v2 目录按 stale/unmanaged 数据处理，同时列入
`skippedEncodedDirs` 与 `unmanagedDirs`，不阻断普通只读 hook；即使显式追加 `--archive-unmanaged`
也不会归档这类目录。该开关只归档其他可判定的 unmanaged raw 旧目录。

runtime rename 不生成备份；需要可审计备份时，先执行 `npm run normalize:sessions`，确认 dry-run 后再执行
`npm run normalize:sessions:apply`。normalizer 会在完整预检后事务化执行目录迁移与归档，并以同目录
temp + rename 原子替换 registry / manifest；任一步失败都会逆序尝试回滚已移动目录、恢复原 registry，并清理
安全临时文件。完整回滚成功时只删除本事务的 `backupRoot`；若任一反向目录移动或 registry 恢复失败，
或反向移动时发现 destination 已丢失 / source 已被并发重建，则不覆盖 source，并保留 registry 备份、
migration / archive 副本与 `recovery.json`；错误消息会记录 state conflict 与 recovery path，供人工恢复。
已存在的 timestamp parent 及其中原有条目不会被递归删除。迁移后的重复 apply 保持 no-op。

目录组件仍限制为 240 UTF-8 bytes。hex v2 最多承载 118 bytes 的 UTF-8 sessionKey，低于 v1 的
177 bytes；超过上限的旧 key 不会被截断或 hash，而是要求人工调整 logical key / registry 后再迁移。

工具链长度和排队消息数量从 `before_prompt_build` 事件本身统计：宿主传入的 `messages`
会话快照用来数最近连续的 tool call 轮数，`currentUserMessage` / `prompt` 用来识别
`[Queued messages while agent was busy]` 块里的 `Queued #N` 条数，不再依赖上游的 transcript 文件
（OpenClaw 已把会话存进 SQLite，`~/.openclaw/agents/main/sessions/*.jsonl` 只剩历史文件）。只有宿主完全
没有传 `messages` 时，才回退到按带 raw-colon `sessionKey` 后缀扫描该目录的旧逻辑；回退路径找不到匹配
文件时，链长检查安全降级为 `false`，排队消息计数降级为 `0`，hook 继续执行但不注入对应的停止或排队提示。

## 作为 AI Skill / 插件使用

**Claude Code**

```bash
ln -s /path/to/mud-agent ~/.claude/skills/mud-agent
```

**OpenClaw（多平台 IM 插件）**

```bash
openclaw plugins install path:/path/to/mud-agent
```

### OpenClaw 模型路由（低延迟模型）

插件会在已注册的 MUD 会话（`/mud start` 建过 session 目录的话题，不要求守护进程正在运行）里把模型自动切到配置项 `model`（必须显式配置，未配置则不覆盖），`/mud reset` 删掉目录后回落到 agent 默认模型。上线 / 下线回合因此也走低延迟模型。在 `~/.openclaw/openclaw.json` 里配置：

模型配置路径是 `plugins.entries.mud-agent.config.model`，thinking 档位在 `agents.defaults.models` 下单独设置。

```json5
{
  plugins: {
    entries: {
      "mud-agent": {
        enabled: true,
        hooks: { allowConversationAccess: true },
        config: { model: "<provider>/deepseek-flash" },
      },
    },
  },
  agents: {
    defaults: {
      models: {
        "<provider>/deepseek-flash": { params: { thinking: "high" } },
      },
    },
  },
}
```

`hooks.allowConversationAccess: true` 不能省：OpenClaw 2026.10.3 对非内置插件默认拦截 `before_prompt_build` 和 `before_model_resolve`，不开这个键时 MUD 提示词注入和模型覆盖都会被静默跳过，只在 gateway 日志里留一条 WARN。网关加载的是 `labs/mud-agent/dist/index.js`，改了 `src/` 之后要先跑 `npm run build`（或 `npm run ci`），再执行 `openclaw plugins install --link --force <path>` 或重载。

2026-10-14 在本中转上实测，thinking 档位对延迟没有可测影响：暖缓存交错跑时 off、low、high 的单回合墙钟都在 4 到 5.5 秒之间，差异落在噪声内；第一轮里 off 最慢，是因为前两次运行时 18k token 的系统提示词还没进缓存。选 `"high"` 是因为它不增加延迟，又给工具决策留足推理。deepseek-flash 回合大约 5 秒，比默认的 gpt-6-astra（9.4 秒）快一倍左右。`model` 设为空字符串即关闭覆盖。验证方式：gateway 日志出现 `[hooks] model overridden to deepseek-flash`。

## 开发

```bash
npm ci               # 按 lockfile 安装依赖
npm run build        # 编译 TypeScript
npm run watch        # 监听编译
npm test             # 运行测试
npm run test:coverage # 覆盖率报告
npm run lint         # Biome 检查
npm run typecheck    # TypeScript 类型检查
npm run verify:sessions # 校验 session normalize 脚本的 fixture 审计/归并行为
npm run ci           # typecheck + lint + test + verify:sessions + build
npm audit
npm audit --omit=dev
```

说明：仓库根 pre-commit 已在 `labs/mud-agent/` 变更时触发 `npm run ci`，而 `ci` 现在包含 `verify:sessions`，后续改 session 逻辑时会强制跑一次 normalize 审计校验。

## License

[MIT](LICENSE)
