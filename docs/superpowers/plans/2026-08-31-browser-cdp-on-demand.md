# Browser CDP On-Demand Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the process-wide Electron remote-debugging endpoint, attach CDP only to Agent/recording/Workflow tabs, and replace the production Playwright Workflow runtime with a deterministic main-process CDP runner.

**Architecture:** A main-process-only `CdpSessionRouter` owns every `webContents.debugger` attach/detach and hands reference-counted `BrowserPagePort` leases to Agent, recording, and Workflow owners. Browser Workflow executes its approved high-level step union through a deterministic page-step executor and workflow-owned `WebContentsView` registry; Playwright remains limited to a dedicated development E2E process.

**Tech Stack:** Electron 43 `WebContentsView` / `webContents.debugger`, TypeScript, Bun test, local JSON/JSONL Workflow storage, existing React/Jotai UI contracts unchanged.

**Spec:** `docs/superpowers/specs/2026-08-31-browser-cdp-on-demand-design.md`

## Global Constraints

- Ordinary `+`, restored, navigated, refreshed, incognito-recreated, and OAuth popup tabs must not attach CDP implicitly.
- Only Agent `open`, Agent binding, recording, and workflow-owned tabs may acquire a CDP lease.
- Production startup must not append `remote-debugging-address` or `remote-debugging-port`, create `DevToolsActivePort`, or expose a browser-level endpoint.
- Renderer, Preload, Rust HTTP, MCP, and Agent tools must not receive arbitrary CDP methods, endpoints, target IDs, or session IDs.
- Do not spoof `navigator.webdriver`, `alert`, `confirm`, or `prompt` in preload/page JavaScript.
- Keep HTTP(S) `window.open` OAuth child windows native and CDP-free for ordinary user tabs.
- Existing Workflow `steps` are authoritative. Continue accepting legacy `approval.playwrightScriptSha256`, but do not generate or execute Playwright scripts for new approvals/runs.
- Preserve unrelated dirty files, especially `apps/electron/package.json`, the two sidebar CSS files/tests, and `apps/electron/resources/agently-cli/darwin-arm64.tar.gz`.
- Do not update `README.md`, `AGENTS.md`, package versions, dependencies, or lockfiles without separate user permission.
- Comments and logs should be Chinese except where protocol terms require English.
- Follow BDD/TDD: write a failing behavior test, confirm the expected failure, implement the smallest behavior, and rerun focused tests before each task commit.
- Electron UI and real-site acceptance are performed by the user in the actual app window; screenshots do not count as acceptance.

## File Map

- `apps/electron/src/main/lib/cdp-session-router.ts`: CDP target registration, owner leases, generations, pending-command cancellation, detach/destroy lifecycle.
- `apps/electron/src/main/lib/browser-page-port.ts`: main-process-only allowed method union and narrow port contracts.
- `apps/electron/src/main/lib/browser-workflow-page-executor.ts`: deterministic locator resolution and single-page step execution.
- `apps/electron/src/main/lib/browser-workflow-runner.ts`: run orchestration, aliases, manual/CDP pause, artifacts, handoff, cleanup.
- `apps/electron/src/main/lib/web-tab-manager.ts`: register/replace/destroy CDP targets, ordinary/workflow popup policy, workflow page lifecycle.
- `apps/electron/src/main/lib/browser-workflow-service.ts`: Agent/recording leases, binding generation, ownership transfer.
- `apps/electron/src/main/lib/browser-workflow-store.ts`: legacy Playwright metadata compatibility without new script generation.
- `apps/electron/src/main/index.ts`: no production global CDP setup.
- `apps/electron/scripts/browser-workflow-e2e-main.ts`: only remaining caller allowed to configure a browser-level debugging endpoint.

---

### Task 1: Add the CDP Session Router and Browser Page Port

**Files:**
- Create: `apps/electron/src/main/lib/browser-page-port.ts`
- Create: `apps/electron/src/main/lib/cdp-session-router.ts`
- Test: `apps/electron/src/main/lib/cdp-session-router.test.ts`

**Interfaces:**
- Consumes: an Electron-free `BrowserCdpTarget` adapter supplied by `web-tab-manager` in Task 2.
- Produces: `BrowserCdpOwner`, `BrowserCdpMethod`, `BrowserCdpTarget`, `BrowserPagePort`, `CdpSessionRouter`, and `createCdpSessionRouter()`.

The contracts must be exact:

