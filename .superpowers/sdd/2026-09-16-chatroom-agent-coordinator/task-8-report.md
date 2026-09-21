# Task 8 — Structured Output Parsing and Sanitization

## 结果

Task 7 的三个 load-bearing carry-over 已关闭，并完成 Task 8 parser/sanitizer 与 prompt gating。

## TDD / BDD 证据

### Carry-over 1：displayName canonicalization

- RED：`bun test packages/shared/src/types/chatroom.test.ts` 首次失败，原因是 `canonicalizeChatRoomAgentDisplayName` 尚不存在（`TypeError: ... is not a function`）。
- GREEN：同命令 `14 pass, 0 fail`。
- Go：新增真实 `ChatRoomV2Store` CreateAgent FEFF/NBSP/UTF-8 boundary 回归；首次运行因仓库根目录无 Go module 被错误工作目录阻断，切换到 `backend/modules/edu-api` 后通过；`go test ./services -run TestChatRoomV2AgentDisplayNameUsesTrimmedUTF8AndControlRules -count=1` 通过。
- Rust：`cargo test chatroom_gateway_tests::given_chatroom_agent_display_name_when_validating_then_use_trimmed_utf8_limit_and_reject_controls -- --exact` 通过。
- 生产改动：Shared canonical helper、Electron local store、Go model Create/Update/builder、Rust public route/bridge 均使用明确的 Unicode White_Space + U+FEFF edge trim、Cc rejection、UTF-8 <=128 bytes；持久化使用 canonical 值。

### Carry-over 2：原子 delivery failure transition

- RED：新增 `TestChatRoomV2LegacyFailureStoreFailsClosedWithoutAtomicTransition` 后，旧 helper 的 legacy `FailInvocation` fallback 实际发布了 `agent.failed`，证明仅凭返回 invocation 无法判断新转移。
- GREEN：移除 helper 的 legacy fallback；缺少 `FailInvocationIfActive` 或 `BroadcastTransient` 时 fail closed。公共 `FailInvocation` 仍保留给其他命令路径。
- GREEN：`go test ./services -run TestChatRoomV2FailInvocationIfActiveIsAtomicAndDoesNotOverwriteTerminalCode -count=1` 通过（真实 `ChatRoomV2Store`/生产事务）。
- 覆盖：created/accepted/running -> `failed(invalid_invocation)` 返回 newly=true；已有 failed/completed/rejected 不重复转移、不覆盖 failureCode。
- HTTP/WS builder failure 共用 `failChatRoomV2Invocation` helper；生产 store 使用 `FailInvocationIfActive` 窄 API，旧 `FailInvocation` 保留。

### Carry-over 3：room-wide failure visibility

- GREEN：`go test ./handlers -run 'TestChatRoomV2(HTTPInvocation|BuilderFailure)' -count=1` 通过。
- 新增 `TestChatRoomV2BuilderFailureUsesRoomWideTransientBroadcast`：同 room 两成员各收到一次 `agent.failed`，其他 room 无事件；`agent.invocation` 仍走 direct device path。

### Task 8 sanitizer

- RED：新增 Unicode/空格 POSIX+Windows path、纯换行制表符、root-contained secret、unpaired-surrogate 回归后，`bun test apps/electron/src/main/lib/chatroom-output-sanitizer.test.ts` 先以 `4 fail, 9 pass` 暴露路径残留、空白文本、secret overlap 和 surrogate 边界。
- RED：新增 quoted/single-quoted、bracketed/parenthesized/braced path 后同命令 `13 pass, 1 fail`，暴露 closing delimiter 未作为 terminator 且句点被吞；新增 URL 回归后 `14 pass, 1 fail` 暴露 `https://` 被误判。
- GREEN：修复 component/terminator 边界、file URI 专用规则及句末标点保留后，同命令 `15 pass, 0 fail`。
- 覆盖：strict JSON object、tail/multiple JSON/array/malformed fallback、raw @ 不触发 mention、known/generic POSIX+Windows path、overlapping roots/secrets、ANSI/C0/C1、CRLF、allowlist intersection/order/dedupe、Unicode 64 KiB boundary、清理后 placeholder、无 raw logs。
- 路径边界：外围 `'`/`"`/`]`/`)`/`}` 保留；`https://` 不改写；`file:///` 变为 `file://[本地路径已隐藏]`；ASCII/CJK 句末标点保留。
- UTF-8 裁定：JS unpaired surrogate 不是有效 Unicode scalar，清理为固定 `[内容已清理]`；合法 surrogate pair 继续由 `TextEncoder` 编码，64 KiB 截断使用 fatal `TextDecoder`，不产生 U+FFFD。

