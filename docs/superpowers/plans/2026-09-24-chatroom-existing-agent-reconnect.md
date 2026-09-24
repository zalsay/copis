# 已有聊天室添加 Agent 的离线恢复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 已有房间在 WebSocket 暂断并恢复后可安全添加 grok 等 Agent，不重建房间、不绕过真正离线拒绝。

**Architecture:** Rust 网关用 internal token 保护的只读接口报告当前房间是否完成本轮 WebSocket 快照订阅及连接 epoch；Main 在 provision 和旧 Agent 租约恢复的外部副作用前后验证同一 epoch，只有就绪且当前账号/设备仍匹配时才从 `disconnected` 恢复协调器并沿既有远端注册、服务端 ID、本地持久化、lease 流程添加 Agent。Renderer 将“已有房间添加”失败与“房间创建后补配”文案区分。

**Tech Stack:** Rust Gateway、Electron Main typed IPC、React/Jotai、Cargo/Bun tests。

**Spec:** `docs/superpowers/specs/2026-09-16-copis-multi-agent-chatrooms-design.md`

## Global Constraints

- 只在现有房间添加 Agent；不重复提交 POST 创建房间，不直接对用户真实房间进行测试写入。
- 只有内部令牌可读网关就绪状态；账号切换、设备切换、再次断线 fail closed，离线调用仍立即失败且不排队。
- 不修改 edu-api、`AGENTS.md` 或 `README.md`；保留当前 checkout 的其他未提交改动。
- Electron UI 的最终交互和视觉由用户在实际窗口确认。

---

### Task 1：Rust 房间级就绪证明

**Files:** `native/http-api-server/src/chatroom_gateway.rs`, `chatroom_gateway_tests.rs`, `main_tests.rs`。

- [x] RED：只有当前认证、WebSocket 已连接且房间在最近一次连接收到 `room.snapshot` 才报告就绪；断连、旧 snapshot、退出登录都报告未就绪。
- [x] 在既有 internal 路由新增只读 GET，房间 ID 校验与内部令牌保持既有安全边界。
- [x] GREEN：网关聚焦/全量测试、cargo fmt/build。

### Task 2：Main 添加 Agent 安全恢复

**Files:** `apps/electron/src/main/lib/chatroom-management-client.ts`, `chatroom-agent-coordinator.ts`, `chatroom-agent-bootstrap.ts` 与相邻测试。

- [x] RED：断连后恢复且本机网关已验证 room 就绪时，已有房间可再次 provision；未就绪、账号改变或验证期间二次断线时注册/本地文件均不变。
- [x] 将网关就绪验证置于远端注册之前；恢复时复用当前 lease generation 和既有补偿边界，并对注册、续租之后的 epoch 变化执行补偿。
- [x] GREEN：client/coordinator/IPC tests、typecheck、Main 构建。

### Task 3：区分已有房间添加错误与创建后补配

**Files:** `apps/electron/src/renderer/lib/chatroom-api.ts`, `ChatroomAgentProvisionDialog.tsx` 与相邻测试。

- [x] RED：已有房间添加失败提示“添加 Agent 失败”，而创建后补配仍明确房间已创建；两者都不再次 POST 房间。
- [x] 最小实现并分进程运行 Bun tests、Renderer build。

### Task 4：交付

- [x] 定向只读审查和全链路构建；检查并移除临时诊断代码。
- [x] 本仓库 dev 进程通过 Electron 热重载加载新 Rust 二进制；只读确认原房间仍存在、内部状态接口拒绝未授权访问。
- [ ] 用户在 Electron 实际窗口确认已有房间添加 Agent 的交互和视觉结果。
