# 网网页签原生弹窗支持 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 支持原生 `window.open` 子窗口以及 `alert`、`confirm`、`prompt`、`beforeunload` 对话框。

**Architecture:** HTTP(S) 新窗口由 Electron 原生 `BrowserWindow` 创建并受主窗口管理。当前 `WebContentsView` 的 JavaScript 对话框通过独立 CDP bridge 处理；`prompt` 由带专用 preload 的 Copis 自有输入窗口返回结果，网页内容不会进入应用特权渲染器。

**Tech Stack:** Electron 43 `WebContentsView`/`BrowserWindow`、Chrome DevTools Protocol Page domain、TypeScript、React 18、Bun test。

**Spec:** `docs/superpowers/specs/2026-08-31-web-tab-native-popups-design.md`

## Global Constraints

- 在当前工作区原地实现，保留其他未提交改动；禁止 reset、checkout、覆盖或全局格式化。
- 不修改 `README.md` 或 `AGENTS.md`。
- 仅允许 HTTP(S) 原生子窗口。外部协议拒绝建窗后仅交给系统默认处理器。
- 所有子窗口保持 `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`，以主窗口为 parent。
- prompt 的 IPC 以 request ID、`event.sender.id` 和待处理状态校验，过期或跨窗口调用必须拒绝。
- 按 BDD/TDD 推进：每个生产行为先验证失败测试，再写最小实现。
- Electron 实机交互和视觉必须由用户确认，不能由截图替代。

---

### Task 1: 原生网页子窗口策略

**Files:**
- Create: `apps/electron/src/main/lib/web-tab-native-popup.ts`
- Create: `apps/electron/src/main/lib/web-tab-native-popup.test.ts`
- Modify: `apps/electron/src/main/lib/web-tab-manager.ts:502-532`

**Interfaces:**
- `createWebTabWindowOpenHandler(input: NativePopupContext): (details: Electron.HandlerDetails) => Electron.WindowOpenHandlerResponse`
- `installNativeWebPopupWindow(input: NativePopupInstallInput): void`

- [ ] **Step 1: Write the failing test**

在 `web-tab-native-popup.test.ts` 建立最小 fake host、popup window、webContents 与外部协议处理器。编写以下 BDD 场景：

```ts
test('Given HTTP(S) window.open When 请求新窗口 Then allow 并固定 parent 与安全 WebPreferences', () => {
  const response = createWebTabWindowOpenHandler(context)({ url: 'https://login.example' } as never)
  expect(response).toEqual(expect.objectContaining({
    action: 'allow',
    outlivesOpener: false,
    overrideBrowserWindowOptions: expect.objectContaining({
      parent: hostWindow,
      show: false,
      modal: false,
      webPreferences: expect.objectContaining({ contextIsolation: true, nodeIntegration: false, sandbox: true }),
    }),
  }))
})

test('Given 非 HTTP(S) window.open When 请求新窗口 Then deny 并打开外部协议', async () => {})
test('Given 原生子窗口 When ready-to-show Then 显示聚焦且递归安装新窗口和导航策略', () => {})
test('Given 原生子窗口 When host 或 opener 销毁 Then 安全关闭且不访问已销毁 webContents', () => {})
```

断言 handler 不调用 `createWebTabInternal`、不修改页签快照或持久化数据。

- [ ] **Step 2: Run test to verify RED**

Run: `bun test apps/electron/src/main/lib/web-tab-native-popup.test.ts`

Expected: 因模块与导出尚不存在而失败，不得是 fake 类型或拼写错误。

- [ ] **Step 3: Write minimal implementation**

实现纯策略与安装器：

```ts
export function createWebTabWindowOpenHandler(input: NativePopupContext) {
  return ({ url }: Electron.HandlerDetails): Electron.WindowOpenHandlerResponse => {
    if (!isHttpWebUrl(url)) {
      if (url) void input.openExternal(url).catch(input.logExternalFailure)
      return { action: 'deny' }
    }
    const host = input.getHostWindow()
    if (!host || host.isDestroyed()) return { action: 'deny' }
    return {
      action: 'allow',
      outlivesOpener: false,
      overrideBrowserWindowOptions: {
        parent: host,
        show: false,
        modal: false,
        autoHideMenuBar: true,
        webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
      },
    }
  }
}
```

`installNativeWebPopupWindow` 在 `did-create-window` 中递归安装 handler，阻止无效顶层导航，在 `ready-to-show` 后 show/focus，并在 owner/host 销毁时关闭。将 `web-tab-manager.ts` 现有“创建新页签并返回 deny”的 `setWindowOpenHandler` 替换为该模块；不得向 `records` 写入 popup。

- [ ] **Step 4: Run test to verify GREEN**

Run: `bun test apps/electron/src/main/lib/web-tab-native-popup.test.ts`

Expected: 4 个场景 PASS，HTTP(S) 只走 native allow，外部协议只走 deny + `openExternal`。

### Task 2: JavaScript 对话框 CDP bridge

