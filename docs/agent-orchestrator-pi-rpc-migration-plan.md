# AgentOrchestrator 到 Pi Worker RPC 迁移计划

> 状态：实施中。普通发送、队列、停止、运行中权限模式及所有外部入口均已走 Pi Worker RPC；遗留 `AgentOrchestrator` 源码和旧 IPC 的删除仍待后续阶段处理。
>
> 日期：2026-08-06

## 1. 目标与边界

### 1.1 目标

将 Copis 的 Pi Agent 执行入口统一到 `Rust HTTP API + Pi Worker` 链路，逐步移除交互式 UI 对主进程 `AgentOrchestrator` 的依赖，最终让 `AgentOrchestrator` 不再承担 Pi Agent 的执行、队列和运行中控制。

迁移完成后，目标链路为：

```text
Renderer UI
    |
    v
Preload / AgentHttpStreamClient
    |
    v
Rust HTTP API
    |
    +--> Electron internal /api/internal/agent/prepare
    |        |
    |        +--> agent-rpc-service：构建凭证、上下文、Skill、Memory 和 Worker 配置
    |
    +--> Pi Worker：执行 Pi SDK、输出事件、处理控制命令
```

### 1.2 必须保持的行为

- Agent runtime 继续固定为 Pi，保留本地文件优先和 `~/.copis` JSON/JSONL 存储模型。
- 普通消息、队列消息、停止、权限模式、上下文压缩、Skill/MCP mention、会话引用和 Planning 引用使用一致的输入语义。
- SDK 消息、Copis 事件、标题更新、完成状态、错误状态、OAuth 凭证和会话元数据继续通过现有 renderer listener 更新 UI。
- 每个会话最多一个活跃 Worker；重复请求不能产生两个并行运行或重复持久化。
- `rawUserMessage` 继续用于 UI 展示和历史记录，经过上下文注入的文本只用于 Pi prompt。
- Worker 异常、HTTP API 重启、Electron 退出和用户停止都必须释放运行状态，不能留下永久的 running 会话。

### 1.3 本计划不做

- 不修改 `README.md` 或 `AGENTS.md`，除非后续得到明确允许。
- 不引入数据库、不改变会话 JSONL 和工作区目录结构。
- 不在本阶段直接删除自动化、飞书、微信/钉钉 Bridge 等外部入口；它们改经统一的非 UI RPC gateway 执行。
- 不把快照回退强行实现为 Worker 内部命令。回退是本地会话和文件状态操作，应从 `AgentOrchestrator` 提取为独立服务。
- 不通过简单删除 IPC 方法来“完成迁移”；每个旧入口必须先完成调用方审计和行为替代。

## 2. 当前审计结论

### 2.1 AgentOrchestrator 的职责

`AgentOrchestrator` 是 Electron 主进程中的遗留 TypeScript 类，不是独立进程，也不是 HTTP 服务。它的实现仍保留在仓库中，但 [agent-service.ts](../apps/electron/src/main/lib/agent-service.ts) 已不再创建或调用它。其旧职责包括：

- 同一会话的并发守卫和运行状态。
- 渠道、API Key、代理、Shell 和工作区运行环境构建。
- Pi Adapter 查询、事件遍历和错误重试。
- 用户/助手消息持久化以及标题生成。
- 权限模式、AskUser、ExitPlan 和工具事件。
- `stop`、`queueMessage`、`updateSessionPermissionMode` 和 `rewindSession`。
- Memory 自动捕获和部分运行时资源清理。

`agent-service.ts` 现在是 RPC gateway 的 IPC/外部调用薄包装，负责将 Rust Worker 的 SSE 事件转为 EventBus 和 `webContents.send()`。

### 2.2 已经走 Pi Worker RPC 的 UI 发送链路

Preload 中 `sendAgentMessage()` 对 `agentRuntime === 'pi'` 直接调用 `agentHttpStreamClient.send()`。由于当前 `AgentRuntime` 类型已经只有 `'pi'`，以下普通发送入口不会进入 `AGENT_IPC_CHANNELS.SEND_MESSAGE`：

