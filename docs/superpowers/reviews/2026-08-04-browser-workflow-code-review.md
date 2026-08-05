# Copis Pi Agent Browser Workflow 代码审查

> 对照计划：`docs/superpowers/plans/2026-08-04-browser-workflow-plan.md`
>
> 审查范围：Browser Workflow 共享协议、Electron 主进程服务与 Runner、WebContentsView 生命周期、Pi 工具、IPC/Preload、Browser Agent Renderer UI、持久化和验证覆盖。
>
> 审查工作树：`/Volumes/RC500/dev/copis-browser-workflow`

## 结论

当前实现已经具备 Browser Workflow 的基础闭环，但还不能按照计划文档的 Definition of Done 标记为完成，也不建议直接合并。主要风险集中在：

- 录制范围没有 root/opener 隔离，可能收集无关页签操作。
- Compiler 和 Runner 没有可靠的 action correlation，点击导航和新页签可能重复执行。
- Locator 没有置信度、歧义检测或真正的 fallback 解析。
- CDP detach、页面关闭和长运行工具没有形成完整的状态机。
- IPC、来源、审批和 unattended 权限边界仍不完整。
- 真实跨页签、Locator、Runner、Profile lease 和权限矩阵测试缺失。

本节记录的是 Rust JSONL 改造前的审查基线；后续修订状态见下方“录制架构修订复核”。本次基线审查没有修改产品源码、README 或 `AGENTS.md`。

## 录制架构修订复核

本次按用户要求将录制链路改为“Rust API 生成操作 JSONL，最后由 Pi Agent 总结提炼”，已完成以下边界调整：

- Rust HTTP API 新增带内部 token 的 Browser Recording 端点，负责创建、追加、结束、取消和读取 `browser-recordings/{recordingId}.jsonl`；写入按录制事件串行化，并限制单行、单文件大小。
- Electron 主进程仍负责 CDP 采集、nonce、隔离世界、`event.isTrusted`、URL 脱敏和生命周期校验，但不再在停止录制时编译 Workflow。
- `BrowserWorkflowRecordingGet` 读取已结束的脱敏 JSONL，并明确将其标记为 `untrusted_browser_recording`；Pi Agent 负责总结步骤、变量、Origin 和人工检查点，再通过 `BrowserWorkflowDraft` 提交结构化草稿。
- 录制 JSONL 在持久化边界只保留稳定 tab alias；运行时页签 ID、popup ID 和链接中的敏感查询参数不会作为 Agent 输入输出。
- `BrowserWorkflowRecordingGet` 返回的工具结果显式标记为 `untrusted_browser_recording`，网页文本只能作为总结输入。
- Browser Workflow 状态通知已从所有 BrowserWindow 收窄到主渲染窗口；Browser Workflow IPC 也要求调用方是主渲染窗口。

原审查中的第 1 条调用方校验和第 2 条 Prompt URL 脱敏已在当前基线中分别加入主窗口校验/广播收窄和 `sanitizeBrowserWorkflowUrl`；session ownership 与更细粒度脱敏仍按原建议待补。

P1 表示会阻塞计划中的安全边界、数据正确性或主要产品闭环。

### 1. IPC 没有校验调用方

`bindContext`、`unbindContext`、`stopRecording`、`continueRun`、`approveDraft` 等 IPC handler 都忽略了 `event.sender`，没有确认调用者是主窗口，也没有校验调用者是否拥有目标 Agent session。

位置：

- `apps/electron/src/main/ipc.ts:999`
- `apps/electron/src/main/ipc.ts:1005`
- `apps/electron/src/main/ipc.ts:1013`
- `apps/electron/src/main/ipc.ts:1018`

Browser Workflow 状态还会广播给所有 `BrowserWindow`：

- `apps/electron/src/main/ipc.ts:1021`

