# 聊天室 Agent 首次配置与恢复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复创建房间后首次配置 Agent 报 `not_room_host`，保证远端与本地使用同一 Agent ID，且已创建房间可以继续配置。

**Architecture:** Electron Main 用本机 Rust 网关经当前 AuthSession 验证主理人并注册远端 Agent，拿服务端生成的 ID 创建本地配置；本地失败时尝试撤销远端注册。Renderer 在配置失败后保留房间及剩余 Agent 选择，允许继续配置而不再次创建房间。

**Tech Stack:** Electron Main / IPC、TypeScript、Bun 测试、Rust ChatRoomGateway 现有路由、edu-api 现有 v2 API。

**Spec:** `docs/superpowers/specs/2026-09-16-copis-multi-agent-chatrooms-design.md`

## Global Constraints

- Main 不接收 Renderer 声称的主理人或 Agent ID；验证由 Rust AuthSession 转发 edu-api 完成。
- 服务端生成的 `roomAgentId` 是本地 room.json 和远端公开信息的共同主键。
- 主理人或设备不匹配、服务端失败时不可创建本地 Agent。
- 已创建房间不得重新 POST 创建；最多 3 个 Agent，记忆/Skill 默认不共享。
- 保留现有未提交工作；未经允许不修改 `AGENTS.md` 和 `README.md`。

### Task 1: 可信远端注册与本地一致性

**Files:** `apps/electron/src/main/lib/chatroom-agent-coordinator.ts`, `chatroom-agent-bootstrap.ts`, `chatroom-workspace-store.ts`, 新建专用 Rust 管理客户端及相邻测试。

- [x] 先写失败测试：无本地 room.json 的主理人可配置第一个 Agent；其他用户或设备不能配置；远端生成 ID 被本地使用；远端失败无本地写入；本地失败撤销远端注册。
- [x] 运行测试确认仅因上述行为缺失而失败。
- [x] 在 Main 新增固定 loopback 路由的受信任客户端，严格校验远端房间身份及 Agent 响应，原有 invocation 客户端保持不变。
- [x] Coordinator 在验证远端授权和设备后调用注册，随后将服务端 ID 写入 store；失败时清理远端并向 UI 告知状态。
- [x] 重跑 Main/store/IPC 相关测试，typecheck 和 build:main。

### Task 2: 已创建房间继续配置

**Files:** `apps/electron/src/renderer/lib/chatroom-api.ts`, `apps/electron/src/renderer/components/chatroom/ChatroomCreateDialog.tsx`、`ChatroomView.tsx` 与相邻测试（以最小实际入口为准）。

- [x] 先写失败测试：首次 provision 失败后可在原房间继续配置，不再 POST 房间；已关闭弹窗的现存房间也可添加 Agent；成功 Agent 不重复添加。
- [x] 运行测试确认 RED，最小实现继续配置与原房间入口。
- [x] 分进程跑渲染器 focused tests；执行 typecheck、build:renderer、diff 检查。

### Task 3: 交付验收

- [x] 审查边界和补偿失败的错误文案；运行 focused 组合测试和构建。
- [x] 不执行真实远端写入或重建用户房间。
- [ ] Electron 真实窗口的最终交互与视觉由用户确认。
