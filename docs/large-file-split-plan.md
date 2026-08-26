# 大文件拆分方案（Top 5）

> 状态：**仅方案设计，未改动任何代码**。
> 范围：仓库中行数最多的 5 个文件。

| # | 文件 | 行数 | 现状摘要 |
|---|------|------|----------|
| 1 | `apps/electron/src/main/ipc.ts` | 5275 | 单文件注册 **342 个** `ipcMain.handle`，import 了 60+ 个服务模块 |
| 2 | `native/http-api-server/src/main.rs` | 3697 | 手写 HTTP server：请求解析、路由分发、memory/automation/expert-team/browser-recording/agent-stream 全部内联 |
| 3 | `apps/electron/src/renderer/components/agent/AgentConversationSurface.tsx` | 3141 | 单组件承载发送/重试/rewind/fork/队列/附件/拖拽/模型切换等 40+ 个 handler |
| 4 | `apps/electron/src/main/lib/agent-orchestrator.ts` | 2788 | `sendMessage()` 一个方法约 1800 行（801→2594），含重试、标题、持久化、事件流 |
| 5 | `apps/electron/src/preload/index.ts` | 2745 | 一个巨型 `electronAPI` 对象字面量，30+ 个注释分节 |

所有方案遵循现有架构约定（AGENTS.md 的 IPC 四层模式、Rust 测试文件分离规则、BDD 回归命令），并保持对外公共 API 不变，可逐文件灰度迁移。

---

## 方案 1：`main/ipc.ts` → 按业务域拆分的 IPC 注册器

**目标结构**：

```
apps/electron/src/main/ipc/
├── index.ts                 # 唯一入口：registerAllIpcHandlers(mainWindow)，只做聚合
├── context.ts               # 共享上下文：mainWindow 引用、appState getter 等传参封装
├── runtime.ipc.ts           # IPC_CHANNELS：运行时、Git、环境检查、代理设置
├── conversations.ipc.ts     # CHANNEL_IPC_CHANNELS + ATTACHMENT_IPC_CHANNELS + STORAGE_IPC_CHANNELS
├── agent-sessions.ipc.ts    # AGENT_IPC_CHANNELS：会话 CRUD、消息历史、后台任务、队列
├── agent-workspace.ipc.ts   # 工作区、MCP、Skills、权限、AskUser、ExitPlan、Agent 工具管理
├── agent-files.ipc.ts       # Agent 文件系统操作 + Scratch Pad
├── chat-tools.ipc.ts        # AGENT_TOOL_IPC_CHANNELS / CHAT_TOOL 相关
├── web-tabs.ipc.ts          # WEB_IPC_CHANNELS + BOOKMARKS（954-1032 行整段平移）
├── browser-workflow.ipc.ts  # BROWSER_WORKFLOW_IPC_CHANNELS（1034-1116 行）
├── working.ipc.ts           # WORKING_IPC_CHANNELS 登录/订单/支付/模型目录（1117 行起的大段）
├── integrations.ipc.ts      # 飞书 / 钉钉 / 微信 / Agent Mail
├── memory.ipc.ts            # MEMORY_IPC_CHANNELS + 知识库摄取
├── automation-planning.ipc.ts # AUTOMATION + PLANNING
└── misc.ipc.ts              # 用户档案、设置、教程、图标、Dock、快速任务、语音、菜单
```

**关键设计**：

- 每个模块导出 `register(ctx: IpcContext): void`，内部只调 `ipcMain.handle`；不引入新抽象层，handler 体原样搬移。
- 跨模块共享的状态（如 mainWindow、单例 service）通过 `context.ts` 显式传递，避免循环 import。
- `ipc.ts` 顶部 800+ 行的 import type 随各域分散到对应文件。
- macOS AppKit 相关代码（833 行附近）单独放 `macos-extra.ts` 并用平台守卫。

**迁移顺序**（每步独立可验证）：先建骨架搬 webTabs（最独立）→ browserWorkflow → working（最大块）→ 其余按域。最后 `index.ts` 收口，旧 `ipc.ts` 删除。

**验证**：`bun run typecheck` + `bun run --filter='@copis/electron' build:main` + 启动 dev 手工回归核心链路。

---

## 方案 2：`http-api-server/src/main.rs` → 按 router 模块拆分

`handle_connection()`（1517 行起，约 560 行的路由 if-chain）是核心问题，其余是各域 handler 与工具函数混在一起。

**目标结构**：

