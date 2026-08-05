# Copis Pi Agent 浏览器工作流开发计划

> **For agentic workers:** 实施时按本文 Task 顺序推进，每个步骤使用 checkbox（`- [ ]`）跟踪。遵循 BDD：先写失败场景和测试，再实现，再运行聚焦验证。不要在同一提交中夹带无关重构。

**状态：** 实施中：Rust JSONL 录制、Pi 提炼、session/Origin/审批/profile 边界和确定性 Runner 已接入；真实 Electron Runner 回放和共享 `AgentConversationSurface` 已完成，当前重点是录制端到端、权限矩阵和生产隐藏执行视图回归
**日期：** 2026-08-04
**目标版本：** `@copis/electron` 0.16.13；Shared 未新增运行时契约，版本保持不变
**负责人边界：** Electron 主进程、Rust 本地 API、Pi Agent Runtime、Renderer 浏览器页签与 Agent 会话 UI

**Goal:** 将 Copis 当前的 CDP 测试能力重构为 Pi Agent 专用的浏览器工作流系统。用户可以从网页工具栏打开 Copis Agent 侧栏，通过对话录制真实网页操作；录制事件先由 Rust 本地 API 以脱敏 JSONL 文件追加保存，停止后由 Pi Agent 读取并总结提炼成固定、可审计、可跨页面执行的 Workflow，最后由确定性执行器完成自动化。

**Architecture:** CDP 只存在于 Electron 主进程，由 `BrowserWorkflowService` 管理。主进程只负责验证上下文、采集并脱敏操作事件，然后通过带内部 token 的本地 Rust API 将每个事件按顺序写入 workspace 下的 JSONL 文件；停止后 Pi Agent 通过高层工具读取这份 untrusted JSONL，负责总结、命名、变量提炼和提交待审核草稿。主进程只对 Agent 草稿做 schema、workspace、来源录制和 Origin 校验，不把任意 CDP 或网页日志指令交给 Agent 执行。Renderer 不接触原始 CDP 或 JSONL，只展示浏览器 Agent 对话、录制状态、Workflow 审批和运行进度。正式回放由确定性状态机执行，Agent 负责发起、参数化、解释失败和提出版本修复。

**Tech Stack:** Bun workspace、TypeScript、Electron `WebContentsView` / `webContents.debugger`、Rust 本地 HTTP API、React 18、Jotai、TypeBox、Pi Agent SDK、JSON/JSONL、本地文件存储、Bun test、Cargo test。Playwright只用于开发期 E2E，不进入产品运行链路。

---

## 1. 已确认决策

以下决策是实施约束，不在开发过程中重新打开：

1. Copis Agent Runtime 收敛为 Pi-only，不实现 Claude Agent SDK、Claude Code 或 Claude MCP 适配。
2. “移除 Claude”仅指 Claude Code / Claude Agent SDK Runtime。Anthropic Provider、Claude 模型、模型 Logo、thinking 能力和通过 Pi 调用 Claude 模型的能力继续保留。
3. 删除外部 `chrome-devtools-mcp` 产品能力，不通过 `npx ...@latest` 启动独立 Chrome。
4. 不开放 Electron 全局 `--remote-debugging-port`，不让 Playwright连接整个 Copis Electron 实例。
5. CDP 只允许主进程的 Browser Workflow 服务访问；Renderer、Preload、HTTP API、普通 MCP 均不得发送任意 CDP 命令。
6. 用户操作录制必须由 Pi Agent 工具发起。Renderer 可以停止、取消、批准或拒绝，但不能直接开启底层 CDP 录制。
7. Workflow 回放是确定性执行，不允许 Agent在每一步临场自由操作页面。
8. Workflow 支持同页交互、同页导航、跨域导航、`window.open` 新页签、页签切换和页签关闭。
9. Workflow 定义、版本、运行日志和产物使用本地 JSON/JSONL，不引入数据库。
10. 录制使用用户当前可见网页；正式运行使用 Workflow 自有页面上下文，默认不接管用户正在操作的页签。
11. Playwright只作为开发期 E2E 测试工具。首版产品运行时不增加 Playwright依赖或浏览器下载。
12. 网页工具栏现有 `CDP` 提示替换为 Copis 图标。点击后打开真实分栏式 Agent 对话面板，不使用覆盖原生网页的 DOM Sheet。
13. 录制操作 JSONL 由 Rust 本地 API 创建、追加和结束标记；Electron 主进程不把内存事件数组作为最终 Workflow 来源。停止录制后，Pi Agent 通过高层工具获得这份脱敏 JSONL，再提交结构化草稿。

---

## 2. 背景与现状

当前代码已经具备部分底层能力，但它们属于测试形态：

- `apps/electron/src/main/lib/web-tab-manager.ts` 会为每个网页页签调用 `webContents.debugger.attach()`。
- `packages/shared/src/types/web.ts` 将 `cdpAttached` 暴露给 Renderer，并定义 `SEND_CDP_COMMAND`。
- `apps/electron/src/preload/index.ts` 暴露 `webTabs.sendCdpCommand()`。
- `apps/electron/src/main/ipc.ts` 接收 Renderer 任意 CDP method 和 params。
- `apps/electron/src/renderer/components/web-browser/WebBrowserSurface.tsx` 只显示“CDP 已连接”测试提示。
- `apps/electron/src/main/lib/builtin-mcp/chrome-devtools.ts` 通过 `npx -y chrome-devtools-mcp@latest` 启动独立浏览器 MCP。
- Agent Runtime 仍保留 Claude/Pi 双路由、Claude SDK 二进制、平台包、sidecar settings、旧默认值和 UI 选项。

这些能力不能直接演变成正式自动化：

- Renderer 任意 CDP 会扩大主渲染进程被 XSS 利用后的攻击面。
- 外部 Chrome 不等于用户当前正在浏览的 Copis 页签，录制和登录态会脱节。
- `connectOverCDP()` 需要浏览器级 endpoint；Electron 当前持有的是单个 `WebContents` 会话。
- 开放全局远程调试端口会暴露 Copis 主窗口、Agent 消息和其它 Renderer。
- 让 Agent直接获得 `click/evaluate` 等原语无法保证“固定 Workflow”语义。
- 网页 DOM、Portal 或 Radix Sheet 无法覆盖原生 `WebContentsView`。

---

## 3. 产品目标

### 3.1 用户目标

用户可以完成以下闭环：

1. 在 Copis 打开一个真实网页。
2. 点击网页工具栏中的 Copis 图标。
3. 在右侧 Agent 面板中说明要记录的业务流程。
4. Agent 启动录制，用户正常操作网页，包括跨页面和新页签。
5. 停止录制后，Rust JSONL 由 `BrowserWorkflowRecordingGet` 提供给 Agent；Agent将操作总结、参数化并提交待审核 Workflow 草稿。
6. 用户检查步骤、变量、允许域名和人工检查点，并批准一个版本。
7. 用户以后通过自然语言、手动入口或定时任务运行该 Workflow。
8. 执行失败时，系统暂停并生成诊断，Agent提出修复版本，用户批准后才更新。

### 3.2 工程目标

- CDP 边界不可从 Renderer 或外部 MCP 穿透。
- 录制事件可重放、可审计、可版本化。
- Workflow 执行不依赖每一步 LLM 推理。
- 页面结构发生轻微变化时可使用备用 Locator，但不静默改写已批准版本。
- 跨页面执行具备明确的页签归属和 Origin 边界。
- 用户输入、Cookie、Authorization、密码和请求正文不会意外进入 Agent transcript。
- 页面关闭、导航、DevTools 抢占 CDP、应用退出和 Agent 取消都能确定性收尾。

### 3.3 非目标

首版不实现：

- 任意网页 JavaScript `evaluate` Agent 工具。
- 面向第三方进程的标准 CDP WebSocket server。
- Playwright控制用户当前的 Copis 页签。
- 浏览器扩展录制。
- 跨设备同步 Workflow。
- 自动绕过验证码、MFA、支付确认或浏览器安全提示。
- 任意文件上传、下载管理、拖拽、画布或复杂手势录制。
- 自动修改已批准 Workflow。
- 跨浏览器兼容；首版只支持 Copis 内嵌 Chromium。

---

## 4. 总体架构