```ts
export type BrowserCdpOwner = 'agent' | 'recording' | 'workflow'

export type BrowserCdpMethod =
  | 'DOM.setFileInputFiles'
  | 'Input.dispatchKeyEvent'
  | 'Input.dispatchMouseEvent'
  | 'Input.insertText'
  | 'Page.addScriptToEvaluateOnNewDocument'
  | 'Page.captureScreenshot'
  | 'Page.createIsolatedWorld'
  | 'Page.enable'
  | 'Page.getFrameTree'
  | 'Page.handleJavaScriptDialog'
  | 'Page.removeScriptToEvaluateOnNewDocument'
  | 'Runtime.addBinding'
  | 'Runtime.enable'
  | 'Runtime.evaluate'
  | 'Runtime.releaseObject'
  | 'Runtime.removeBinding'

export interface BrowserCdpTarget {
  readonly identity: number
  isDestroyed(): boolean
  isAttached(): boolean
  getSnapshot(): BrowserPageSnapshot
  attach(): void
  detach(): void
  sendCommand(method: BrowserCdpMethod, params?: Record<string, unknown>, sessionId?: string): Promise<unknown>
  onMessage(listener: (method: string, params: Record<string, unknown>, sessionId?: string) => void): () => void
  onDetach(listener: (reason: string) => void): () => void
  onDestroyed(listener: () => void): () => void
}

export interface BrowserPagePort {
  readonly tabId: string
  readonly owner: BrowserCdpOwner
  readonly generation: number
  readonly documentEpoch: number
  getSnapshot(): BrowserPageSnapshot
  send(method: BrowserCdpMethod, params?: Record<string, unknown>, sessionId?: string): Promise<unknown>
  onMessage(listener: (method: string, params: Record<string, unknown>, sessionId?: string) => void): () => void
  onDetached(listener: (reason: string) => void): () => void
  onDestroyed(listener: () => void): () => void
  release(): void
}

export interface CdpSessionRouter {
  registerTarget(tabId: string, target: BrowserCdpTarget): void
  replaceTarget(tabId: string, target: BrowserCdpTarget): void
  unregisterTarget(tabId: string): void
  acquire(tabId: string, owner: BrowserCdpOwner): BrowserPagePort
  hasLease(tabId: string): boolean
  getLeaseCount(tabId: string): number
  onLeaseStateChange(tabId: string, listener: (active: boolean) => void): () => void
  dispose(): void
}
```

- [ ] **Step 1: Write failing lease and lifecycle tests**

```ts
test('Given 同一页签有多个 owner When 依次释放 Then 只 attach 一次且最后一个 lease 才 detach', async () => {
  const target = createTarget(101)
  router.registerTarget('tab-1', target)
  const agent = router.acquire('tab-1', 'agent')
  const recording = router.acquire('tab-1', 'recording')
  expect(target.attachCalls).toBe(1)
  agent.release()
  expect(target.detachCalls).toBe(0)
  recording.release()
  expect(target.detachCalls).toBe(1)
})

test('Given 旧 generation lease When target 被替换且新 lease 已创建 Then 旧 release 不 detach 新 target', () => {
  const first = createTarget(101)
  const second = createTarget(202)
  router.registerTarget('tab-1', first)
  const stale = router.acquire('tab-1', 'agent')
  router.replaceTarget('tab-1', second)
  const current = router.acquire('tab-1', 'agent')
  stale.release()
  expect(second.detachCalls).toBe(0)
  current.release()
  expect(second.detachCalls).toBe(1)
})

test('Given command 尚未返回 When target destroyed Then command reject 且监听器全部清理', async () => {
  const target = createDeferredTarget(101)
  router.registerTarget('tab-1', target)
  const port = router.acquire('tab-1', 'workflow')
  const pending = port.send('Runtime.enable')
  target.emitDestroyed()
  await expect(pending).rejects.toThrow('网页页签已销毁')
  expect(target.listenerCount()).toBe(0)
})
```

- [ ] **Step 2: Run the new test and confirm it fails because the modules do not exist**

Run: `bun test apps/electron/src/main/lib/cdp-session-router.test.ts`

Expected: FAIL with module resolution errors for `cdp-session-router` / `browser-page-port`.

- [ ] **Step 3: Implement the contracts and minimal router state machine**

Implement one target entry per tab with `{ target, generation, documentEpoch, leases, pending, listeners }`. `replaceTarget()` must reject pending commands, detach/clean the old target, increment generation and document epoch, register the new target, and attach it only when a still-valid lease must be migrated. A released port must reject subsequent `send()` with `CDP lease 已释放`.

- [ ] **Step 4: Add detach/recovery and disposal tests**

```ts
test('Given debugger 意外 detach When owner 仍持有 lease Then 通知 owner 但不静默重连', () => {
  const reasons: string[] = []
  const port = acquireWorkflowPort()
  port.onDetached((reason) => reasons.push(reason))
  target.emitDetach('target closed')
  expect(reasons).toEqual(['target closed'])
  expect(target.attachCalls).toBe(1)
})

test('Given router dispose When 多页签有活动 lease Then reject pending、detach 并拒绝新 acquire', () => {
  router.dispose()
  expect(target.detachCalls).toBe(1)
  expect(() => router.acquire('tab-1', 'agent')).toThrow('CDP Router 已释放')
})
```

