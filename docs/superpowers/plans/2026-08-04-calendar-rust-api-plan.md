# Planning Rust 一次性完整迁移 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在一个可发布版本内把 `planning.db`、Planning 业务规则、Todo/日程/标签/提醒 API、Pi Planning 工具执行与 schema、Planning 引用解析和全部 UI/主进程消费者迁移到 Rust API，并删除 Electron TypeScript 对 Planning 数据与业务逻辑的直接实现。

**Architecture:** Rust `copis-http-api-server` 成为 `planning.db` 的唯一拥有者，负责 schema migration、事务、乐观锁、提醒 claim、HTTP API 和事件流。Electron 主进程、Renderer 和 Pi worker 只能通过带类型的本地 HTTP client 调用 Rust；迁移版本不保留回退到 `planning-manager.ts` 的双写或旁路。

**Tech Stack:** Rust 2021、SQLite（执行阶段按仓库规则调研并锁定 Rust crate）、Bun、TypeScript、Electron 43、React 18、Jotai、SSE、Bun Test、Cargo Test。

---

## 0. 执行边界

**状态：** 方案边界已确认，尚未开始实施

**日期：** 2026-08-04
**迁移方式：** 一次性完整迁移，不发布 TypeScript/Rust 双写版本

本计划中的“一次性”指一个发布边界，不要求所有改动挤在一个提交中。开发期间可以按 Task 拆成可验证提交，但只有全部完成标准通过后才能合并或发布。

明确包含：

- Rust 独占整个 `planning.db`，包括 Todo、日程、分组、标签、提醒和 Todo-Session 关联。
- Rust 实现完整 Planning HTTP API、提醒调度和 Planning SSE 事件流。
- Electron 主进程原生通知、Agent Island 和 Todo 启动会话逻辑改为 Rust client 消费者。
- Rust 实现 `mcp__planning__*` 工具目录、JSON Schema、参数校验、权限分类和执行分派；Pi worker 只保留 SDK ToolDefinition 协议适配。
- 旧 `AgentOrchestrator` Pi 兼容路径继续保留，但必须消费同一套 Rust 工具目录和执行端点，不能保留第二套工具实现。
- Rust 实现 Planning 引用解析和规范化 prompt fragment，并接入旧 IPC Agent 路径和新 Rust/Pi RPC 路径。
- Renderer 日程、提醒、提及搜索和 Todo 入口改为 Planning HTTP client。
- 删除 `planning-manager.ts` 生产实现、Planning CRUD IPC 和 Preload 数据桥。

明确不包含：

- Plan mode 的语义重构。Plan mode 仍是 Agent 权限模式，不写入 `planning.db`。
- Automation 数据迁移。Automation 保持独立存储与调度。
- 与 Planning 无关的 UI 重设计。
- README 和 `AGENTS.md` 修改；功能完成后按仓库约束另行取得用户许可再同步。

## 1. 当前事实与缺口

### 1.1 当前数据库所有权

`apps/electron/src/main/lib/planning-manager.ts` 通过 `node:sqlite` 打开 `getPlanningDatabasePath()`，创建并维护：

- `todos`
- `calendar_events`
- `planning_groups`
- `calendar_groups`
- `tags`
- `todo_tags`
- `calendar_event_tags`
- `planning_reminders`
- `todo_session_links`

当前直接依赖 `planning-manager.ts` 的生产模块：

| 消费者 | 当前职责 | 迁移结果 |
| --- | --- | --- |
| `apps/electron/src/main/ipc.ts` | Planning CRUD、Todo 启动 Agent | 数据操作改为 Rust client；只保留窗口/会话编排 IPC |
| `apps/electron/src/main/lib/adapters/pi-builtin-tools.ts` | 旧 Pi Planning 工具 | 删除 Planning 业务实现，改由薄适配器消费 Rust tool catalog/execute API |
| `apps/electron/src/main/lib/planning-reference-context.ts` | 引用 Todo/日程快照 | 删除 XML 构建逻辑；旧路径只消费 Rust reference resolve 结果 |
| `apps/electron/src/main/lib/planning-reminder-scheduler.ts` | 每 30 秒 claim 提醒 | claim 和调度迁入 Rust；Electron 只展示/外发通知 |
| `apps/electron/src/main/lib/agent-island-service.ts` | 构建当天 Todo/日程投影 | 改为 Rust snapshot/client 与事件驱动缓存 |

### 1.2 当前 Rust/Pi 缺口

- Rust 仅特殊处理 `/api/agent/sessions/:id/messages` 和 `/stop`，没有 Planning domain 或 Planning 路由。
- `pi-rpc-worker.ts` 启动 Node `PiAgentAdapter`；Rust 负责传输和进程调度，不执行 Planning 工具。
- 新 `agent-rpc-service.ts` 没有注入 `buildPiBuiltinTools`，也没有解析 `mentionedTodoIds` / `mentionedCalendarEventIds`。
- `PiAgentAdapter` 默认工具只有 Read/Bash/Edit/Write/Grep/Find/LS、Plan mode 和内存 Task/Todo 工具；没有 `mcp__planning__*`。
- 系统提示词仍宣称 Pi 拥有 Planning 工具，当前 RPC 能力与提示词不一致。

### 1.3 Plan mode 与 Planning 的边界

Plan mode 不属于 Planning 数据域：

- Plan mode 状态由 Agent 会话权限控制。
- 计划文档写入会话 Context 的 `plan/` 目录。
- `planning.db` 不保存 Plan mode 状态或计划文件。
- 唯一交集是权限：Plan mode 下只允许 Planning 查询工具，禁止创建、更新、完成、删除、确认和推迟提醒。

迁移后必须保留这个权限边界，但不能把 Plan mode 写入 Rust Planning schema。

## 2. 目标架构