| UI 入口 | 当前调用 | 实际执行链路 | 是否进入 AgentOrchestrator |
| --- | --- | --- | --- |
| `AgentConversationSurface` 普通发送、重试、压缩 | `window.electronAPI.sendAgentMessage()` | HTTP SSE -> Rust -> Pi Worker | 否 |
| `WelcomeComposer` 首条消息 | `window.electronAPI.sendAgentMessage()` | HTTP SSE -> Rust -> Pi Worker | 否 |
| `WebBrowserSurface` 网页 Agent 消息 | `window.electronAPI.sendAgentMessage()` | HTTP SSE -> Rust -> Pi Worker | 否 |
| 浏览器模式 HTTP bridge | `agentHttpStreamClient.send()` | `/api/agent/.../messages` | 否 |

Rust 在 `/api/agent/sessions/:id/messages` 路由中调用 Electron internal `prepare`，由 `agent-rpc-service.ts` 构建 Worker 配置；Rust 随后直接启动 Pi Worker 并转发 SSE。

### 2.3 UI 兼容入口迁移状态

| UI 入口 | 旧 API | 现有调用位置 | 迁移判断 |
| --- | --- | --- | --- |
| 活跃 Agent 追加消息 | `queueAgentMessage()` -> 本地 HTTP `/queue` -> Pi Worker | `AgentConversationSurface.tsx` | 已迁移；Skill、MCP、会话、待办和日程引用由 RPC prepare 统一处理 |
| 会话快照回退 | `rewindSession()` -> `agent-session-rewind-service` | `AgentConversationSurface.tsx` | 已从 Orchestrator 提取为独立服务，不进入 Worker |
| 运行中权限模式切换 | `updateSessionPermissionMode()` -> Rust internal policy control | `PermissionModeSelector.tsx` | 已迁移；内部令牌接口由 Rust 向 Worker 下发 `set_permission_mode`，仅在命令写入成功后更新文件策略；Pi 不接收策略或内部令牌 |
| 停止 Agent | `stopAgent()` -> Rust `/stop` | `AgentConversationSurface`、`WelcomeComposer`、`AskUserBanner`、`PermissionBanner`、`ExitPlanModeBanner` | 已迁移；停止接口幂等，不存在旧 Orchestrator fallback |
| 生命周期状态与批量停止 | Rust `PiWorkerManager` status / `stop-all` | 托盘、更新器、项目删除、自动任务和 Bridge | 已迁移；Electron 不再维护 `activeSessions` 镜像，全部异步查询或命令 Pi Worker |

以下接口仍暴露在 Preload/IPC 中，但当前没有发现 renderer 生产代码直接调用 `generateAgentTitle()`。Pi Worker 路径已经由 `agent-rpc-service.finalizeAgentRpcRun()` 生成回退标题；旧 `GENERATE_TITLE` 可以在调用方审计后删除或转为统一标题服务。

### 2.4 非 UI 调用方

以下主进程服务仍通过 `agent-service.ts` 使用 `runAgentHeadless()` 或 `stopAgent()`，但其实现已统一委托给 `AgentRpcGateway`，不会调用 `AgentOrchestrator`：

- `automation-scheduler.ts`：定时任务执行。
- `bridge-command-handler.ts`：微信、钉钉等 Bridge 命令。
- `feishu-bridge.ts`：飞书消息和会话镜像。
- `main/index.ts`、`tray.ts`：应用退出、更新和托盘生命周期检查。
- `http-api-handler.ts`：Electron 业务桥仍保留 Agent facade；Rust 直接处理 Agent SSE 路由时不会走普通 bridge，但 fallback 路径仍需单独审计。

## 3. 目标架构

### 3.1 职责拆分

迁移不是把整个 `AgentOrchestrator` 原样搬到 Rust，而是按职责拆分：

| 目标模块 | 职责 |
| --- | --- |
| `agent-rpc-service.ts` | 准备单轮 Worker 配置、凭证、上下文、Memory、Skill/MCP mention、消息持久化和完成收尾 |
| Rust `PiWorkerManager` | 会话到 Worker 的生命周期、并发守卫、stop、queue/control 命令和运行状态 |
| `pi-rpc-worker.ts` | Pi Adapter 查询、连续 turn、队列注入、软中断、权限控制和事件输出 |
| `agent-session-manager.ts` | 会话元数据、SDK JSONL、resume 信息和持久化一致性 |
| 新的 `agent-session-rewind-service.ts` | 回退前置校验、Pi session artifact 回退、JSONL 截断和工作区冲突检查 |
| `agent-external-run-service.ts` 或等价 gateway | 自动化、Bridge、飞书等无 UI 调用方的统一执行入口；不得再直接依赖 `AgentOrchestrator` |