```text
Browser Toolbar Copis Icon
          │
          ▼
BrowserAgentPanel (Renderer, Jotai)
          │  Agent message / approve / stop only
          ▼
Pi Agent Runtime + Pi Native Tools
          │
          ▼
BrowserWorkflowService (Main Process, source of truth)
  ├── RecordingCoordinator / CDP recorder
  ├── Rust Recording API client
  ├── WorkflowStore / WorkflowRunner
  ├── BrowserProfileManager / BrowserPageManager
  ├── CdpSessionRouter / LocatorResolver
  └── WorkflowPermissionPolicy
          │
          ├── normalized, redacted events
          ▼
Rust Local HTTP API (internal token)
          │
          ▼
workspace/browser-recordings/{recordingId}.jsonl
          │
          ▼
Pi Agent: RecordingGet -> summarize -> Draft -> user approval
          │
          ▼
Main schema / permission validation -> WorkflowRunner -> Electron webContents.debugger
          │
          ▼
User WebContentsView / Workflow-owned WebContentsView
```

### 4.1 分层职责

| 层 | 职责 | 禁止事项 |
| --- | --- | --- |
| Renderer | 对话、状态、审批、停止、面板布局 | 不发送 CDP method，不注入页面脚本 |
| Preload / IPC | 高层上下文、状态、审批和取消协议 | 不暴露 `sendCdpCommand` |
| Workflow Service | 录制生命周期、脱敏、权限、并发、Agent 草稿校验和执行编排 | 不信任 Renderer 传来的 URL/title，不把内存事件数组当最终 Workflow 来源 |
| Rust Recording API | 创建、串行追加、结束/取消标记和读取操作 JSONL | 不接收网页端请求，不执行 CDP，不解析网页文本指令 |
| Pi Tools | 发起录制、读取 JSONL、总结提交草稿、保存、运行、停止、修复 | 不暴露低层 click/evaluate |
| CDP Router | attach、命令、事件、frame session 路由 | 不向外监听网络端口 |
| Workflow Store | JSON/JSONL 原子写入版本和运行日志 | 不存 Cookie、密码、Authorization |

### 4.2 主进程单一事实源

以下状态必须由主进程维护：

- 当前录制会话及其 Agent sessionId、workspaceId、起始 tabId。
- Rust 录制文件的 recordingId、workspace slug、追加顺序、事件计数和结束状态。
- 被录制页签集合及 opener 关系。
- 当前 Workflow run、拥有的页面、页签别名和步骤状态。
- CDP attach/detach、document epoch、frame session 和 pending command。
- Workflow 版本、允许 Origin、是否批准无人值守运行。
- Agent 工具 Promise 的等待和取消。

Rust API 是操作 JSONL 的文件事实源，Pi Agent 只读取脱敏内容并提交草稿；Jotai 只保存用于展示的镜像状态，不能作为录制或执行权限的依据。

---

## 5. 用户体验与界面计划

### 5.1 网页工具栏入口

将 `WebBrowserSurface` 中的绿色 `CDP` 文本替换为 `CopisAppLogo` 图标按钮：

| 状态 | 表现 | 点击行为 |
| --- | --- | --- |
| idle | 普通 Copis 图标 | 打开或恢复 Browser Agent 面板 |
| panel-open | 选中背景 | 收起面板；不终止任务 |
| thinking | 图标外圈轻量旋转 | 聚焦当前 Agent 对话 |
| recording | 右上角红色录制点 | 打开面板显示录制状态 |
| running | 运行进度环 | 打开面板显示 Workflow 进度 |
| waiting | 警示点 | 打开待处理审批或人工步骤 |
| error | 错误状态 | 打开失败诊断 |

要求：

- `aria-label="Copis 网页 Agent"`。
- 使用短 Tooltip 说明图标，不显示 CDP 字样。
- 图标固定尺寸，状态变化不能让工具栏位移。
- 点击入口本身不请求模型、不自动录制，避免误触消耗和隐私问题。
- 面板内“录制”快捷按钮通过发送结构化 Agent 用户消息触发，不能直接调用 CDP。

### 5.2 Browser Agent 侧栏

`WebContentsView` 位于 Renderer DOM 之上，因此侧栏不能用 Radix `Sheet` 覆盖页面。采用真实分栏：

```text
┌────────────────── Browser Area ──────────────────┬──────── Browser Agent ────────┐
│ Browser Toolbar                                  │ Header / page context          │
├──────────────────────────────────────────────────┤                                │
│                                                  │ Agent messages                 │
│ Native WebContentsView                           │ Workflow draft / run status    │
│                                                  │ Composer / record / stop       │
└──────────────────────────────────────────────────┴────────────────────────────────┘
```

布局约束：

- 浏览器列和 Agent 面板是同级 Flex/Grid 子节点。
- 面板默认宽度 `400px`，限制为 `340px - 520px`。
- 面板宽度使用 Jotai 持久化。
- 网页宿主先真实缩窄，再在已分配区域内播放约 `150ms` 面板内容滑入。
- 不对原生网页做长时间逐帧宽度动画，避免连续 IPC resize 抖动。
- `ResizeObserver` 继续以网页宿主真实 `getBoundingClientRect()` 更新原生 View bounds。
- 关闭时先播放面板内容退出，再释放分栏宽度。
- 小窗口必须保证网页最小可用宽度；空间不足时面板宽度按容器约束缩小，不允许文本溢出。

### 5.3 浏览器会话与主 Agent 会话

浏览器侧栏使用真实 Pi Agent Session，但不得同时挂载两个完整 `AgentView`：

- 抽取 `AgentConversationSurface` 和 `useAgentSessionController`。
- 主区域使用 `variant="full"`。
- 浏览器侧栏使用 `variant="browser"`。
- Browser Agent 新会话在第一条消息前保持 draft，不立即进入左侧历史列表。
- 浏览器面板创建会话时不自动调用 `openSession()`。
- 用户选择“在主界面展开”后，关闭侧栏并将同一 sessionId 打开为 Agent Tab。
- 同一个 sessionId 同时只能有一个可交互 Surface。

点击 Copis 图标时：

1. 若当前有 Browser Agent session，恢复该 session。
2. 否则创建 Pi draft session，关联当前 workspace/channel/model 默认值。
3. Renderer 只提交当前 `tabId`。
4. 主进程重新读取该 tab 的真实 URL/title/favicon，并生成 Browser Context。
5. Browser Context 随下一条 Agent 消息发送，并在工具上下文中保存，不要求模型回传 tabId。

### 5.4 录制中的交互

- Agent 调用录制工具后，操作事件立即按脱敏 JSONL 追加到 Rust API 管理的录制文件。
- 用户可以收起侧栏并继续在网页中操作。
- Copis 图标始终显示录制点。
- 面板和工具栏都可提供“停止”命令；停止只结束采集并写入 Rust finish 标记，随后向同一 Pi session 发起“读取 JSONL 并总结”的请求，不把原始日志交给 Renderer。
- Agent 读取 JSONL 后先展示步骤、变量、Origin 和人工检查点，用户确认后才能提交保存。
- `Escape` 不默认停止录制，避免网页按键误终止。
- 应用退出、起始页签关闭或 Agent run 取消时写入 cancel 标记并释放录制资源。

---

## 6. CDP 私有边界

### 6.1 删除公开能力

实施时删除：

- `WebTabState.cdpAttached`。
- `SendWebTabCdpCommandInput`。
- `WEB_IPC_CHANNELS.SEND_CDP_COMMAND`。
- Preload `webTabs.sendCdpCommand()`。
- HTTP bridge 的 CDP stub。
- `ipcMain.handle(...SEND_CDP_COMMAND...)`。
- Renderer 的 CDP 状态 UI。
- `builtin-mcp/chrome-devtools.ts`。
- `default-mcp.json` 中 `chrome-devtools` catalog。
- Orchestrator 的 chrome-devtools 注入和 plan-mode工具白名单。
- 已保存的 builtin MCP enable key 只在读取迁移时忽略，不报错。

### 6.2 内部 BrowserPagePort

不要让 Workflow Service 直接访问 `web-tab-manager` 的内部 record。新增窄接口：

```ts
export interface BrowserPagePort {
  readonly pageId: string
  readonly owner: 'user' | 'workflow'
  isDestroyed(): boolean
  getSnapshot(): BrowserPageSnapshot
  send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<unknown>
  onMessage(listener: BrowserCdpMessageListener): () => void
  onDestroyed(listener: () => void): () => void
}
```

约束：

- `send` 仅在主进程模块内可见，不从 shared/preload 导出。
- `CdpSessionRouter` 是唯一 attach/detach 协调者。
- 打开 DevTools 导致 debugger detach 时，录制/运行进入 `paused_cdp_detached`，不能静默继续。
- 重连成功后必须重新启用 Page、Runtime、DOM、Accessibility，并使当前元素引用失效。
- 关闭页面时取消所有 pending command 和 wait。

---

## 7. 操作录制设计

### 7.1 录制生命周期