```text
Electron startup
  -> generate local API token
  -> start copis-http-api-server
       -> open/migrate/lock planning.db
       -> start Planning reminder scheduler
       -> serve Planning JSON API + Planning SSE

Renderer / Planning UI
  -> planning-api-client.ts
  -> http://127.0.0.1:51730/api/planning/*
  -> Rust Planning routes/domain/repository
  -> planning.db

Electron native consumers
  -> planning-api-client.ts
  -> Rust Planning API / SSE
  -> native notifications, Agent Island, session/window orchestration

Pi worker
  -> pi-planning-tool-adapter.ts (SDK thin adapter)
  -> Rust Planning tool catalog + execute API
  -> Rust Planning tool service
  -> tool result -> Pi -> Rust SSE -> UI

Agent reference ids
  -> Rust Planning reference resolve API
  -> Rust loads current records and builds canonical prompt fragment
  -> old orchestrator / new RPC path append the returned fragment
```

### 2.1 单写入原则

1. Rust 是唯一允许打开 `planning.db` 的生产进程。
2. TypeScript 不包含 Planning SQL、不使用 `node:sqlite`、不持有数据库连接。
3. 所有创建、更新、删除、提醒 claim 和 Todo-Session touch 都通过 Rust 事务完成。
4. Rust 启动或 migration 失败时，Planning 功能进入明确的 unavailable 状态；禁止回退到 TypeScript 数据层。
5. Agent 对话本身可以继续工作，但 Planning 工具必须返回可识别的服务不可用错误。

### 2.2 本地 API 认证

- Rust 继续只监听 `127.0.0.1:51730`。
- Electron 每次启动生成随机 bearer token，通过 `COPIS_HTTP_API_TOKEN` 传给 Rust。
- Rust 启动 Pi worker 时让子进程继承同一 token 和 `COPIS_HTTP_API_BASE_URL`。
- Electron Renderer 通过最小 Preload bootstrap 获取 base URL 和 token；不暴露其他主进程能力。
- Electron 额外传入 `COPIS_HTTP_API_PACKAGED=1|0`。Node/native 请求可不带 Origin；packaged `file://` Renderer 的 `Origin: null` 只在 packaged 标志为 `1` 且 bearer token 有效时放行。
- 开发浏览器模式使用 `COPIS_HTTP_API_DEV_ALLOW_UNAUTHENTICATED=1`；Rust 只在 packaged 标志为 `0` 且 Origin 为 `http://127.0.0.1:5174` 或 `http://localhost:5174` 时放行。生产构建忽略该开关。
- 本计划新增的 `/api/planning/*` 和 Planning SSE 校验 `Authorization: Bearer <token>`；现有 Working/Agent API 的认证不在本计划内扩张。
- Rust CORS 预检必须允许 `Authorization`、`Content-Type` 和 Planning 使用的 `GET/POST/PATCH/DELETE/OPTIONS`；其余 origin 一律拒绝。

### 2.3 失败与恢复

- migration 前创建带 schema 版本和时间戳的备份。
- migration 在事务中执行；失败时回滚并保留原数据库和备份。
- `/api/health` 返回 `planning.status`、schema version 和 migration error 摘要，不返回路径或 token。
- 客户端统一映射 `400/401/404/409/422/503`，不把网络错误误报为“记录不存在”。
- SQLite busy/locked 只允许有限次数退避重试；不能无限等待 UI。
- Rust 重启后，Renderer、Electron event subscriber 和 Pi worker client 都重新建立连接。

## 3. Planning HTTP 合约

所有时间使用 Unix 毫秒；字段沿用 `@copis/shared` 的 camelCase 类型。

### 3.1 Todo

```text
GET    /api/planning/todos?status=<open|completed>&dueBefore=<ms>&limit=<n>
POST   /api/planning/todos
GET    /api/planning/todos/:id
PATCH  /api/planning/todos/:id
DELETE /api/planning/todos/:id
POST   /api/planning/todos/:id/session-links
```

### 3.2 日程

```text
GET    /api/planning/calendar-events?from=<ms>&to=<ms>&limit=<n>
POST   /api/planning/calendar-events
GET    /api/planning/calendar-events/:id
PATCH  /api/planning/calendar-events/:id
DELETE /api/planning/calendar-events/:id
```

### 3.3 分组与标签

```text
GET    /api/planning/groups?scope=<todo|calendar>
POST   /api/planning/groups
PATCH  /api/planning/groups/:id
DELETE /api/planning/groups/:id?scope=<todo|calendar>

GET    /api/planning/tags
POST   /api/planning/tags
PATCH  /api/planning/tags/:id
DELETE /api/planning/tags/:id
```

### 3.4 提醒

```text
GET    /api/planning/reminders/active
POST   /api/planning/reminders
PATCH  /api/planning/reminders/:id
DELETE /api/planning/reminders/:id
POST   /api/planning/reminders/:id/acknowledge
POST   /api/planning/reminders/:id/snooze
```

`claim-due` 只作为 Rust service 内部方法，不暴露 HTTP route。Rust scheduler 原子更新 `last_notified_at` 后再发布 `reminder_due` 事件。

### 3.5 快照与事件

```text
GET /api/planning/snapshot?from=<ms>&to=<ms>
GET /api/planning/events
```

事件使用 SSE：

```ts
interface PlanningApiEvent {
  id: number
  type: 'changed' | 'reminder_due'
  resources: PlanningChangeResource[]
  reminders?: ActivePlanningReminder[]
  occurredAt: number
}
```

`id` 在 Rust 进程生命周期内单调递增。客户端断线重连后先读取 snapshot，再消费新事件，不依赖跨进程持久 event log。

Renderer 使用 `fetch` + `ReadableStream` 读取 SSE，以便携带 bearer header；不得使用无法设置 `Authorization` 的浏览器原生 `EventSource`。

### 3.6 Planning 工具

```text
GET  /api/planning/tools
POST /api/planning/tools/:name/execute
```

- catalog 由 Rust 返回工具名、中文描述、JSON Schema、只读/写入分类和结果版本；TypeScript 不复制每个工具的参数 schema。
- execute 请求包含 `arguments` 以及 `sessionId`、`workspaceId`、`permissionMode` 等执行上下文。
- Rust 负责参数校验、Plan mode 写入拒绝、事务调用、错误映射和统一 tool result；Pi adapter 只把 catalog 转为 SDK ToolDefinition，并把执行请求转发给 Rust。
- 工具名保持 `mcp__planning__*`，保证已有 prompt 和权限规则兼容。
- `TodoRead` / `TodoWrite` 仍是单次 Agent turn 的内存任务工具，不属于 Planning 工具目录。