- [ ] **Step 5: Run focused tests and typecheck the Electron package**

Run:

```bash
bun test apps/electron/src/main/lib/cdp-session-router.test.ts
bun run --filter='@copis/electron' typecheck
```

Expected: all new tests pass; Electron typecheck passes.

- [ ] **Step 6: Commit Task 1 only**

```bash
git add apps/electron/src/main/lib/browser-page-port.ts apps/electron/src/main/lib/cdp-session-router.ts apps/electron/src/main/lib/cdp-session-router.test.ts
git commit -m "feat(electron): add CDP session router"
```

---

### Task 2: Integrate Per-Tab Leases with Web Tabs, Agent Binding, Recording, and Dialogs

**Files:**
- Modify: `apps/electron/src/main/lib/web-tab-manager.ts`
- Modify: `apps/electron/src/main/lib/web-tab-javascript-dialog.ts`
- Modify: `apps/electron/src/main/lib/browser-page-control-runtime.ts`
- Modify: `apps/electron/src/main/lib/browser-workflow-service.ts`
- Test: `apps/electron/src/main/lib/web-tab-manager.test.ts`
- Test: `apps/electron/src/main/lib/web-tab-manager-native-popup-integration.test.ts`
- Test: `apps/electron/src/main/lib/web-tab-manager-promotion.test.ts`
- Test: `apps/electron/src/main/lib/browser-workflow-service.test.ts`

**Interfaces:**
- Consumes: `createCdpSessionRouter()`, `CdpSessionRouter.acquire()`, and `BrowserPagePort` from Task 1.
- Produces: `acquireWebTabPagePort(tabId: string, owner: BrowserCdpOwner): BrowserPagePort` and `subscribeWorkflowWebTabOpened(parentTabId: string, listener: (tab: WebTabState) => void): () => void` from `web-tab-manager`.
- Removes after all callers migrate: direct `ensureWebTabCdpAttached()`, `detachWebTabCdp()`, and implicit attach inside `sendWebTabCdpCommandInternal()`.

- [ ] **Step 1: Add failing BDD tests for ordinary tabs and Agent leases**

```ts
test('Given 普通页签 When 创建、导航、刷新和无痕替换 Then 全程不 attach debugger', async () => {
  const tab = createWebTab({ url: 'https://example.com' })
  navigateWebTab(tab.id, 'https://example.com/next')
  reloadWebTab(tab.id)
  expect(allDebuggerAttachCalls()).toBe(0)
})

test('Given Agent 绑定已有页签 When 建立和解除 Context Then 只在绑定期间持有 agent lease', () => {
  bindBrowserAgentContext('session-1', { tabId: 'tab-1' })
  expect(routerOwners('tab-1')).toEqual(['agent'])
  unbindBrowserAgentContext('session-1')
  expect(routerOwners('tab-1')).toEqual([])
})

test('Given 解绑取消录制尚未结束 When 同 session 重新绑定原页签 Then 旧 finally 不释放新 binding', async () => {
  startDeferredRecording('session-1', 'tab-1')
  unbindBrowserAgentContext('session-1')
  bindBrowserAgentContext('session-1', { tabId: 'tab-1' })
  finishDeferredRecordingCancellation()
  await cancellationSettled()
  expect(routerOwners('tab-1')).toEqual(['agent'])
})
```

- [ ] **Step 2: Run the focused tests and confirm they fail on the old attach/detach APIs or rebinding race**

Run:

```bash
bun test apps/electron/src/main/lib/web-tab-manager.test.ts
bun test apps/electron/src/main/lib/browser-workflow-service.test.ts
```

Expected: the new ownership assertions fail before implementation. Record the two known pre-existing favicon failures separately if they remain.

- [ ] **Step 3: Register every WebContents target with the router**

At tab creation call `router.registerTarget(tabId, createElectronCdpTarget(webContents))`; on incognito recreation call `router.replaceTarget()` before destroying the old WebContents; on close/destroy call `router.unregisterTarget()`. The adapter must guard `webContents.isDestroyed()` before attach, detach, send, or listener removal.

- [ ] **Step 4: Replace binding and recording booleans with explicit lease objects**

Add fields to the in-memory binding/recording records:

```ts
interface BrowserAgentBinding {
  // existing fields
  generation: number
  cdpPort: BrowserPagePort
}

interface RecordingPage {
  // existing fields
  cdpPort: BrowserPagePort
}
```

