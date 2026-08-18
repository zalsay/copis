# Browser 无痕页签设计

## 目标

为 Copis 内嵌 Chromium 网页页签增加无痕模式支持：人工用户可以从新建的空白页签进入无痕模式，Agent 可以通过 `BrowserPageOpenTab` 直接新建无痕页签。无痕页签不持久化、不跨页签共享浏览器存储，也不在应用重启后恢复。

## 已确认的行为边界

- 普通页签和无痕页签都使用现有 `WebContentsView`、CDP、页签激活和 Browser Agent context 绑定链路。
- 每个无痕页签使用独立的非 `persist:` partition，因此不同无痕页签之间不共享 Cookie、localStorage、Cache 或其他 Chromium session 数据。
- 无痕页签不写入 `web-tabs.json`，应用退出后不恢复。
- 人工入口仍使用现有“新建网页”按钮先创建普通空白页签；地址栏工具栏新增无痕图标。
- 只有从未打开过 HTTP(S) 地址的空白页签可以人工转换为无痕模式。
- 一旦页签访问过 HTTP(S) 地址，即使之后导航回 `about:blank`，该页签也永久不能人工转换为无痕模式。UI 禁用只是提示，主进程必须再次校验。
- Agent 可以调用 `BrowserPageOpenTab({ url, incognito: true })` 直接创建无痕页签，不受人工转换限制。
- 无痕模式不绕过 Browser Page control policy、跨 Origin 审批、敏感字段限制或 capability 校验。
- 页签 ID 在人工转换时保留；底层 WebContentsView 和 CDP target 会更换。当前 Browser Agent 绑定要求页面已经是 HTTP(S)，而人工转换只允许从未访问地址的空白页签，因此正常人工转换不会带已有 Agent context；当转换请求被拒绝时，原绑定保持不变。转换实现不主动撤销任何已有绑定或 capability。

## 数据模型与主进程

### 共享类型

`WebTabState` 增加 `isIncognito: boolean` 和 `canActivateIncognito: boolean`，分别用于页签模式展示和地址栏按钮状态。`canActivateIncognito` 由主进程根据页签生命周期历史计算，Renderer 不自行推断。

`CreateWebTabInput` 增加可选 `incognito?: boolean`。已有 `partition` 仍只作为主进程内部受控参数；当 `incognito` 为 true 时，主进程忽略外部 partition 并生成唯一临时 partition。

### 页签记录

`WebTabRecord` 保存：

- `isIncognito`：是否使用无痕 session。
- `hasOpenedAddress`：页签生命周期内是否曾经打开过 HTTP(S) 地址。
- 当前 `partition`、WebContentsView、CDP listeners 和现有状态。

创建普通页签时，partition 继续使用 `persist:copis-web`。创建 Agent Workflow 专用页签时，继续使用现有 Workflow partition 规则。创建无痕页签时，生成 `copis-incognito-{uuid}` 格式的非持久 partition，每个页签唯一。

`hasOpenedAddress` 在以下情况下设置为 true：初始 URL 是 HTTP(S)、导航目标是 HTTP(S)，或 HTTP(S) 导航已提交。该状态只存在于当前运行的页签记录，不写入恢复文件；恢复出来的普通地址页签在创建时直接标记为 true。对外状态的 `canActivateIncognito` 只在普通、当前为 `about:blank` 且 `hasOpenedAddress` 为 false 时为 true。

### 人工转换

新增主进程内部操作 `activateWebTabIncognito(tabId)`，并增加对应 IPC/preload 方法。操作必须满足：

1. 页签存在且不是 Workflow-owned。
2. 页签当前 URL 为 `about:blank`。
3. `hasOpenedAddress` 为 false。
4. 页签尚未处于无痕模式。

通过校验后，主进程保存原页签的 `tabId`、URL、bounds 和激活状态，解绑旧 WebContents 的 CDP 监听，创建唯一临时 partition 的新 WebContentsView，并复用原 `tabId` 替换记录中的 view。新 view 重新 attach CDP、恢复 bounds/可见性并加载原 URL。转换失败时保留原 view 和原 partition，不修改对外状态。

页签生命周期事件新增 `recreated`（或等价的明确事件），让 Browser Workflow 的 CDP/录制监听从旧 target 重新挂载到新 target；转换实现不主动撤销已有 context 或 Browser Agent worker capability。当前限制下，Agent 直接打开无痕页签时按普通新页签流程创建并绑定 context。

### 持久化与清理

持久化快照过滤 `isIncognito` 页签，并基于过滤后的普通页签重新计算 active index。无痕页签不能出现在 `web-tabs.json`。