这与计划第 14、15 节要求的可信 Agent 上下文和来源权限不一致。任何带有 Copis preload 的本地 Renderer 都可能查询、绑定或操作其它 session 的 Workflow 状态。

建议由主进程维护 `session -> owner webContents/workspace/context` 映射，在每个 IPC handler 校验 `event.sender`、session 所属窗口和操作权限；状态事件只发给拥有该 session 的 Renderer。

### 2. 原始网页 URL 被直接注入 Agent Prompt

Orchestrator 从 `web-tab-manager` 读取当前 tab 后，将原始 `browserTab.url` 放入系统提示词，没有复用 Workflow 的 URL 脱敏逻辑。

位置：

- `apps/electron/src/main/lib/agent-orchestrator.ts:1641`
- `apps/electron/src/main/lib/agent-prompt-builder.ts:116-123`

包含 `token`、`code`、签名或临时授权参数的 URL 会被发送给模型，违反计划第 15.3 节关于敏感 URL 和凭据不进入 Agent transcript/provider 的约束。

建议在进入 Prompt 前统一使用 URL sanitizer，仅保留 origin、pathname 和经过 allowlist 的非敏感查询参数；原始 URL 只能留在主进程短生命周期状态中。

### 3. 录制页签没有 opener 关系和范围隔离

录制监听全局 `created` 事件，新建用户页签会被自动加入当前录制，没有 `openerPageId`、action correlation 或用户显式纳入步骤。

位置：

- `apps/electron/src/main/lib/browser-workflow-service.ts:594-612`
- `apps/electron/src/main/lib/web-tab-manager.ts:300-304`

这会使用户从其它页面打开的页签也可能进入 Workflow。计划第 7.4、13 节要求只录制 root tab、root 的后代页签和用户明确纳入的已有页签。

建议让 `WebTabLifecycleEvent` 携带 `openerPageId` 和 correlation id；对无关页签暂停录制并等待用户确认，不要自动纳入。

### 4. 关闭 root tab 不会结束录制

`closed` 生命周期只从页面集合中删除 tab 并记录 `tab_close`，没有检测 `recording.startTabId`，也没有停止录制、编译或生成可恢复草稿。

位置：

- `apps/electron/src/main/lib/browser-workflow-service.ts:606-628`

root 页面关闭后，录制状态仍可能保持 `recording`，后续其它页面的操作也可能继续被收集。该行为违反计划第 7.1 和第 20.8 节的生命周期要求。

### 5. 没有全局录制互斥

`startBrowserWorkflowRecording` 只检查同一个 `sessionId` 是否已有录制：

- `apps/electron/src/main/lib/browser-workflow-service.ts:575-576`

没有检查是否已有其它 session 正在录制。两个 Browser Agent session 可以同时向网页安装 recorder、监听 binding 并收集事件，造成重复事件、binding 冲突和不可预测的草稿。

计划明确要求同一时刻只允许一个全局用户录制。建议增加主进程级 lease，并返回当前占用 session 的可诊断错误。

### 6. Compiler 和 Runner 没有 action correlation

编译器把点击触发的导航编译成 click 后的独立 navigate，虽然类型定义有 `click.expect`，但编译器和 Runner 都没有使用该 outcome。

位置：

- `apps/electron/src/main/lib/browser-workflow-service.ts:316-400`
- `apps/electron/src/main/lib/browser-workflow-runner.ts:469-480`

因此一次表单提交或带副作用的链接可能在回放时被点击一次后又导航一次，造成重复提交或错误页面状态。

`window.open` 还有重复创建问题：点击执行时 `setWindowOpenHandler` 会创建一个 Workflow tab，编译出的 `openTab` 又会创建另一个 tab；前一个 popup 不一定进入 Runner 的 `runContext.tabs`，也不一定在 finally 中释放。

建议在录制时给 click、submit、navigation、window.open 建立 correlation，编译为一个带 outcome 的业务动作；Runner 应等待 outcome，而不是重复导航。