Increment binding generation on every bind. In asynchronous unbind cleanup, capture `{ generation, cdpPort }` and release only that captured port. Do not rescan bindings with `isTabReferenced(..., sessionId)` to decide whether a newer generation should detach.

- [ ] **Step 5: Move Agent page control and recording commands to their owner ports**

`browser-page-control-runtime` resolves the current binding's `cdpPort.send()`. Recording setup/removal uses each `RecordingPage.cdpPort`; it must release after removing bindings/scripts, with `finally` guarded against destroyed targets.

- [ ] **Step 6: Bind JavaScript dialog bridge lifetime to active leases without creating its own lease**

Use `router.onLeaseStateChange(tabId, ...)`: on first active lease start the dialog bridge using the router-backed send/event channel; on last release dispose it before debugger detach. Ordinary tabs with zero leases never start the bridge. Add assertions:

```ts
test('Given 普通页签没有 lease Then dialog bridge 不启用 Page domain', () => {
  createWebTab({ url: 'https://example.com' })
  expect(sentMethods()).not.toContain('Page.enable')
})

test('Given Agent lease 建立后又释放 Then bridge 启动一次并在 detach 前 dispose', () => {
  const port = acquireWebTabPagePort('tab-1', 'agent')
  expect(sentMethods()).toContain('Page.enable')
  port.release()
  expect(lifecycleOrder()).toEqual(['bridge:start', 'bridge:dispose', 'debugger:detach'])
})
```

- [ ] **Step 7: Preserve ordinary OAuth popup behavior and add workflow popup registration**

Ordinary parent tabs continue creating native child `BrowserWindow`s without a lease. Workflow-owned parents intercept allowed HTTP(S) popup requests into `createWorkflowWebTab()` using the same partition and notify `subscribeWorkflowWebTabOpened`; they must not enter ordinary tab persistence.

- [ ] **Step 8: Run all Task 2 tests and main build**

Run:

```bash
bun test apps/electron/src/main/lib/browser-workflow-service.test.ts
bun test apps/electron/src/main/lib/web-tab-manager-native-popup-integration.test.ts
bun test apps/electron/src/main/lib/web-tab-manager-promotion.test.ts
bun test apps/electron/src/main/lib/web-tab-manager.test.ts
bun run --filter='@copis/electron' build:main
```

Expected: focused lifecycle tests pass; any existing favicon failures are documented with before/after evidence and not masked.

- [ ] **Step 9: Commit only the Task 2 implementation and tests**

```bash
git add apps/electron/src/main/lib/web-tab-manager.ts apps/electron/src/main/lib/web-tab-javascript-dialog.ts apps/electron/src/main/lib/browser-page-control-runtime.ts apps/electron/src/main/lib/browser-workflow-service.ts apps/electron/src/main/lib/web-tab-manager.test.ts apps/electron/src/main/lib/web-tab-manager-native-popup-integration.test.ts apps/electron/src/main/lib/web-tab-manager-promotion.test.ts apps/electron/src/main/lib/browser-workflow-service.test.ts
git commit -m "fix(electron): lease CDP only to browser agents"
```

---

### Task 3: Implement Deterministic Workflow Page Steps

**Files:**
- Create: `apps/electron/src/main/lib/browser-workflow-page-executor.ts`
- Create: `apps/electron/src/main/lib/browser-workflow-page-executor.test.ts`
- Modify: `apps/electron/src/main/lib/browser-page-control-service.ts`

**Interfaces:**
- Consumes: `BrowserPagePort`, existing `BrowserWorkflowStep`, `BrowserLocatorBundle`, `BrowserWorkflowValue`, and `BrowserWorkflowVersion` types.
- Produces:

```ts
export interface BrowserWorkflowPageRuntime {
  getTab(tabId: string): { id: string; url: string; title: string; isLoading: boolean } | undefined
  navigate(tabId: string, url: string): void
  waitForLoad(tabId: string, timeoutMs: number, signal: AbortSignal): Promise<void>
}

export interface BrowserWorkflowPageStepInput {
  step: Exclude<BrowserWorkflowStep, BrowserOpenTabStep | BrowserSwitchTabStep | BrowserCloseTabStep | BrowserManualStep>
  tabId: string
  port: BrowserPagePort
  allowedOrigins: string[]
  variables: Record<string, string | number | boolean>
  signal: AbortSignal
}

export interface BrowserWorkflowPageStepResult {
  fallbackUsed: boolean
  expectsNewTabAlias?: string
}

export function createBrowserWorkflowPageExecutor(runtime: BrowserWorkflowPageRuntime): {
  execute(input: BrowserWorkflowPageStepInput): Promise<BrowserWorkflowPageStepResult>
}
```

- [ ] **Step 1: Write failing locator tests for uniqueness, fallback, fingerprint, and sensitivity**