### 3.7 Planning 引用

```text
POST /api/planning/references/resolve
```

请求携带 `mentionedTodoIds`、`mentionedCalendarEventIds` 和可选 `workspaceId`。Rust 在同一快照中读取最新记录，返回规范化记录和 `promptFragment`；缺失 ID 以结构化 warning 返回，不能把网络错误伪装成记录缺失。TypeScript 不再拼接 `<referenced_planning>` 内容。

### 3.8 错误协议

```json
{
  "error": "日程已被其他窗口修改，请重新加载后再试",
  "code": "planning_conflict"
}
```

固定错误码：

- `planning_unavailable`
- `planning_unauthorized`
- `planning_invalid_request`
- `planning_todo_not_found`
- `planning_calendar_event_not_found`
- `planning_group_not_found`
- `planning_tag_not_found`
- `planning_reminder_not_found`
- `planning_conflict`
- `planning_workspace_required`
- `planning_migration_failed`
- `planning_tool_not_found`
- `planning_tool_write_forbidden`
- `planning_reference_invalid`

## 4. 文件结构

### Rust 新增

- `native/http-api-server/src/planning/mod.rs`：模块入口和共享状态。
- `native/http-api-server/src/planning/models.rs`：HTTP DTO 与数据库 row 映射。
- `native/http-api-server/src/planning/migrations.rs`：schema version、备份和迁移。
- `native/http-api-server/src/planning/repository.rs`：SQLite 查询与事务。
- `native/http-api-server/src/planning/service.rs`：校验、状态转换、提醒同步和乐观锁。
- `native/http-api-server/src/planning/routes.rs`：路由解析、认证和 JSON 响应。
- `native/http-api-server/src/planning/events.rs`：SSE 订阅、资源失效和提醒事件。
- `native/http-api-server/src/planning/scheduler.rs`：到期提醒调度与原子 claim。
- `native/http-api-server/src/planning/tools.rs`：Planning 工具 catalog、schema、权限分类和执行分派。
- `native/http-api-server/src/planning/references.rs`：引用记录解析与规范化 prompt fragment。

### TypeScript 新增

- `packages/shared/src/types/planning-api.ts`：HTTP 路径、错误码、事件和 connection DTO。
- `apps/electron/src/main/lib/planning-api-client.ts`：可供 Electron 主进程和 Pi worker 使用的 Node HTTP client。
- `apps/electron/src/main/lib/planning-event-subscriber.ts`：主进程 SSE 订阅和原生事件适配。
- `apps/electron/src/main/lib/adapters/pi-planning-tool-adapter.ts`：把 Rust catalog 转换为 Pi SDK ToolDefinition 的薄适配器，不含 Planning 业务规则。
- `apps/electron/src/renderer/lib/planning-api-client.ts`：Renderer HTTP client 与错误映射。
- `apps/electron/src/renderer/lib/planning-event-client.ts`：Renderer SSE 重连和 snapshot 恢复。

### 删除或收缩

- 删除 `apps/electron/src/main/lib/planning-manager.ts`。
- 删除或改写 `apps/electron/src/main/lib/planning-manager.test.ts`。
- 删除 `apps/electron/src/main/lib/planning-reminder-scheduler.ts`，保留原生通知逻辑到 event subscriber。
- `apps/electron/src/main/lib/adapters/pi-builtin-tools.ts` 删除 Planning SQL 工具，只保留其他产品工具。
- `apps/electron/src/main/ipc.ts` 删除 Planning CRUD handler，仅保留 `OPEN_WINDOW`、`START_TODO_AGENT` 和必要的跨窗口激活。
- `apps/electron/src/preload/index.ts` 删除 Planning CRUD 和数据事件桥，只保留窗口/会话编排与本地 API bootstrap。
- `packages/shared/src/types/planning.ts` 删除已废弃的 CRUD IPC channel 常量，保留非数据型通道。

## 5. 实施任务

### Task 1: 固化共享 API 合约

**Files:**

- Create: `packages/shared/src/types/planning-api.ts`
- Create: `packages/shared/src/types/planning-api.test.ts`
- Modify: `packages/shared/src/types/index.ts`
- Modify: `packages/shared/src/types/planning.ts`

- [ ] **Step 1: 写失败测试，锁定路径、错误码和事件结构**

```ts
test('Given Planning API constants When consumed by clients Then paths and error codes stay stable', () => {
  expect(PLANNING_API_PATHS.todos).toBe('/api/planning/todos')
  expect(PLANNING_API_PATHS.calendarEvents).toBe('/api/planning/calendar-events')
  expect(PLANNING_API_ERROR_CODES.conflict).toBe('planning_conflict')
})
```

- [ ] **Step 2: 运行测试确认 RED**

Run: `bun test packages/shared/src/types/planning-api.test.ts`
Expected: FAIL，提示 `planning-api` 导出不存在。

- [ ] **Step 3: 定义完整共享合约**

```ts
export const PLANNING_API_PATHS = {
  todos: '/api/planning/todos',
  calendarEvents: '/api/planning/calendar-events',
  groups: '/api/planning/groups',
  tags: '/api/planning/tags',
  reminders: '/api/planning/reminders',
  snapshot: '/api/planning/snapshot',
  events: '/api/planning/events',
  tools: '/api/planning/tools',
  references: '/api/planning/references/resolve',
} as const

export interface PlanningApiConnection {
  baseUrl: string
  token: string
}
```

- [ ] **Step 4: 运行测试和 shared typecheck**

Run: `bun test packages/shared/src/types/planning-api.test.ts && bun run --filter='@copis/shared' typecheck`
Expected: PASS，0 TypeScript errors。

- [ ] **Step 5: 提交合约**