```text
idle
  -> starting
  -> recording
  -> stopping
  -> awaiting_agent_summary
  -> awaiting_review
  -> approved | discarded | error
```

每次录制包含：

- `recordingId`
- `agentSessionId`
- `workspaceId` / workspace slug
- `rootTabId`
- `includedTabIds`
- `startedAt`
- `status`
- Rust JSONL file reference and event count
- `tabAliases`
- `observedOrigins`

同一时刻只允许一个全局用户录制，避免无法判断用户操作归属。Workflow 回放与录制不能同时控制同一页面。录制结束后，Rust 文件保留原始操作顺序和结束标记；它不是 Workflow 版本，必须由 Agent 读取和总结后才能产生草稿。

### 7.2 注入方式

录制器使用 CDP：

1. `Runtime.enable`
2. `Page.enable`
3. `Runtime.addBinding`
4. `Page.addScriptToEvaluateOnNewDocument`
5. 对当前 document 立即执行同一安装脚本
6. 监听 `Runtime.bindingCalled`
7. 监听主框架导航、history change、目标创建和页面销毁

注入脚本运行在命名隔离 world，不污染页面全局变量。事件监听使用 capture phase，并只接受 `event.isTrusted === true` 的真实用户事件。每个 recording 使用不可预测 nonce，主进程拒绝 nonce 不匹配、来源 context 不匹配或超出录制范围的 payload。

### 7.3.1 Rust JSONL 持久化边界

Electron 主进程通过内部 token 调用 Rust API：

- `POST /internal/browser-workflows/recordings/{workspace}/{recording}/start` 创建文件并写入 metadata 行。
- `POST .../event` 追加一条已经完成 nonce、Origin、URL 和敏感字段处理的操作事件。
- `POST .../finish` 或 `POST .../cancel` 追加结束标记。
- `GET .../content` 只允许主进程读取，Pi 工具通过主进程将内容作为 untrusted browser data 提供给 Agent。

文件位于 `~/.copis(-dev)/agent-workspaces/{workspace}/browser-recordings/{recordingId}.jsonl`。Renderer、网页端、HTTP bridge 的业务路由和 MCP 不得直接访问这些端点。普通 input 的字面值在进入 Rust 前已被替换为 empty/variable 语义；password、OTP、支付、文件等敏感输入只保留人工检查点信息。

### 7.3 录制事件

```ts
export interface BrowserRecordingEvent {
  id: string
  recordingId: string
  timestamp: number
  pageId: string
  tabAlias: string
  framePath: BrowserFramePath
  url: string
  type: 'click' | 'input' | 'change' | 'submit' | 'key' | 'navigation' | 'tab_open' | 'tab_switch' | 'tab_close'
  target?: BrowserRecordedTarget
  value?: BrowserRecordedValue
  navigation?: BrowserRecordedNavigation
}
```

采集规则：

- 记录 click、input/change、submit 和用于确认的 Enter 等按键。
- 不记录 mousemove、hover、普通滚动、每个 keydown。
- 连续 input 只在 blur/change/submit 或下一业务动作时提交。
- `type=password` 只记录“需要人工输入”，不读取 value。
- file input 只记录人工文件选择检查点，不读取本地路径。
- 普通文本输入不发送原值给 Agent，默认生成变量占位符。
- 页面脚本生成的非 trusted event 不作为用户操作。
- 同一次 click 触发的 submit/navigation 必须关联，避免生成重复步骤。

### 7.4 页签范围

默认只录制：

- rootTab。
- rootTab 通过 `window.open` 或 target=_blank 创建的后代页签。
- 用户在录制 UI 中明确纳入的现有页签。

用户切到无关联页签时先暂停采集并提示是否纳入，不能无条件记录其它私人页面。`setWindowOpenHandler` 创建新页签时携带 `openerPageId` 和当前 action correlation id。

---

## 8. Locator 与页面指纹

### 8.1 Locator Bundle

每个可操作目标保存多个候选，不只保存 CSS 或坐标：

```ts
export interface BrowserLocatorBundle {
  framePath: BrowserFramePath
  strategies: BrowserLocatorStrategy[]
  fingerprint: BrowserElementFingerprint
}

export type BrowserLocatorStrategy =
  | { kind: 'testId'; attribute: string; value: string }
  | { kind: 'role'; role: string; name?: string }
  | { kind: 'label'; value: string }
  | { kind: 'name'; value: string }
  | { kind: 'id'; value: string }
  | { kind: 'text'; value: string; exact: boolean }
  | { kind: 'css'; value: string }
```

优先级：

1. 唯一 `data-testid`、`data-qa` 等稳定测试属性。
2. role + accessible name。
3. 关联 label。
4. 稳定 name。
5. 非生成式 id。
6. 文本 + 结构范围。
7. CSS 路径兜底。

禁止将 XPath 和屏幕坐标作为首选定位。坐标只在一次实际 Input dispatch 中由当前 box model 计算。

### 8.2 元素指纹

指纹用于歧义消解：

- tagName
- input type
- accessible name
- placeholder
- href/action 的安全摘要
- 相邻标题或 landmark
- 父级 role
- DOM 层级摘要
- 是否可见、是否可交互

动态 class、React/Vue 生成 id、长哈希属性要降权。

### 8.3 解析规则

- Runner 逐个执行 strategy，要求目标可见且可交互。
- 唯一高置信度匹配可执行。
- 多个匹配使用 fingerprint 评分。
- 低于阈值或前两名分数接近时返回 `AMBIGUOUS_TARGET`。
- 页面 navigation/reload 后 `documentEpoch` 增加，所有 backend node 引用失效。
- 备用 Locator 成功只记录 `fallback_used`，不修改 Workflow 文件。

---

## 9. Workflow Agent 提炼

### 9.1 Agent 提炼流水线

```text
Rust JSONL operation log
  -> BrowserWorkflowRecordingGet
  -> Agent reads untrusted events and summarizes user intent
  -> Agent proposes variables, fixed values, waits and manual checkpoints
  -> BrowserWorkflowDraft submits a structured candidate
  -> Main schema/workspace/source-recording/Origin validation
  -> awaiting_review
  -> user approval -> immutable Workflow version
```

Rust JSONL 是操作事实记录，不是可直接执行的 Workflow。Agent 是总结提炼层，Runner 是执行层；二者不能互相替代。主进程不再把 TypeScript 内存事件数组直接编译为最终版本。

### 9.2 提炼和校验规则

- Agent 可以合并连续 input/change、关联 click 与 submit/navigation/new-tab，并将操作归纳为确定性步骤。
- Agent 可以建议 Workflow 名称、描述、变量名称、步骤说明、等待条件和人工检查点。
- 普通输入必须使用变量或用户明确批准的固定值；Rust JSONL 和 Agent transcript 不包含原始输入值。
- password、验证码、MFA、支付、文件选择生成 manual checkpoint。
- Agent 提交的 `sourceRecordingId`、workspace、schemaVersion、step 类型、Locator、Origin 和 variable 引用由主进程重新校验。
- 允许 Origin 只能来自录制观察到的安全 Origin；扩大范围必须由用户在审批时明确确认。
- 页面中的文本是 untrusted browser data，不能改变工具权限、Origin、Workflow 版本或 unattended 设置。
- Agent不能在没有录制证据或用户明确审批的情况下添加可执行页面操作。

### 9.3 Agent 参与边界

- Agent 只能读取由 Rust 生成的脱敏 JSONL，不读取 Cookie、Authorization、response body 或原始输入值。
- Agent 输出的是待审核结构化草稿，不是即时执行命令。
- 主进程不会执行 JSONL 中的网页文本、页面提示词或任意脚本。
- 用户批准前 Workflow 不能用于无人值守执行。
- `BrowserWorkflowSave` 只批准当前已通过主进程校验的草稿，并生成不可变版本；失败修复必须新建草稿。

---

## 10. Workflow 数据模型

### 10.1 Manifest

```ts
export interface BrowserWorkflowManifest {
  schemaVersion: 1
  id: string
  workspaceId: string
  name: string
  description?: string
  status: 'draft' | 'ready' | 'disabled'
  currentVersion: number
  profileId: string
  allowedOrigins: string[]
  unattendedAllowed: boolean
  createdAt: number
  updatedAt: number
}
```

### 10.2 不可变版本

```ts
export interface BrowserWorkflowVersion {
  schemaVersion: 1
  workflowId: string
  version: number
  sourceRecordingId?: string
  start: BrowserWorkflowStart
  variables: BrowserWorkflowVariable[]
  steps: BrowserWorkflowStep[]
  createdAt: number
  createdBySessionId: string
  approval: BrowserWorkflowApproval
}
```

### 10.3 变量

