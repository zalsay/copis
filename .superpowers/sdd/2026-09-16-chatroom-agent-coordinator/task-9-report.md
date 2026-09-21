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