### Prompt trust gating

- RED：`bun test apps/electron/src/main/lib/agent-prompt-builder.test.ts` 首次失败，trusted chatroom prompt 缺少结构化输出指令。
- GREEN：同命令 `32 pass, 0 fail`。
- 仅在 `getTrustedAgentExternalSource(sessionId) === 'chatroom'` 且 `getTrustedAgentRuntimeContext(sessionId)` 同时存在时注入；普通 session、仅 source、仅 context 均不注入，指令不携带 local paths/workspace IDs/Memory/Skill 内容。

## 验证

- `bun run typecheck`：通过。
- `bun run --filter='@copis/electron' build:main`：通过。
- `bun run --filter='@copis/electron' build:renderer`：通过；仅有既有 Browserslist/chunk-size warning。
- `bun test apps/electron/src/main/lib/chatroom-output-sanitizer.test.ts`：15/15。
- `bun test apps/electron/src/main/lib/agent-prompt-builder.test.ts`：32/32。
- `bun test packages/shared/src/types/chatroom.test.ts`：14/14。
- `bun test apps/electron/src/main/lib/chatroom-workspace-store.test.ts`：22/22。
- `cargo test -- --test-threads=1`：443/443。
- `go test ./services ./handlers -count=1`（`ai-education/backend/modules/edu-api`）：通过。
- 最终回归：`go test ./handlers -run 'ChatRoomV2' -count=1`、`go test ./services -count=1`：通过；整包 `go test ./services ./handlers -count=1` 仍受本机缺少 `ai_education_test` PostgreSQL 数据库影响（非本任务代码路径）。
- `cargo fmt --check`：通过。
- `gofmt` 已执行；两仓 `git diff --check`：通过。

## 提交

- Copis：`c7b0a706` — `feat(chatroom): sanitize structured agent output`；`afcb4fee` — `fix(chatroom): harden output sanitization boundaries`。
- Copis 本轮：`2ae8de37` — `fix(chatroom): preserve path delimiters and URL boundaries`。
- ai-education：`adb4ede6` — `fix(chatroom): close delivery failure and name boundaries`；`f3cc2bfe` — `fix(chatroom): require atomic failure transition`。

## Concern

- 既有 Copis 五个 Rust dirty 文件保持未修改、未暂存、未提交：`auth_session.rs`、`edu_api_client_tests.rs`、`main.rs`、`working_gateway.rs`、`working_gateway_tests.rs`。
- Electron renderer build 保留仓库既有 warning；未替用户执行 Electron 实际窗口 UI 确认。
- ai-education 整包 handlers 测试需要本机 PostgreSQL `ai_education_test`，当前环境不存在；任务相关 ChatRoomV2 handler/service focused suites 已通过。
- Go/Rust carry-over 的部分实现先于最终新增回归命令完成，命令结果均为真实 production path GREEN，但无法回溯记录每个跨语言测试的独立 RED 输出。

## 修复轮 2：跨层边界回归

### 1. Shared/local displayName surrogate

- RED：`bun test packages/shared/src/types/chatroom.test.ts` 为 `\uD800` 失败（孤立 surrogate 被 `TextEncoder` 按 U+FFFD 接受）；`bun test apps/electron/src/main/lib/chatroom-workspace-store.test.ts` 生产 `provisionAgent` 同样持久化了 `\uD800`。
- GREEN：Shared canonicalizer 显式拒绝 UTF-16 surrogate code point；合法 surrogate pair（emoji）仍接受，workspace store 生产路径拒绝且不创建 room 配置。Shared `14 pass`、workspace `23 pass`。

### 2. Rust bridge canonical forwarding

- RED：新增真实 `ChatroomGateway` → `FakeBridge` callback body 回归后，`cargo test chatroom_gateway_tests::given_invocation_sender_names_with_edge_whitespace_when_forwarded_then_bridge_receives_canonical_names -- --exact` 收到原始 `FEFF/NBSP`，断言失败。
- GREEN：`forward_invocation_now` 在 validation 后 clone payload，并对 top-level sender 与每个 message sender 写回同一 canonical displayName；malformed payload 仍 fail closed。gateway canonical、forward callback、malformed regression 均通过。

### 3. WS full-frame boundary