### 7. Runner 使用合成 DOM 事件，不能保证真实浏览器语义

Runner 通过 `Runtime.evaluate`、`element.click()` 和 `dispatchEvent(new KeyboardEvent(...))` 执行操作：

- `apps/electron/src/main/lib/browser-workflow-runner.ts:120-176`
- `apps/electron/src/main/lib/browser-workflow-runner.ts:480-486`

`dispatchEvent` 的 keydown/keyup 不会产生真实键盘默认行为，Enter 提交、Tab 移焦、快捷键和部分 React controlled input 场景可能静默失败。当前实现没有覆盖计划测试矩阵中的 React controlled input、异步按钮和真实表单提交。

建议把操作封装在主进程内部的 BrowserPagePort 中，使用 CDP Input/Page 语义或经过验证的页面操作适配器；至少必须为 fill、press、select 和 click outcome 增加真实 HTTP fixture 测试。

### 8. Locator 没有置信度、歧义检测或真正的 fallback

`buildElementScript` 找到第一个满足条件的元素就执行，没有比较 fingerprint、候选数量或置信度，也没有产生 `fallback_used` 日志。

位置：

- `apps/electron/src/main/lib/browser-workflow-runner.ts:120-160`
- `apps/electron/src/main/lib/browser-workflow-runner.ts:447-496`

`framePath` 也没有被解析，当前脚本始终只查询当前 document。页面有多个相同文本或相同 role 时可能误点，而不是暂停并返回 `AMBIGUOUS_TARGET`。

此外，录制器读取 `data-test-id` 时，生成的 strategy attribute 可能仍写为 `data-testid`：

- `apps/electron/src/main/lib/browser-workflow-service.ts:125`

建议新增独立 `LocatorResolver`，返回唯一候选、置信度、使用的 strategy 和 ambiguity；不允许在低置信度时继续执行危险步骤。

### 9. CDP detach 对 Runner 是静默的

Web tab manager 在 detach 时通知了订阅者，但 Runner 没有订阅该事件。底层发送函数发现 CDP 未连接后会自动重新 attach：

- `apps/electron/src/main/lib/web-tab-manager.ts:219-231`
- `apps/electron/src/main/lib/web-tab-manager.ts:789-829`

重连后没有重新启用 `Page`、`Runtime`、DOM/Accessibility，也没有使 document epoch 或元素引用失效。Runner 可能在 CDP 状态不完整时继续执行，违反计划第 6.2 和第 23 节关于 `paused_cdp_detached` 的要求。

建议由单一 `CdpSessionRouter` 管理 attach、detach、重连、pending command 取消和 domain re-enable；Runner 必须显式暂停，不能由底层 send 函数自动恢复后继续。

### 10. 审批没有形成真正的审核边界

Browser Agent 面板没有展示步骤、变量、Origin、profile 或人工检查点，点击保存会直接调用主进程批准：

- `apps/electron/src/renderer/components/web-browser/BrowserAgentPanel.tsx:171-188`
- `apps/electron/src/main/lib/browser-workflow-service.ts:683-715`

`draftHash` 和 `approvedBySessionId` 虽在协议中定义，但没有生成或重新校验。`allowedOrigins` 也由录制期间观察到的 origin 自动汇总，没有 Origin 扩大提示。

共享协议定义了 `REJECT_DRAFT`，但没有对应的 Preload、IPC 或 UI：

- `packages/shared/src/types/browser-workflow.ts:355-367`

建议审批时主进程重新读取并校验 draft hash，UI 明确展示步骤、变量、Origin 和人工步骤，并实现 reject/discard。

### 11. `unattendedAllowed` 永远无法由用户批准

保存 Workflow 时硬编码为 false：

- `apps/electron/src/main/lib/browser-workflow-service.ts:701-712`