如果实现过程中发现某个模块只承担单一职责，可以优先复用现有 `agent-rpc-service.ts` 或 `agent-session-manager.ts`，不要为了迁移机械新增多层 facade。

### 3.2 Worker 控制协议

现有协议只有 `run` 和 `stop`。在实现队列迁移前，需要扩展为结构化 JSONL 命令，至少包含：

```text
run
stop
queue
set_permission_mode
```

`queue` 必须支持：

- `sessionId`、用户消息 UUID、原始文本和 SDK 文本。
- `interrupt` 软中断标志。
- `mentionedSkills`、`mentionedMcpServers`、会话/待办/日程引用。
- Worker 内部对 mention 做与普通 run 相同的 prompt 注入。
- UUID 防重，失败时可判断消息是否已被 Worker 接收。

Worker 当前在一次 `query()` 完成后发送 `complete` 并退出进程。迁移队列时必须先定义连续 turn 语义：

1. Worker 在当前 turn 结束前收到 queue 命令时，继续消费队列，不提前向 UI 发最终 complete。
2. 没有后续队列时才发送本轮最终 complete 并退出，或采用明确的 `turn_complete` / `run_complete` 两级帧。
3. 不能让 UI 已经进入 idle 后又收到没有对应 running 状态的追加事件。
4. Rust 连接关闭、Worker 崩溃和队列请求超时都要产生唯一的 error/complete 终态。

权限模式的实际执行权属于 Rust。Pi Worker 的命令只同步 `plan_mode_changed` UI 状态，不携带可读根、可写根或内部令牌；所有 Read/Edit/Write 都必须经 Rust 的会话文件 capability 和工作区策略校验。`set_permission_mode` 先由 Rust 验证并写入 Worker stdin，成功后才更新 Rust 文件策略，避免 UI 与文件权限状态分叉。

### 3.3 UI 控制 API

保留 `window.electronAPI` 作为渲染层稳定接口，内部统一改为 HTTP/RPC。建议新增或调整以下本地 API：

| 方法 | 作用 | 事件来源 |
| --- | --- | --- |
| `POST /api/agent/sessions/:id/messages` | 新回合，现有接口 | 当前 SSE 连接 |
| `POST /api/agent/sessions/:id/queue` | 活跃回合追加消息，返回接受 UUID | 当前 Worker SSE 连接 |
| `POST /api/agent/sessions/:id/stop` | 幂等停止 | 当前 SSE 连接发送 complete/error |
| `GET /api/agent/sessions/:id/status` | 查询 `Running` / `Stopping` Worker 生命周期 | Rust `PiWorkerManager` 快照 |
| `GET /api/agent/workers/status` | 查询所有活跃 Worker 会话 | Rust `PiWorkerManager` 快照 |
| `POST /api/agent/workers/stop-all` | 应用退出前批量停止 | Rust 逐个向 Worker stdin 发送 stop |
| `POST /api/internal/agent/files/permission-mode` | 内部令牌授权的权限热切换 | Worker SSE 发送 `plan_mode_changed`；Rust 更新文件策略 |
| `POST /api/agent/sessions/:id/rewind` | 可选 HTTP facade；第一阶段也可继续走 IPC 独立服务 | 普通 JSON 响应 |

队列 API 不应另开一条 UI 流来消费事件；同一会话的事件必须由 Worker 的主 SSE 流统一输出，避免两个 reader 竞争同一个会话事件。

## 4. 分阶段实施计划

### Task 0：建立调用契约和迁移保护（部分完成）

**目标：** 先锁定现状和旧入口，防止迁移过程中出现双执行。

**涉及文件：**

- `apps/electron/src/main/lib/agent-rpc-protocol.ts`
- `apps/electron/src/main/lib/agent-rpc-service.ts`
- `native/http-api-server/src/pi_rpc.rs`
- `native/http-api-server/src/main.rs`
- `apps/electron/src/preload/index.ts`
- `apps/electron/src/main/ipc.ts`

**工作：**

1. 增加 Worker 命令和帧的 contract 测试，覆盖未知命令、缺少 sessionId、错误终态和重复 UUID。
2. 为 `AgentSendInput`、队列输入和控制输入明确 `agentRuntime: 'pi'`，避免旧 runtime 分支重新出现。
3. 增加会话运行来源标识，例如 `rpc-worker` / `legacy-orchestrator`，仅用于日志和诊断，不改变持久化协议。
4. 为 stop、complete、queue 定义幂等规则，确保 HTTP 重试不会重复停止或重复保存用户消息。

