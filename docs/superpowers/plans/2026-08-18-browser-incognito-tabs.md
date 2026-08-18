# Browser 无痕页签 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Copis 内嵌 Chromium 页签增加不落盘的无痕 session，支持人工从全新空白页签激活，也支持 Agent 通过 `BrowserPageOpenTab({ incognito: true })` 直接创建。

**Architecture:** 复用现有 `WebContentsView`、CDP、页签生命周期和 Agent context 链路；无痕页签由主进程为每个页签生成唯一非 `persist:` partition。人工入口只在从未访问地址的空白页签上重建同一 tabId 的底层 view，Agent 入口直接创建无痕页签；普通页签恢复和授权策略保持不变。

**Tech Stack:** Electron `WebContentsView`/Session、TypeScript、Bun test、React 18、Jotai、Radix UI、Lucide icons、Preload IPC。

## Global Constraints

- 所有 partition、URL、页签生命周期和地址访问历史校验必须在主进程执行，Renderer 状态只能用于展示。
- 无痕 partition 不得使用 `persist:` 前缀，不得写入 `web-tabs.json`，每个无痕页签必须独立。
- 一旦页签访问过 HTTP(S)，即使回到 `about:blank` 也不能人工转换为无痕；Agent 仍可直接新建无痕页签。
- `BrowserPageOpenTab` 的 `incognito` 参数必须可选，缺省行为与现有普通页签完全一致。
- 无痕模式不绕过跨 Origin 审批、Browser Page control policy、敏感字段限制或 capability 校验。
- 中文注释、日志和用户提示优先；不修改 README.md 或 AGENTS.md。
- 遵循 BDD/TDD：每个生产行为先写能失败的测试并运行确认，再写最小实现。
- 保留当前 main 工作树中与本功能无关的既有改动，不执行 reset、checkout 或大范围格式化。

---

### Task 1: 共享页签契约与主进程 session 生命周期

**Files:**
- Modify: `packages/shared/src/types/web.ts`
- Modify: `apps/electron/src/main/lib/web-tab-manager.ts`
- Test: `apps/electron/src/main/lib/web-tab-manager.test.ts`

**Interfaces:**
- `WebTabState.isIncognito: boolean`
- `WebTabState.canActivateIncognito: boolean`
- `CreateWebTabInput.incognito?: boolean`
- `activateWebTabIncognito(tabId: string): WebTabsSnapshot`
- `WebTabLifecycleEvent.type` 增加 `'recreated'`

- [ ] **Step 1: 写失败测试**

在 `web-tab-manager.test.ts` 增加以下 BDD 场景，并扩展最小 Electron stub 使 `WebContentsView` 能记录 `webPreferences.partition`、`loadURL`、`close`、`session.clearStorageData` 和 debugger attach/detach：

```ts
test('Given 新建空白页签 When 激活无痕模式 Then 保留 tabId 并切换到唯一非持久 partition', () => {})
test('Given 页签已经访问 HTTP(S) When 激活无痕模式 Then 保持原页签并拒绝转换', () => {})
test('Given 页签访问地址后回到 about:blank When 激活无痕模式 Then 仍拒绝转换', () => {})
test('Given 两个无痕页签 When 创建 Then partition 不相同且都不是 persist partition', () => {})
test('Given 无痕页签 When 保存网页会话 Then 恢复快照不包含无痕页签', () => {})
```

断言必须覆盖 `isIncognito`、`canActivateIncognito`、`tabId`、`url`、active 状态、partition 以及拒绝时原 view 未被替换；不要只断言内部 mock 调用次数。

- [ ] **Step 2: 运行测试确认 RED**

Run: `bun test apps/electron/src/main/lib/web-tab-manager.test.ts`

Expected: 新增场景失败，原因是 `isIncognito`、`activateWebTabIncognito` 或无痕 partition 行为尚不存在；现有 favicon 场景仍通过。

- [ ] **Step 3: 实现最小主进程行为**

在 `WebTabRecord` 增加 `isIncognito`、`hasOpenedAddress`，在公开状态增加 `isIncognito` 和 `canActivateIncognito`。创建页签时：

```ts
const isIncognito = input.incognito === true
const partition = isIncognito
  ? `copis-incognito-${randomUUID()}`
  : normalizeWebTabPartition(input.partition)
```

将 HTTP(S) 初始地址和导航目标标记为 `hasOpenedAddress`。持久化时过滤无痕记录，并基于过滤后的普通页签重新计算 `activeTabIndex`。新增 `activateWebTabIncognito`，只接受非 Workflow-owned、`about:blank`、`!hasOpenedAddress`、非无痕记录；成功时替换底层 view 但保留 tabId/bounds/active 状态，重新 attach CDP，并发出 `recreated` 生命周期事件。拒绝或创建失败时保留旧记录。

关闭和 dispose 无痕页签时保存 session 引用，调用 `clearStorageData()` 并捕获中文警告，再执行现有 CDP/view 清理；不改变普通页签关闭语义。

- [ ] **Step 4: 运行测试确认 GREEN**

Run: `bun test apps/electron/src/main/lib/web-tab-manager.test.ts`

