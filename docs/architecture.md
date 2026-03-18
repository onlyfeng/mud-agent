# 系统架构

## 四层设计

```
用户（自然语言）
    ↕ 随时响应
AI 对话层（主 Agent / Claude Code / OpenCode）
    ↕ 读文件 / 启动 Background Agent / 接收完成通知
AI 执行层（Background Agent / autopilot.js）
    ↕ 文件 IPC（写 report.md / decisions.json，读 autopilot-config.json）
mud-ctl.js + mud-daemon.js（持久连接层）
    ↕ TCP Telnet
MUD 服务器
```

---

## 三种运行模式

用户通过自然语言切换，主 Agent 负责感知并相应调整行为：

| 模式 | 用户说什么 | 主 Agent | 执行层 |
|------|-----------|---------|-------|
| **互动模式**（默认） | 直接对话 / "我来" / "停一下" | 每步叙述，等用户决策 | 不启动 |
| **半自动模式** | "你去探索，有意思的告诉我" | 读 report.md 汇报亮点 | autopilot 跑，定期写叙事日志，遇亮点暂停 |
| **全自动模式** | "去练级，快死了叫我" | 只在决策点/危险时介入 | autopilot 跑，只在关键事件写 decisions.json 并暂停 |

**用户插话规则**：任何时候用户发消息，主 Agent 立即：
1. 读当前游戏状态（state.json + report.md 最新段落）
2. 一句话交代"现在在哪、刚发生了什么"
3. 响应用户的具体问题或指令
4. 询问是否继续自动 / 接管控制

---

## 第一层：持久连接守护进程（mud-daemon.js）

负责维持与 MUD 服务器的长连接，独立于 AI 工具进程运行。

| 功能 | 说明 |
|------|------|
| TCP Telnet 连接 | 断线自动重连（15 秒延迟） |
| 编码处理 | iconv-lite 支持 GBK / Big5 / UTF-8，自动剥离 ANSI 颜色码 |
| 输出缓冲 | `output.jsonl` 环形缓冲，保留最新 500 行 |
| 无换行提示刷出 | rawBuf 超过 300ms 无新数据时主动刷出 |
| 命令发送 | 每 500ms 轮询 `send-queue.json`，批量发送 |
| 状态解析 | 从游戏文本中提取 HP / MP / 位置 / 出口 / 等级 / 金币 |
| 触发器系统 | 9 类内置触发器，检测后写入 `alerts.json` |
| 自动登录 | 检测登录提示，按配置发送账号/密码/自定义序列 |
| 控制监听 | 每秒读取 `control.json`，响应 stop / reconnect 指令 |

### 触发器列表

| ID | 条件 | 优先级 |
|----|------|--------|
| `death` | 角色死亡文本 | critical |
| `hp_critical` | HP < 20% | critical |
| `hp_low` | HP < 35% | high |
| `boss` | Boss/首领关键词 | high |
| `puzzle` | 谜题/机关关键词 | high |
| `level_up` | 升级文本 | normal |
| `quest_update` | 任务完成/更新 | normal |
| `rare_item` | 稀有物品关键词 | normal |
| `npc_talk` | NPC 对话检测 | low |

---

## 第二层：控制接口（mud-ctl.js）

AI 工具与守护进程之间的桥接，通过文件 IPC 实现零耦合通信。

| 操作 | 机制 |
|------|------|
| 发命令 | 写入 `send-queue.json`，守护进程 500ms 内处理 |
| 读输出 | 读取 `output.jsonl` 的最近 N 行 |
| 查状态 | 读取 `state.json`（守护进程实时更新） |
| 查警报 | 读取 `alerts.json` |
| 停止守护进程 | 写入 `control.json`，守护进程读取后删除并执行 |

---

## 第三层：AI 执行层（autopilot / Background Agent）

**半自动/全自动模式下**，由 Background Agent 或 autopilot.js 承担游戏执行：

### 决策分层

| 层次 | 机制 | 时间窗口 | 典型场景 |
|------|------|---------|---------|
| 反应层 | daemon 触发器（规则） | 亚秒 | HP 危急自动逃、死亡检测 |
| 战术层 | Background Agent 分段执行 | 数秒～数十秒 | 战斗中每 N 轮回主 Agent 汇报 |
| 战略层 | 主 Agent + 用户参与 | 分钟级 | 拜师、探索路线、重要 NPC |

### Background Agent 分段模式（战术决策）

```
主 Agent 启动「战斗 Agent」（background）
    ↓
执行 N 轮（自主：规则 + 读文件）
    ↓
遇决策点 or 轮次上限 → 完成，返回叙事结果给主 Agent
    ↓
主 Agent 处理 → 必要时问用户 → 启动下一段
```

