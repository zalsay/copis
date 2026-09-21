# Task 9 — ChatRoomAgentCoordinator

## BDD/TDD 记录

- RED：在既有 Task 7 facade 上增加“导出真正协调器”测试；运行 `bun test apps/electron/src/main/lib/chatroom-agent-coordinator.test.ts`，该断言因 `ChatRoomAgentCoordinator` 未定义失败，既有两项 facade 注册回归通过。
- GREEN：实现协调器后，协调器聚焦测试 6/6 通过；覆盖三 Agent 并行、重复投递、depth=3、Gateway 断开和无启动失败路径。

## 实现

- `chatroom-agent-coordinator.ts`：Main-only activeRuns/pendingPermissions；accepted 先持久化再上报，running/terminal 使用当前记录和 CAS 语义；无全局队列，按 Agent session 并行执行；结构化输出复用 sanitizer，只有允许的结构化 Agent ID 才能创建下一跳且 `depth + 1 < 3`。
- Gateway 断开、stopAll、dispose 会停止运行、清理权限、回传一次失败并释放租约；late callback 不覆盖 terminal。
- 权限请求完整对象只保留在 Main，向主理人发送 room/agent/trace/invocation 与脱敏摘要；响应重新读取用户、房间 host/device 和 60 秒有效期，强制 `alwaysAllow=false`。
- `agent-orchestrator.ts`：聊天室 trusted runtime 的权限请求走 Main-only sink，普通会话继续走现有 EventBus。
- `agent-rpc-runtime-context.ts` / shared contract：增加 Main-only `requestPermission` 函数槽位，禁止进入 IPC DTO。

## 验证

- `bun test apps/electron/src/main/lib/chatroom-agent-coordinator.test.ts`：6 pass。
- `bun run --filter='@copis/electron' typecheck`：pass。

## 剩余风险

- Task 10 仍需把真实 `runAgentHeadless`、hidden session store、session override、Skill snapshot 和 Rust bridge 生命周期注入 coordinator；本任务没有修改 IPC/preload/main lifecycle。
- Electron 实际窗口中的权限 UI 和聊天室页面属于后续 Task 10/Phase 4，需用户最终确认。

## Fix round 1

- RED：reviewer 指出原实现缺少敏感工具 defense-in-depth、统一 delta sanitizer、拒绝状态持久化、CAS、回传失败停止、完整 lease release 等边界；新增 workspace CAS 与增量 sanitizer 回归后先验证失败/类型错误，再修复为 GREEN。
- GREEN：`ChatRoomWorkspaceStore.transitionInvocation()` 在单次 load/validate/persist 路径内完成 expected-status CAS；协调器现在强制 session override 依赖、身份二次校验、accepted/running 回传失败不启动、固定错误摘要、rejected 持久化、terminal late callback 防覆盖、主理人 deny/timeout 先 stop、下一跳 `allSettled`、所有未归档 Agent lease release，并复用统一文本 sanitizer 和敏感值。
- Orchestrator 对聊天室仅自动放行隔离 project 文件工具与只读 Memory，其余能力进入主理人单次审批；浏览器/支付/外部账号能力继续 fail closed。
- BDD 补充覆盖：三路 barrier 并行启动、depth 2 不创建下一跳、host/device mismatch、hidden override 注册失败、accepted 回传失败、最新 N 条上下文、Main-only 权限摘要与强制单次批准、全量未归档 lease stopAll、delta 路径/secret/UTF-8 16 KiB/50ms、真实 workspace CAS late callback。

Fix round 1 verification：coordinator 15/15，workspace store 24/24，sanitizer 16/16，permission 1/1，runtime 5/5，HTTP handler 17/17；Electron typecheck、build:main、build:renderer、git diff --check 均通过。

## Fix round 2

- RED：补充 duplicate requestId 双 Promise、terminal 状态回退、reportRunning/reportCompleted 失败、stopAgent 永不返回时 deny 收敛等 BDD 场景；初始实现分别出现权限 Promise 悬挂、状态矩阵未限制和重复运行风险。
- GREEN：权限服务先原子占位再发送 renderer，重复 requestId 明确拒绝，sink 异常固定拒绝且不遗留 pending；协调器在 deny/timeout/disconnect/stopAll 前显式 deny 底层请求，stopAgent 采用有界 fire-and-forget，terminal 不等待停止；状态 CAS 增加单向矩阵，Rust 没有 rejected bridge 时本地拒绝统一保存为 failed；completed 只有远端回传成功后才落本地，失败转固定 failed 且不继续下一跳。
- 聊天室 query 使用 SDK `default` 可拦截模式（仅 Main 内部类型扩展，不改变用户可选的 bypass/plan），原生敏感工具仍经 canUseTool/主理人审批；聊天室路径解析以 projectRoot 为相对基准，Skill 启动前校验 snapshot digest。