```bash
git add packages/shared/src/types/planning-api.ts packages/shared/src/types/planning-api.test.ts packages/shared/src/types/index.ts packages/shared/src/types/planning.ts
git commit -m "feat(shared): define planning HTTP API contract"
```

### Task 2: 建立 Rust Planning 数据库与迁移层

**Files:**

- Modify: `native/http-api-server/Cargo.toml`
- Modify: `native/http-api-server/Cargo.lock`
- Create: `native/http-api-server/src/planning/mod.rs`
- Create: `native/http-api-server/src/planning/models.rs`
- Create: `native/http-api-server/src/planning/migrations.rs`
- Create: `native/http-api-server/src/planning/repository.rs`
- Modify: `native/http-api-server/src/main.rs`

- [ ] **Step 1: 按仓库规则调研 SQLite crate**

Run:

```bash
cargo search rusqlite --limit 5
cargo info rusqlite
```

检查当前稳定版本、`bundled`、WAL、backup API、Windows/macOS 构建和 license；记录选择依据后使用 `cargo add` 锁定精确版本，禁止手写猜测版本。

- [ ] **Step 2: 写 Rust 失败测试，覆盖现有 schema**

```rust
#[test]
fn migrates_existing_planning_database_without_losing_calendar_or_todo_rows() {
    let fixture = create_legacy_fixture();
    let database = PlanningDatabase::open(fixture.path()).unwrap();
    assert_eq!(database.schema_version().unwrap(), CURRENT_SCHEMA_VERSION);
    assert_eq!(database.list_todos(Default::default()).unwrap().len(), 1);
    assert_eq!(database.list_calendar_events(Default::default()).unwrap().len(), 1);
}
```

- [ ] **Step 3: 运行 Rust 测试确认 RED**

Run: `cargo test --manifest-path native/http-api-server/Cargo.toml planning::`
Expected: FAIL，`PlanningDatabase` 和 migration 模块不存在。

- [ ] **Step 4: 实现数据库打开、备份与 schema migration**

要求：

- 数据库路径只读自 `COPIS_PLANNING_DB_PATH`。
- 启用 `foreign_keys=ON`、WAL 和有限 busy timeout。
- migration 前创建备份，migration 事务失败时不替换原库。
- 保留所有现有表、字段、索引、CHECK 和级联语义。
- 连接由 Rust `PlanningState` 串行管理，禁止每个请求无界创建连接。

- [ ] **Step 5: 覆盖空库、旧库、当前库、失败回滚和并发写测试**

Run: `cargo test --manifest-path native/http-api-server/Cargo.toml planning::migrations planning::repository`
Expected: PASS，迁移前后 row count 和关联数据一致。

- [ ] **Step 6: 提交数据库层**

```bash
git add native/http-api-server/Cargo.toml native/http-api-server/Cargo.lock native/http-api-server/src/planning native/http-api-server/src/main.rs
git commit -m "feat(rust): own planning database and migrations"
```

### Task 3: 实现 Rust Planning domain 与完整 HTTP API

**Files:**

- Create: `native/http-api-server/src/planning/service.rs`
- Create: `native/http-api-server/src/planning/routes.rs`
- Modify: `native/http-api-server/src/planning/mod.rs`
- Modify: `native/http-api-server/src/main.rs`

- [ ] **Step 1: 写路由与业务行为失败测试**

覆盖 Todo、日程、分组、标签、提醒、session link、乐观锁和删除级联。每个资源至少包含正常 CRUD、404、非法输入和 409。

```rust
#[test]
fn stale_calendar_update_returns_planning_conflict() {
    let response = send_planning_request(
        "PATCH",
        "/api/planning/calendar-events/event-1",
        json!({ "title": "旧草稿", "expectedUpdatedAt": 1 }),
    );
    assert_eq!(response.status, 409);
    assert_eq!(response.code(), "planning_conflict");
}
```

- [ ] **Step 2: 运行测试确认 RED**

Run: `cargo test --manifest-path native/http-api-server/Cargo.toml planning::routes planning::service`
Expected: FAIL，Planning route 未注册。

- [ ] **Step 3: 实现 service 层**

service 必须拥有：

- 标题、时间、limit、分组、标签和工作区关联校验。
- `expectedUpdatedAt` 乐观锁。
- Todo 完成时间与日程状态转换。
- Todo due reminder 和 calendar start reminder 同步。
- tag/group 删除后的关系清理。
- Todo-Session touch 去重。
- 每个写操作的事务与 `PlanningChangeResource[]` 结果。

- [ ] **Step 4: 实现 routes 层、认证、CORS 和统一错误映射**

Rust route 直接处理 `/api/planning/*`，不得转发到 Electron business bridge。未知资源返回 `404`；domain 错误映射到固定 code。测试必须证明：

- 缺少或错误 bearer token 返回 `401 planning_unauthorized`。
- Planning SSE 与普通 JSON route 使用同一认证规则。
- CORS preflight 的 `Access-Control-Allow-Headers` 包含 `Authorization, Content-Type`。
- CORS 允许 `GET, POST, PATCH, DELETE, OPTIONS`；Node/native 无 Origin 请求仍需 bearer，`Origin: null` 只在 packaged + bearer 有效时放行，其余非受信任 origin 拒绝。
- `COPIS_HTTP_API_DEV_ALLOW_UNAUTHENTICATED=1` 只在非 packaged 开发模式与约定 localhost origin 同时满足时生效。

- [ ] **Step 5: 运行全部 Rust 测试**

Run: `cargo test --manifest-path native/http-api-server/Cargo.toml`
Expected: PASS，现有 Agent RPC 测试和新增 Planning 测试全部通过。

- [ ] **Step 6: 提交 domain 与 API**

```bash
git add native/http-api-server/src/planning native/http-api-server/src/main.rs
git commit -m "feat(rust): expose complete planning API"
```

### Task 4: 把提醒调度与 Planning 事件迁入 Rust

**Files:**

- Create: `native/http-api-server/src/planning/events.rs`
- Create: `native/http-api-server/src/planning/scheduler.rs`
- Modify: `native/http-api-server/src/planning/service.rs`
- Modify: `native/http-api-server/src/planning/routes.rs`
- Modify: `native/http-api-server/src/planning/mod.rs`

