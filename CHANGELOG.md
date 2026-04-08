# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Fixed

- Restrict MUD prompt injection to registered MUD sessions or sessions with a live daemon, so stale `state.json` data no longer contaminates non-MUD chats.
- Add a regression test covering both stale non-MUD sessions and registered paused MUD sessions.

## [0.1.0] - 2026-03-15

### Added

- TypeScript 五层架构（core → infra → services → cli → plugin）
- `mud-ctl` CLI 工具：setup / start / stop / restart / status / send / read / alerts / autopilot
- 守护进程（daemon）：TCP 持久连接、自动重连、自动登录、触发器警报
- autopilot 自动驾驶：exploration / grinding 策略、安全边界、决策系统
- 9 个内置触发器：death / hp_critical / hp_low / boss / puzzle / level_up / quest_update / rare_item / npc_talk
- 游戏状态解析：HP / MP / 出口 / 等级 / 金币
- 多编码支持：UTF-8 / GBK / Big5（通过 iconv-lite）
- OpenClaw 插件支持：多会话管理、斜杠命令 `/mud`
- 进程守护：PID 管理、心跳检测、过期 PID 清理
- 原子文件写入（tmp + rename）防止竞态
- 全局异常守护（uncaughtException / unhandledRejection）
- 错误分级处理（ENOENT vs JSON 损坏 → 备份 + 降级）
- sessionKey 路径遍历防护
- ReDoS 防护（用户正则长度限制）
- 56 个测试用例，core 模块覆盖率 >70%

### Changed

- 从 JavaScript 脚本迁移到 TypeScript 模块化架构
- `scripts/mud-daemon.js`、`scripts/mud-ctl.js`、`scripts/autopilot.js` 标记为 @deprecated

### Security

- 修复 sessionKey 路径遍历漏洞（P0）
- 修复 loginSequence 用户正则 ReDoS 风险（P0）
- 修复 spawn 路径指向旧脚本的部署风险（P0）
- 修复 spawn 后文件描述符泄漏（P1）