### 叙事优先原则

执行层写入 report.md 的内容必须是**故事片段**，不是状态报告：
- ❌ "走了 5 个房间，HP 100%"
- ✅ "穿过松树林，云雾中隐约出现一块巨石，上面刻着诗……"

OS 通知同理，内容要有画面感，而不是"游戏状态更新"。

---

## 第四层：AI 对话层（主 Agent）

主 Agent 在所有模式下保持高响应性，核心职责：

```
用户发消息
    ↓
1. 读 alerts.json（有无紧急事件）
2. 读 report.md 最新段落 + state.json（当前状态）
3. 读 decisions.json（有无待决策事项）
4. 用叙事语气汇报现状 + 响应用户问题
5. 处理决策 / 接管控制 / 继续委托执行层
```

**互动模式循环**（用户逐步决策）：

```
检查警报 → 读输出 → 获取状态 → 叙述给用户 → 等待输入 → 翻译命令 → 执行 → 循环
```

---

## 数据流图

```
MUD 服务器
  │ TCP
  ▼
mud-daemon.js ─────────────────────────────────────┐
  │ 写                                              │ 读
  ▼                                              ▼
output.jsonl  state.json  alerts.json       send-queue.json  control.json
  │                                              ▲
  └──────────────── mud-ctl.js ──────────────────┘
                        │
          ┌─────────────┴──────────────┐
          │                            │
   AI 执行层                       AI 对话层
 (Background Agent               (主 Agent)
  / autopilot.js)                     │
          │ 写                         │ 读
          ▼                         ▼
   report.md                  report.md
   decisions.json             decisions.json
   autopilot-config.json            │
                                  用户
```

---

## 运行时文件结构（默认 `~/.mud-agent/`）

```
~/.mud-agent/
├── mud-daemon.js            ← 守护进程脚本
├── mud-ctl.js               ← 控制接口脚本
├── mud-session.js           ← 按需会话脚本
├── node_modules/
├── package.json
│
├── config.json              ← 服务器配置 + 账号凭证 + 登录序列
├── autopilot-config.json    ← 自动驾驶策略（模式/偏好/安全边界）[新]
│
├── output.jsonl             ← 游戏输出流（环形缓冲 500 行）
├── send-queue.json          ← 待发命令队列
├── state.json               ← 角色状态（HP/MP/位置/出口等）
├── alerts.json              ← 触发器警报队列（最近 50 条）
├── control.json             ← 控制指令（处理后自动删除）
│
├── report.md                ← 执行层叙事日志（主 Agent 汇报来源）[新]
├── decisions.json           ← 待决策事项队列（执行层写，主 Agent 读消）[新]
│
├── mud-daemon.pid
└── daemon.log
```

### 新增文件规范

**report.md** — 叙事日志，追加写入，每段带时间戳：

```markdown
## 2026-03-14 17:30
走进松树林，地上有一把锈迹斑斑的竹耙，已捡起。继续往上，
云雾中隐约出现一块巨石，上面刻着"混沌未分天地乱……"。
当前 HP 100%，位置：仙石。
```

**decisions.json** — 待决策队列，执行层写入后暂停等待：

```json
[
  {
    "id": "d001",
    "time": "2026-03-14T17:35:00Z",
    "priority": "high",
    "narrative": "你和癞头和尚缠斗了七八个回合，对方似乎还有余力。HP 35%。",
    "options": ["继续战斗", "flee 撤退"],
    "resolved": false
  }
]
```

**autopilot-config.json** — 自动驾驶策略配置：

```json
{
  "mode": "semi-auto",
  "style": "exploration",
  "safetyBoundary": {
    "minHpPercent": 30,
    "autoFlee": true,
    "avoidCombatWith": ["癞头和尚"]
  },
  "reportInterval": 5,
  "pauseOn": ["rare_item", "boss", "puzzle", "level_up"]
}
```

---

## 扩展点

| 方向 | 说明 | 当前状态 |
|------|------|---------|
| autopilot.js | 自主执行层实现，含叙事日志写入和 OS 通知 | 已实现（基础版） |
| Background Agent 战斗分段 | 分段执行 + 回主 Agent 的通信协议 | 待实现 |
| 仪表板 UI | React 可视化面板，读取 `state.json` 展示 HP/MP/位置等 | 待实现 |
| 多服务器并发 | 多 MUD_DIR 实例 | 待设计 |
| 服务器特化适配 | 针对特定 MUD 的解析规则 | 可通过配置扩展 |