- [ ] **Step 1: 写提醒 claim 与 SSE 失败测试**

```rust
#[test]
fn due_reminder_is_claimed_once_and_emitted_once() {
    let state = seeded_state_with_due_reminder();
    assert_eq!(state.claim_due(1_000).unwrap().len(), 1);
    assert_eq!(state.claim_due(1_000).unwrap().len(), 0);
    assert_eq!(state.events().reminder_due_count(), 1);
}
```

- [ ] **Step 2: 实现原子 claim 和 scheduler**

- scheduler 使用可停止线程或任务，随 Rust 服务启动/关闭。
- claim 与 `last_notified_at` 更新在同一事务中。
- 首次到期和 snooze 后再次到期各发一次。
- scheduler 不负责 macOS/Windows 原生通知或外部消息。

- [ ] **Step 3: 实现 `/api/planning/events` SSE**

支持 `changed`、`reminder_due`、心跳和断线清理。慢消费者不能阻塞 Planning 写事务。

- [ ] **Step 4: 运行事件与并发测试**

Run: `cargo test --manifest-path native/http-api-server/Cargo.toml planning::events planning::scheduler`
Expected: PASS，无重复 claim、无永久阻塞线程。

- [ ] **Step 5: 提交提醒与事件**

```bash
git add native/http-api-server/src/planning
git commit -m "feat(rust): schedule planning reminders and stream events"
```

### Task 5: 接入 Electron 生命周期、认证与 Node client

**Files:**

- Modify: `apps/electron/src/main/lib/http-api-server.ts`
- Modify: `apps/electron/src/main/index.ts`
- Modify: `apps/electron/src/main/lib/config-paths.ts`
- Create: `apps/electron/src/main/lib/planning-api-client.ts`
- Create: `apps/electron/src/main/lib/planning-api-client.test.ts`
- Create: `apps/electron/src/main/lib/planning-event-subscriber.ts`
- Create: `apps/electron/src/main/lib/planning-event-subscriber.test.ts`

- [ ] **Step 1: 写 connection bootstrap 和 client 失败测试**

```ts
test('Given a Planning API connection When listing todos Then bearer auth and query are preserved', async () => {
  const client = createPlanningApiClient({ baseUrl: 'http://127.0.0.1:51730', token: 'secret' }, fetchSpy)
  await client.listTodos({ status: 'open', limit: 50 })
  expect(fetchSpy).toHaveBeenCalledWith(
    'http://127.0.0.1:51730/api/planning/todos?status=open&limit=50',
    expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer secret' }) }),
  )
})
```

- [ ] **Step 2: 运行测试确认 RED**

Run: `bun test apps/electron/src/main/lib/planning-api-client.test.ts`
Expected: FAIL，client 不存在。

- [ ] **Step 3: 启动 Rust 时传入数据库路径和随机 token**

`http-api-server.ts` 保存当前 `PlanningApiConnection`，并向 Rust 环境传入：