**本轮完成：** Worker 协议增加 `queue` 命令及解析测试；Rust 增加 `/api/agent/sessions/:id/queue` 路由；Electron internal bridge 负责 RPC 配置准备；Preload 和浏览器 HTTP bridge 统一调用 HTTP 队列接口。重复 UUID 由 `agent-rpc-service` 去重 JSONL 持久化，并由 Worker 接收器去重 Pi 注入；首次 Pi 注入失败会释放 UUID 以允许同 UUID 重试。

**BDD：**

```text
Given 一个 Pi Worker 会话已经启动
When 同一个 queue UUID 被请求两次
Then 只持久化一次用户消息，并返回同一个接受结果

Given 一个会话由 RPC Worker 运行
When 旧 IPC SEND_MESSAGE 被意外触发
Then 不得同时启动 AgentOrchestrator，调用方得到明确的 legacy path 错误或被统一路由到 RPC
```

### Task 1：扩展 Worker 为连续 turn 和控制命令（部分完成）

**目标：** 替代 `AgentOrchestrator.queueMessage()`、`stop()` 和运行中权限状态。

**涉及文件：**

- `native/http-api-server/src/pi_rpc.rs`
- `native/http-api-server/src/main.rs`
- `apps/electron/src/main/pi-rpc-worker.ts`
- `apps/electron/src/main/lib/agent-rpc-protocol.ts`
- `apps/electron/src/main/lib/adapters/pi-agent-adapter.ts`
- 新增或拆分 Worker 控制测试

**工作：**

1. 实现 `queue`、`set_permission_mode` 命令，并增加命令发送的 session 校验。
2. 将 Worker 的单次 `runWorker()` 改为可控制的连续 turn 生命周期，明确最终 complete 的发送时机。
3. 复用 `PiAgentAdapter.sendQueuedMessage()`、`interruptQuery()` 和 `setPermissionMode()` 的既有语义；不能在 Worker 中重新实现一套 mention 或消息持久化逻辑。
4. Worker 只输出结构化 stdout；诊断日志继续写 stderr。
5. Rust manager 维护 Worker 状态和 session 映射，应用退出时向所有 Worker 发送 stop 并等待有限时间后清理。

**本轮完成：** `queue` 通过现有 `PiAgentAdapter.sendQueuedMessage()` 注入同一 Pi session，支持 `interrupt` 和 Skill mention。运行中权限模式由 Rust 保存的 `AgentFilePolicyStore` 原子更新，后续 Read/Edit/Write 均重新按该策略校验；Pi 不持有或修改权限策略。

**BDD：**

```text
Given 一个 Pi Worker 正在输出当前 turn
When UI 发送带 /automation mention 的 queue 请求
Then Worker 接受消息，沿用 mention prompt 注入，并继续从同一 Pi session 执行

Given queue 请求携带 interrupt=true
When Worker 收到 queue 命令
Then 先软中断当前 turn，再按顺序执行追加消息，不创建第二个 Worker

Given 一个 Worker 正在运行
When UI 发送 stop
Then Worker 只产生一个 stopped complete，Rust manager 删除 session 映射
```

### Task 2：迁移 AgentConversationSurface 的队列路径（完成）

**目标：** 让 UI 中最容易触发 Skill 不识别的追加消息路径进入 RPC Worker。

**涉及文件：**

- `apps/electron/src/renderer/components/agent/AgentConversationSurface.tsx`
- `apps/electron/src/preload/index.ts`
- `apps/electron/src/renderer/lib/agent-http-stream.ts`
- `apps/electron/src/renderer/lib/http-api-bridge.ts`
- `apps/electron/src/main/lib/agent-rpc-service.ts`
- `native/http-api-server/src/main.rs`

**工作：**

1. 将 `queueAgentMessage()` 的 Electron IPC 实现改为本地 HTTP queue API。
2. 保留当前 UI 的乐观用户消息、失败回滚和 UUID 传递。
3. 将 Skill、MCP、session、todo、calendar event mention 全部传入 RPC；普通发送和 queue 必须使用同一 `buildMentionedToolsPrompt()` 规则。
4. queue 失败时只回滚尚未被 Worker 接收的消息；收到确认后即使流随后失败也不能重复发送。
5. 统一 `useGlobalAgentListeners` 对 HTTP 和 IPC 事件的处理，不让同一个 RPC 事件同时走两次 listener。