```ts
test('Given 首选 locator 无匹配且第二策略唯一 When click Then 标记 fallback_used', async () => {
  runtime.setEvaluationResult({ matches: [{ selector: '#account', tagName: 'a', accessibleName: '账户', visible: true, enabled: true }], strategyIndex: 1 })
  await expect(executor.execute(clickInput())).resolves.toEqual({ fallbackUsed: true })
})

test('Given locator 匹配多个可见元素 When execute Then 拒绝歧义目标', async () => {
  runtime.setEvaluationResult({ matches: [candidate1, candidate2], strategyIndex: 0 })
  await expect(executor.execute(clickInput())).rejects.toThrow('AMBIGUOUS_TARGET')
})

test('Given fingerprint 指向 password/otp/payment/file/captcha/secret When 自动 fill Then 拒绝执行', async () => {
  await expect(executor.execute(fillSensitiveInput('password'))).rejects.toThrow('Workflow 不允许自动填写敏感字段')
})
```

- [ ] **Step 2: Run the test and confirm the executor module is missing**

Run: `bun test apps/electron/src/main/lib/browser-workflow-page-executor.test.ts`

Expected: FAIL because `browser-workflow-page-executor` does not exist.

- [ ] **Step 3: Extract reusable focus/input primitives without changing Agent behavior**

Move only pure source builders/parsers required by both services into named exports within `browser-page-control-service.ts` or a focused sibling if the file would grow. Preserve current Agent authorization and sensitive-field checks exactly; Workflow calls the pure primitives through its own approved-step boundary.

- [ ] **Step 4: Implement structured locator resolution**

Use one fixed `Runtime.evaluate` source with locator data passed through `JSON.stringify` as inert values. Support the existing strategy order: test id, role/name, label, name, id, text, CSS, then the existing anchor href fingerprint fallback. Return only serializable selector/fingerprint/point data. Require exactly one visible candidate and compare tagName, inputType, accessibleName, visible, and enabled fields.

- [ ] **Step 5: Implement navigate/click/fill/press/select/wait/assert**

Use `Input.dispatchMouseEvent`, `Input.dispatchKeyEvent`, and `Input.insertText` after validated focus. `select` uses the validated option index and dispatches input/change through a fixed source. `wait` polls every 100ms until its structured condition succeeds, timeout expires, or `signal.aborted`; it must not use a fixed completion sleep.

- [ ] **Step 6: Add BDD tests for every page step and cancellation**

```ts
test.each(['navigate', 'click', 'fill', 'press', 'select', 'wait', 'assert'])('Given approved %s step When execute Then only allowed port methods are used', async (type) => {
  await executeFixtureStep(type)
  expect(port.methods.every((method) => ALLOWED_METHODS.has(method))).toBe(true)
})

test('Given wait 正在轮询 When signal abort Then 立即取消且不再 send', async () => {
  const pending = executor.execute(waitInput(controller.signal))
  controller.abort()
  await expect(pending).rejects.toThrow('Browser Workflow 已取消')
  expect(port.sendCountAfterAbort()).toBe(0)
})

test('Given 当前页面 Origin 与 step 不同 When execute Then 在页面操作前拒绝', async () => {
  runtime.setUrl('https://evil.example/')
  await expect(executor.execute(clickInput())).rejects.toThrow('页面 Origin 不在 Workflow 白名单内')
})
```

- [ ] **Step 7: Run focused tests, Agent control regression, and typecheck**

Run:

```bash
bun test apps/electron/src/main/lib/browser-workflow-page-executor.test.ts
bun test apps/electron/src/main/lib/browser-page-control-service.test.ts
bun run --filter='@copis/electron' typecheck
```

- [ ] **Step 8: Commit Task 3**

```bash
git add apps/electron/src/main/lib/browser-workflow-page-executor.ts apps/electron/src/main/lib/browser-workflow-page-executor.test.ts apps/electron/src/main/lib/browser-page-control-service.ts
git commit -m "feat(electron): execute workflow steps over CDP"
```

---

### Task 4: Replace the Playwright Runner with Deterministic Multi-Tab Orchestration

**Files:**
- Modify: `apps/electron/src/main/lib/browser-workflow-runner.ts`
- Modify: `apps/electron/src/main/lib/browser-workflow-runner.test.ts`
- Modify: `apps/electron/src/main/lib/browser-workflow-service.ts`
- Modify: `apps/electron/src/main/lib/browser-workflow-service.test.ts`

**Interfaces:**
- Consumes: `acquireWebTabPagePort()`, `subscribeWorkflowWebTabOpened()`, and `createBrowserWorkflowPageExecutor()`.
- Produces: existing public functions unchanged: `runBrowserWorkflow()`, `continueBrowserWorkflowRun()`, `stopBrowserWorkflowRun()`, and `stopAllBrowserWorkflowRuns()`.
- Removes production imports of `getPlaywrightCdpEndpoint`, `resolvePlaywrightCoreEntrypoint`, `browser-workflow-playwright-script`, `browser-workflow-playwright-executor`, and Node runtime resolution.