关闭无痕页签或应用释放页签时，保存临时 session 引用并在关闭 WebContents 前发起 `clearStorageData`，随后解除 CDP、移除 WebContentsView 并关闭页面；清理异常只写中文警告，不阻塞关闭。应用退出后非持久 partition 的内存数据自然失效。

## Renderer UI

### 地址栏

在 `WebBrowserSurface` 的地址栏工具栏中加入无痕图标按钮：

- 普通、从未访问地址的 `about:blank` 页签：可点击，Tooltip 为“启用无痕模式”。
- 已访问过地址的页签：按钮禁用，Tooltip 说明需要新建空白页签。
- 已经是无痕页签：显示激活态和无痕标识，不提供切回普通模式的切换。
- 无活动网页页签或 Copis 首页：按钮不提供转换动作。

点击按钮后调用主进程转换 IPC，成功后刷新快照并保留当前 tabId；失败通过现有 toast 错误反馈。

### 页签栏

无痕页签使用无痕图标而不是普通 favicon 作为主要模式标识，标题仍可显示网页标题。普通页签的现有 favicon 和行为不变。

## Agent 工具与 Prompt

`BrowserPageOpenTab` 的 schema 增加可选 Boolean `incognito`，默认 false。主进程将该参数传给 `openBrowserAgentTab`，返回结果增加 `incognito` 字段，并根据模式返回对应中文消息。

工具描述、默认 Browser Agent skill 和系统 prompt 明确以下事实：无痕页签没有普通 `persist:copis-web` 的登录态，不能假定已有 Cookie/localStorage；需要登录时必须由用户在该无痕页签中重新完成；无痕模式不改变页面操作授权规则。

## 错误处理与安全

- Renderer 只负责展示可用状态，所有 partition、URL、生命周期和 `hasOpenedAddress` 校验在主进程执行。
- 不能通过传入自定义 partition 伪造无痕或共享其他页签的 session。
- 转换期间的旧 CDP target 不再接受新的页面操作；新 target 准备完成后才恢复当前 tabId 的页面操作，Agent 遇到切换中的错误应重新观察并重试。
- 由于无痕使用内存 session，它不会写入 Copis 的网页恢复文件；这不等同于网络侧或网页自身不记录数据。

## BDD 与验证

### 主进程和持久化

- Given 新建普通空白页签 When 激活无痕模式 Then tabId、bounds、激活状态保留且 partition 变为唯一非持久 partition。
- Given 页签曾打开 HTTP(S) 地址 When 激活无痕模式 Then 主进程拒绝并保持原 view。
- Given 页签导航回 `about:blank` 但曾打开过地址 When 激活无痕模式 Then 仍拒绝。
- Given 无痕页签 When 保存网页会话 Then `web-tabs.json` 不包含该页签。
- Given 无痕页签 When 关闭 Then 发起临时 session 存储清理。

### Agent 与 CDP

- Given `BrowserPageOpenTab` 的 `incognito` 为 true When Agent 创建页签 Then 新页签为无痕模式并保留现有审批和 policy。
- Given 转换请求被拒绝的已绑定普通页签 When 用户激活无痕模式 Then 原 sessionId、tabId、capability 和页面保持不变。
- Given 当前存在页签绑定 When 用户的无痕转换请求通过主进程校验 Then 不主动撤销现有 sessionId、tabId 或 capability，CDP target 更换后监听重新挂载。
- Given Agent 调用未提供 `incognito` When 创建页签 Then 行为与当前普通页签完全兼容。

### Renderer

- Given 普通空白页签 When 渲染地址栏 Then 无痕按钮可用。
- Given 已访问地址的页签 When 渲染地址栏 Then 无痕按钮禁用并显示原因。
- Given 无痕页签 When 渲染页签栏和地址栏 Then 显示无痕激活态且不提供回切按钮。

验证命令：

```bash
bun test apps/electron/src/main/lib/web-tab-manager.test.ts
bun test apps/electron/src/main/lib/web-tab-session-service.test.ts
bun test apps/electron/src/main/lib/browser-workflow-service.test.ts
bun test apps/electron/src/main/lib/browser-agent-tool-service.test.ts
bun test apps/electron/src/main/lib/adapters/pi-browser-agent-tools.test.ts
bun test apps/electron/src/renderer/components/web-browser/WebTabBar.test.tsx
bun run typecheck
bun run --filter='@copis/electron' build:main
bun run --filter='@copis/electron' build:renderer
git diff --check
```

Electron 地址栏和无痕页签的真实视觉与交互仍由用户在实际应用窗口确认，不能用截图替代。
