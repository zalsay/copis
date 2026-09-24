# 聊天室断线重连与人数展示 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 无效/失效的房间订阅不再导致主理人的有效房间持续重连，连接状态显示真实远端 WebSocket 状态，房间详情显示实际成员人数。

**Architecture:** Rust 网关在接受本地 SSE 房间订阅前经 AuthSession 校验每个房间，并在服务端报告 `not_found`/`not_member` 时移除已经失效的旧订阅；不因一个坏房间牺牲有效房间。Renderer 保留并消费 Rust `local.status` 状态码，成员人数以已加载的详情列表为准。

**Tech Stack:** Rust HTTP API、现有 edu-api WebSocket、TypeScript/React/Jotai、Bun 与 Cargo 测试。

**Spec:** `docs/superpowers/specs/2026-09-16-copis-multi-agent-chatrooms-design.md`

## Global Constraints

- 不修改 edu-api 和持久房间数据；未经允许不修改 `AGENTS.md`、`README.md`。
- SSE 校验只读，不能把异常房间写入订阅状态；断线清理仅移除已确认不存在或无成员权限的房间。
- 状态以远端 WebSocket 为准，本地 SSE HTTP 200 不得长期掩盖远端断线。
- 保留当前所有其他未提交改动；最终 Electron UI 由用户在真实应用窗口确认。

---

### Task 1: Rust 订阅校验与旧订阅收敛

**Files:** `native/http-api-server/src/chatroom_gateway.rs`, `chatroom_gateway_tests.rs`。

- [x] BDD RED：不存在的房间收到定向 SSE 拒绝状态，不改变有效房间的 WebSocket 订阅；混合房间仍可保持有效房间在线。
- [x] BDD RED：服务端返回 `not_found` 时，旧房间被验证并剔除；有效房间继续订阅，临时上游失败不误剔除。
- [x] 最小实现经现有 AuthSession 转发只读 GET，授权/世代检查前后 fail closed；空房间 Go `omitempty` 快照中缺失的 `latestSeq` 规范化为 0。
- [x] GREEN：聚焦 Rust 测试、全 crate 测试、fmt/build。

### Task 2: Renderer 状态与人数

**Files:** `packages/shared/src/types/chatroom.ts`, `apps/electron/src/renderer/lib/chatroom-sse.ts`, `components/chatroom/ChatroomSseInitializer.tsx`, `ChatroomView.tsx` 与相邻测试。

- [x] BDD RED：`local.status` 的连接与断连状态会覆盖本地 SSE HTTP 状态；首次订阅可读取网关当前状态。
- [x] BDD RED：房间摘要缺少 `memberCount` 时，详情加载后按 `members.length` 展示人数。
- [x] 已失效房间的终态补拉先返回 404 时不拖垮有效房间；重新加入同一个 Tab 时清除墓碑并重新读取详情。
- [x] 最小实现；Bun 聚焦测试、类型检查、Main/Renderer 构建。

### Task 3: Dev 运行恢复与交付

- [x] 确认进程归属后重新构建 Rust API 并重启当前 dev 服务，清除本次诊断留下的无效内存订阅。
- [x] 通过只读 HTTP/SSE 检查：有效房间在 25 秒观察窗口内保持连接、收到 `room.snapshot` 与 `room.recovery_ready` 且不再重复 `not_found`；成员详情为 1。
- [ ] 不使用截图代替用户；由用户在 Electron 窗口确认连接显示和操作。