- [ ] **Step 1: Rewrite runner tests as failing deterministic-runtime BDD scenarios**

Replace script mocks with port/executor mocks and assert behavior, not source strings:

```ts
test('Given 已批准 Workflow When 运行 Then 创建 workflow-owned 起始页、获取 workflow lease 并逐步执行', async () => {
  await expect(runBrowserWorkflow(runInput)).resolves.toMatchObject({ status: 'completed' })
  expect(createdTabs[0]).toMatchObject({ partition: 'persist:copis-web' })
  expect(acquiredPorts).toEqual([{ tabId: 'workflow-tab', owner: 'workflow' }])
  expect(executedStepIds).toEqual(['step-1'])
  expect(startedNodeProcesses).toBe(0)
})

test('Given openTab/switchTab/closeTab When 运行 Then alias 只指向 workflow-owned 页签并按结束顺序释放', async () => {
  await runBrowserWorkflow(multiTabInput)
  expect(aliasHistory).toEqual([
    ['main', 'workflow-tab-1'],
    ['details', 'workflow-tab-2'],
  ])
  expect(closedTabs).toEqual(['workflow-tab-2', 'workflow-tab-1'])
})
```

- [ ] **Step 2: Run runner tests and confirm old Playwright assertions fail**

Run: `bun test apps/electron/src/main/lib/browser-workflow-runner.test.ts`

Expected: FAIL because the current runner still requests target ID/endpoint and starts the script executor.

- [ ] **Step 3: Implement alias and lease orchestration**

Create the start tab, acquire a `workflow` port, and store `{ tabId, port }` under `workflow.version.start.tabAlias`. Route page steps to Task 3. Handle `openTab`, `switchTab`, and `closeTab` in the runner; reject missing/duplicate aliases. For `click.expect.newTab`, subscribe before dispatching the click and accept only a child emitted for the active workflow parent within the step timeout.

- [ ] **Step 4: Preserve manual and CDP pause/resume behavior**

For `manual`, call `setWorkflowWebTabVisible(activeTabId, true)`, publish `waiting_user`, install `active.resumeManual`, then hide and resume after continuation. On port detach publish `paused`; continuation reacquires a fresh workflow port, increments document epoch, reruns the interrupted step from its beginning, and never reuses an old locator/object ID.

- [ ] **Step 5: Preserve events, artifacts, and failure handoff**

Keep existing run JSONL/status events. On page-step fallback append `fallback_used`. On failure try `Page.captureScreenshot`, decode base64 to `Uint8Array`, write `failure.png`, and always write sanitized `failure.json`. Complete Agent ownership transfer in `handoffBrowserWorkflowFailure()` before releasing the workflow port; runner `finally` must not close a promoted tab.

- [ ] **Step 6: Add cleanup/race tests**

```ts
test('Given Workflow abort When step pending Then 先取消 step 和 release ports，再关闭 tabs/profile lease', async () => {
  controller.abort()
  await run
  expect(cleanupOrder).toEqual(['step:abort', 'port:release', 'tab:close', 'profile:release'])
})

test('Given failure handoff 已提升页签 When finally 执行 Then 页签保留且 Agent lease 有效', async () => {
  await expect(runBrowserWorkflow(failingInput)).rejects.toThrow()
  expect(promotedTabs).toEqual(['workflow-tab'])
  expect(closedTabs).not.toContain('workflow-tab')
  expect(routerOwners('workflow-tab')).toEqual(['agent'])
})

test('Given popup 来自普通页签 When Workflow 等待 newTab Then 不登记该 popup', async () => {
  emitOrdinaryPopup('user-tab', 'https://example.com')
  await expect(run).rejects.toThrow('Workflow 新页签等待超时')
})
```

- [ ] **Step 7: Run runner/service/router regression tests**

Run:

```bash
bun test apps/electron/src/main/lib/browser-workflow-runner.test.ts
bun test apps/electron/src/main/lib/browser-workflow-service.test.ts
bun test apps/electron/src/main/lib/browser-workflow-page-executor.test.ts
bun test apps/electron/src/main/lib/cdp-session-router.test.ts
bun run --filter='@copis/electron' build:main
```

- [ ] **Step 8: Commit Task 4**

```bash
git add apps/electron/src/main/lib/browser-workflow-runner.ts apps/electron/src/main/lib/browser-workflow-runner.test.ts apps/electron/src/main/lib/browser-workflow-service.ts apps/electron/src/main/lib/browser-workflow-service.test.ts
git commit -m "refactor(electron): run workflows in main process"
```

