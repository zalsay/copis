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
