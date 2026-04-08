# 快速上手

## 前提条件

- Node.js v18+（`node --version` 确认）
- 支持的 AI 工具：Claude Code、OpenCode（或其他加载 SKILL.md 的工具）

---

## 安装

```bash
git clone https://github.com/onlyfeng/mud-agent
cd mud-agent && bash install.sh
```

安装会把运行时脚本复制到 `~/.mud-agent/` 并安装 `iconv-lite` 依赖。

**自定义安装目录**：

```bash
# Claude Code 用户，统一到 Claude 数据目录
MUD_DIR=~/.claude/mud bash install.sh

# 自定义
MUD_DIR=/opt/mud-agent bash install.sh
```

---

## 连接第一个 MUD 服务器

### 以北大侠客行为例（推荐新手入门）

```bash
CTL="node ~/.mud-agent/mud-ctl.js"

# 1. 配置（使用 UTF-8 端口，不需要账号）
$CTL setup "mud.pkuxkx.net" 8081 "utf8" "" ""

# 2. 启动守护进程
$CTL start

# 3. 等待连接，读取欢迎界面
sleep 4 && $CTL read 30
```

### 编码选择

| 服务器类型 | 端口选择 | 编码参数 |
|-----------|---------|---------|
| 北大侠客行 UTF 端口 | 8081 | `utf8` |
| 北大侠客行 GBK 端口 | 8080 | `gbk` |
| 台湾/香港 MUD | 各异 | `big5` |
| 国际英文 MUD | 各异 | `utf8` |

---

## 注册新角色（以北大侠客行为例）

北大侠客行的注册流程已完整验证：

```bash
CTL="node ~/.mud-agent/mud-ctl.js"

$CTL send "2"        # 选择 UTF-8 编码
sleep 2 && $CTL read 5

$CTL send "new"      # 开始注册新角色
sleep 4 && $CTL read 8

$CTL send "yes"      # 同意玩家须知（注意：必须发 "yes"，不是 "y"）
sleep 4 && $CTL read 8

$CTL send "角色名"   # 输入英文角色名（3-12位英文字母）
sleep 4 && $CTL read 8

$CTL send "yes"      # 确认创建新角色
sleep 3 && $CTL read 8
# → 此时守护进程会自动显示"请设定密码"提示

$CTL send "你的密码" # 设置密码（记住！）
sleep 3 && $CTL read 15
```

注册完成后保存账号信息（下次自动登录）：

```bash
$CTL config-update-creds "角色名" "你的密码"
```

---

## 登录已有账号

```bash
# 在 setup 时直接提供账号信息
$CTL setup "mud.pkuxkx.net" 8081 "utf8" "角色名" "密码"
$CTL start

sleep 5 && $CTL status   # loginDone: true 表示登录成功
```

若自动登录失败，手动操作：

```bash
$CTL read 20             # 看服务器提示
$CTL send "角色名"
sleep 2 && $CTL send "密码"
sleep 3 && $CTL read 20
```

---

## 三种游戏模式

mud-agent 支持三种模式，默认进入**陪伴模式**，可随时通过自然语言切换。

### 陪伴模式（默认）

AI 作为游戏向导与你一起探索，把游戏输出转化为生动叙事，让你轻松感受游戏乐趣。AI 每执行 2 次操作后会主动暂停报告进度，并设有 3 次连续工具调用的硬中断保底，确保你始终掌控节奏。

```
你：往东走
AI：你迈步向东…（执行操作后）已到达迷雾森林，继续前进吗？
```

**切换触发词**：「帮我挂机」「去自动探索」→ 切到半自动；「全自动跑」→ 切到全自动

### 半自动模式

autopilot 在后台自主探索，遇到重要事件（稀有物品、Boss、谜题、升级）自动暂停等待你的决策。AI 负责汇报进度和转达决策请求。

```
你：帮我探索吧，有重要的告诉我
AI：（调用 set-mode 切换）好的，autopilot 已启动，探索中…
（一段时间后）
AI：发现稀有物品「天蚕宝典」，是否捡取？
```

**切换触发词**：「我来玩」「陪我玩」→ 切回陪伴；「全自动」「不用汇报了」→ 切到全自动

### 全自动模式

autopilot 完全自主运行，不写决策点，只在血量危急等紧急情况发送系统通知。AI 不主动干预，只回答你的直接提问。

```
你：挂机打怪吧，快死了再叫我
AI：（调用 set-mode 切换）全自动挂机已启动（grinding），紧急情况会通知你。
```

**切换触发词**：「我来玩」「暂停挂机」→ 切回陪伴；「需要汇报」「遇到好东西告诉我」→ 切到半自动

### 手动切换（/mud mode 命令）

```
/mud mode companion              陪伴模式（默认）
/mud mode semi-auto              半自动探索
/mud mode semi-auto grinding     半自动挂机
/mud mode full-auto              全自动探索
/mud mode full-auto grinding     全自动挂机
```

---

## 正式游玩

登录成功后，通过 AI 工具自然语言对话：

```
你：往东走
AI：你向东走去。来到了…

你：查看背包
AI：背包里有…

你：血量低了
AI：⚠️ 建议立即治疗，当前 HP 32/100…
```

---

## 常用维护命令

```bash
CTL="node ~/.mud-agent/mud-ctl.js"

$CTL status          # 守护进程状态总览
$CTL state           # 角色当前状态（HP/MP/位置等）
$CTL alerts          # 查看未读警报
$CTL alerts-clear    # 清除警报
$CTL read 40         # 读取最近 40 行输出
$CTL stop            # 停止守护进程
$CTL restart         # 重启守护进程
```

---

## 常见问题

**Q：守护进程启动后立刻退出？**
→ 先运行 `$CTL setup` 配置服务器

**Q：中文乱码？**
→ 确认编码，尝试 `gbk` 或 `big5`，重新 `setup` 后 `restart`

**Q：登录后一直没有 loginDone: true？**
→ 查看 `$CTL read 20` 看服务器在等什么，可能需要添加自定义登录步骤：

```bash
$CTL login-step "触发词" "回复内容"
```

**Q：如何查看守护进程完整日志？**

```bash
cat ~/.mud-agent/daemon.log | tail -50
```