---

### Task 5: Remove Production Global CDP and Stop Generating Playwright Artifacts

**Files:**
- Modify: `apps/electron/src/main/index.ts`
- Modify: `apps/electron/src/main/lib/browser-workflow-store.ts`
- Modify: `apps/electron/src/main/lib/browser-workflow-store.test.ts`
- Modify: `apps/electron/src/main/lib/browser-workflow-schema.ts`
- Modify: `packages/shared/src/types/browser-workflow.ts`
- Create: `apps/electron/src/main/lib/browser-cdp-startup-contract.test.ts`
- Retain for dev E2E only: `apps/electron/src/main/lib/playwright-cdp-endpoint.ts`
- Retain for dev E2E only: `apps/electron/src/main/lib/browser-workflow-playwright-script.ts`
- Retain for dev E2E only: `apps/electron/src/main/lib/browser-workflow-playwright-executor.ts`

**Interfaces:**
- Consumes: Task 4 runner no longer needs endpoint or scripts.
- Produces: new approvals with no `playwrightScriptSha256`; old versions containing a valid 64-character hash still parse and run from `steps`.

- [ ] **Step 1: Add failing startup and legacy storage tests**

```ts
test('Given production main entry When inspected Then it never configures a global remote debugging endpoint', () => {
  const source = readFileSync(join(import.meta.dir, '../index.ts'), 'utf8')
  expect(source).not.toContain('configurePlaywrightCdpEndpoint')
  expect(source).not.toContain('remote-debugging-port')
})

test('Given 新 Workflow 获批 When 保存版本 Then 不生成脚本摘要或 playwright 文件', () => {
  const approved = approveBrowserWorkflowDraft(input)
  expect(approved.approval.playwrightScriptSha256).toBeUndefined()
  expect(findPlaywrightArtifacts()).toEqual([])
})

test('Given 旧版本含 playwrightScriptSha256 When 读取 Then schema 兼容且 steps 保持不变', () => {
  const legacy = createLegacyApprovedVersion('a'.repeat(64))
  expect(readVersion(legacy)).toMatchObject({ approval: { status: 'approved', playwrightScriptSha256: 'a'.repeat(64) } })
})
```

- [ ] **Step 2: Run tests and confirm the production entry and store still use Playwright**

Run:

```bash
bun test apps/electron/src/main/lib/browser-cdp-startup-contract.test.ts
bun test apps/electron/src/main/lib/browser-workflow-store.test.ts
```

- [ ] **Step 3: Remove the production startup call**

Delete the import and `configurePlaywrightCdpEndpoint(app)` call from `main/index.ts`. Do not change the dedicated E2E main, which explicitly owns its temporary endpoint.

- [ ] **Step 4: Stop writing scripts and hashes on draft/approval**

Remove production store imports/calls to `writeBrowserWorkflowPlaywrightDraft`, `writeBrowserWorkflowPlaywrightVersion`, and `getBrowserWorkflowPlaywrightScriptSha256`. Keep schema parsing of the optional legacy field. Update its shared comment to `旧版 Playwright 运行产物摘要，仅用于读取兼容；新版本不再生成。`

- [ ] **Step 5: Prove the production main graph no longer references Playwright runtime**

Run:

```bash
rg -n "getPlaywrightCdpEndpoint|connectOverCDP|startBrowserWorkflowPlaywrightScript|resolvePlaywrightCoreEntrypoint" apps/electron/src/main/index.ts apps/electron/src/main/lib/browser-workflow-runner.ts apps/electron/src/main/lib/browser-workflow-store.ts
```

Expected: no matches. Matches may remain only in dedicated Playwright/dev E2E modules and tests.

- [ ] **Step 6: Run storage/schema/shared and build checks**

Run:

```bash
bun test apps/electron/src/main/lib/browser-cdp-startup-contract.test.ts
bun test apps/electron/src/main/lib/browser-workflow-store.test.ts
bun test apps/electron/src/main/lib/browser-workflow-schema.test.ts
bun run typecheck
bun run --filter='@copis/electron' build:main
```

- [ ] **Step 7: Commit Task 5**

```bash
git add apps/electron/src/main/index.ts apps/electron/src/main/lib/browser-workflow-store.ts apps/electron/src/main/lib/browser-workflow-store.test.ts apps/electron/src/main/lib/browser-workflow-schema.ts packages/shared/src/types/browser-workflow.ts apps/electron/src/main/lib/browser-cdp-startup-contract.test.ts
git commit -m "fix(electron): remove global browser debugging"
```

---

### Task 6: Run Real Electron Integration, Simplification Review, and Final Verification