**Files:**
- Create: `apps/electron/src/main/lib/web-tab-javascript-dialog.ts`
- Create: `apps/electron/src/main/lib/web-tab-javascript-dialog.test.ts`
- Modify: `apps/electron/src/main/lib/web-tab-manager.ts:33-51, 400-532, 778-842, 853-885, 1203-1227`

**Interfaces:**
- `createWebTabJavascriptDialogBridge(input: WebTabJavascriptDialogBridgeInput): WebTabJavascriptDialogBridge`
- `WebTabJavascriptDialogBridge.start(): Promise<void>`
- `WebTabJavascriptDialogBridge.dispose(): void`
- `JavascriptDialogPresenter.present(input): Promise<{ accept: boolean; promptText?: string }>`

- [ ] **Step 1: Write the failing test**

用可发出 `message`/`detach` 事件的 fake debugger 编写：

```ts
test('Given 无浏览器处理器的 alert When CDP 事件到达 Then 展示 presenter 并确认 dialog', async () => {
  debugger.emit('message', {}, 'Page.javascriptDialogOpening', {
    type: 'alert', message: '已保存', hasBrowserHandler: false,
  })
  await flushPromises()
  expect(present).toHaveBeenCalledWith(expect.objectContaining({ type: 'alert', message: '已保存' }))
  expect(sendCommand).toHaveBeenCalledWith('Page.handleJavaScriptDialog', { accept: true })
})

test('Given confirm 与 beforeunload When 用户取消 Then CDP 发送 accept=false', async () => {})
test('Given prompt When 用户确认文本 Then CDP 发送 accept=true 和 promptText', async () => {})
test('Given hasBrowserHandler=true When 收到事件 Then 不重复展示或提前处理', async () => {})
test('Given 第一个对话框未完成 When 第二个到达 Then 在同一 WebContents 顺序展示', async () => {})
test('Given CDP detach 或 view 销毁 When 对话框未完成 Then 取消且不命令已销毁 debugger', async () => {})
```

- [ ] **Step 2: Run test to verify RED**

Run: `bun test apps/electron/src/main/lib/web-tab-javascript-dialog.test.ts`

Expected: 因 bridge 缺失而失败。

- [ ] **Step 3: Write minimal implementation**

bridge 启动后 attach CDP、发送 `Page.enable` 并监听 `Page.javascriptDialogOpening`。仅在 `hasBrowserHandler !== true` 时排队呈现；完成后：

```ts
await sendCommand('Page.handleJavaScriptDialog', {
  accept: result.accept,
  ...(event.type === 'prompt' && result.accept ? { promptText: result.promptText ?? '' } : {}),
})
```

`alert`、`confirm`、`beforeunload` presenter 用 `dialog.showMessageBox(hostWindow, ...)`；`prompt` 暂调用 Task 3 的 `showWebJavascriptPromptWindow`。维护一个串行 Promise 队列、dispose 标记及 message/detach listener；CDP detach 后安全重连并重新 `Page.enable`。

给 `WebTabRecord` 添加 bridge。在公开页签创建后启动，在 record `destroyed`、`closeWorkflowWebTab`、无痕 view 替换、`disposeWebTabs` 和异常创建回滚时恰好 dispose 一次。bridge 是长期 CDP 使用者，`detachWebTabCdp` 不能使它永久失效。

- [ ] **Step 4: Run test to verify GREEN**

Run: `bun test apps/electron/src/main/lib/web-tab-javascript-dialog.test.ts`

Expected: alert、confirm、beforeunload、prompt、队列、销毁和 detach 场景全部 PASS。

### Task 3: 安全 prompt 窗口与独立渲染入口

**Files:**
- Create: `apps/electron/src/main/lib/web-tab-javascript-prompt-window.ts`
- Create: `apps/electron/src/main/lib/web-tab-javascript-prompt-window.test.ts`
- Create: `apps/electron/src/preload/web-javascript-prompt.ts`
- Create: `apps/electron/src/renderer/components/web-browser/WebJavascriptPromptWindowApp.tsx`
- Create: `apps/electron/src/renderer/components/web-browser/WebJavascriptPromptWindowApp.test.tsx`
- Modify: `packages/shared/src/types/web.ts:146-173`
- Modify: `apps/electron/src/main/ipc.ts:951-980`
- Modify: `apps/electron/src/renderer/main.tsx:112-117, 1125-1134`
- Modify: `apps/electron/package.json:17-35`

**Interfaces:**
- `showWebJavascriptPromptWindow(input): Promise<{ accept: boolean; promptText?: string }>`
- `getWebJavascriptPromptRequest(requestId, senderId): WebJavascriptPromptRequest | null`
- `resolveWebJavascriptPromptRequest(input, senderId): boolean`
- `window.webJavascriptPrompt.get(requestId)` / `.resolve(input)` / `.cancel(requestId)`

- [ ] **Step 1: Write the failing test**

在 prompt manager fake BrowserWindow/ipcMain 测试中覆盖：创建窗口含专用 preload、host parent 和 `window=web-javascript-prompt&requestId=` URL；正确 `webContents.id` 确认时返回输入；其他窗口或过期 request ID 返回 false；关闭窗口则返回 `{ accept: false }` 并清理映射。