Fix round 2 verification：coordinator 18/18，workspace store 25/25，permission 2/2；Electron typecheck、build:main 已通过。未修改 IPC/preload/main lifecycle；仍需主 Agent 完成全套回归、code simplifier 与最终 Electron 实际窗口确认。

## Fix round 3

- RED：补充 pre-aborted/dispatch 中 abort、RPC chatroom `default`、Rust file API Bash 注册及 completion/disconnect 竞态场景；旧实现分别会发送已取消请求、仍输出 bypass、缺少 Bash 或允许断连覆盖完成状态。
- GREEN：权限服务在注册前及 dispatch 后检查 abort，并通过幂等 settle 清理 pending；RPC Main-only query mode 使用 `default`，Renderer `CopisPermissionMode` 未扩展；聊天室 Rust file tools 恢复受限 Bash，安全文件工具仍由 coordinator/orchestrator 控制，外部工具继续审批或拒绝；run 增加 completion claim，完成回传 pending 时断连不会倒写 failed。

Fix round 3 verification：permission 4/4，coordinator 19/19，RPC service 34/34，Pi builtin tools 22/22；Electron typecheck、build:main、build:renderer 均通过。停止超时可通过 Main-only `stopAgentTimeoutMs` 注入测试值；待提交。

## Fix round 4/5

- RED：新增 Worker 源码回归断言、external approval settle 测试与 Rust `chatroom default` profile 测试；初始结果分别为 unconditional allow 断言失败、`openExternalApproval is not a function`、Rust helper unresolved import。
- GREEN：Pi Worker 在 `capabilityProfile=chatroom` 下对 project 内 Read/Edit/Write/MultiEdit 与只读 Memory 自动允许，敏感能力明确拒绝，其余（含 Bash/越界文件）经 session-bound `COPIS_PI_FILE_API_TOKEN` 访问 Rust permission route；Rust 只对 chatroom profile 接受 Main-only `default`，普通 profile 仍拒绝；Rust route 校验 token/session 后通过 stdio Bridge 转发 Main，Main coordinator 复用统一 pending settle API。
- 验证：`bun test apps/electron/src/main/pi-rpc-worker.test.ts apps/electron/src/main/lib/agent-permission-service.test.ts` 8 pass；`cargo test --manifest-path native/http-api-server/Cargo.toml chatroom_default_permission_mode_is_main_only` 1 pass；`cargo test --manifest-path native/http-api-server/Cargo.toml chatroom_default_policy_requires_chatroom_profile` 1 pass；Electron typecheck pass；`git diff --check` pass。
- 剩余风险：本轮尚未补齐 Rust route 的网络级 token 错误/跨 session、Main handler/gateway 集成测试，completion/disconnect 终态协议与 expired/non-host 既有实现仍需主 Agent 继续审阅；未执行全套 build 与实际 Electron UI 验收。

### Fix round 4 continuation

- 修复 chatroom `query.permissionMode=default` 与 Rust file policy mismatch：policy 与 query 同时使用 Main-only `default`，普通 profile 仍拒绝。
- Bridge 对 permission route 使用 90 秒有界等待；Rust permission route 增加 chatroom profile、token/session 绑定、精确字段、长度、控制字符和 body 上限校验；Main 增加严格 permission DTO validator，拒绝未知字段和静默截断。
- Coordinator 改用注入的 permission service；权限服务 pending 使用统一幂等 settle 并移除 abort listener；过期响应立即删除 pending、底层 deny、claim timeout terminal 后抛 `permission_expired`。
- 新增 settle-after-respond、Main validator、chatroom profile/token 绑定回归测试。
- 验证：Electron focused 27 pass，typecheck pass；Rust focused tests需分进程运行（Bun/Rust 命令参数不能一次传多个 test filter）；cargo fmt check 尚待精确格式化且不触碰既有 dirty hunks。

