# Task 7 — Rust Internal Client and Bridge Dispatch

## 范围

本任务实现 Electron Main 到 Rust 聊天室网关的五个状态回传客户端，以及 Rust stdout bridge 到 Main 协调器的两个精确入口。未修改 Shared 契约、Renderer/public token API 或 Rust 文件。

## BDD/TDD 证据

### RED

先新增以下测试，再运行：

```text
bun test apps/electron/src/main/lib/chatroom-rust-client.test.ts
```

测试在生产模块尚不存在时因 `Cannot find module './chatroom-rust-client'` 失败；同时新增的 handler 场景在路由尚未注册时返回 404，证明测试覆盖了缺失行为。

### GREEN

实现后聚焦测试通过：

```text
bun test apps/electron/src/main/lib/chatroom-rust-client.test.ts  # 7 pass
bun test apps/electron/src/main/lib/http-api-handler.test.ts      # 11 pass
bun run --filter='@copis/electron' typecheck                    # pass
```

覆盖内容包括：

- 五个冻结 invocation 状态路径、仅 `127.0.0.1` loopback、非空 internal token；
- invocationId 路径校验、UTF-8 delta 16 KiB 边界、上下文到 Rust DTO 的严格字段映射；
- 非 2xx 响应的有界流读取（最多 400 字符）和敏感字段/本地路径脱敏；
- 精确 POST bridge 路径、query/trailing slash 拒绝、strict invocation DTO/未知字段/请求体上限；
- accepted/duplicate 状态码、断开清理一次、coordinator lazy import 不可用、注入 callback 抛错。

## 实现位置

- `apps/electron/src/main/lib/chatroom-rust-client.ts`
  - 导出 `HttpChatRoomRustApiClient`，仅暴露五个 Phase 2 invocation 回传方法；
  - Main-only `getInvocationContext` 可补齐 Phase 2 要求的 room/agent/device/clientMessage 字段，不进入 Renderer；
  - `releaseAgentLeases` 没有 Phase 2 对应 loopback 路由，留给 Task 10 生命周期适配层。
- `apps/electron/src/main/lib/http-api-handler.ts`
  - 新增两个精确 Rust bridge 路由和可注入依赖；
  - 合法 DTO 校验后才加载协调器，未注入且模块不可用时稳定返回 503；
  - 不接触 Working JWT/public web token。
- `apps/electron/src/main/lib/chatroom-rust-client.test.ts`
- `apps/electron/src/main/lib/http-api-handler.test.ts`

## 剩余风险

- 尚未运行真实 Windows runner；本任务无 Windows 特定代码。
- Rust 网关要求回传 body 带 `roomId`/Agent/device 等字段，而 Shared `ChatRoomRustApi` 的公开方法参数只带 invocationId；客户端提供 Main-only `getInvocationContext` 接缝，Task 9/10 接入时必须注入，不能用 Renderer 或远端字段补齐。
- Task 9 协调器模块尚不存在；本任务只验证缺失模块返回稳定 503。Task 9 落地后必须提供 `getChatRoomAgentCoordinator()` 或 `chatRoomAgentCoordinator` 导出，并补跑 handler 全量测试。

## 提交与状态

本报告与四个实现/测试文件应在同一个独立 commit 中提交。提交前必须确认 5 个既有 dirty Rust 文件仍未暂存，且 `git diff --check` 通过。

## Fix Round 2

本轮针对 rereview 的两项 Important finding 补充了 BDD 回归覆盖：

### RED

- 新增 completed 输出的 strict shared validator、Rust 64 KiB UTF-8 边界、控制字符、mention/attachment component 以及 failed code/message 场景后，先运行 `bun test apps/electron/src/main/lib/chatroom-rust-client.test.ts`，得到 10 pass / 4 fail；失败均为实现尚未在 fetch 前拒绝伪造输出、超限文本、非法文本和未知 failureCode。
- 新增 coordinator 错误/未知状态日志脱敏场景，要求捕获 `console.error` 并验证 token、POSIX/Windows 路径和 stack marker 均不出现。

### GREEN

- `HttpChatRoomRustApiClient` 现在先以 `isChatRoomAgentOutput()` 校验完整运行时对象，再执行 Rust `valid_text` 等价检查；mention/attachment ID 使用 Rust `valid_component` 约束；failed report 使用完整 failureCode union 和同一文本边界校验，所有失败均发生在 fetch 前。
- coordinator 异常和未知状态仅记录固定中文类别，不序列化 error、status 或堆栈；HTTP response 保持固定 `chatroom_coordinator_failed`。
- 聚焦验证：client 14 pass / 0 fail；handler 14 pass / 0 fail；coordinator scaffold 2 pass / 0 fail；shared chatroom 11 pass / 0 fail；既有 HTTP API bridge 17 pass / 0 fail。
- `bun run --filter='@copis/electron' typecheck`、`build:main`、`build:renderer`、`git diff --check` 均通过。Renderer 构建仅保留既有 chunk size/dynamic import warnings。

本轮未修改计划、ledger、AGENTS.md、README.md 或五个既有 dirty Rust 文件；提交 hash 记录在交付消息中。

## Fix Round 3

本轮重新对照 `chatroom_protocol.rs`：`MAX_ID_BYTES=64`、`MAX_DEVICE_BYTES=128`、`MAX_CLIENT_MESSAGE_ID_BYTES=128`，并确认 gateway 的 `valid_component` 还会拒绝 `/ ? # \\`。

### RED

- 新增 protocol ID 64/65 字节、device/clientMessage 128/129 字节、multibyte output ID 64/65 字节以及 delta 控制字符场景；实现尚未按字段拆分限制时，client 聚焦测试得到 14 pass / 3 fail。

### GREEN

- roomId、agentId、mentionAgentIds、attachmentIds 使用 64 UTF-8 字节的 `valid_id` 等价校验；deviceId 和 clientMessageId 使用 128 UTF-8 字节限制，并保留 gateway component 兼容约束。
- invocationId 收紧为最多 64 字节的 ASCII 路由安全形式；failureCode union 值天然在 protocol 64 字节范围内。
- delta 复用 Rust 文本校验，保持 16 KiB 上限，同时拒绝除换行、回车、制表符外的控制字符。
- 聚焦 client 测试现为 17 pass / 0 fail；边界测试明确证明 device/clientMessage 128 字节可成功发送，attachment 64 字节可成功发送，超限字段均在 fetch 前拒绝。

本轮新增测试与实现仍保持五种 Rust request body exact shape；其余完整验证在提交交付消息中记录。

## Fix Round 1

Reviewer 指出的边界已在本轮修复：

- 五个回传方法现在严格生成 Phase 2 `require_keys` 对应的 exact body；上下文由 Main-only resolver 提供，公开方法签名精确实现五个 Shared report 方法，resolver 缺失、异常、原型/字段/ASCII component 不合法都会在 fetch 前失败；调用方注入的同名额外字段不会覆盖 resolver。
- handler 使用静态字面量 lazy import，并新增无默认实例的 coordinator 注册 scaffold；注册 disposer 带 token，旧实例 disposer 不会清理替换后的实例。
- callback 结果运行时只接受 `accepted`/`duplicate`；callback/协调器异常统一为固定 `chatroom_coordinator_failed` 中文响应，详细异常仅经 `redactSensitiveLogValue` 写日志。

本轮 RED 由 exact body、resolver fail-closed、注册 token、未知 callback 状态及敏感错误响应测试证明；GREEN 聚焦验证为：client 10 pass、handler 12 pass、coordinator scaffold 2 pass、Electron typecheck pass。提交 hash 由本轮独立 commit 记录在交付消息中。