```ts
{
  COPIS_HTTP_API_TOKEN: token,
  COPIS_HTTP_API_BASE_URL: `http://${HTTP_API_HOST}:${HTTP_API_PORT}`,
  COPIS_PLANNING_DB_PATH: getPlanningDatabasePath(),
  COPIS_HTTP_API_PACKAGED: app.isPackaged ? '1' : '0',
}
```

token 不写磁盘、不打印日志。Rust ready 之前 client 请求返回 `planning_unavailable`。

- [ ] **Step 4: 实现 Node Planning client 和 SSE subscriber**

client 提供与现有 manager 等价的异步方法；subscriber 收到 `reminder_due` 后调用原生通知和 `notifyPlanningReminders()`，收到 `changed` 后刷新 Agent Island cache。

- [ ] **Step 5: 删除旧 Electron reminder scheduler 启动**

`main/index.ts` 不再调用 `startPlanningReminderScheduler()`；关闭顺序为停止 subscriber、停止 Rust、销毁窗口。

- [ ] **Step 6: 运行测试和主进程构建**

Run:

```bash
bun test apps/electron/src/main/lib/planning-api-client.test.ts apps/electron/src/main/lib/planning-event-subscriber.test.ts
bun run --filter='@copis/electron' build:main
```

Expected: PASS，主进程 bundle 不包含 `node:sqlite` Planning 代码。

- [ ] **Step 7: 提交生命周期与 client**

```bash
git add apps/electron/src/main/lib/http-api-server.ts apps/electron/src/main/index.ts apps/electron/src/main/lib/config-paths.ts apps/electron/src/main/lib/planning-api-client.ts apps/electron/src/main/lib/planning-api-client.test.ts apps/electron/src/main/lib/planning-event-subscriber.ts apps/electron/src/main/lib/planning-event-subscriber.test.ts
git commit -m "feat(electron): connect native planning consumers to Rust"
```

### Task 6: 在 Rust 实现 Planning 工具与引用并接入两条 Pi 路径

**Files:**

- Create: `native/http-api-server/src/planning/tools.rs`
- Create: `native/http-api-server/src/planning/references.rs`
- Modify: `native/http-api-server/src/planning/routes.rs`
- Modify: `native/http-api-server/src/planning/mod.rs`
- Create: `apps/electron/src/main/lib/adapters/pi-planning-tool-adapter.ts`
- Create: `apps/electron/src/main/lib/adapters/pi-planning-tool-adapter.test.ts`
- Modify: `apps/electron/src/main/lib/adapters/pi-agent-adapter.ts`
- Modify: `apps/electron/src/main/lib/adapters/pi-builtin-tools.ts`
- Delete: `apps/electron/src/main/lib/planning-permission-policy.ts`
- Delete: `apps/electron/src/main/lib/planning-reference-context.ts`
- Modify: `apps/electron/src/main/lib/agent-orchestrator.ts`
- Modify: `apps/electron/src/main/lib/agent-rpc-service.ts`
- Modify: `apps/electron/src/main/lib/agent-rpc-protocol.ts`
- Modify: `apps/electron/src/main/pi-rpc-worker.ts`
- Modify: `apps/electron/src/renderer/lib/agent-http-stream.ts`

- [ ] **Step 1: 写 Rust 工具 catalog 与执行失败测试**

覆盖 Todo、日程、分组、标签和提醒的 `list/get/create/update/complete/delete/acknowledge/snooze` 工具。测试 catalog 名称唯一、JSON Schema 有效、读写分类正确，且 execute 通过 Rust service 完成业务操作。

```rust
#[test]
fn plan_mode_rejects_mutating_planning_tool_in_rust() {
    let response = execute_tool(
        "mcp__planning__complete_todo",
        json!({ "id": "todo-1" }),
        execution_context("plan"),
    );
    assert_eq!(response.code(), "planning_tool_write_forbidden");
}
```

- [ ] **Step 2: 在 Rust 建立唯一工具实现**

`tools.rs` 必须拥有：

- `mcp__planning__*` 名称、中文描述、JSON Schema 和只读/写入分类。
- 参数校验、工具名分派、domain service 调用和稳定结果 envelope。
- Plan mode 下写工具拒绝；list/get 保持可用。
- 删除操作的显式用户意图校验，禁止后台隐式删除。
- `TodoRead` / `TodoWrite` 排除在 catalog 外，继续作为当前 turn 内存任务。

TypeScript 中不得再出现逐工具 CRUD handler、Planning 参数校验或独立权限清单。

- [ ] **Step 3: 写 Rust 引用解析失败测试并实现**

测试 Todo/日程混合引用、重复 ID、缺失 ID、workspace 不匹配和稳定顺序。`references.rs` 在同一数据库快照读取最新记录，生成唯一规范的 `<referenced_planning>` prompt fragment，并提示 Agent 先用只读工具核验易变状态。

- [ ] **Step 4: 建立 Pi SDK 薄适配器**

`PiAgentQueryOptions` 和 `PiWorkerQueryConfig` 增加 `planningApi: PlanningApiConnection`。`pi-planning-tool-adapter.ts` 启动时读取 Rust catalog，机械转换为 SDK ToolDefinition；`execute` 只转发 `{ name, arguments, executionContext }` 并转换 result envelope。旧 orchestrator 和新 worker 都只传 connection/context，不注入另一套 Planning ToolDefinition；`pi-builtin-tools.ts` 删除原 Planning 工具。

- [ ] **Step 5: 接入引用和新 Rust/Pi RPC 输入**

`parseAgentRpcInput()` 必须保留 `mentionedTodoIds` 和 `mentionedCalendarEventIds`。新 Rust Agent route 可直接调用 Planning reference service；旧 orchestrator 通过 `/api/planning/references/resolve` 获取同一 `promptFragment`。`pi-rpc-worker` 不自行猜测地址或 token，也不拼接引用 XML。

- [ ] **Step 6: 验证 Rust 独占工具与引用语义**

Run:

```bash
cargo test --manifest-path native/http-api-server/Cargo.toml planning::tools planning::references
bun test apps/electron/src/main/lib/adapters/pi-planning-tool-adapter.test.ts apps/electron/src/main/lib/agent-rpc-protocol.test.ts
bun run --filter='@copis/electron' build:agent-rpc-worker
bun run typecheck
rg -n "mcp__planning__|referenced_planning|planning-permission-policy" apps/electron/src/main --glob '*.ts'
```

Expected: 全部测试与构建通过；`mcp__planning__*` 业务定义和 `<referenced_planning>` 内容生成只存在于 Rust，TypeScript 命中仅限薄适配、协议字段和测试断言。

- [ ] **Step 7: 提交工具与引用迁移**

```bash
git add native/http-api-server/src/planning apps/electron/src/main/lib/adapters/pi-planning-tool-adapter.ts apps/electron/src/main/lib/adapters/pi-planning-tool-adapter.test.ts apps/electron/src/main/lib/adapters/pi-agent-adapter.ts apps/electron/src/main/lib/adapters/pi-builtin-tools.ts apps/electron/src/main/lib/agent-orchestrator.ts apps/electron/src/main/lib/agent-rpc-service.ts apps/electron/src/main/lib/agent-rpc-protocol.ts apps/electron/src/main/pi-rpc-worker.ts apps/electron/src/renderer/lib/agent-http-stream.ts
git rm apps/electron/src/main/lib/planning-permission-policy.ts apps/electron/src/main/lib/planning-reference-context.ts
git commit -m "feat(planning): move tools and references into Rust"
```

### Task 7: 迁移 Electron 主进程消费者并收缩 IPC

**Files:**

- Modify: `apps/electron/src/main/ipc.ts`
- Modify: `apps/electron/src/main/lib/agent-island-service.ts`
- Modify: `apps/electron/src/main/lib/planning-events.ts`
- Delete: `apps/electron/src/main/lib/planning-reminder-scheduler.ts`
- Modify: `apps/electron/src/preload/index.ts`
- Modify: `packages/shared/src/types/planning.ts`

- [ ] **Step 1: 将 Agent Island 改为异步 snapshot cache**

主进程启动后先从 `/api/planning/snapshot` 加载；收到 Rust `changed` 后刷新。Agent Island 高频 push loop 只读内存 cache，不发 HTTP、不打开 SQLite。

- [ ] **Step 2: 收缩 Planning IPC**

删除 LIST/CREATE/UPDATE/DELETE Todo、日程、分组、标签、提醒 IPC handler。保留：

- `OPEN_WINDOW`
- `START_TODO_AGENT`
- `TODO_AGENT_SESSION_READY`

`START_TODO_AGENT` 仍负责创建 Agent session 和聚焦窗口，但 Todo 的工作区更新必须先通过 Rust client 完成乐观锁事务。

- [ ] **Step 3: 收缩 Preload API**

删除 Planning CRUD 方法和 `onPlanningChanged` 数据事件；新增只读 `getLocalApiConnection()` bootstrap，并保留窗口/会话编排方法。

- [ ] **Step 4: 运行主进程、Preload 类型与构建检查**

Run:

```bash
bun run typecheck
bun run --filter='@copis/electron' build:main
bun run --filter='@copis/electron' build:preload
```

Expected: PASS；`ipc.ts` 和 Preload 不再暴露 Planning CRUD。

- [ ] **Step 5: 提交主进程消费者迁移**

```bash
git add apps/electron/src/main/ipc.ts apps/electron/src/main/lib/agent-island-service.ts apps/electron/src/main/lib/planning-events.ts apps/electron/src/preload/index.ts packages/shared/src/types/planning.ts
git rm apps/electron/src/main/lib/planning-reminder-scheduler.ts
git commit -m "refactor(electron): remove planning data IPC"
```

### Task 8: 迁移 Renderer Planning UI、提醒和引用搜索

**Files:**

- Create: `apps/electron/src/renderer/lib/planning-api-client.ts`
- Create: `apps/electron/src/renderer/lib/planning-api-client.test.ts`
- Create: `apps/electron/src/renderer/lib/planning-event-client.ts`
- Create: `apps/electron/src/renderer/lib/planning-event-client.test.ts`
- Modify: `apps/electron/src/renderer/lib/http-api-bridge.ts`
- Modify: `apps/electron/src/renderer/main.tsx`
- Modify: `apps/electron/src/renderer/components/planning/PlanningView.tsx`
- Modify: `apps/electron/src/renderer/components/planning/CalendarWorkspace.tsx`
- Modify: `apps/electron/src/renderer/components/planning/PlanningReminderRail.tsx`
- Modify: `apps/electron/src/renderer/components/agent/mention-suggestions.tsx`
- Modify: `apps/electron/src/renderer/components/agent/AgentView.tsx`

- [ ] **Step 1: 写 Renderer client 和重连失败测试**

覆盖 query 编码、Bearer token、409 映射、503 映射、SSE 断线后 snapshot 恢复和 listener 清理。

- [ ] **Step 2: 实现统一 Renderer client**

组件不直接散落 `fetch`。桌面模式使用 Preload 提供的 connection；浏览器开发模式通过 `/api` 同源代理。

- [ ] **Step 3: 迁移 PlanningInitializer 和页面 CRUD**

- `main.tsx` 初始化 Todo、日程、分组、标签和提醒 snapshot。
- `PlanningView`、`CalendarWorkspace` 使用 client CRUD。
- `PlanningReminderRail` 使用 active reminders API，并消费 `reminder_due` SSE。
- Jotai atoms 保持 UI 状态源，不在组件中复制远端 cache。

- [ ] **Step 4: 迁移 Agent mention 和 Todo UI 入口**

提及弹层通过 Rust 查询开放 Todo 和时间范围内日程；AgentView 创建 Todo 通过 Planning client。发送消息时完整保留引用 ID。

- [ ] **Step 5: 删除浏览器 bridge 的 Planning 空数组 fallback**

`http-api-bridge.ts` 将 Planning 方法映射到真实 client；Rust 不可用时抛出 `planning_unavailable`，不能静默返回空列表。

- [ ] **Step 6: 运行 Renderer 测试和构建**

Run:

```bash
bun test apps/electron/src/renderer/lib/planning-api-client.test.ts apps/electron/src/renderer/lib/planning-event-client.test.ts apps/electron/src/renderer/components/agent/planning-reference-state.test.ts
bun run typecheck
bun run --filter='@copis/electron' build:renderer
```

Expected: PASS；构建产物中不再调用 Planning CRUD IPC。

- [ ] **Step 7: 提交 Renderer 迁移**

```bash
git add apps/electron/src/renderer/lib/planning-api-client.ts apps/electron/src/renderer/lib/planning-api-client.test.ts apps/electron/src/renderer/lib/planning-event-client.ts apps/electron/src/renderer/lib/planning-event-client.test.ts apps/electron/src/renderer/lib/http-api-bridge.ts apps/electron/src/renderer/main.tsx apps/electron/src/renderer/components/planning apps/electron/src/renderer/components/agent/mention-suggestions.tsx apps/electron/src/renderer/components/agent/AgentView.tsx
git commit -m "feat(renderer): use Rust planning API"
```

### Task 9: 删除 TypeScript 数据层并证明单写入

**Files:**

- Delete: `apps/electron/src/main/lib/planning-manager.ts`
- Delete: `apps/electron/src/main/lib/planning-manager.test.ts`

- [ ] **Step 1: 删除旧 manager 和 SQL 测试**

Rust migration/repository tests 成为数据库行为的唯一测试。TypeScript 只保留 API client、工具 contract 和 UI tests。

- [ ] **Step 2: 运行静态审计**

Run:

```bash
rg -n "planning-manager|node:sqlite|DatabaseSync" apps/electron/src packages native
rg -n "getPlanningDatabasePath\(" apps/electron/src/main
rg -n "PLANNING_IPC_CHANNELS\.(LIST|CREATE|UPDATE|DELETE|ACKNOWLEDGE|SNOOZE)" apps/electron/src packages/shared/src
```

Expected:

- 第一条没有生产代码命中。
- `getPlanningDatabasePath()` 只在 Rust 启动配置中命中。
- 第三条没有数据 CRUD IPC 命中。

- [ ] **Step 3: 验证打包产物没有 TypeScript SQLite 依赖**

Run: `rg -n "node:sqlite|planning-manager" apps/electron/dist/main.cjs`
Expected: 0 matches。

- [ ] **Step 4: 提交旧数据层删除**

```bash
git rm apps/electron/src/main/lib/planning-manager.ts apps/electron/src/main/lib/planning-manager.test.ts
git add apps/electron/src packages/shared/src native/http-api-server
git commit -m "refactor(planning): remove TypeScript database owner"
```

### Task 10: 数据迁移、跨进程 E2E、打包与发布门禁

**Files:**

- Create: `native/http-api-server/tests/planning_api.rs`
- Create: `apps/electron/src/main/lib/planning-rust-integration.test.ts`
- Modify: `apps/electron/scripts/build-http-api-server.ts`
- Modify: `apps/electron/electron-builder.yml`
- Modify: `apps/electron/package.json`
- Modify: `packages/shared/package.json`
- Modify: `native/http-api-server/Cargo.toml`
- Modify: `bun.lock`

- [ ] **Step 1: 建立旧数据库 fixture 和进程级集成测试**

测试启动真实 Rust binary，传入临时数据库和 token，通过 HTTP 完成 Todo、日程、标签、提醒、SSE 和 migration 验证。

- [ ] **Step 2: 运行完整自动化验证**

```bash
bun run typecheck
bun test apps/electron/src/main/lib/planning-api-client.test.ts
bun test apps/electron/src/main/lib/adapters/pi-planning-tool-adapter.test.ts
bun test apps/electron/src/renderer/lib/planning-api-client.test.ts
cargo test --manifest-path native/http-api-server/Cargo.toml
bun run --filter='@copis/electron' build:http-api-server
bun run --filter='@copis/electron' build:main
bun run --filter='@copis/electron' build:preload
bun run --filter='@copis/electron' build:agent-rpc-worker
bun run --filter='@copis/electron' build:renderer
```

Expected: 全部 exit 0，无新增 error；仓库既有 warning 单独记录，不能与本次回归混淆。

- [ ] **Step 3: 执行桌面 E2E**

在真实 Electron 窗口验证：

1. 旧 `planning.db` 升级后 Todo、日程、标签和提醒数量一致。
2. 日程 CRUD、完成状态、提醒开关和跨窗口冲突正常。
3. Todo CRUD、分组、标签和启动 Agent 正常。
4. Pi 调用 `mcp__planning__list_todos`、`get_todo`、创建、更新和完成工具成功。
5. Agent 引用 Todo/日程后，prompt 使用 Rust 最新数据。
6. Plan mode 下 Planning 写工具被拒绝，只读工具可用。
7. 到期提醒只触发一次；snooze 后可再次触发。
8. Agent Island 展示当天 Todo/日程并随 Rust 事件更新。
9. Rust 进程重启后 UI、worker 和主进程 subscriber 自动恢复。

- [ ] **Step 4: 验证跨平台打包**

至少验证 macOS 当前架构和 CI Windows x64。确认 Rust binary、SQLite bundled library、数据库路径、token 环境和退出顺序正确。

- [ ] **Step 5: 按仓库版本规则递增受影响包 patch 版本**

至少包括 `@copis/shared` 和 `@copis/electron`；Rust crate version 同步递增 patch。不得修改无关包版本。

- [ ] **Step 6: 执行代码简化和最终审计**

运行仓库要求的 `@code-simplifier`，然后重新执行 Task 9 静态审计和 Task 10 全部验证。取得用户许可后再更新 README 与 `AGENTS.md` 的最终架构说明。

- [ ] **Step 7: 提交发布门禁**

```bash
git add native/http-api-server apps/electron packages/shared bun.lock
git commit -m "test(planning): verify complete Rust migration"
```

## 6. BDD 验收场景

```text
Given 用户已有包含 Todo、日程、标签和提醒的 planning.db
When 新版本首次启动
Then Rust 在迁移前创建备份并完成 schema migration
And 所有记录、关系和提醒状态保持一致
And Electron 不再用 node:sqlite 打开该数据库