**Files:**
- Modify: `apps/electron/scripts/browser-workflow-e2e-main.ts`
- Modify: `apps/electron/scripts/browser-workflow-e2e.ts`
- Test: all files touched by Tasks 1-5

**Interfaces:**
- Consumes: final Router, Agent leases, deterministic runner, and dev-only E2E endpoint.
- Produces: machine-checkable E2E evidence plus a user acceptance checklist; no README/AGENTS/package-version changes.

- [ ] **Step 1: Add E2E assertions that separate product and test process behavior**

The dedicated fixture process may contain `--remote-debugging-port=0`; the normal product entry must not. Add fixture pages for `navigator.webdriver`, ordinary OAuth-style `window.open`, Agent open/bind, workflow popup, detach/resume, and failure handoff. Do not use screenshots as pass criteria.

```ts
assert.equal(await ordinaryPage.evaluate(() => navigator.webdriver), false)
assert.equal(await mainProcessHasArgument('--remote-debugging-port'), false)
assert.equal(existsSync(join(isolatedUserData, 'DevToolsActivePort')), false)
assert.equal(await getDebuggerAttached(ordinaryTabId), false)
assert.equal(await getDebuggerAttached(agentTabId), true)
```

If the existing E2E harness itself requires a global test endpoint, obtain product-process assertions from a second normal Electron launch with an isolated temporary userData directory; never infer normal startup behavior from the instrumented process.

- [ ] **Step 2: Run the real Electron Workflow E2E**

Run: `bun run --filter='@copis/electron' test:browser-workflow:e2e`

Expected: ordinary launch has no remote-debugging argument, Agent/Workflow fixture actions pass, popup ownership is isolated, detach/resume and handoff complete without unhandled rejection.

- [ ] **Step 3: Run the repository-required browser tests in separate Bun processes**

Run:

```bash
bun test apps/electron/src/main/lib/web-bookmark-service.test.ts
bun test apps/electron/src/main/lib/web-tab-session-service.test.ts
```

Expected: both pass independently; do not combine them because their `config-paths` mocks conflict.

- [ ] **Step 4: Run the complete focused regression set**

Run:

```bash
bun test apps/electron/src/main/lib/cdp-session-router.test.ts
bun test apps/electron/src/main/lib/browser-workflow-page-executor.test.ts
bun test apps/electron/src/main/lib/browser-workflow-runner.test.ts
bun test apps/electron/src/main/lib/browser-workflow-service.test.ts
bun test apps/electron/src/main/lib/browser-page-control-service.test.ts
bun test apps/electron/src/main/lib/web-tab-manager.test.ts
bun test apps/electron/src/main/lib/web-tab-manager-native-popup-integration.test.ts
bun test apps/electron/src/main/lib/web-tab-manager-promotion.test.ts
bun test apps/electron/src/main/lib/web-tab-native-popup.test.ts
bun test apps/electron/src/main/lib/web-tab-javascript-dialog.test.ts
```

- [ ] **Step 5: Run typecheck and all Electron builds**

Run:

```bash
bun run typecheck
bun run --filter='@copis/electron' build:main
bun run --filter='@copis/electron' build:preload
bun run --filter='@copis/electron' build:renderer
git diff --check
```

- [ ] **Step 6: Run the required simplification review**

Dispatch a fresh reviewer subagent with ownership limited to the files changed by this plan. Ask it to identify unnecessary abstractions, duplicate lifecycle logic, large mixed-responsibility functions, and deviations from existing project patterns. Apply only behavior-preserving simplifications, then rerun Steps 4-5. This fulfills the repository's `@code-simplifier` requirement without changing unrelated files.

- [ ] **Step 7: Run final code review and inspect the combined diff**

Review from the implementation base through HEAD. Explicitly check: no arbitrary CDP interface escaped main; every lease is released; generation guards prevent stale cleanup; production main has no endpoint; ordinary popup behavior remains native; legacy workflows still parse; no secrets/logged endpoint; unrelated dirty files are unstaged.

- [ ] **Step 8: Commit E2E-only changes if any**

```bash
git add apps/electron/scripts/browser-workflow-e2e-main.ts apps/electron/scripts/browser-workflow-e2e.ts
git commit -m "test(electron): verify on-demand browser CDP"
```

- [ ] **Step 9: Hand off real-window acceptance to the user**

Ask the user to verify in the actual Electron app:

1. Open `https://linux.do` from `+` and confirm Cloudflare behavior.
2. Complete Google OAuth through the native child window and confirm shared login state/close behavior.
3. Let Agent `open` a page and bind an existing page; confirm operations work only after explicit enablement.
4. Run a multi-step Workflow and confirm manual pause, popup/new-tab, failure handoff, and visual interaction.

Do not claim these UI/real-site items passed until the user confirms them.