```
native/http-api-server/src/
├── main.rs               # 只保留 main() + server 启动 + TcpListener accept 循环
├── http/                 # 通用 HTTP 层
│   ├── mod.rs
│   ├── request.rs        # read_http_request / read_chunked_body / parse_query_parameters
│   ├── response.rs       # send_json_response / send_response / reason_phrase / SSE frame
│   └── encoding.rs       # encode_hex / decode_hex / escape_json_string / find_subslice
├── router.rs             # handle_connection 的路由判定逻辑，按 path 前缀分发到各 route 模块
├── auth.rs               # internal/web token 校验、origin 白名单、is_private_auth_bridge_path
├── routes/
│   ├── mod.rs
│   ├── memory.rs         # handle_memory_route 及其解析/响应辅助（逻辑已在 memory.rs，这里只留路由壳）
│   ├── workspace.rs      # workspace mcp/skills/dev 三类路由判定与转发
│   ├── automation.rs     # handle_automation_route / prepare-run 内部桥
│   ├── expert_team.rs
│   ├── agent_stream.rs   # handle_agent_stream / handle_agent_queue / build_prepare_body / bridge responses
│   ├── recording.rs      # browser recording 全套（parse_internal_recording_route ~ append_recording_line）
│   ├── agent_files.rs    # handle_internal_agent_files/shell/alipay_bot/agent_mail 四个内部端点
│   └── working.rs        # skill market / payment / model 路由 + parse_auth_working_response
└── paths.rs              # resolve_memory_directory / resolve_config_directory 等
```

**关键设计**：

- 路由判定函数（`is_working_model_route`、`is_workspace_*_route` 等）与 handler 成对放进同一模块，`router.rs` 只做一次线性 match，消除 main.rs 里散落的布尔判定。
- `Bridge` 共享状态通过 `Arc` 参数显式传入各 route 函数（现有风格已是函数式，保持不变）。
- 测试遵循仓库规则：`routes/recording.rs` ↔ `routes/recording_test.rs` 同目录同名，不在生产文件内嵌 `#[cfg(test)]`。

**迁移顺序**：先抽无依赖的 `http/` 和 `paths.rs` → 抽 `auth.rs` → 逐域抽 routes，每抽一个域跑 `cargo check` + `cargo test`。

---

## 方案 3：`AgentConversationSurface.tsx` → 自定义 Hooks 分层拆分

纯展示+交互组件，问题在于所有交互逻辑都堆在一个函数体里（256–3100 行全是 hooks 和 handler）。拆法不是切子组件，而是把逻辑抽成自定义 hooks，组件本体保留 JSX 编排。

**目标结构**：

```
apps/electron/src/renderer/components/agent/conversation/
├── useAgentAttachments.ts      # 附件：上传/粘贴(1623)/拖拽(1661-1810)/编辑完成/剪贴板预览/长文本
├── useAgentModelSelect.ts      # 模型选择(1812)、高级授权(1908)、Codex fast mode(1927)
├── useAgentSend.ts             # 发送(1958)/停止(2186)/compact(2209)——最核心的一条链
├── useAgentRetry.ts            # 重试(2329)/新会话重试(2392)/错误复制
├── useAgentHistoryOps.ts       # fork(2439)/rewind(2479-2577)
├── useAgentQueue.ts            # 队列消息：立即发送/召回/移除/移动(2578-2633+)
├── useAgentProjectRoot.ts      # relink/restore project root(2298-2328)
├── useReplyTodo.ts             # 回复创建 TODO(531-539)
├── message-utils.ts            # 顶层纯函数：createUserSDKMessage/getUserTextFromSDKMessage/
│                               #   removeRetriedErrorSDKMessage/resolveRunContextWindow 等(159-248)
│                               #   → 纯函数可直接补单测
└── AgentConversationSurface.tsx # 原路径 re-export，组件缩到 ~600 行 JSX 编排
```

**关键设计**：

- hooks 之间通过参数传递共享 state（如 `messages`、`streamState`），不新建全局 atom，避免改变 Jotai 数据流。
- `message-utils.ts` 是零风险第一步：纯函数外移 + 补 bun:test 单测，行为完全不变。
- 保持 `AgentConversationSurfaceProps` 和 `variant = 'main' | 'browser'` 导出签名不变，`browser` variant 的调用方（Browser Agent）不受影响。
- 已有 `AgentConversationSurface.shortcut.test.ts` 作为回归基线。

**迁移顺序**：message-utils → attachments → queue/history ops → send/retry（最耦合的放最后）。

**验证**：`bun run typecheck` + `bun test apps/electron/src/renderer/components/agent/`；UI 层交互与视觉由用户在 Electron 实际窗口中确认（不使用截图代替）。

---

## 方案 4：`agent-orchestrator.ts` → 把 `sendMessage` 大方法分解为协作单元

`sendMessage()` 约 1800 行，是全仓库最大的单方法。它混合了：并发守卫、渠道解密、Pi 环境构建、自动重试循环、事件流累积、错误映射、标题生成、持久化。类只有 10 个方法，说明职责全压进了这一个方法。

**目标结构**（保持 `AgentOrchestrator` 公共 API 完全不变）：