Expected: 新增和既有场景全部 PASS。

### Task 2: IPC、Preload 与 Renderer 页签类型

**Files:**
- Modify: `packages/shared/src/types/web.ts`
- Modify: `apps/electron/src/main/ipc.ts`
- Modify: `apps/electron/src/preload/index.ts`
- Modify: `apps/electron/src/renderer/atoms/web-tabs.ts`

**Interfaces:**
- `window.electronAPI.webTabs.activateIncognito(tabId: string): Promise<WebTabsSnapshot>`

- [ ] **Step 1: 写失败的 IPC 类型/行为测试**

在现有网页页签契约测试或新增最小测试中断言：`WEB_IPC_CHANNELS.INCOGNITO_ACTIVATE` 存在，preload 的 `webTabs.activateIncognito` 调用该通道并返回 `WebTabsSnapshot`。

- [ ] **Step 2: 运行测试确认 RED**

Run: `bun test apps/electron/src/renderer/components/web-browser/WebTabBar.test.tsx`

Expected: 新增通道/方法断言失败。

- [ ] **Step 3: 接入主进程 handler 与 preload bridge**

在 `packages/shared/src/types/web.ts` 增加 `WEB_IPC_CHANNELS.INCOGNITO_ACTIVATE = 'web-tabs:incognito-activate'`，然后在 `ipc.ts` 注册：

```ts
ipcMain.handle(WEB_IPC_CHANNELS.INCOGNITO_ACTIVATE, (_event, tabId: string) => activateWebTabIncognito(tabId))
```

在 preload 类型声明和实现中暴露 `activateIncognito`，只传递 tabId，不接受 Renderer 自定义 partition。

- [ ] **Step 4: 运行类型与契约测试确认 GREEN**

Run: `bun test apps/electron/src/renderer/components/web-browser/WebTabBar.test.tsx`

Expected: IPC 契约断言通过。

### Task 3: 地址栏无痕入口与页签视觉状态

**Files:**
- Create: `apps/electron/src/renderer/components/web-browser/browser-incognito-ui.ts`
- Test: `apps/electron/src/renderer/components/web-browser/browser-incognito-ui.test.ts`
- Modify: `apps/electron/src/renderer/components/web-browser/WebBrowserSurface.tsx`
- Modify: `apps/electron/src/renderer/components/web-browser/WebTabBar.tsx`
- Test: `apps/electron/src/renderer/components/web-browser/WebTabBar.test.tsx`

**Interfaces:**
- `getIncognitoActionState(tab: WebTabState | null): { visible: boolean; disabled: boolean; active: boolean; label: string; description: string }`

- [ ] **Step 1: 写失败的纯 UI 状态测试**

在 `browser-incognito-ui.test.ts` 写四个场景：Copis 首页不可用、全新 `about:blank` 普通页签可用、曾访问地址的普通页签禁用且提示新建空白页签、无痕页签显示激活态且不可回切。

- [ ] **Step 2: 运行测试确认 RED**

Run: `bun test apps/electron/src/renderer/components/web-browser/browser-incognito-ui.test.ts`

Expected: helper 尚不存在或状态断言失败。

- [ ] **Step 3: 实现地址栏和页签标识**

实现纯 helper，使用 `tab.canActivateIncognito` 判断“曾访问过地址”的禁用状态；`WebBrowserSurface` 在地址栏输入框右侧放置 Lucide `Incognito` 图标按钮：普通空白页签点击调用 `window.electronAPI.webTabs.activateIncognito(activeTabId)`，成功后应用快照；已访问地址时禁用并显示原因；无痕页签显示 active 状态，不提供回切。

`WebTabBar` 在无痕页签中优先显示无痕图标；普通页签保持 favicon。按钮使用现有 `BrowserToolbarButton`/Tooltip 体系，不能用文本圆角矩形替代图标。

- [ ] **Step 4: 运行 UI 测试确认 GREEN**

Run: `bun test apps/electron/src/renderer/components/web-browser/browser-incognito-ui.test.ts apps/electron/src/renderer/components/web-browser/WebTabBar.test.tsx`

Expected: helper、页签标识和既有标题栏场景全部 PASS。

### Task 4: Agent 直接创建无痕页签

**Files:**
- Modify: `apps/electron/src/main/lib/browser-workflow-service.ts`
- Modify: `apps/electron/src/main/lib/browser-agent-tool-service.ts`
- Modify: `apps/electron/src/main/lib/adapters/pi-browser-agent-tools.ts`
- Modify: `apps/electron/src/main/lib/adapters/pi-builtin-tools.ts`
- Modify: `apps/electron/src/main/lib/agent-prompt-builder.ts`
- Modify: `apps/electron/default-skills/browser-page-control/SKILL.md`
- Test: `apps/electron/src/main/lib/browser-workflow-service.test.ts`
- Test: `apps/electron/src/main/lib/browser-agent-tool-service.test.ts`
- Test: `apps/electron/src/main/lib/adapters/pi-browser-agent-tools.test.ts`
- Test: `apps/electron/src/main/lib/adapters/pi-builtin-tools.test.ts`
- Test: `apps/electron/src/main/lib/agent-prompt-builder.test.ts`
- Test: `apps/electron/src/main/lib/default-skills-manifest.test.ts`