工具参数和 UI 都没有提供单独批准无人值守运行的流程。因此 Runner 虽然检查了 `unattendedAllowed`，但 Automation 永远无法运行用户批准的 unattended Workflow。

### 12. 录制工具不是长运行 Promise，Agent stop 不会取消录制

`BrowserWorkflowRecord` 启动录制后立即返回：

- `apps/electron/src/main/lib/adapters/pi-builtin-tools.ts:110-125`

计划第 14.2 节要求该工具保持 pending，直到用户停止；Agent abort、session delete 和 app quit 都应统一结束 pending tool。当前 Renderer 停止按钮只是直接发 IPC，之前的 Agent tool call 不会收到完成结果。

此外，系统提示词要求调用不存在的 `BrowserWorkflowStopRecording`，实际注册的工具名是 `BrowserWorkflowStop`：

- `apps/electron/src/main/lib/agent-prompt-builder.ts:121-123`
- `apps/electron/src/main/lib/adapters/pi-builtin-tools.ts:242-257`

### 13. Repair 工具无法生成新版本

`BrowserWorkflowRepair` 只返回文本 proposal，不创建新 draft；`BrowserWorkflowSave` 只能保存录制服务中的当前 draft：

- `apps/electron/src/main/lib/adapters/pi-builtin-tools.ts:163-187`
- `apps/electron/src/main/lib/browser-workflow-service.ts:683-715`

因此失败后无法按照计划“提出修复、用户批准、保存不可变新版本”，也无法真正修改 locator 或等待条件。

### 14. 没有 profile lease

Runner 只按 `sessionId` 做 active run 互斥：

- `apps/electron/src/main/lib/browser-workflow-runner.ts:515-540`

不同 session 可以同时使用 `persist:copis-web` 或同一个 Workflow profile，没有 profile lock 或串行 mutation 机制。多个 Workflow 会互相影响登录态、购物车、草稿和业务状态。

## P2 Findings

### 15. 默认读取忽略 `manifest.currentVersion`

Store 默认读取时选择目录中的最大版本，而不是 manifest 指定的 `currentVersion`：

- `apps/electron/src/main/lib/browser-workflow-store.ts:106-112`

保存时先写 manifest、后写版本文件：

- `apps/electron/src/main/lib/browser-workflow-store.ts:156-163`

崩溃后可能出现 manifest 指向不存在版本，读取逻辑却静默回退到另一个版本。该行为会使回滚和诊断结果不可靠。

### 16. Schema 对 wait/assert 条件校验过宽

Schema 只检查 condition.type 是字符串，没有完整验证 union 字段：

- `apps/electron/src/main/lib/browser-workflow-schema.ts:182-189`

额外检查表明，`{ type: "arbitrary" }` 和包含非法正则的输入都可以返回 `valid: true`。这会把错误推迟到 Runner 执行阶段。

### 17. Browser Agent 仍然挂载完整 `AgentView`

Browser panel 直接渲染 `<AgentView compact />`，没有计划中的 `AgentConversationSurface` 和 `useAgentSessionController`：

- `apps/electron/src/renderer/components/web-browser/BrowserAgentPanel.tsx:4`
- `apps/electron/src/renderer/components/web-browser/BrowserAgentPanel.tsx:195`

因此完整 Agent composer、附件和其它主 Agent 交互仍可能进入紧凑网页侧栏，且没有明确保证同一 session 只有一个可交互 Surface。

### 18. Browser Agent session 在第一条消息前进入历史

点击 Copis 图标就创建并持久化 Agent session：

- `apps/electron/src/renderer/components/web-browser/WebBrowserSurface.tsx:131-139`
- `apps/electron/src/main/lib/agent-session-manager.ts:253-294`

计划要求第一条消息前保持 draft，不立即进入左侧历史列表。当前实现违反该 UI/session 生命周期约束。

### 19. 缺少 feature flag、面板宽度持久化和拖拽调整

当前代码中没有 `browserWorkflowEnabled`。Workflow 工具和网页入口始终启用：

