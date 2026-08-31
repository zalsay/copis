# 浏览器 CDP 按需启用与 Workflow Runner 迁移设计

## 背景与根因

当前 Copis 虽然已经开始把单页签 `webContents.debugger` 改为按需挂载，但应用入口仍在 Electron ready 前为整个 Chromium 进程追加：

```text
--remote-debugging-address=127.0.0.1
--remote-debugging-port=0
```

Chromium 会把 `--remote-debugging-port=0` 视为自动化启动条件，使普通网页可观察到 `navigator.webdriver === true`。因此，单独 detach 某个页签的 `webContents.debugger` 不能让普通页签退出进程级自动化模式。当前开发进程和正式 Copis 进程中的 renderer 都继承了该参数，并在 userData 目录生成 `DevToolsActivePort`。

全局端口由产品内的 Playwright Browser Workflow Runner 使用：Runner 读取 `DevToolsActivePort`，把浏览器级 endpoint 和目标 `targetId` 传给 Node 子进程，再由生成的脚本调用 `chromium.connectOverCDP()`。该实现与原 Browser Workflow 设计中“不开放 Electron 全局远程调试端口、CDP 只在主进程内部按页签使用、Playwright 只用于开发期 E2E”的边界冲突。

## 目标

- 普通“+”页签、恢复页签、普通导航、无痕替换和 OAuth 原生子窗口默认不启用 CDP。
- 只有 Agent 发起的 `open`、Agent 明确绑定的已有页签、录制中的页签和 Workflow 自有页签按需启用 CDP。
- 产品进程不监听 browser-level CDP 端口，不生成 `DevToolsActivePort`，不把 CDP endpoint 暴露给子进程。
- Browser Workflow 继续复用 `persist:copis-web` 登录态和原生 `WebContentsView`，但由主进程确定性 Runner 执行已批准步骤。
- 保持 CDP 私有：Renderer、Preload、Rust HTTP、MCP 和 Agent 均不能发送任意 CDP method。
- 保留正常网页的原生 `window.open` / OAuth 子窗口能力，不用反检测脚本修改 `navigator.webdriver`。

## 非目标

- 不承诺绕过 Cloudflare 或其他站点的所有风控。此次修复只移除 Copis 主动产生的明确自动化启动标记；Electron User-Agent、浏览器版本、网络信誉和站点自身策略仍可能影响结果。
- 不实现 Playwright browser-level CDP 兼容代理。单个 `webContents.debugger` 不是浏览器根会话，仿造 `Browser.*`、`Target.*`、auto-attach 和多 target 生命周期等同于维护私有 CDP server。
- 不启动独立 Chromium 并复制 Cookie。该方案无法可靠复用正在运行的 Electron Session、HttpOnly Cookie、SSO/MFA 和页面交接状态。
- 不通过 preload 覆盖 `navigator.webdriver`、`alert`、`confirm` 或 `prompt`。
- 本阶段不修改 Renderer 视觉或交互设计。

## 已确认的产品边界

### 普通页签

普通页签在完整生命周期内默认不 attach `webContents.debugger`。创建、恢复、导航、刷新、无痕替换和打开 OAuth 子窗口都不能隐式触发 CDP。

普通 HTTP(S) 页面的 `window.open()` 和 `target="_blank"` 继续使用受主窗口管理的原生子窗口。该链路依赖 Electron `setWindowOpenHandler` / `did-create-window`，不依赖 CDP，因此 Google OAuth 等弹窗流程可以在无 CDP 条件下运行。

现有 JavaScript dialog bridge 依赖 `Page.javascriptDialogOpening`，必须先 attach CDP 并启用 `Page` 域。为遵守“普通页签默认无 CDP”，该 bridge 不再是普通页签的长期 owner；只有页签因 Agent、录制或 Workflow 明确启用 CDP 后才启动。普通无 CDP 页签的 `alert`、`confirm`、`prompt` 不属于本次保证范围。后续若要同时满足两者，需要单独设计不依赖 CDP 且保持同步返回语义的实现。

### Agent 页签

- Agent `open` 创建页签后立即获得该页签的 CDP lease。
- Agent 绑定已有页签时获得 lease；解绑、切换到其他页签或 session 结束时释放 lease。
- 同一 session 在异步取消录制期间重新绑定页签时，以 binding generation 判断旧清理是否仍有效，旧清理不得 detach 新 binding。
- Agent 只获得高层浏览器工具，不获得 CDP method、endpoint、sessionId 或任意脚本执行入口。

### Workflow 页签