Given 用户在日程页面创建、修改或删除日程
When 操作完成
Then Renderer 只请求 Rust Planning API
And Rust 在单个事务中写入 planning.db 并发布 changed 事件
And 其他窗口通过 SSE 刷新

Given Pi Agent 运行在 Rust RPC worker 路径
When Agent 调用 mcp__planning__get_todo
Then worker 从 Rust catalog 建立工具并调用 Rust execute endpoint
And Rust 校验参数并通过 Planning service 读取 Todo
And 工具结果沿 Pi -> Rust SSE -> Renderer 返回
And 不调用 planning-manager.ts

Given 用户在消息中引用 Todo 或日程
When Agent 请求通过 Rust HTTP/SSE 路径发出
Then mentionedTodoIds 和 mentionedCalendarEventIds 保持不丢失
And prompt 注入 Rust API 返回的最新记录
And Agent 先调用对应只读 Planning 工具核验

Given Agent 处于 Plan mode
When 它尝试调用 Planning 工具
Then list/get 工具可用
And create/update/complete/delete/acknowledge/snooze 工具被权限层拒绝
And Plan mode 状态不写入 planning.db

Given 一个提醒到期
When Rust scheduler 原子 claim 该提醒
Then 只发布一次 reminder_due
And Electron 展示原生通知并发送已配置的外部通知
And Renderer 提醒条同步显示