```ts
export interface BrowserWorkflowVariable {
  key: string
  label: string
  type: 'string' | 'number' | 'boolean' | 'choice'
  required: boolean
  defaultValue?: string | number | boolean
  options?: string[]
  sensitive?: boolean
}
```

首版不持久化 secret。`sensitive: true` 表示运行时由用户临时提供，不能写入 manifest、run log 或 Agent transcript；无法安全提供时转换为 manual step。

### 10.4 步骤

首版支持：

```ts
export type BrowserWorkflowStep =
  | BrowserNavigateStep
  | BrowserClickStep
  | BrowserFillStep
  | BrowserPressStep
  | BrowserSelectStep
  | BrowserWaitStep
  | BrowserAssertStep
  | BrowserOpenTabStep
  | BrowserSwitchTabStep
  | BrowserCloseTabStep
  | BrowserManualStep
```

所有步骤共享：

```ts
export interface BrowserWorkflowStepBase {
  id: string
  type: string
  tabAlias: string
  page: {
    origin: string
    urlPattern: string
  }
  timeoutMs?: number
  description?: string
}
```

操作步骤包含 `target: BrowserLocatorBundle`；输入步骤的 value 只能是固定常量或变量引用。禁止存任意脚本。

### 10.5 运行状态

```ts
export type BrowserWorkflowRunStatus =
  | 'queued'
  | 'starting'
  | 'running'
  | 'waiting_user'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled'
```

每个 step 写入 JSONL 事件：started、resolved、completed、fallback_used、failed。日志只保存必要元数据和脱敏错误，不保存页面完整 DOM。

---

## 11. 本地存储

按工作区存储：

```text
~/.copis/agent-workspaces/{workspace-slug}/browser-workflows/
└── {workflow-id}/
    ├── manifest.json
    ├── versions/
    │   ├── 1.json
    │   └── 2.json
    ├── runs/
    │   └── {run-id}.jsonl
    └── artifacts/
        └── {run-id}/
            ├── failure-step-{step-id}.png
            └── diagnostic.json
```

存储要求：

- manifest 和 version 使用临时文件 + rename 原子写入。
- version 文件一旦批准不得原地修改。
- 修改 Workflow 必须创建新版本并更新 manifest 指针。
- run JSONL 追加写入，应用崩溃后可诊断未完成状态。
- artifacts 有数量和大小上限，并提供清理策略。
- 不引入索引数据库；列表通过轻量 manifest 扫描并缓存。
- 不保存 Cookie、localStorage、Authorization、请求正文、密码和完整 HTML。

Browser Profile 元数据单独保存在 `~/.copis/browser-profiles.json`，只记录 profile id、展示名和 Electron partition 标识，不记录凭据。

---

## 12. Workflow 执行器

### 12.1 状态机

```text
validate input
  -> acquire workflow/profile lease
  -> create run-owned page context
  -> load start URL
  -> resolve step target
  -> execute CDP input/navigation
  -> wait for declared outcome
  -> append run event
  -> next step
  -> release pages and lease
```

### 12.2 执行原则

- 标准 run 不调用 LLM 决定每一步。
- 所有 mutation 按 step 串行执行。
- 每个 run 使用 AbortController。
- 关闭页面、应用退出、用户取消或 Agent run 取消时向下传播 abort。
- click 使用当前 DOM box model + `Input.dispatchMouseEvent`，不能复用录制坐标。
- fill 先 focus、清空，再使用 CDP 输入事件，确保 React 等框架收到真实 input/change。
- 每一步先校验当前 Origin 与 URL pattern。
- 超时必须是有界的，默认和最大值集中配置。
- 不使用无限 network-idle；优先等待 URL、目标元素或业务断言。

### 12.3 Run-owned 页面

正式运行创建不持久化到 `web-tabs.json` 的 Workflow 页面：

- `owner: 'workflow'`
- `runId`
- `tabAlias`
- `profileId`
- `openerPageId`

默认不接管用户可见 tab。预览运行可以将 run-owned page 暂时附加到主窗口；后台运行可以保持隐藏，但必须维持完整 BrowserWindow/WebContents 生命周期和 session partition。

建议先抽取底层 `BrowserPageManager`，再让：

- `web-tab-manager` 管理 `owner='user'` 的可见/持久页签。
- `BrowserWorkflowRunner` 管理 `owner='workflow'` 的临时页签。

两者共享 CDP 和页面生命周期实现，不共享用户 Tab 列表状态。

### 12.4 Browser Profile

- `default` profile 使用现有 `persist:copis-web`，可以复用用户登录态。
- 隔离 profile 使用 `persist:copis-workflow-{profileId}`。
- Workflow manifest 只引用 profileId。
- 同一 profile 默认只允许一个 mutation run，避免共享 Cookie 状态下的并发冲突。
- 删除 profile 必须先确认没有 Workflow 引用，不自动删除用户浏览数据。

---

## 13. 跨页面与多页签

Workflow 使用稳定 alias，而不是运行时 tabId：

```text
main -> detail -> confirm
```

规则：

- root page 固定 alias `main`。
- 录制中新开的页签按语义或序号分配 alias。
- `window.open` 通过 opener + action correlation 关联到触发步骤。
- 新页签 URL 必须在 `allowedOrigins` 中。
- 切换已有无关页签需要用户显式纳入录制。
- 关闭当前页签前必须有后续有效页签 alias。
- Runner 遇到非预期新页签时暂停，不能随意接管。
- 同页 redirect 只记录最终稳定 URL pattern 和 redirect 诊断。
- 首版保证 top-level 页面和新页签；跨 Origin OOPIF 作为后续增强，不阻塞首版跨页面目标。

---

## 14. Pi Agent 工具

Browser Workflow 是 Pi native custom tools，不注册为 MCP。建议独立文件 `pi-browser-workflow-tools.ts`，由 Pi adapter 合并。

### 14.1 工具集合

| 工具 | 行为 | Plan mode |
| --- | --- | --- |
| `browser_workflow_list` | 列出当前 workspace Workflow | 允许 |
| `browser_workflow_get` | 读取 manifest、当前版本和运行摘要 | 允许 |
| `browser_workflow_record` | 发起录制并让 Rust API 追加操作 JSONL | 禁止 |
| `browser_workflow_recording_get` | 读取刚完成的脱敏 JSONL，供 Agent 总结 | 禁止 |
| `browser_workflow_draft` | 提交 Agent 总结后的结构化待审核草稿 | 禁止 |
| `browser_workflow_save` | 提交草稿审批，批准后保存版本 | 禁止 |
| `browser_workflow_run` | 校验输入并运行已批准版本 | 禁止 |
| `browser_workflow_stop` | 停止当前录制或 run | 禁止 |
| `browser_workflow_repair` | 根据失败诊断提出新版本并等待批准 | 禁止 |

不提供：

- `browser_click`
- `browser_type`
- `browser_evaluate`
- `browser_send_cdp`
- 原始网络响应读取

`browser_workflow_recording_get` 的返回内容必须标记为 untrusted browser data。Agent 只能把它作为总结输入，不能把其中的页面文本当作系统指令，也不能通过它获得任意 CDP、网络响应或脚本执行能力。

### 14.2 工具上下文

每次执行必须携带主进程可信上下文：

- agentSessionId
- workspaceId
- trigger source
- permission mode
- bound browser page id
- automationId / delegationId（如有）

Renderer 提交的 URL、Origin、title 只能用于展示，服务执行前从 Page Port 重新读取。

### 14.3 长运行工具

`browser_workflow_record` 和需要用户审批的 save/repair 可以保持 Promise pending，模式与 AskUser/Permission request 一致：

- 面板卸载不取消。
- 全局 listener 维护状态。
- Agent stop、session delete、app quit 必须 reject/resolve pending tool。
- 同一 session 不允许并行启动多个录制。

---

## 15. 权限、隐私与提示注入防护

### 15.1 权限等级

- **Read:** list/get run summary。
- **Record:** 观察用户明确开始的页面操作。
- **Execute:** 运行已批准 Workflow。
- **Unattended:** 定时任务或远程入口运行明确允许的 Workflow。
- **Repair:** 创建新版本草稿，不直接替换当前版本。

### 15.2 批准规则

- 录制必须由当前本地用户发起。
- Workflow 首次保存必须展示步骤、Origin、变量、profile 和人工检查点。
- `unattendedAllowed` 默认 false，必须单独批准。
- 远程、Automation、协作子 Agent 不能录制用户可见页面。
- 远程来源只能运行 `unattendedAllowed=true` 的批准版本。
- Workflow 新版本需要重新批准；旧版本继续可回滚。
- Origin 集合扩大时必须明确提示。