**Interfaces:**
- `openBrowserAgentTab(sessionId: string, url: string, incognito?: boolean): BrowserPageOpenTabResult`
- `BrowserPageOpenTabResult.incognito: boolean`
- Tool input: `{ url: string; incognito?: boolean }`

- [ ] **Step 1: 写失败测试**

增加以下断言：

```ts
test('Given incognito=true When Agent opens a tab Then the dispatcher passes it to an isolated tab and result marks incognito', () => {})
test('Given incognito is omitted When Agent opens a tab Then the result remains a normal tab', () => {})
test('Given BrowserPageOpenTab schema When incognito is supplied Then the optional boolean is accepted', () => {})
test('Given browser prompt When describing new tabs Then it explains incognito has no persisted login state', () => {})
```

- [ ] **Step 2: 运行测试确认 RED**

Run: `bun test apps/electron/src/main/lib/browser-workflow-service.test.ts apps/electron/src/main/lib/browser-agent-tool-service.test.ts apps/electron/src/main/lib/adapters/pi-browser-agent-tools.test.ts apps/electron/src/main/lib/adapters/pi-builtin-tools.test.ts apps/electron/src/main/lib/agent-prompt-builder.test.ts apps/electron/src/main/lib/default-skills-manifest.test.ts`

Expected: 新增 incognito 参数、返回字段和 prompt 断言失败，既有普通打开页签场景继续通过。

- [ ] **Step 3: 实现 Agent 参数链路**

在两个 Pi tool definition 中为 `BrowserPageOpenTab` 增加 `Type.Optional(Type.Boolean())`，更新描述和 prompt snippet。Dispatcher 用严格的可选布尔解析，非布尔值拒绝；将值传给 `openBrowserAgentTab`，由 `createWebTab({ url, activate: true, incognito })` 创建并绑定。结果和成功消息明确模式，但不改变现有 approval/policy 分支。

在 `agent-prompt-builder.ts` 和 `browser-page-control/SKILL.md` 补充：需要无痕时显式传 `incognito: true`；无痕没有普通页签登录态；页面操作授权规则不变。

- [ ] **Step 4: 运行 Agent 测试确认 GREEN**

Run: `bun test apps/electron/src/main/lib/browser-workflow-service.test.ts apps/electron/src/main/lib/browser-agent-tool-service.test.ts apps/electron/src/main/lib/adapters/pi-browser-agent-tools.test.ts apps/electron/src/main/lib/adapters/pi-builtin-tools.test.ts apps/electron/src/main/lib/agent-prompt-builder.test.ts apps/electron/src/main/lib/default-skills-manifest.test.ts`

Expected: 新增和既有 Agent tool、prompt、权限场景全部 PASS。

### Task 5: CDP/Workflow 生命周期回归与交付验证

**Files:**
- Modify: `apps/electron/src/main/lib/browser-workflow-service.ts`
- Test: `apps/electron/src/main/lib/browser-workflow-service.test.ts`
- Modify: `apps/electron/src/main/lib/web-tab-manager.ts`（仅在 Task 1 接口不足时）

- [ ] **Step 1: 写失败的生命周期测试**

增加一个事件级测试：页签被 `recreated` 后，录制或 CDP 订阅从旧 target 移除并在相同 tabId 的新 target 上重新挂载；拒绝地址页签转换时不触发 recreated、不解除 binding/capability。

- [ ] **Step 2: 运行测试确认 RED**

Run: `bun test apps/electron/src/main/lib/browser-workflow-service.test.ts`

Expected: recreated 事件重挂载断言失败。

- [ ] **Step 3: 实现生命周期重挂载**

在 Browser Workflow 生命周期监听中处理 `recreated`：找到相同 tabId 的 `RecordingPage`，撤销旧 CDP listener/detach listener，重新调用 `attachRecordingPage`/录制注入逻辑；不调用 capability revoke。转换期间的旧 target 操作返回可识别的页面切换错误，新 target 准备后恢复。

- [ ] **Step 4: 运行完整目标验证**

按顺序执行：

```bash
bun test apps/electron/src/main/lib/web-tab-manager.test.ts
bun test apps/electron/src/main/lib/web-tab-session-service.test.ts
bun test apps/electron/src/main/lib/browser-workflow-service.test.ts
bun test apps/electron/src/main/lib/browser-agent-tool-service.test.ts
bun test apps/electron/src/main/lib/adapters/pi-browser-agent-tools.test.ts
bun test apps/electron/src/renderer/components/web-browser/browser-incognito-ui.test.ts
bun test apps/electron/src/renderer/components/web-browser/WebTabBar.test.tsx
bun run typecheck
bun run --filter='@copis/electron' build:main
bun run --filter='@copis/electron' build:renderer
git diff --check
```

Expected: 所有测试、类型检查和两个构建命令通过；当前 Electron 实际窗口仍由用户确认地址栏按钮、无痕状态标识、页面重新加载和登录态隔离。