Given Rust Planning migration 或服务启动失败
When UI、Agent 工具或原生消费者访问 Planning
Then 返回 planning_unavailable 或 planning_migration_failed
And 不回退到 TypeScript SQLite
And Agent 非 Planning 对话仍可继续使用
```

## 7. 完成标准

- Rust 是 `planning.db` 的唯一生产读写者。
- Rust 完整覆盖 Todo、日程、分组、标签、提醒、Todo-Session 关联和 migration。
- Rust 负责提醒 claim、调度和 Planning SSE。
- Rust 独占 `mcp__planning__*` catalog、schema、参数校验、权限分类和执行分派；新 worker 与旧 Pi 路径仅保留同一薄协议适配。
- Rust 独占 Planning 引用读取和规范化 prompt fragment；两条 Agent 路径不再拼接引用上下文。
- Renderer、Preload、主进程、Agent Island 和提醒功能没有 Planning SQL 或 CRUD IPC 旁路。
- `planning-manager.ts`、`planning-manager.test.ts` 和 Electron reminder scheduler 已删除。
- Plan mode 与 Planning 数据域继续解耦，只保留工具权限关系。
- 旧数据库升级、失败回滚、提醒去重、跨窗口同步、Rust 重启和跨平台打包均通过验证。
- `rg` 审计、Bun tests、Cargo tests、typecheck、全部 Electron build 和真实桌面 E2E 全部通过。