在 `WebJavascriptPromptWindowApp.test.tsx` 用最小 bridge mock 覆盖默认值、确认、取消、Enter、Escape 和初始焦点。

- [ ] **Step 2: Run test to verify RED**

Run: `bun test apps/electron/src/main/lib/web-tab-javascript-prompt-window.test.ts apps/electron/src/renderer/components/web-browser/WebJavascriptPromptWindowApp.test.tsx`

Expected: 因 manager、preload 和独立 UI 入口尚不存在而失败。

- [ ] **Step 3: Write minimal implementation**

在 shared `web.ts` 增加：

```ts
JAVASCRIPT_PROMPT_GET: 'web-tabs:javascript-prompt-get'
JAVASCRIPT_PROMPT_RESOLVE: 'web-tabs:javascript-prompt-resolve'
JAVASCRIPT_PROMPT_CANCEL: 'web-tabs:javascript-prompt-cancel'
```

prompt manager 保存随机 request ID、创建窗口 `webContents.id`、文本、默认值和 resolver；创建 `{ parent: hostWindow, modal: true, show: false, width: 420, height: 220, resizable: false }` 窗口，并固定 `preload: join(__dirname, 'web-javascript-prompt-preload.cjs')`、`contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`。任何加载失败、关闭或 host 销毁均 resolve `{ accept: false }`。

独立 preload 只暴露三项固定 IPC 方法。`ipc.ts` handler 必须把 `event.sender.id` 传入 manager，不接受 Renderer 传来的 owner。新增：

```json
"build:web-javascript-prompt-preload": "esbuild src/preload/web-javascript-prompt.ts --bundle --platform=node --format=cjs --outfile=dist/web-javascript-prompt-preload.cjs --external:electron"
```

并纳入 `dev:electron`、watch 与 `build`。`main.tsx` 加 `isWebJavascriptPromptWindow` 分支。新 UI 用 Shadcn `Input`/`Button`，中文确认/取消文案，自动 focus 输入框，且只使用 `window.webJavascriptPrompt`，不能使用完整 `window.electronAPI`。

- [ ] **Step 4: Run test to verify GREEN**

Run: `bun test apps/electron/src/main/lib/web-tab-javascript-prompt-window.test.ts apps/electron/src/renderer/components/web-browser/WebJavascriptPromptWindowApp.test.tsx`

Expected: 身份校验、取消清理、输入回传和键盘场景全部 PASS。

### Task 4: 组合回归与实机验收

**Files:**
- Modify: `apps/electron/src/main/lib/web-tab-manager.ts`
- Test: `apps/electron/src/main/lib/web-tab-native-popup.test.ts`
- Test: `apps/electron/src/main/lib/web-tab-javascript-dialog.test.ts`
- Test: `apps/electron/src/main/lib/web-tab-javascript-prompt-window.test.ts`

- [ ] **Step 1: Write the failing integration test**

扩展 native popup harness，证明普通页签的 `window.open` 创建原生窗口后不改变 `WebTabsSnapshot.activeTabId` 或恢复会话；再覆盖记录关闭期间 bridge dispose 后不会重连或继续发 CDP 命令。

- [ ] **Step 2: Run test to verify RED**

Run: `bun test apps/electron/src/main/lib/web-tab-native-popup.test.ts apps/electron/src/main/lib/web-tab-javascript-dialog.test.ts`

Expected: manager 组合接线前至少一个新场景失败。

- [ ] **Step 3: Complete minimal manager assembly**

只为非 Workflow 的记录创建 dialog bridge；在创建失败、关闭、替换和 dispose 的所有路径清理。将 native popup handler 的安装收敛到 `installWebContentsHandlers`，确保恢复页签、无痕页签和新建页签一致。不得改动普通页签持久化、Agent capability、workflow-owned tab 或收藏夹原生浮层。

- [ ] **Step 4: Run complete verification**

Run:

```bash
bun test apps/electron/src/main/lib/web-tab-native-popup.test.ts
bun test apps/electron/src/main/lib/web-tab-javascript-dialog.test.ts
bun test apps/electron/src/main/lib/web-tab-javascript-prompt-window.test.ts
bun test apps/electron/src/renderer/components/web-browser/WebJavascriptPromptWindowApp.test.tsx
bun test apps/electron/src/main/lib/web-bookmark-service.test.ts
bun test apps/electron/src/main/lib/web-tab-session-service.test.ts
bun run typecheck
bun run --filter='@copis/electron' build:main
bun run --filter='@copis/electron' build:preload
bun run --filter='@copis/electron' build:renderer
git diff --check
```

Expected: 所有命令通过，且没有未解决冲突或 whitespace error。

- [ ] **Step 5: User validation**

用户在实际 Electron 窗口验证：

1. HTTP(S) `window.open` / `target="_blank"` 出现原生子窗口，而非 Copis 新页签。
2. 子窗口关闭不影响原页签；原页签或主窗口关闭后子窗口不遗留。
3. `alert`、`confirm`、`prompt` 和离开页面确认都展示，网页收到正确返回值。
4. 收藏夹浮层、无痕页签和 Browser Agent 原有行为未回归。
