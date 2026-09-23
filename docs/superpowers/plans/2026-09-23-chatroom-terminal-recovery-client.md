# Chatroom Terminal Recovery Client Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Copis 在聊天室重连后通过 edu-api 的分页终态接口恢复漏掉的 Agent completed/failed 状态。

**Architecture:** Rust 网关显式允许新只读路径并验证 `room.recovery_ready` transient 事件，继续通过现有 SSE 桥转发。Renderer 在该标记后逐页读取终态，将其转成已有的 `agent.completed`/`agent.failed` Jotai 事件，保持实时终态与补拉终态的同一合并路径。

**Tech Stack:** Rust HTTP API、React Renderer、TypeScript、Jotai、Bun test、Cargo test。

**Spec:** `docs/superpowers/specs/2026-09-23-chatroom-reliability-repair-design.md`

## Global Constraints

- 30 秒内未 `accepted` 的 `created` invocation 由 edu-api 判定；Copis 不排队、不重新执行。
- `room.recovery_ready` 与 invocation 状态不占消息 `seq`。
- 补拉只能在该房间订阅成功后发生；首次连接和每次重连均执行，分页严格前进，失败不得伪称恢复成功。
- 终态响应不能携带设备哈希、COS object key 或内部错误；跨房间响应必须拒绝。
- 使用 Jotai；保留现有无关 Rust 和 ledger 改动，不修改 `AGENTS.md` 或 `README.md`，不部署。
- 新行为必须先写正确失败的测试并记录 RED/GREEN；注释与日志优先中文。

---

### Task 1: Rust 网关接受恢复标记与终态查询

**Files:**
- Modify: `native/http-api-server/src/chatroom_protocol.rs`
- Modify: `native/http-api-server/src/chatroom_gateway.rs`
- Test: `native/http-api-server/src/chatroom_protocol_tests.rs`
- Test: `native/http-api-server/src/chatroom_gateway_tests.rs`

**Interfaces:**
- Consumes: edu-api 的 `room.recovery_ready` WS frame；`GET /api/chatrooms/v2/rooms/:room_id/invocations/terminal?after=<id>&limit=<n>`。
- Produces: `ChatroomEvent::RoomRecoveryReady { room_id: String }` 或等价强类型 transient 事件；本机同路径只读 HTTP facade。

- [ ] **Step 1: 写 RED 测试。** 合法标记可解析并通过 SSE 转发，含 `seq`、跨房间或敏感字段时拒绝；终态查询仅 GET、只允许 `after` 与 `limit` 参数、room ID 正规化、不会转发任意外部 URL。

```rust
let event = parse_event(br#"{"type":"room.recovery_ready","roomId":"room-1","payload":{}}"#).unwrap();
assert_eq!(event.kind(), "room.recovery_ready");
```

- [ ] **Step 2: 验证 RED。** `cargo test chatroom_protocol_tests::`、`cargo test chatroom_gateway_tests::` 应因新事件或路径尚不支持而失败。
- [ ] **Step 3: 最小实现。** 在现有 `parse_event`、`public_event`、`Route`、`parse_route`、`method_allowed`、`canonical_query_for_route` 添加精确分支；保持既有敏感字段过滤及 Authorization 边界。

```rust
// 路由只放行约定的只读终态查询，不开放任意 path 透传。
Route::TerminalInvocations(room_id) => method == "GET",
```

- [ ] **Step 4: 验证 GREEN 并提交。** 重跑两组定向测试、`cargo test`、`cargo fmt --check`、`cargo build`、`git diff --check`；只暂存本任务四个文件。

### Task 2: Renderer 在 ready 后分页恢复 invocation 终态

**Files:**
- Modify: `apps/electron/src/renderer/lib/chatroom-sse.ts`
- Test: `apps/electron/src/renderer/lib/chatroom-sse.test.ts`

**Interfaces:**
- Consumes: Task 1 转发的 `room.recovery_ready`；edu-api 终态页 `{invocations:[{invocationId,roomId,traceId,targetAgentId,triggerMessageId,depth,status,failureCode?,finishedAt?}],nextCursor:string|null}`。
- Produces: 对每个完成/失败调用派发已有 `ChatRoomEventEnvelope` (`agent.completed` / `agent.failed`，`rejected` 映射为 `agent.failed`)；不生成 seq。现有 `chatRoomApplyEventAtom` 已支持合并这些事件，不改 atom。

- [ ] **Step 1: 写 RED 测试。** 首连和重连收到 ready 后均请求第一页；多页走严格递增游标；实时状态与补拉重复只合并一次；非本房间行、无效游标及 HTTP 失败让连接进入重试；断开或切换账号后旧请求不得写入 Jotai。

```ts
client.onEvent((event) => recovered.push(event))
// 收到 room.recovery_ready 后，断言分页请求及合成的 agent.failed/agent.completed。
expect(recovered.some((event) => event.type === 'agent.failed' && event.roomId === 'room-1')).toBe(true)
```

- [ ] **Step 2: 验证 RED。** `bun test apps/electron/src/renderer/lib/chatroom-sse.test.ts` 应因未发起终态查询或未派发终态而失败。
- [ ] **Step 3: 最小实现。** 在 `ChatRoomSseClient.receive` 识别 ready 后启动每房间、每连接 generation 的分页恢复；验证响应字段与游标严格前进后再经已有 listener 派发终态。并发实时事件可先到，终态按 invocation ID 幂等合并；失败调用 `failConnection`，不静默吞掉。

```ts
if (event.type === 'room.recovery_ready' && roomId) {
  void this.recoverTerminalInvocations(roomId, controller, generation)
}
```

- [ ] **Step 4: 验证 GREEN 并提交。** 重跑定向测试、Renderer 相关测试、`bun run --filter='@copis/electron' typecheck`、`bun run --filter='@copis/electron' build:renderer`、`git diff --check`；只暂存本任务文件。