### Fix round 4 final continuation

- `prepareAgentRpcRun` 的聊天室 file policy 现在与 query 同用 Main-only `default`；`PiWorkerFileAccessPolicy` 与内部 protocol 接受该值，普通 renderer 输入仍不可注入 capability profile。
- permission bridge timeout 精确提高到 90 秒；Rust policy 增加 `chatroom_profile` 绑定，permission route 不再接受普通 worker token。Rust/Main validator 均拒绝未知字段、空值、控制字符、过长 ID/文本、非对象 toolInput 和静默截断。
- Worker canUseTool 抽为 `pi-worker-permission.ts` 并由真实 Worker 使用；测试真实调用证明 project-local Read 立即 allow、Bash 在 bridge response 前保持 pending，abort 后 fail closed。
- `PendingPermission` 统一幂等 settle，settle 时移除 abort listener；补 respond→abort→clear 回归。过期 host 响应立即删除 pending、底层 deny 并 claim `host_approval_timeout`。
- 验证：Electron focused 28 pass，Electron typecheck pass；Rust `chatroom_default_policy_requires_chatroom_profile` pass，`chatroom_default_permission_mode_is_main_only` pass。cargo fmt check 仍需主代理对既有 dirty main.rs hunks 做精确格式处理；未提交。
## Fix round 4 final RED/GREEN

- RED: completion callback could remain in flight after the local 1s race, allowing a late remote completed terminal; the new regression holds `reportCompleted` until its `AbortSignal` is observed and asserts cancellation before lease release.
- GREEN: `ChatRoomRustApi.reportCompleted` now accepts an optional signal; `HttpChatRoomRustApiClient` forwards it to fetch; coordinator aborts and awaits the in-flight request before recording the single local failed terminal and releasing leases. Added concurrent invocation, archive ABA, timeout, skill-digest, and next-hop isolation BDDs.
- Commands: `bun test apps/electron/src/main/lib/chatroom-agent-coordinator.test.ts` (25 pass, 53 expects); focused worker/permission/handler suite (28 pass, 82 expects); `bun run --filter='@copis/electron' typecheck`; `bun run --filter='@copis/electron' build:main`; `bun run --filter='@copis/electron' build:renderer`; `cargo fmt --manifest-path native/http-api-server/Cargo.toml -- --check`; `cargo test --manifest-path native/http-api-server/Cargo.toml` (453 pass); `git diff --check`.
## Fix round 5 RED/GREEN

- RED: aborting a timed-out completion request did not establish whether Rust had already committed `completed`; a late response could leave local failed/remote completed and release a lease with unknown authority.
- GREEN: completion now performs an idempotent finalize retry. A successful retry marks local `completed`; an unconfirmed retry leaves the run `running/uncertain`, keeps it in the active set, and `stopAll` returns no released lease for that run. Confirmed failed terminals only release after the Rust failure report succeeds. Added BDDs for server-completed/response-lost, unknown-terminal lease retention, and permission dispatch ordering.
- Rust route timeout regression: `permission_bridge_has_a_bounded_approval_timeout`.
- Evidence: coordinator `28 pass / 61 expects`; Rust focused timeout test passed; `cargo fmt -- --check`; Electron typecheck and `build:main`; `git diff --check`. `git diff a32b7d68..95f1766a --numstat -- native/http-api-server/src/main.rs` is `135 0`, with exactly four Task 9 hunks (permission constant, 90s timeout, route dispatch, permission handler); no module-order or unrelated rustfmt hunks are present in that commit range.
## Fix round 5 handler test completion

- Added real `handle_internal_agent_permission` TCP harness tests covering non-POST, wrong token, cross-session token, ordinary profile, unknown field, valid chatroom token, and bridge unavailable. Authentication failures return before bridge forwarding; valid chatroom authorization reaches the bridge boundary and returns stable 503 when unavailable.
- The completion retry BDD (`Rust 已写入 completed 但响应丢失 When finalize retry succeeds`) verifies the retry uses the same completed payload and resolves local terminal to completed; no separate Rust gateway idempotency fixture existed, so this remains the client contract boundary.
- Latest focused Rust handler tests: 2 passed; coordinator suite: 29 passed / 62 expects. `cargo fmt --check` and `git diff --check` pass.