```
apps/electron/src/main/lib/orchestrator/
├── mod.ts                        # re-export AgentOrchestrator，外部 import 路径不变
├── orchestrator.ts               # AgentOrchestrator 类瘦身后 ~400 行：编排各步骤
├── retry-policy.ts               # AUTO_RETRYABLE_ERROR_CODES/MAX_AUTO_RETRIES/getRetryDelayMs/
│                                 #   isAutoRetryable* 判定（191-258 行纯逻辑，直接可测）
├── error-mapper.ts               # extractApiError/errorMessageOf/isMissingActiveQueueChannelError +
│                                 #   网络/供应商/上下文/权限错误统一映射
├── title-generator.ts            # generateTitle + isDefaultSessionTitle + 剥离飞书/微信/钉钉信封
├── stream-accumulator.ts         # Pi 事件流 → 文本/工具调用/压缩事件的累积状态机
├── send-context-builder.ts       # collectAttachedDirectories/buildPiAdditionalDirectoriesPrompt/
│                                 #   escapePromptXml（295-373 行，纯函数）
└── types.ts                      # SessionCallbacks 等接口
```

**关键设计**：

- `sendMessage` 改写为步骤序列：`buildContext → acquireGuard → runWithRetry(streamAccumulator) → persistAndEmit → maybeGenerateTitle`，每步是 orchestrator 目录下的一个函数或小类。
- 重试策略（`retry-policy.ts`）和错误映射是最值得先抽的两块——它们是纯逻辑，抽出即可补单测，覆盖 25 次自动重试上限、退避延迟、partial message 处理这些目前最难测的行为。
- 不改 `agent-service.ts` 及 IPC 层的任何调用方式；`SessionCallbacks` 接口原样保留。

**迁移顺序**：retry-policy + error-mapper（带测试）→ title-generator → stream-accumulator → 最后重组 sendMessage 本体。

**验证**：`bun run typecheck` + 为 retry-policy/error-mapper 新增 bun:test + 现有 agent 相关测试全量跑一遍。

---

## 方案 5：`preload/index.ts` → 按域组合 API 分片

结构与 ipc.ts 同构：一个巨型对象字面量，30 个 `// ===== xxx =====` 注释节。preload 有 contextIsolation 约束不能动态生成，但可以静态组合多个分片对象。

**目标结构**：

```
apps/electron/src/preload/
├── index.ts                  # 组装：const electronAPI = { ...runtimeApi, ...webTabsApi, ... }
├── shared/ipc-invoke.ts      # 统一 invoke 封装与类型 helper（消除各片重复样板）
├── api/
│   ├── runtime.ts            # 运行时/通用工具/环境检测/窗口控制
│   ├── web-tabs.ts           # webTabs + bookmarks（282-350 两段合并为一个命名空间）
│   ├── browser-workflow.ts
│   ├── channels.ts           # 渠道管理
│   ├── conversations.ts      # 会话/附件/存储统计/ScratchPad
│   ├── agent.ts              # Agent 会话/队列/后台任务/工作区/MCP/Skills/权限/AskUser/ExitPlan/工具
│   ├── agent-files.ts        # Agent 文件系统操作 + 附件
│   ├── integrations.ts       # 飞书/钉钉/微信/AgentMail
│   ├── working.ts            # Copis Working 后端
│   ├── memory.ts
│   ├── automation-planning.ts
│   └── misc.ts               # 教程/档案/设置/图标/Dock/快速任务/语音/菜单/数据迁移/updater
└── global.d.ts               # Window 接口扩展（2740 行起），从各 api 片 import 类型聚合
```

**关键设计**：

- 每个 `api/*.ts` 默认导出一个普通对象 `{ listTabs: () => ipcRenderer.invoke(...) }`，`index.ts` 用 spread 或 `Object.assign` 按现有键名组装——保证 `window.electronAPI.*` 的运行时形状逐字节不变。
- **类型安全是重点**：`global.d.ts` 中 `electronAPI` 的类型应从各片的返回值 `typeof` 推导聚合，而不是手写两份（当前实现和类型声明分离容易漂移；preload 里 282 和 1341 出现两组同名 `webTabs` 定义疑似就是漂移痕迹，值得在拆分时核对去重）。
- 不改渲染进程任何调用点。

**迁移顺序**：与方案 1 配对推进——每拆一个 ipc 注册器就同步搬对应 preload 片（webTabs → browserWorkflow → working → …），两边一起验证。

**验证**：`bun run typecheck` + `bun run --filter='@copis/electron' build:preload && build:renderer` + dev 启动后抽查 `window.electronAPI` 键完整性。

---

## 总体建议

1. **优先级**：方案 1+5 一起做收益最大（IPC 是所有功能的咽喉，且两者同构）；方案 4 的 retry/error-mapper 抽取风险最低、测试收益最高，适合先行热身。
2. **顺序依赖**：方案 1（ipc.ts）和方案 5（preload）应同步分阶段进行，保持四层 IPC 模式两端一致。
3. **不动的东西**：所有方案都保持对外公共 API 不变（IPC channel 常量、`window.electronAPI` 形状、`AgentOrchestrator` 类接口、组件 props），因此可以逐文件灰度迁移，不需要一次性大爆炸重构。
4. **版本管理**：按仓库约定，每步落地时递增受影响包的 patch 版本。
5. **文档同步**：实际落地任一方案后，需经确认再更新本文件与 `AGENTS.md`/`README.md` 反映新结构。