**验收：**

- 空闲会话普通 `/skill` 调用仍可用。
- 运行中输入 `/skill`，Skill mention 到达同一个 Pi Worker，并在 Worker prompt 中可见。
- `interrupt`、引用会话、引用待办和引用日程行为与现有 Orchestrator 路径一致。

### Task 3：迁移停止、权限和运行状态（完成）

**目标：** 去掉 UI 对 `isAgentSessionActive()` 和 Orchestrator active map 的隐式依赖。

**涉及文件：**

- `apps/electron/src/renderer/components/agent/PermissionModeSelector.tsx`
- `apps/electron/src/renderer/components/agent/AgentConversationSurface.tsx`
- `apps/electron/src/renderer/components/agent/AskUserBanner.tsx`
- `apps/electron/src/renderer/components/agent/PermissionBanner.tsx`
- `apps/electron/src/renderer/components/agent/ExitPlanModeBanner.tsx`
- `apps/electron/src/preload/index.ts`
- `apps/electron/src/main/lib/agent-rpc-service.ts`
- `native/http-api-server/src/main.rs`
- `native/http-api-server/src/pi_rpc.rs`

**工作：**

1. `stopAgent()` 只调用 Rust RPC stop，停止接口幂等；不保留 Orchestrator 或 IPC fallback。
2. `PiWorkerManager` 维护 `Running` / `Stopping` 快照和会话映射，并提供会话状态、全量状态和 `stop-all` HTTP 端点；Electron 不再维护 `activeSessions`。
3. 实现 `set_permission_mode` Worker 控制命令。Rust 在命令写入后更新 Rust 文件策略，Worker 仅输出 `plan_mode_changed`，Pi 不获取策略对象或内部令牌。
4. 对 AskUser/Permission/ExitPlan 现有 UI 做路径审计。若 RPC Worker 当前不能安全等待 UI 响应，必须先明确采用 `bypassPermissions` 或新增 Worker 控制通道，不能静默丢掉请求。

**本轮完成：** 托盘、自动更新、项目删除、自动任务、Bridge、回退保护和应用退出均通过 Rust Pi Worker 查询状态或下发命令。应用退出先完成 `stop-all`，再关闭 Rust HTTP API，避免停止命令因关闭顺序丢失。

### Task 4：将回退逻辑从 AgentOrchestrator 提取（完成）

**目标：** 保留快照回退能力，但让它不再依赖 AgentOrchestrator 的 active map 或 adapter。

**涉及文件：**

- 新增 `apps/electron/src/main/lib/agent-session-rewind-service.ts`
- `apps/electron/src/main/lib/agent-orchestrator.ts`
- `apps/electron/src/main/lib/agent-service.ts`
- `apps/electron/src/main/ipc.ts`
- `apps/electron/src/renderer/components/agent/AgentConversationSurface.tsx`
- 现有 `agent-session-manager` 回退测试

**工作：**

1. 把本地项目根校验、同项目并发检查、Pi session artifact 回退和 JSONL 截断移入独立服务。
2. 运行状态由 RPC Worker manager 或统一 Agent run registry 提供；运行中回退仍然拒绝。
3. 回退操作保持当前结果格式、消息数量和文件回退错误说明。
4. `agent-service.rewindAgentSession()` 改为调用新服务，确认没有其他 Orchestrator 依赖后删除该 wrapper。

**本轮完成：** 新服务保留项目根、运行冲突和 artifact 回退校验；成功后才截断 SDK JSONL。`AgentOrchestrator.rewindSession()` 仅保留薄委托，`agent-service` 已改为直接使用该服务。

### Task 5：统一标题、消息持久化和 Memory 收尾

**目标：** 确保迁移后新旧运行时不会产生两种持久化口径。

**涉及文件：**

- `apps/electron/src/main/lib/agent-rpc-service.ts`
- `apps/electron/src/main/lib/agent-session-manager.ts`
- `native/http-api-server/src/main.rs`
- `apps/electron/src/main/lib/agent-orchestrator.ts`
- `apps/electron/src/renderer/hooks/useGlobalAgentListeners.ts`

**工作：**