- RED：真实 Gorilla WebSocket server 测试构造 Unicode `agent.completed` envelope（文本 65,535 UTF-8 bytes，含 invocationId、arrays、clientMessageId；frame >64 KiB 且 <=128 KiB），旧 `SetReadLimit(64 KiB)` 返回 close 1009。
- GREEN：edu-api read limit 对齐共享 `ChatRoomV2WireEventMaxPayloadBytes`（128 KiB），文本字段仍单独限制 64 KiB；真实测试接受该 frame 并完成 invocation，>128 KiB frame 被拒绝且未进入 handler。Rust protocol/client 既有 64 KiB payload、128 KiB frame/config regression 通过。
- 裁定：保留 64 KiB text/64 KiB payload 语义，128 KiB 仅为完整 WS JSON envelope/frame 上限，避免单点放宽文本输入。

### 修复轮 2 验证

- 提交：Copis `1903de21`（Shared surrogate、Rust bridge canonical forwarding、报告）；ai-education `507ce8a8`（WS 128 KiB full-frame boundary）。
- Copis：Shared/workspace focused tests、Rust gateway/protocol/client focused tests、`cargo fmt --check` 通过。
- ai-education：`go test ./handlers -run 'ChatRoomV2' -count=1`、`go test ./services -run 'ChatRoomV2' -count=1` 通过。
- 既有 sanitizer/prompt、atomic failure、room-wide transient 回归保持通过；最终 Electron typecheck/build:main/build:renderer、Rust 全套 `444 passed`、两仓 diff check 均通过。

## 修复轮 3：Rust parser envelope/text budget

- RED：先加入真实 `agent.completed` parser/client 回归，正文为 21,845 个 `界`（65,535 UTF-8 bytes），携带 invocationId、三项 mention IDs、附件 IDs 和 clientMessageId；frame 大于 64 KiB 且不超过 128 KiB。旧 `parse_event()` 以 `payload_too_large: chatroom event payload exceeds 64 KiB` 拒绝，`cargo test given_completed_ -- --test-threads=1` 为 `2 failed, 4 passed`（包含 production `decode_message` 链路）。
- GREEN：`MAX_PAYLOAD_BYTES` 改为完整 envelope/frame 的 128 KiB 预算，新增 `MAX_TEXT_BYTES=64 KiB`；`content`、`delta`、`message` 及命令侧正文继续执行字段级 UTF-8 byte 上限，并对 invocation/failure/code/clientMessageId 与 mention/attachment ID 字段做边界校验。合法完整 envelope 保留 content；正文超过 64 KiB 拒绝；payload/frame 超过 128 KiB 拒绝。
- 新增回归：`given_completed_event_with_64_kib_content_and_envelope_when_parsing_then_preserve_content`、`given_completed_frame_over_64_kib_but_under_128_kib_when_client_decodes_then_preserve_content`、`given_completed_content_over_64_kib_when_parsing_then_reject_field_without_widening_text_limit`、`given_payload_over_128_kib_when_parsing_then_reject_whole_frame`、delta 64 KiB 字段边界。`cargo test 'when_parsing_then' -- --test-threads=1` 为 `10 passed`；`cargo test -- --test-threads=1` 为 `448 passed, 0 failed`。
- 裁定：128 KiB 只覆盖完整 Rust/Go WebSocket frame JSON envelope；业务文本仍严格 64 KiB，避免扩大总 payload 后绕过正文限制。`decode_message()` 的真实 client receive decoder 复用同一 `parse_event()`，新增回归证明合法 envelope 可达 client event。

### 修复轮 3 验证与提交

- Copis focused Rust：`cargo test 'completed_' -- --test-threads=1` 为 `7 passed`；protocol boundary `10 passed`；full `cargo test -- --test-threads=1` 为 `448 passed`；`cargo fmt --check`、`git diff --check` 通过。
- Copis existing Task 8 regression：sanitizer `15/15`、prompt `32/32`、Shared `14/14`、workspace store `23/23`；`bun run typecheck`、`build:main`、`build:renderer` 均通过（保留既有 Browserslist/大 chunk warning）。
- ai-education：`go test ./handlers -run 'ChatRoomV2' -count=1`、`go test ./services -run 'ChatRoomV2' -count=1` 均通过；本轮无 Go 文件改动、无新增提交。
- 本轮代码提交：Copis `4c73203c`（仅三个 Rust protocol/client 文件）；保留 Copis 五个无关 dirty Rust 文件不暂存。

## 修复轮 4：附件、完整 WebSocket frame 与 Agent transient schema

### TDD / BDD 证据