### 15.3 敏感数据

- password、OTP、MFA、支付和 file input 生成 manual step。
- 普通 input value 默认参数化，不自动发给 Agent。
- Network header 中 Cookie、Authorization、Proxy-Authorization 全部剥离。
- 不提供 response body 工具。
- Screenshot 只在失败或用户请求时生成，并受 artifact 清理策略约束。
- Agent transcript 只存 Workflow step 摘要和变量名，不存敏感输入值。

### 15.4 网页提示注入

- 页面文本和 Accessibility snapshot 统一标记为 untrusted browser content。
- 页面内容不能改变工具权限、Origin、Workflow 版本或 unattended 设置。
- 运行器只执行已批准 step，不解析网页中的自然语言指令。
- Agent repair 只能生成候选版本，不能直接执行额外操作。

---

## 16. Claude Code Runtime 移除边界

### 16.1 删除内容

- `@anthropic-ai/claude-agent-sdk` 及所有平台 optionalDependencies。
- `claude-agent-adapter.ts`。
- `runtime-routing-agent-adapter.ts`。
- Agent service 中 Claude adapter 和 orphan process 扫描。
- Orchestrator 中 Claude SDK import、CLI path、settings、env、resume 分支。
- Claude native binary 打包、external 参数和 electron-builder 条目。
- AgentRuntime UI selector 和 Automation 的 Claude 选项。
- Claude channel whitelist 和 Agent-compatible channel 开关。
- Copis 管理的 Claude sidecar settings。
- `builtin-mcp` 中只为 Claude SDK创建 in-process server 的代码路径；Pi native/MCP bridge 保留。
- 历史缺失 runtime 默认 Claude 的逻辑。

### 16.2 保留内容

- Anthropic Provider 和 Messages API。
- Claude 模型 ID、Logo、thinking 规则和模型能力识别。
- Pi 通过 Anthropic或兼容渠道调用 Claude 模型。
- 历史 SDKMessage/JSONL 的只读兼容解析。
- 用户项目中已有 `.claude/` 或 `CLAUDE.md` 文件，不删除、不改写。
- `@anthropic-ai/sdk` 如仍被 Chat/Provider 路径实际使用则保留；不能因为名称中有 Anthropic 而机械删除。

### 16.3 本地数据迁移

启动迁移前创建一次备份：

```text
~/.copis/migrations/pi-only-runtime/{timestamp}/
├── agent-sessions.json
├── automations.json
└── settings.json
```

迁移规则：

- `agentRuntime: 'claude'` 或缺失 -> `'pi'`。
- 清除活动恢复使用的 Claude `sdkSessionId`，保留 JSONL 消息。
- 历史会话下一次继续时由 Pi 从已有消息启动，不尝试恢复 Claude native session。
- Automation 的 Claude 或缺失 runtime -> Pi。
- Collaboration child 默认继承 Pi。
- 飞书、钉钉、微信和 HTTP API 新会话固定 Pi。
- 旧 builtin `chrome-devtools` enabled key 忽略并在下一次设置写入时清理。
- Copis 管理目录中的 `CLAUDE.md`/`.claude/memory` 如需要继续作为工作区记忆，迁移到中立命名；原文件先保留备份，不覆盖已存在的新文件。

迁移必须幂等。单个记录失败时写中文诊断并保留备份，不能让应用无法启动。

---

## 17. IPC 与共享类型

新增 `packages/shared/src/types/browser-workflow.ts`，只导出高层产品协议，不导出 CDP method。

建议通道：

```ts
export const BROWSER_WORKFLOW_IPC_CHANNELS = {
  LIST: 'browser-workflows:list',
  GET: 'browser-workflows:get',
  GET_STATUS: 'browser-workflows:get-status',
  STOP_RECORDING: 'browser-workflows:stop-recording',
  CANCEL_RECORDING: 'browser-workflows:cancel-recording',
  APPROVE_DRAFT: 'browser-workflows:approve-draft',
  REJECT_DRAFT: 'browser-workflows:reject-draft',
  STOP_RUN: 'browser-workflows:stop-run',
  STATUS_CHANGED: 'browser-workflows:status-changed',
} as const
```

Renderer 不提供 START_RECORDING 或 RUN IPC；这些动作由 Agent tools 发起。Renderer可以通过发送预置 Agent 消息触发工具。

`AgentSendInput` 增加可选 Browser Context reference：

```ts
export interface AgentBrowserContextInput {
  tabId: string
}
```

主进程收到后验证：

- tab 存在且是用户页面。
- tab 没有销毁。
- 当前 Renderer sender 是主窗口。
- 重新读取 URL/title/origin。
- 将可信 context 交给 Pi tool context。

---

## 18. 组件与模块规划

### 18.1 Shared

- Create: `packages/shared/src/types/browser-workflow.ts`
- Modify: `packages/shared/src/types/index.ts`
- Modify: `packages/shared/src/types/web.ts`
- Modify: `packages/shared/src/types/agent.ts`
- Modify: `packages/shared/src/types/agent-provider.ts`

### 18.2 Main

- Create: `apps/electron/src/main/lib/browser-workflow/browser-page-port.ts`
- Create: `apps/electron/src/main/lib/browser-workflow/cdp-session-router.ts`
- Create: `apps/electron/src/main/lib/browser-workflow/recording-coordinator.ts`
- Create: `apps/electron/src/main/lib/browser-workflow/recorder-script.ts`
- Create: `apps/electron/src/main/lib/browser-workflow/workflow-compiler.ts`
- Create: `apps/electron/src/main/lib/browser-workflow/locator-resolver.ts`
- Create: `apps/electron/src/main/lib/browser-workflow/workflow-store.ts`
- Create: `apps/electron/src/main/lib/browser-workflow/browser-profile-manager.ts`
- Create: `apps/electron/src/main/lib/browser-workflow/workflow-runner.ts`
- Create: `apps/electron/src/main/lib/browser-workflow/workflow-permission-policy.ts`
- Create: `apps/electron/src/main/lib/browser-workflow/browser-workflow-service.ts`
- Create: `apps/electron/src/main/lib/adapters/pi-browser-workflow-tools.ts`
- Modify: `apps/electron/src/main/lib/web-tab-manager.ts`
- Modify: `apps/electron/src/main/lib/agent-orchestrator.ts`
- Modify: `apps/electron/src/main/lib/agent-service.ts`
- Modify: `apps/electron/src/main/lib/agent-session-manager.ts`
- Modify: `apps/electron/src/main/lib/automation-scheduler.ts`
- Modify: `apps/electron/src/main/lib/migration-service.ts`
- Modify: `apps/electron/src/main/lib/config-paths.ts`
- Modify: `apps/electron/src/main/ipc.ts`
- Modify: `apps/electron/src/main/index.ts`
- Delete: `apps/electron/src/main/lib/builtin-mcp/chrome-devtools.ts`
- Delete: `apps/electron/src/main/lib/adapters/claude-agent-adapter.ts`
- Delete: `apps/electron/src/main/lib/adapters/runtime-routing-agent-adapter.ts`

### 18.3 Preload / Renderer

- Modify: `apps/electron/src/preload/index.ts`
- Create: `apps/electron/src/renderer/atoms/browser-workflow-atoms.ts`
- Create: `apps/electron/src/renderer/components/web-browser/BrowserAgentTrigger.tsx`
- Create: `apps/electron/src/renderer/components/web-browser/BrowserAgentPanel.tsx`
- Create: `apps/electron/src/renderer/components/web-browser/BrowserWorkflowStatus.tsx`
- Create: `apps/electron/src/renderer/components/agent/AgentConversationSurface.tsx`
- Create: `apps/electron/src/renderer/hooks/useAgentSessionController.ts`
- Modify: `apps/electron/src/renderer/components/web-browser/WebBrowserSurface.tsx`
- Modify: `apps/electron/src/renderer/components/agent/AgentView.tsx`
- Modify: `apps/electron/src/renderer/components/agent/tool-utils.ts`
- Modify: `apps/electron/src/renderer/components/agent/tool-phrase.ts`
- Modify: `apps/electron/src/renderer/hooks/useGlobalAgentListeners.ts`
- Modify: `apps/electron/src/renderer/lib/http-api-bridge.ts`

### 18.4 Packaging / Settings

- Modify: `package.json`
- Modify: `apps/electron/package.json`
- Modify: `apps/electron/electron-builder.yml`
- Modify: `apps/electron/src/types/settings.ts`
- Modify: `apps/electron/src/renderer/components/automation/AutomationFormView.tsx`
- Modify: `apps/electron/src/renderer/components/settings/ChannelSettings.tsx`
- Modify: `bun.lock`