1. 以 `agent-rpc-service` 为 Pi Worker 的唯一消息持久化入口，过滤 partial/replay 消息规则保持一致。
2. 统一 Worker complete 和旧 EventBus complete 的 `stoppedByUser`、result subtype、error 数组和 startedAt。
3. 保留 RPC 路径的 Memory 自动捕获和超过上下文阈值后的维护调度，不因删除 Orchestrator 而丢失记忆整理。
4. 删除 renderer 对 `generateAgentTitle` 的无效调用；标题生成统一使用 RPC 完成收尾的 fallback 或独立标题服务。

### Task 6：迁移自动化和外部 Bridge

**目标：** 在 UI parity 完成后，迁移所有主进程外部调用方，最终解除 `AgentOrchestrator` 的生产依赖。

**涉及文件：**

- `apps/electron/src/main/lib/automation-scheduler.ts`
- `apps/electron/src/main/lib/bridge-command-handler.ts`
- `apps/electron/src/main/lib/feishu-bridge.ts`
- `apps/electron/src/main/lib/http-api-handler.ts`
- 新增统一 `agent-external-run-service.ts` 或等价 gateway
- EventBus/Bridge 事件适配测试

**工作：**

1. 自动化任务使用统一 RPC gateway，继续支持 automation context、workspace、model、memory policy 和完成通知。
2. 微信/钉钉 Bridge 和飞书 Bridge 通过 `agent-service` 暴露的统一 gateway 订阅 Worker 事件，不再依赖 Orchestrator EventBus 语义。
3. 外部调用必须保留 source、originSessionId、session title、workspace 和错误回调。
4. 处理应用重启和旧任务恢复：运行中的外部任务标记 interrupted，不能因为迁移重复执行。
5. `http-api-handler` 只保留业务 API facade 和 internal RPC persistence，不再把 `/api/agent` fallback 指向 `agent-service.runAgentHeadless`。

**本轮完成：** 新增 `AgentRpcGateway`，自动化、微信/钉钉 Bridge、飞书 Bridge、旧 IPC 兼容入口和 `http-api-handler` 的 headless facade 都经过 Rust `/api/agent` SSE、queue 与 stop 路由。gateway 将 Worker 事件回放到既有 EventBus；Rust 对每个 Worker 生成文件 capability，Pi 只持有该会话 token，不能调用管理权限接口。

### Task 7：删除 AgentOrchestrator 和旧 IPC

**前置条件：** `rg` 审计确认没有生产调用方，Task 0-6 的 focused tests 和构建全部通过。

**删除或收缩：**

- `apps/electron/src/main/lib/agent-orchestrator.ts` 中仅用于旧执行链路的代码。
- `apps/electron/src/main/lib/agent-service.ts` 的 `runAgent`、`runAgentHeadless`、`queueAgentMessage`、`updateAgentPermissionMode` 和旧 stop wrapper。
- `AGENT_IPC_CHANNELS.SEND_MESSAGE`、`QUEUE_MESSAGE` 及其 Preload/IPC handler，保留仍有实际消费者的会话管理通道。
- `agent-service` 对 EventBus 到 `webContents` 的旧转发逻辑，改由 RPC stream listener 和外部 gateway 承担。
- `main/index.ts`、`tray.ts` 中只针对 Orchestrator active map 的生命周期检查，替换为统一 Worker registry。

删除前必须再次确认：

```bash
rg -n "AgentOrchestrator|agent-service|runAgentHeadless|runAgent\(|queueAgentMessage|updateAgentPermissionMode|AGENT_IPC_CHANNELS\.(SEND_MESSAGE|QUEUE_MESSAGE)" apps packages native
```

搜索结果允许存在迁移文档、测试说明和兼容日志，但不允许存在未计划的生产调用。

## 5. 测试与验收计划

### 5.1 TypeScript/Bun BDD 场景

至少覆盖以下行为：

```text
Given 普通 Pi 会话
When UI 发送包含 /skill、#mcp、&session、&todo、&calendar_event 的消息
Then RPC prepare 保留所有 mention，并且 Worker prompt 使用统一注入规则

Given Pi Worker 正在运行
When UI 追加一条 Skill mention 消息
Then 消息进入同一个 Worker，不经过 AgentOrchestrator，不重复持久化

Given Pi Worker 正在运行
When UI 点击停止
Then HTTP stop 可幂等完成，UI 收到一次 stopped complete，旧 IPC fallback 不会启动第二个运行时

Given Pi Worker 已结束
When UI 请求回退
Then 回退服务检查 session artifact、截断 JSONL，并返回现有 RewindSessionResult 结构

Given 自动化、飞书或 Bridge 触发 Agent
When RPC Worker 执行完成或失败
Then 外部回调、标题、事件和运行记录与旧 Orchestrator 链路一致
```