- 正式 Workflow 只操作由 Runner 创建并登记的 workflow-owned 页签。
- 起始页签和后续 `openTab` 页签复用 `persist:copis-web` Session，但不成为普通用户页签，正常结束后自动销毁。
- Workflow 页面的 popup 由 Runner 登记为 workflow-owned 页签；普通用户页面的 popup 仍走原生子窗口，二者不能混用。
- Workflow 失败时维持现有 handoff：失败页签可提升为 Agent 可接管的普通页签，同时把 CDP lease 所有权从 Workflow 转交给 Agent。

## 架构

```text
Browser Agent / Recording / Workflow Runner
                    |
                    | acquire(owner, tabId)
                    v
             CdpSessionRouter
          / lease / generation / abort \
         v                              v
 BrowserPagePort                 lifecycle events
         |
         | send allowlisted internal commands
         v
 web-tab-manager -> WebContents.debugger -> Chromium target
```

### CdpSessionRouter

新增主进程私有 `CdpSessionRouter`，成为 `webContents.debugger` attach/detach 的唯一协调者。它按 tab 维护：

- 当前 `WebContents` identity 与 document epoch；
- `agent`、`recording`、`workflow` 三类 owner lease；
- attach generation 和 binding generation；
- pending command、CDP message listener、detach/destroy listener；
- 当前暂停原因和可恢复状态。

`acquire(tabId, owner)` 返回幂等 lease。只有第一个 lease attach debugger；只有最后一个 lease 释放后才 detach。释放旧 generation 的 lease 不影响后来创建的新 lease。页面重建、无痕替换或失败提升时，Router 显式迁移或失效旧 lease，禁止依靠异步回调猜测当前所有权。

DevTools 抢占、renderer crash、`webContents.destroyed` 或显式 detach 会取消当前 pending command。录制和 Workflow 进入明确暂停或失败状态，不能静默重连后继续使用旧 node/frame/object ID。恢复后递增 document epoch，并重新启用需要的 CDP domain。

### BrowserPagePort

`BrowserPagePort` 是录制器、Agent 高层页面控制和 Workflow Runner 共用的窄接口，但不进入 shared/preload：

```ts
interface BrowserPagePort {
  readonly tabId: string
  readonly owner: 'agent' | 'recording' | 'workflow'
  getSnapshot(): BrowserPageSnapshot
  send(command: AllowedBrowserCommand): Promise<unknown>
  onMessage(listener: BrowserCdpMessageListener): () => void
  onDetached(listener: BrowserCdpDetachListener): () => void
  onDestroyed(listener: () => void): () => void
  release(): void
}
```

Port 不接受任意字符串 method。命令使用主进程内部 discriminated union，只覆盖页面观察、定位、输入、导航、截图和必要的 Page/Runtime/DOM/Accessibility 生命周期操作。底层若仍需字符串 CDP method，只存在于 Router adapter 内部。

### 确定性 Workflow Runner

产品运行时不再生成或执行 Playwright `.mjs`。Runner 读取已经通过 schema 校验和用户批准的 `BrowserWorkflowVersion`，逐条执行固定 step union：

- `navigate`
- `click`
- `fill`
- `press`
- `select`
- `wait`
- `assert`
- `openTab`
- `switchTab`
- `closeTab`
- `manual`

Runner 维护 `tabAlias -> workflow-owned tabId`，每一步执行前验证 tab ownership、当前 Origin、URL pattern 和 document epoch。Locator 解析使用固定的主进程脚本和结构化参数，依次尝试 test id、role/name、label、name、id、text 和 CSS 策略；结果必须唯一，并与 fingerprint 的 tag、input type、可访问名称、可见/可用状态做一致性检查。网页提供的字符串只能作为数据参数，不能拼接成可执行 JavaScript。

点击、输入和选择优先复用现有 `browser-page-control-service` 中已经验证的 focus、坐标和 `Input.dispatch*` 逻辑，但 Workflow 不复用 Agent 的自由操作授权入口。敏感目标继续要求 `manual` step，Runner 不自动填写 password、OTP、支付、文件、captcha 或 secret 字段。

等待使用条件轮询和事件驱动，不使用固定 sleep 作为完成判断。每个 step 受 `timeoutMs` 和 run AbortSignal 约束；页面关闭、Origin 越界、定位不唯一、CDP detach 或 abort 都必须取消 pending work并生成现有 failure artifact。

### Playwright 的保留范围

`configurePlaywrightCdpEndpoint()` 从产品入口 `main/index.ts` 移除，`browser-workflow-runner.ts` 不再读取 endpoint，也不再启动 Node/Playwright 子进程。

Playwright 可以保留在独立开发 E2E 入口中。该入口启动专用测试 Electron 进程并显式配置临时调试端口，不进入正式包主入口，也不代表用户页签运行策略。生产构建不应从 main bundle 引用 endpoint discovery、generated script executor 或 Playwright Core runtime。

## 数据兼容与迁移

Workflow 的权威数据始终是 `BrowserWorkflowVersion.steps`，因此已有批准版本可直接交给确定性 Runner，不需要重新录制。