---

## 19. 实施任务

### Task 1: 建立回归基线和架构契约测试

**Files:**
- Create: `apps/electron/src/main/lib/browser-workflow/browser-workflow-contract.test.ts`
- Modify: adjacent web-tab, session and automation tests

- [ ] **Step 1: 写失败测试，确认目标边界**

覆盖：shared 不再导出任意 CDP input；Preload 不再暴露 `sendCdpCommand`；default MCP 不含 chrome-devtools；Agent Runtime 新写入只能是 Pi。

- [ ] **Step 2: 运行聚焦测试并确认按预期失败**

Run: `bun test apps/electron/src/main/lib/browser-workflow/browser-workflow-contract.test.ts`

Expected: FAIL，因为当前仍公开 CDP、chrome-devtools 和 Claude runtime。

- [ ] **Step 3: 保存当前相关测试基线**

分别运行现有 web bookmark 和 web tab session tests，避免后续把既有 native overlay 回归误判成 Workflow 问题。

### Task 2: 实现 Pi-only 数据迁移

**Files:**
- Modify: `apps/electron/src/main/lib/migration-service.ts`
- Modify: `apps/electron/src/main/lib/agent-session-manager.ts`
- Modify: `apps/electron/src/main/lib/automation-manager.ts`
- Create: `apps/electron/src/main/lib/pi-only-runtime-migration.test.ts`

- [ ] **Step 1: 写 Claude/缺失 runtime 到 Pi 的迁移场景**

覆盖 session、automation、settings、备份、幂等和迁移失败保留原文件。

- [ ] **Step 2: 实现原子备份和迁移**

迁移必须在 runtime 类型收窄前落地，保证旧数据可读。

- [ ] **Step 3: 验证历史消息保留且旧 resume token 不再使用**

Run: `bun test apps/electron/src/main/lib/pi-only-runtime-migration.test.ts apps/electron/src/main/lib/agent-session-manager.test.ts`

### Task 3: 删除 Claude Code Runtime 和依赖

**Files:**
- Delete: Claude/runtime-routing adapters
- Modify: orchestrator、agent service、session manager、bridge、automation、settings、packages、builder、lockfile

- [ ] **Step 1: 将 AgentRuntime 收敛到 Pi-only 领域模型**

旧 `'claude'` 只允许出现在 migration parser fixture，不进入新写入类型。

- [ ] **Step 2: 删除 SDK import、CLI path、sidecar、env 和 process cleanup**

不要删除 Anthropic Provider 或 Claude 模型能力。

- [ ] **Step 3: 删除平台 SDK optionalDependencies 和打包条目**

Run: `bun install --lockfile-only`

- [ ] **Step 4: 扫描剩余 Claude 词条并逐项分类**

Run: `rg -n "claude-agent-sdk|ClaudeAgentAdapter|agentRuntime.*claude|'claude'" apps packages package.json bun.lock`

Expected: 只剩迁移 fixture 或描述 Claude 模型的合法内容；不剩 Claude Code Runtime。

- [ ] **Step 5: 运行 Agent/Automation/Bridge 聚焦测试**

### Task 4: 移除公开 CDP 和外部 Chrome MCP

**Files:**
- Modify: shared web types、preload、ipc、http bridge、WebBrowserSurface、orchestrator、builtin MCP catalog/settings
- Delete: `builtin-mcp/chrome-devtools.ts`

- [ ] **Step 1: 删除 Renderer 任意 CDP contract**

- [ ] **Step 2: 删除 CDP 状态 UI 和 `cdpAttached` shared state**

- [ ] **Step 3: 删除 external chrome-devtools MCP 注入**

- [ ] **Step 4: 运行契约测试，确认 Renderer/HTTP/MCP 无 CDP 入口**

### Task 5: 定义 Workflow shared schema 和验证器

**Files:**
- Create: `packages/shared/src/types/browser-workflow.ts`
- Create: `apps/electron/src/main/lib/browser-workflow/workflow-schema.ts`
- Test: schema tests

- [ ] **Step 1: 写合法/非法 manifest、version、step 和 variable 测试**

拒绝未知 schemaVersion、任意脚本、非 HTTP(S) Origin、重复 step id、未声明 tab alias 和未声明 variable。

- [ ] **Step 2: 实现 TypeScript discriminated unions 和运行时解析**

- [ ] **Step 3: 模糊输入测试不能抛出非预期异常**

### Task 6: 实现 Workflow 路径和存储

**Files:**
- Modify: `config-paths.ts`
- Create: `workflow-store.ts`
- Create: `workflow-store.test.ts`

- [ ] **Step 1: 写临时目录中的 CRUD、原子写入和版本不可变测试**

- [ ] **Step 2: 实现 manifest cache、版本文件和 run JSONL**

- [ ] **Step 3: 实现 artifact 限额和清理**

- [ ] **Step 4: 验证无数据库、无凭据字段写入**

### Task 7: 抽取 BrowserPagePort 和 CDP Session Router

**Files:**
- Create: `browser-page-port.ts`
- Create: `cdp-session-router.ts`
- Modify: `web-tab-manager.ts`
- Test: mocked debugger tests

- [ ] **Step 1: 写 attach、detach、reattach、destroy、abort 和 document epoch 测试**

- [ ] **Step 2: 将现有 web tab CDP 生命周期迁入 router**

- [ ] **Step 3: 保持 favicon、导航、收藏夹和 session persistence 行为不变**

- [ ] **Step 4: 验证 DevTools detach 时产生明确暂停状态**

### Task 8: 实现录制器、隔离 world 和 Rust JSONL 持久化

**Files:**
- Create: `recording-coordinator.ts`
- Create: `recorder-script.ts`
- Create: `rust-browser-recording-client.ts`
- Modify: `native/http-api-server/src/main.rs`
- Modify: `http-api-server.ts`
- Create: recorder/Rust endpoint tests and local fixture pages

- [ ] **Step 1: 写 click/input/submit/navigation 录制失败场景**

- [x] **Step 2: 实现 Runtime binding、nonce、trusted event 和当前页安装**

- [x] **Step 3: 在进入 Rust API 前完成 URL、Origin、nonce 和敏感字段脱敏**

- [x] **Step 4: 实现 Rust start/event/finish/cancel/content JSONL 端点和内部 token**

- [x] **Step 5: 保证事件按录制顺序串行追加，不使用 Renderer 或网页端直接访问文件**

- [ ] **Step 6: 实现 start/stop/cancel/app quit/page close 生命周期**

- [ ] **Step 7: 验证网页脚本伪造 payload 被拒绝，且 JSONL 不含普通输入原值**

### Task 9: 实现 Locator 生成和解析

**Files:**
- Create: `locator-generator.ts`
- Create: `locator-resolver.ts`
- Test: local fixture matrix

- [ ] **Step 1: 写 testId/role/label/id/text/css 优先级测试**

- [ ] **Step 2: 写动态 class、重复文本、隐藏元素和歧义测试**

- [ ] **Step 3: 实现 fingerprint 评分和置信度阈值**

- [ ] **Step 4: 导航后验证旧 node/ref 失效**

### Task 10: 实现 Agent Workflow 总结提炼和主进程校验

**Files:**
- Modify: `browser-workflow-service.ts`
- Create: `browser-workflow-agent-extraction.test.ts`
- Modify: Pi Browser Workflow tools

- [ ] **Step 1: 写读取 Rust JSONL、untrusted 内容隔离、普通输入不泄漏场景**

- [x] **Step 2: 实现 `BrowserWorkflowRecordingGet`，只向当前用户 Pi session 提供已结束录制**

- [x] **Step 3: Agent 根据 JSONL 提炼步骤、变量、Origin、等待和人工检查点，并通过 `BrowserWorkflowDraft` 提交结构化候选**

- [x] **Step 4: 主进程重新校验 sourceRecordingId、workspace、schema、step/variable 引用和 Origin 集合**

- [x] **Step 5: 用户审批后才生成不可变版本；录制 JSONL 不直接作为可执行 Workflow**

### Task 11: 实现 Workflow Runner

**Files:**
- Create: `browser-profile-manager.ts`
- Create: `workflow-runner.ts`
- Create: runner tests

- [ ] **Step 1: 写状态机、变量校验、Origin 校验、取消和超时测试**

- [ ] **Step 2: 实现 navigate/click/fill/press/select/wait/assert**

- [ ] **Step 3: 实现 run-owned page 和 profile lease**

- [ ] **Step 4: 实现失败截图和脱敏 diagnostic**

- [ ] **Step 5: 验证 run 不调用 LLM 或任意 evaluate 工具**

### Task 12: 实现跨页面和多页签执行