- RED：Rust 原有 `ChatroomCommand` 与完成事件只校验附件 ID 格式，不拒绝 21 项；Rust parser 也允许 Agent transient 任意对象。新增 20/21 附件、缺失/错类型/未知字段/嵌套绕过用例后先失败，再实现统一边界与严格 schema。
- GREEN：Rust `SendMessage`、`AgentEventPayload::Completed`、公共消息 normalize、内部完成路由统一拒绝超过 20 个附件；`agent.accepted`、`agent.delta`、`agent.completed`、`agent.failed` 现在按精确公开字段解析，拒绝未知/缺失/错类型，文本仍 64 KiB、mentions 3、attachments 20。
- RED：Go wire 原按 RawMessage payload 128 KiB 判断，未计 type/roomId/seq/payload envelope 与 Gorilla `WriteJSON` 末尾换行。新增完整 frame 二分边界回归后改为 `json.Marshal(event)+1` 预算，最大可接受 frame 通过，多 1 字节返回 `ErrChatRoomV2WirePayloadTooBig`，写出前不会发送。
- GREEN：Go producer 将 accepted 收敛为 `{invocationId}`，completed 发送完整 `{invocationId,content,mentionAgentIds,attachmentIds,clientMessageId}`；Go store 在事务前统一拒绝 21 附件，并让 clientMessageId/数组 ID 拒绝控制符、Unicode 空白及 `/ ? # \\`，与 Rust 对齐。

### 验证

- Copis Rust protocol `34/34`、gateway `57/57`、client `38/38`；`cargo fmt` 通过。
- ai-education `go test ./handlers -run 'ChatRoomV2' -count=1` 通过；`go test ./services -run 'ChatRoomV2' -count=1` 通过；新增完整 frame 与消息输入边界测试均通过；`gofmt` 通过。
- 保留已有 sanitizer、prompt 双 gate、atomic failure、room-wide transient 与 64 KiB/128 KiB 回归。

### 裁定

- `agent.completed` 的 server outgoing shape 已同步为完整五字段，避免 Rust parser 为兼容旧的二字段事件而放宽 schema；durable `message.created` 与 transient completed 两者字段保持一致。
- 完整 frame 预算只约束 Go 写出 envelope；业务 `content`/`delta` 仍 64 KiB，附件上限由共享模型常量 `ChatRoomV2MaxAttachmentIDs` 定义。

## 修复轮 4（评审回归）：内容、failureCode 与空 transient 边界

### RED / GREEN

- RED：新增 Go WS/Hub 与真实 store 路径回归，发现 Go 允许 Rust `valid_content` 会拒绝的 Unicode control；新增 failureCode 空值、Unicode whitespace、control、`/?#\\`、UTF-8/64 字节边界回归，发现 store 仅做 trim/长度检查。
- GREEN：Go wire/store/WS handler 统一使用与 Rust 等价的 UTF-8、非空、字节上限及 control 规则；只允许 `\\n\\r\\t`，拒绝其他 Unicode control。failureCode 在 WS decode、handleCommand、store 状态转移前均按 `valid_id(64)` 校验，非法值不会进入事务或广播。
- RED：`ValidateChatRoomV2WireEvent` 的空 payload 早退允许四类严格 Agent transient 缺失 schema；GREEN：仅 `accepted/delta/completed/failed` 强制非空对象与 required fields，其他 transient/persisted/snapshot 仍保持可扩展。
- RED：completed producer 使用请求数组，重复 mentions/attachments 会在 transient 广播中复现；GREEN：改从持久化 `result.Message` 权威 JSON 字段解码并去重，保持持久化顺序。

### 验证

- `go test ./handlers -run 'ChatRoomV2' -count=5`：通过。
- `go test ./services -run 'ChatRoomV2' -count=5`：通过。
- Rust protocol `34/34`、gateway `57/57`、client `38/38`：通过；`cargo fmt --check` 通过。
- 完整 frame <=128 KiB、附件 <=20、既有 sanitizer/prompt/atomic failure/room-wide transient 回归保持通过。

## 修复轮 4（评审回归）：原始数组限额先于去重

### RED / GREEN

- RED：新增 store 与 WS command BDD 用例后，21 个相同 attachment 及 4 个相同 mention 因旧逻辑先去重而被接受。
- GREEN：`message.create` 与 `agent.completed` 的 WS 解码、统一消息 store 均先按原始数组数量执行 `attachments <= 20`、`mentions <= 3`，再按原顺序去重并持久化/广播；20/3 边界继续接受并规范化。
- HTTP message create 复用同一 store validator，因此不会绕过事务前检查；completed 的状态转移也在同一 validator 之后执行。

### 验证

- RED 实际失败：store 与 WS 重复数组用例各 1 个失败。
- GREEN：store/WS 重复数组回归通过；后续 `go test ./handlers -run 'ChatRoomV2' -count=5`、`go test ./services -run 'ChatRoomV2' -count=5` 通过。
- Rust protocol/gateway/client、附件 20 边界、完整 frame 128 KiB 与上一轮 control/failure/empty transient 回归保持通过。