- `apps/electron/src/main/lib/adapters/pi-builtin-tools.ts:971-977`

Browser panel 宽度固定为 `400px`，没有 Jotai 持久化或拖拽调整：

- `apps/electron/src/renderer/components/web-browser/BrowserAgentPanel.tsx:105`

这与计划第 22.1 节的默认关闭和回滚要求不一致。

### 20. Plan mode 工具白名单不包含 BrowserWorkflowList/Get

计划第 14.1 节允许在 Plan mode 中使用 list/get，但 Orchestrator 的 `PLAN_MODE_ALLOWED_TOOLS` 没有 `BrowserWorkflowList` 或 `BrowserWorkflowGet`：

- `apps/electron/src/main/lib/agent-orchestrator.ts:1429-1435`

当前 Browser Workflow 工具名称为 PascalCase，因此不会被现有只读白名单匹配。

### 21. Automation 运行记录没有 Workflow 标识

Automation scheduler 的 `AutomationRun` 只保存 session、状态、耗时和错误：

- `apps/electron/src/main/lib/automation-scheduler.ts:181-190`

没有 `workflowId`、version 或 `runId`，计划要求的 Workflow 运行结果无法和 Automation 记录直接关联。

### 22. 锁文件没有同步受影响包版本

当前 package manifest 与 Bun lockfile 版本不一致：

- `apps/electron/package.json:3` 为 `0.16.11`，`bun.lock:39` 仍为 `0.16.10`。
- `packages/shared/package.json:3` 为 `0.1.51`，`bun.lock:182` 仍为 `0.1.50`。

这违反计划 Definition of Done 的版本同步要求，并可能使干净安装得到与源码不一致的 workspace metadata。

## 当前修复复核

本轮继续修复后，原审查项状态如下。前面的 P1/P2 章节保留为审查基线，避免丢失问题发现时的证据；以下状态以当前工作树源码为准。

### 已修复或已形成边界

- IPC handler 现在要求主渲染窗口，并校验目标 Agent session 的 `webContents` owner；Workflow 状态通知只发送给主窗口。
- 录制增加主进程全局互斥，只接收 root tab 及其 opener 后代，保存 `openerTabId` 和 `workflowOwned`；root tab 关闭会结束并完成 Rust JSONL 录制。
- Pi `BrowserWorkflowRecord` 保持 pending，直到 stop/root-close/cancel 唤醒；停止后的 JSONL 仍由 Pi 读取并总结，Renderer 不接触原始日志。
- click、submit、navigation、popup 通过 action ID 和 opener 关系关联；Schema 拒绝 click 后重复 navigate/openTab 的未接管副作用。
- Runner 的 click/fill/press/select 已使用 CDP Input/焦点操作；Locator 会比较完整候选、fingerprint、置信度和歧义，并记录 `fallback_used`；frame path 会按稳定 URL/name 从当前 frame tree 解析 execution context，点击坐标通过 `DOM.getFrameOwner`/`DOM.getBoxModel` 转换到顶层 viewport。
- CDP detach 进入显式 `paused_cdp_detached`，只有用户继续才恢复；恢复后重新启用 `Runtime`/`Page` domain，停止和取消可以解除等待。
- Draft 生成 SHA-256 hash，主进程批准前重新校验；Reject/Repair 均经过 IPC/Preload，Repair 生成新的不可变草稿版本；无人值守权限只接受 Browser Agent UI 的明确批准。
- Runner 使用 Workflow-owned views、Origin 检查、变量检查、profile lease 和终态清理；Automation run 记录现在关联 Workflow、版本和 runId。
- Store 按 `manifest.currentVersion` 读取，并先原子写版本、再更新 manifest；`wait`/`assert`/`outcome` 的 union 和正则校验已收紧。
- Browser Agent 面板宽度使用 Jotai 持久化，网页 Agent session 在首条消息前标记为 draft；Plan mode 已允许只读 Workflow 工具。
- Pi 工具在工具列表构建和每次执行时都重新检查 `browserWorkflowEnabled`；旧设置缺省和新安装默认开启，显式 `false` 仍可关闭。