**Files:**
- Modify: browser page manager、web tab manager、runner、compiler
- Test: multi-page local fixture

- [ ] **Step 1: 写 opener、新页签 alias、switch、close 和未知 popup 场景**

- [ ] **Step 2: 将 `setWindowOpenHandler` 事件与当前 action 关联**

- [ ] **Step 3: 实现 allowedOrigins 和非预期页面暂停**

- [ ] **Step 4: 验证 root 页关闭和 run 取消时所有 owned pages 释放**

### Task 13: 接入 Pi native tools

**Files:**
- Create: `pi-browser-workflow-tools.ts`
- Modify: Pi adapter/tool composition、orchestrator、permission service、tool UI mappings

- [ ] **Step 1: 写工具 schema、workspace 隔离和 trigger source 权限测试**

- [x] **Step 2: 注册 list/get/record/recording-get/draft/save/run/stop/repair**

- [x] **Step 3: 将停止后的 Rust JSONL 读取和 Agent follow-up 接入同一 Pi session**

- [ ] **Step 4: 实现 long-running tool 与 Agent abort 联动**

- [ ] **Step 5: 验证不存在低层 click/type/evaluate/CDP tool**

### Task 14: 重构可复用 Agent Conversation Surface

**Files:**
- Create: `AgentConversationSurface.tsx`
- Create: `useAgentSessionController.ts`
- Modify: `AgentView.tsx`
- Test: Renderer component/state tests

- [ ] **Step 1: 为现有 AgentView 关键发送/停止/队列行为补回归测试**

- [x] **Step 2: 抽取共享 AgentConversationSurface 实现**

主 Agent 和 Browser Agent 通过 `variant="main" | "browser"` 进入同一套会话、消息、composer、权限和流式生命周期；`AgentView` 仅保留兼容适配器。

- [x] **Step 3: 保证 main/browser 两种 variant 不重复注册 listener**

两种 variant 只改变布局，IPC 流式监听仍由全局 `useGlobalAgentListeners` 维护。

- [ ] **Step 4: 验证面板切换不丢流式消息、权限请求和 pending tool**

### Task 15: 实现 Copis 工具栏入口和真实分栏侧栏

**Files:**
- Create: BrowserAgentTrigger、BrowserAgentPanel、browser-workflow-atoms
- Modify: WebBrowserSurface、global listeners

- [ ] **Step 1: 写 Jotai panel reducer/atom 测试**

- [ ] **Step 2: 替换 CDP 标识为固定尺寸 Copis 图标**

- [ ] **Step 3: 实现同级分栏、拖拽宽度和持久化**

- [ ] **Step 4: 绑定当前 tab 的可信 Browser Context**

- [ ] **Step 5: 实现 recording/running/waiting/error 图标状态**

- [ ] **Step 6: 实际网页验证面板不被 WebContentsView 覆盖**

### Task 16: 实现 Workflow 审批、人工步骤和修复 UI

**Files:**
- Create: workflow draft/run renderers
- Modify: Agent tool result renderer、Permission/AskUser integration

- [ ] **Step 1: 展示步骤、变量、Origin、profile 和 unattended 开关**

- [ ] **Step 2: 批准时由主进程重新验证 draft hash**

- [ ] **Step 3: 人工步骤完成前 runner 保持 waiting_user**

- [ ] **Step 4: repair 只创建新版本草稿，不更新 currentVersion**

### Task 17: 集成 Automation 和远程来源权限

**Files:**
- Modify: automation scheduler/tools、bridge trigger context、workflow policy

- [ ] **Step 1: 写本地/Automation/协作/远程来源权限矩阵测试**

- [ ] **Step 2: 只允许 Automation 运行 unattendedAllowed Workflow**

- [ ] **Step 3: 禁止远程来源录制可见页和扩大 Origin**

- [ ] **Step 4: run 结果进入既有 Automation 运行记录，但敏感数据保持脱敏**

### Task 18: 安全与恢复加固

**Files:**
- Test/Modify: recorder、runner、store、policy、app shutdown

- [ ] **Step 1: 覆盖页面关闭、CDP detach、Renderer reload 和应用退出**

- [ ] **Step 2: 覆盖事件伪造、超大 payload、输出上限和路径穿越**

- [ ] **Step 3: 覆盖 run crash 后 lease 回收和 JSONL 未完成标记**

- [ ] **Step 4: 覆盖并发录制、同 profile 并发 run 和重复 stop**

### Task 19: Electron E2E 与可视化回归

**Files:**
- Create: local browser workflow fixture
- Create: Electron E2E scripts/tests
- Optionally add: pinned `@playwright/test` devDependency after compatibility research

- [ ] **Step 1: 先搜索 Electron 43 与当前 Bun/Playwright 的官方兼容信息**

禁止直接采用 `@latest`。如果 Playwright Electron 能力不稳定，使用现有 CDP/HTTP 测试 harness，不让测试依赖阻塞产品功能。

- [ ] **Step 2: E2E 录制同页表单流程**

- [x] **Step 3: 真实 Electron Runner 回放跨域/新页签流程**

`bun run --filter='@copis/electron' test:browser-workflow:e2e` 使用临时 HOME/userData 和本地 HTTP fixture，覆盖 React controlled input、Tab、跨 Origin iframe、popup、close、navigation outcome、Locator 歧义和 CDP detach/resume。

- [ ] **Step 3a: 录制 Rust JSONL 并由 Pi 总结后回放**

- [ ] **Step 4: E2E 验证真实 WebContentsView 与 Agent 侧栏不重叠**

已有手工真实窗口检查覆盖侧栏 bounds；仍需将该检查固化为带截图像素断言的自动化 harness。

- [ ] **Step 5: 检查截图像素、窗口 bounds、控制台错误和原生 view 销毁竞态**

### Task 20: 文档、版本和完整验证

**Files:**
- Modify after explicit approval: `AGENTS.md`, `README.md`, `README.en.md`
- Modify: affected package manifests and lockfile

- [ ] **Step 1: 同步架构和安全约束文档**

功能实现完成后，先获得文档修改许可，再更新 AGENTS/README。记录 CDP 私有边界、Workflow 存储、侧栏与原生 View 分栏、测试命令和 Claude Runtime 移除。

- [x] **Step 2: 递增受影响包 patch 版本**

`@copis/electron` 已从 `0.16.12` 递增至 `0.16.13`，并同步 `bun.lock`；本轮没有修改 Shared 运行时契约。

- [ ] **Step 3: 运行全量类型检查、测试和构建**

- [ ] **Step 4: 运行 `git diff --check` 并审查无关改动**

---

## 20. BDD 验收场景

### 20.1 Browser Agent 入口

```text
Given 用户正在 Copis 内打开一个 HTTP(S) 网页页签
When 点击网页工具栏中的 Copis 图标
Then 网页内容区域真实缩窄
And 右侧显示绑定当前页的 Pi Agent 对话栏
And 网页不会覆盖对话栏
And 页面中不显示 CDP 状态或原始 CDP 能力
And 点击本身不会请求模型或开始录制
```

### 20.2 开始和停止录制

```text
Given Browser Agent 对话栏已绑定当前网页
When 用户发送“记录我接下来的操作”
Then Pi Agent 调用 browser_workflow_record
And Rust API 创建 recording JSONL 文件并持续追加脱敏操作事件
And 停止后状态进入 awaiting_agent_summary
And Agent 调用 browser_workflow_recording_get 读取 JSONL 并提交 browser_workflow_draft
And Copis 图标显示录制状态
And 收起侧栏不会中断录制
```

### 20.3 输入隐私

```text
Given 用户正在录制表单操作
When 用户输入普通文本、密码和一次性验证码
Then Rust JSONL 不包含普通文本原值
And Agent 将普通文本总结为变量占位符
And Agent 将密码和验证码总结为人工步骤
And Agent transcript、Workflow 文件和运行日志均不包含原始敏感值
```

### 20.4 跨页面录制

```text
Given 用户从 main 页开始录制
When 点击链接导航到另一个 Origin 并打开 detail 新页签
Then Workflow 保存 main/detail 页签 alias
And 保存导航、新页签和页签切换关系
And allowedOrigins 包含用户批准的 Origin
And 不相关的已有页签不会被自动纳入录制
```

### 20.5 确定性回放

```text
Given 用户已批准一个 Workflow version
When Agent 以合法变量运行该 Workflow
Then Runner 使用 Workflow-owned 页面逐步执行
And 每一步按声明的 Locator、Origin 和 outcome 校验
And 标准执行过程中不调用 LLM 决定下一次点击
And 完成后释放所有页面和 profile lease
```

### 20.6 页面结构变化