建议测试文件：

- `apps/electron/src/main/lib/agent-rpc-protocol.test.ts`
- `apps/electron/src/main/lib/agent-rpc-service.test.ts`
- `apps/electron/src/main/lib/agent-session-rewind-service.test.ts`
- `apps/electron/src/renderer/lib/agent-http-stream.test.ts`
- `apps/electron/src/renderer/components/agent/AgentConversationSurface.test.tsx`
- `native/http-api-server/src/main.rs` 和 `native/http-api-server/src/pi_rpc.rs` 的 Rust tests
- 自动化、Bridge、飞书的 focused contract tests

### 5.2 必须执行的验证

```bash
bun run typecheck
bun run --filter='@copis/electron' build:main
bun run --filter='@copis/electron' build:preload
bun run --filter='@copis/electron' build:agent-rpc-worker
bun run --filter='@copis/electron' build:renderer
bun test apps/electron/src/main/lib/agent-rpc-protocol.test.ts
bun test apps/electron/src/main/lib/agent-rpc-service.test.ts
bun test apps/electron/src/main/lib/agent-session-rewind-service.test.ts
bun test apps/electron/src/renderer/lib/agent-http-stream.test.ts
cargo test --manifest-path native/http-api-server/Cargo.toml
git diff --check
```

涉及网页页签或原生 WebContentsView 时，沿用仓库现有测试约束，两个会 mock `config-paths` 的 Bun 测试文件分开进程执行。

### 5.3 Electron 实际窗口验收

自动化验证完成后，必须由用户在实际 Electron 窗口确认以下场景；不能用 Chrome、截图或仅验证主渲染进程 DOM 代替：

1. 新会话发送普通消息并使用 `/` 选择 Skill。
2. Agent 输出期间追加一条 `/skill` 消息，确认 Skill 在同一会话中执行。
3. 使用 interrupt、停止、权限模式切换和重新发送。
4. 回退到历史 assistant 消息，再发送下一轮消息。
5. 创建自动化任务，并通过飞书/Bridge 入口验证非 UI 运行（如当前环境已配置）。

## 6. 发布顺序、兼容与回滚

### 6.1 发布顺序

1. 先发布 Worker protocol、队列控制和 RPC focused tests，不删除旧 Orchestrator。
2. 发布 UI queue/stop/permission migration，旧 IPC 只作为临时 fallback。
3. 发布独立 rewind service，确认 Agent 对话功能完整。
4. 发布 automation/Bridge gateway，确认外部入口无 direct Orchestrator import。
5. 保留一个版本周期的 legacy diagnostic flag 或 runtime fallback，收集失败日志后再删除旧执行链路。
6. 最后删除旧 IPC 和 `AgentOrchestrator`，递增受影响包的 patch version。

### 6.2 回滚规则

- Worker 启动失败：返回明确的 `pi_worker_unavailable`，不得回退到旧执行链路。
- queue 请求超时：不能无条件重试；先通过 UUID/Worker ack 判断是否已接收，避免重复执行。
- Worker complete 已发送后出现 persistence 错误：UI 进入终态，错误写入诊断日志，不能再次启动 Orchestrator 补跑。
- 迁移期间任何旧 fallback 都必须记录 `legacy-orchestrator` 来源，便于确认是否仍有生产调用。
- 删除旧代码前发现外部调用方未迁移，应暂停删除 Task 7，而不是保留隐式双路由。

## 7. 完成标准

迁移只有同时满足以下条件才算完成：

- renderer 生产代码的普通发送、队列、停止和运行中权限控制不再依赖 `AgentOrchestrator`。
- 回退能力由独立会话服务提供，不依赖 Orchestrator active map。
- 自动化、飞书、微信/钉钉 Bridge 已通过统一 gateway 运行。
- `AgentOrchestrator` 不再是 Pi 用户请求的必经路径；`agent-service` 仅保留 IPC、事件桥接和外部 gateway 包装，不执行 Pi SDK。
- Skill/MCP/session/todo/calendar mention 在普通发送和队列发送中都能到达 Pi Worker。
- 同一会话没有重复 Worker、重复 complete 或重复消息持久化。
- TypeScript、Rust、focused BDD 测试和构建全部通过。
- 用户完成实际 Electron 窗口验收，确认普通发送、队列 Skill、停止、权限和回退行为。