`approval.playwrightScriptSha256` 在读取旧数据时继续作为可选 legacy 字段接受，但新审批不再生成或校验该字段。已有 `playwright/draft.mjs` 和 `playwright/v*.mjs` 只作为无效历史产物保留，不被加载或执行；本次迁移不主动递归删除用户文件。后续可在单独、可恢复的存储迁移中清理。

Workflow manifest、版本号、批准状态、variables、allowed Origins、run JSONL 和 artifact 格式保持不变。Renderer/Preload 不新增 CDP 契约。

## 错误处理与清理

- `acquire` 失败时不创建半有效 lease，调用方收到中文错误并终止当前启动流程。
- `send` 必须同时校验 tab record、WebContents identity、`isDestroyed()`、lease generation 和 document epoch。
- 页签销毁时 Router 一次性 reject 所有 pending command、移除 listener、清除 ownership，并通知运行方。
- detach 后只有仍持有有效 lease 的 owner 可以请求恢复；已解绑或已取消的 owner不能触发重新 attach。
- Workflow abort 先停止 step、释放全部 Port，再关闭 workflow-owned 页签和 profile lease。
- 失败 handoff 先完成 ownership transfer，再由 Runner finally 清理；已提升页签不能被 finally 关闭或 detach。
- 应用退出统一 dispose Router，不能留下未处理 Promise、Node 子进程或监听端口。

## BDD 场景

```text
Given Copis 正常启动
When 用户点击“+”打开普通页签并访问 HTTP(S) 页面
Then Electron 进程和 renderer 参数中不存在 --remote-debugging-port
And 页面 navigator.webdriver 不因 Copis 配置而变为 true
And 页签没有 webContents.debugger lease

Given 普通页签未启用 CDP
When 页面通过 window.open 发起 Google OAuth
Then 创建受主窗口管理且共享原 Session 的原生子窗口
And 不为父窗口或 OAuth 子窗口启用 CDP

Given Agent 发起 browser open 或绑定已有页签
When Browser Context 建立
Then 仅目标页签获得 agent CDP lease
And 其他普通页签保持无 CDP

Given 同一 Agent session 正在异步取消录制
When session 在清理完成前重新绑定原页签
Then 旧 generation 的 finally 不释放新 binding 的 CDP lease

Given 已批准 Workflow 开始执行
When Runner 执行 navigate/click/fill/press/select/wait/assert
Then 只操作 workflow-owned 页签
And 每一步验证 Origin、locator 唯一性、timeout 和 abort

Given Workflow 打开、切换或关闭多个页签
When popup 或 openTab 产生新页面
Then 新页面被登记为 workflow-owned alias
And 普通用户页签和原生 OAuth 子窗口不进入该 registry

Given Workflow 运行时 CDP detach、renderer crash 或页面关闭
When Router 收到生命周期事件
Then pending command 被取消且运行进入暂停或失败
And 不使用旧 document/frame/object identity 继续执行

Given Workflow 执行失败并完成 handoff
When Runner finally 清理
Then 已提升页签保留并由 Agent lease 接管
And 未提升的 workflow-owned 页签全部关闭
```

## 验证

自动化验证至少包括：

```bash
bun test apps/electron/src/main/lib/cdp-session-router.test.ts
bun test apps/electron/src/main/lib/browser-page-port.test.ts
bun test apps/electron/src/main/lib/browser-workflow-runner.test.ts
bun test apps/electron/src/main/lib/browser-workflow-service.test.ts
bun test apps/electron/src/main/lib/web-tab-manager.test.ts
bun test apps/electron/src/main/lib/web-tab-manager-native-popup-integration.test.ts
bun test apps/electron/src/main/lib/web-tab-manager-promotion.test.ts
bun run typecheck
bun run --filter='@copis/electron' build:main
bun run --filter='@copis/electron' build:preload
bun run --filter='@copis/electron' build:renderer
git diff --check
```

真实 Electron E2E 使用本地 HTTP fixture 验证普通启动无 `remote-debugging-port`、`navigator.webdriver`、Agent 按需 attach、Workflow 多页签、detach/resume、失败 handoff 和退出清理。`web-bookmark-service.test.ts` 与 `web-tab-session-service.test.ts` 继续分两个 Bun 进程运行，避免 module mock 互相覆盖。

最终由用户在实际 Electron 应用窗口中确认：

- 普通“+”页签访问 `https://linux.do` 的 Cloudflare 行为；
- Google OAuth 原生子窗口跳转、登录态和关闭行为；
- Agent `open` 与绑定已有页签后的浏览器操作；
- 普通页签、Agent 页签和 Workflow 页签的视觉及交互没有回归。

不得使用截图或截图分析替代上述用户确认。