```text
Given 首选 Locator 已失效但存在唯一高置信度备用 Locator
When Runner 执行该步骤
Then 使用备用 Locator 完成步骤
And run log 记录 fallback_used
And 已批准 Workflow 文件不被自动修改
```

```text
Given 页面中存在多个低置信度候选目标
When Runner 无法唯一解析步骤
Then 运行暂停并生成脱敏诊断和截图
And Agent只能提出新版本草稿
And 未经用户批准不得继续危险操作或替换当前版本
```

### 20.7 权限边界

```text
Given 请求来自定时任务、远程 Bridge 或协作子 Agent
When 请求录制用户当前可见页或运行未批准 Workflow
Then 服务拒绝请求
And 不建立 CDP 控制
```

```text
Given Workflow 已被用户标记为 unattendedAllowed
When Automation 以合法输入运行该版本
Then 服务只允许访问 approved allowedOrigins
And 人工步骤出现时进入 waiting_user 而不是尝试绕过
```

### 20.8 生命周期

```text
Given Workflow 正在录制或执行
When 页面被关闭、CDP 被 DevTools 断开、Agent 被停止或应用退出
Then pending tool 和 CDP command 被有界取消
And run/recording 状态被持久化为可诊断终态
And 不产生 UnhandledPromiseRejection
```

### 20.9 Pi-only 迁移

```text
Given 本地存在 Claude runtime 或缺失 runtime 的历史会话与 Automation
When 升级后的 Copis 首次启动
Then 数据先完成原子备份
And runtime 迁移为 Pi
And 历史消息仍可读取
And 不再加载 Claude Agent SDK 或 native binary
And Anthropic/Claude 模型仍可通过 Pi 渠道使用
```

---

## 21. 测试矩阵

### 21.1 Unit

- Workflow schema validation。
- Runtime migration 和幂等备份。
- Event coalescing 和 action correlation。
- Locator generation/scoring/ambiguity。
- Workflow compiler。
- Origin policy。
- Store 原子写入、版本不可变、路径安全。
- Runner state machine、abort、timeout。
- Profile lease 和 run page cleanup。
- Sensitive data redaction。
- Pi tool schema 和 trigger source policy。
- Jotai panel/status state。

### 21.2 Integration

使用本地 fixture server 覆盖：

- 普通表单。
- React controlled input。
- SPA history navigation。
- 跨 Origin redirect。
- target=_blank / window.open。
- 重复文本和动态 class。
- 异步加载按钮。
- confirm/manual step。
- 页面关闭和 crash。

### 21.3 Electron Runtime

必须使用真实 HTTP(S) 页面和真实 `WebContentsView`：

- Copis 图标入口。
- 分栏 bounds。
- 面板展开/关闭。
- 录制状态跨页签保持。
- Workflow-owned 页面不进入 web-tabs 持久化。
- Bookmark native window 不受影响。
- DevTools detach。
- 应用退出清理。

### 21.4 建议验证命令

按测试文件隔离同名 Bun mock，尤其是 `config-paths`：

```bash
bun run typecheck
bun run --filter='@copis/electron' build:main
bun run --filter='@copis/electron' build:preload
bun run --filter='@copis/electron' build:renderer
bun test packages/shared
bun test apps/electron/src/main/lib/pi-only-runtime-migration.test.ts
bun test apps/electron/src/main/lib/browser-workflow/workflow-store.test.ts
bun test apps/electron/src/main/lib/browser-workflow/recording-coordinator.test.ts
bun test apps/electron/src/main/lib/browser-workflow/workflow-compiler.test.ts
bun test apps/electron/src/main/lib/browser-workflow/workflow-runner.test.ts
bun test apps/electron/src/main/lib/web-bookmark-service.test.ts
bun test apps/electron/src/main/lib/web-tab-session-service.test.ts
git diff --check
```

最终再运行 `bun test`。若全量测试中已有无关失败，必须单独记录，不能把聚焦测试未通过的功能标记完成。

---

## 22. 发布、迁移与回滚

### 22.1 Feature Flag

首版使用本地设置 `browserWorkflowEnabled` 控制 UI 和 Pi tools，默认开启；用户显式设置为 `false` 时可关闭，用于紧急回滚或隐私控制。

Flag 关闭时：

- 不显示工具栏 Copis Browser Agent 入口。
- 不注册 Workflow mutation tools。
- 已保存 Workflow 不删除。
- 正在运行的 run 先安全停止。

### 22.2 数据兼容

- SchemaVersion 不支持时只读并提示升级，不尝试猜测。
- 新版本 Workflow 不覆盖旧版本。
- Pi-only migration 有本地备份。
- 不删除用户项目 `.claude` 内容。
- 删除 Claude SDK 依赖前先确认 migration 已在同一版本启动路径生效。

### 22.3 回滚

若发布后需要回滚：

- 关闭 feature flag 停止 Workflow 入口。
- 保留 Workflow 文件供后续版本读取。
- 使用 migration backup 恢复 runtime metadata 时必须由显式恢复工具执行，不在启动时自动逆迁移。
- 已删除的 Claude native binary 不作为浏览器功能回滚手段；Pi-only 是独立产品决策。

---

## 23. 风险与缓解

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| 原生 WebContentsView 覆盖 DOM 面板 | 对话不可见/不可交互 | 真实分栏并更新 native bounds，不使用 overlay Sheet |
| 页面结构变化 | Workflow 失效或误点 | Locator bundle、置信度阈值、Origin/页面指纹、低置信度暂停 |
| 用户误录其它页签 | 隐私泄漏 | root+descendant scope，已有页签显式纳入 |
| 输入值进入 LLM | 敏感信息泄漏 | 源头脱敏、默认变量化、password/manual |
| CDP detach | 操作中断或状态漂移 | Router 统一处理，暂停、失效 refs、有界重连 |
| 同 profile 并发 | 登录态/业务状态冲突 | profile lease，默认串行 mutation run |
| Agent自由操作网页 | 不可审计、不确定 | 只提供 Workflow 高层工具，无 click/evaluate |
| Claude 清理破坏模型支持 | 用户无法使用 Claude 模型 | 明确只删 Claude Code Runtime，保留 Anthropic Provider + Pi |
| 历史 Claude 会话不能 resume | 会话中断 | 备份 metadata，保留 JSONL，从 Pi 新 turn 继续 |
| Workflow 日志无限增长 | 磁盘占用 | run/artifact retention 和大小上限 |
| 长运行 tool 面板卸载 | Promise 悬挂 | 主进程持有，Agent abort/app quit 统一取消 |

---

## 24. Definition of Done

所有条件同时满足才能完成：

- [ ] Copis 产品运行时不再依赖或加载 Claude Agent SDK。
- [ ] Claude 模型仍可通过 Pi + Anthropic/兼容 Provider 正常使用。
- [ ] Renderer、Preload、HTTP API 和 MCP 均没有任意 CDP 入口。
- [ ] 外部 chrome-devtools MCP 已移除。
- [ ] 网页工具栏使用 Copis 图标，不显示 CDP 测试状态。
- [ ] Browser Agent 面板在真实网页上方可见且不与原生 View 重叠。
- [ ] 用户可通过 Pi Agent 发起、停止并恢复录制状态。
- [ ] 录制可生成参数化、跨页面、可批准的 Workflow 版本。
- [ ] Runner 可确定性回放同页和多页签流程。
- [ ] Agent没有低层 click/type/evaluate/CDP 工具。
- [ ] 敏感字段、Cookie、Authorization 不进入 Workflow 和 transcript。
- [ ] Workflow 版本不可变，修复产生新版本。
- [ ] Automation 只能运行批准为 unattended 的版本。
- [ ] 页面关闭、CDP detach、Agent stop 和 app quit 无未处理 Promise。
- [ ] 聚焦测试、全量 typecheck、Main/Preload/Renderer build 和 diff check 通过。
- [ ] 在 Electron 实际窗口中完成至少一次跨页面录制和回放。
- [ ] 获得许可后同步更新 AGENTS/README，并递增受影响包 patch 版本。

---

## 25. 后续增强

首版完成后再评估：

- 跨 Origin OOPIF/iframe 完整录制。
- 文件下载和受控上传。
- Workflow 可视化编辑器。
- 条件分支、循环和数据提取步骤。
- Workflow 模板导入/导出和签名。
- 更细粒度的 profile 权限和凭据接管。
- Playwright执行后端适配，但仍不连接用户当前 Electron 页签。
- Workflow run 录屏或可选 trace。
- Agent对历史失败统计的修复建议。

这些增强不得破坏本计划确立的三个核心边界：Pi-only、CDP 私有、固定 Workflow 确定性执行。