### 仍需补充或部分完成

- 真实 Electron Runner 回放已覆盖 HTTP fixture、跨页签 popup、跨 Origin iframe、React controlled input、Tab 键、click/navigation outcome、Locator 歧义和 CDP detach/resume；录制端到端、IPC 权限矩阵和人工接管页签关闭回归仍未单独纳入 harness。
- 当前 E2E 为开发期可见 Workflow-owned view，以保证 Chromium CDP Input 产生可信事件；生产默认隐藏视图下的 Input 兼容性仍需另一个不改变用户页签的执行承载方案。
- `AgentConversationSurface` 已成为实际共享实现，`AgentView` 仅保留 `compact` 兼容适配器；计划中的独立 `useAgentSessionController` hook 和专门 Renderer component test 仍未单独拆出。

## 验证结果

本次 review 依据以下验证结果：

- Main build：本轮通过。
- Renderer build：本轮通过。
- Preload build：本轮通过。
- `git diff --check`：本轮通过。
- `browser-workflow-schema.test.ts`：`13 pass, 0 fail`；本轮新增 click-navigation 重复副作用、popup 重复创建和 assert/regex/profile 校验场景。
- 真实 Electron：使用独立 Vite `5175`、临时 `userData` 和本地 HTTP fixture `5176` 验证；HTTP 页签加载成功，点击 Copis 图标后显示右侧 `400px` Browser Agent sibling panel，页面仍位于左侧，面板无错误文本；CDP `Page.getFrameTree` 能识别 fixture iframe。
- 之前的真实窗口检查验证了 Browser Agent 侧栏与原生 WebContentsView 不重叠；本轮新增独立 Electron harness 通过主进程高层 Runner 入口覆盖实际回放，不绕过 Preload 暴露 raw CDP。
- `bun run --filter='@copis/electron' test:browser-workflow:e2e`：真实 Electron fixture 回放通过；`workflow-e2e-main` 为 `completed`，跨页签/iframe/React controlled input/导航步骤均完成；歧义 Locator 返回 `AMBIGUOUS_TARGET`；detach 流程发布 `paused_cdp_detached` 后经 Continue 完成。
- E2E harness 使用临时 `HOME`、`userData` 和本地 HTTP server，退出后临时目录清理完毕，不写入用户 `~/.copis-dev`。
- `AgentConversationSurface` 已成为主 Agent 与 Browser Agent 的共享实现，BrowserAgentPanel 不再直接挂载 `AgentView compact`。
- `browser-workflow-store.test.ts`：`5 pass, 0 fail`。
- `browser-workflow-profile-lease.test.ts`：`3 pass, 0 fail`。
- `web-tab-session-service.test.ts`：`3 pass, 0 fail`。
- 全量测试基线：`600 pass, 3 fail`；失败为既有 Electron Bun mock/planning 测试环境问题。
- 全量 typecheck：Browser Workflow 新增代码无错误；仍有 `planning-manager.ts` 中两个既有 `CalendarEvent.completedAt` 错误。

## 剩余修复顺序

1. 增加 Rust JSONL 录制到 Pi 总结的真实 Electron E2E，并补 IPC sender/session owner 权限矩阵。
2. 为人工接管期间关闭 Workflow-owned 页签补真实窗口回归，并确定生产隐藏执行视图的可信 CDP Input 承载方式。
3. 将 Agent 会话 controller 从 `AgentConversationSurface` 中进一步抽成 `useAgentSessionController`，补 Renderer component/state tests。
4. 重新运行全量测试并分别记录既有 planning 类型错误与 Electron mock 环境失败，不把它们混入 Workflow 回归结论。
