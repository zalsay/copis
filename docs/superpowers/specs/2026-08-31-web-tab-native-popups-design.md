# 网网页签原生弹窗支持设计

## 目标

让 Copis 内嵌 Chromium 网页页签支持两类网页原生交互：

- `window.open()`、`target="_blank"` 和同类新窗口请求创建受主窗口管理的原生 `BrowserWindow`；
- `alert`、`confirm`、`prompt` 与 `beforeunload` 在 `WebContentsView` 中也能展示并把用户结果返回给网页。

## 已确认的行为边界

- HTTP(S) 新窗口是原生子窗口，不进入 Copis 页签栏、不写入 `web-tabs.json`，也不转换成普通页签。
- 新窗口以主窗口为 parent、非模态、关闭发起页或主窗口时自动释放；它继承网页发起方的 Session 与 Electron 安全限制。
- 非 HTTP(S) 新窗口请求维持现有策略：拒绝创建窗口，并交由系统默认处理器打开外部协议。
- 子窗口递归应用相同的导航和新窗口策略，不能成为绕过协议校验或安全 WebPreferences 的入口。
- 对话框必须保持网页语义：`alert` 确认后继续；`confirm`/`beforeunload` 返回确认或取消；`prompt` 返回用户输入或取消。
- 不修改 `README.md` 或 `AGENTS.md`；现有未提交的工作区改动不属于本功能，必须保留。

## 架构

### 原生网页子窗口

`web-tab-manager` 不再把允许的 `window.open` 请求重写成 `createWebTabInternal()`。改由 `webContents.setWindowOpenHandler()` 对 HTTP(S) 返回 `allow`，并通过 `overrideBrowserWindowOptions` 固定 `parent`、`show: false`、非模态窗口行为和安全的 `webPreferences`。Electron 随后创建真正的 `BrowserWindow`，保留 DOM opener 关系。

`did-create-window` 负责对子窗口安装递归的 URL/协议拦截、窗口关闭清理、`ready-to-show` 显示与聚焦逻辑。它不会被 `records` 当成普通网页页签管理，也不会影响当前激活页签或恢复状态。

### JavaScript 对话框桥接

每个公开 `WebContentsView` 注册一个仅主进程可见的对话框桥接。该桥接使用现有 CDP attach、`subscribeWebTabCdpEvents` 和 detach 生命周期：启用 `Page` 域、监听 `Page.javascriptDialogOpening`，并通过 `Page.handleJavaScriptDialog` 将用户结果回传 Chromium。

- Chromium 已有浏览器处理器时不重复展示，由 Chromium 原生处理。
- 没有浏览器处理器时，`alert`、`confirm` 和 `beforeunload` 使用与主窗口关联的 Electron 原生消息框。
- `prompt` 使用受主窗口管理的小型应用原生窗口；窗口只加载 Copis 自身的渲染入口，通过专用、最小权限的 preload/IPC 请求传递输入或取消结果，绝不加载网页提供的 HTML 或脚本。

对话框在单个 WebContents 内串行展示。页签、主窗口、CDP 会话或提示窗口销毁时，未完成请求一律取消并向 CDP 返回拒绝，避免页面永久阻塞。CDP 意外 detach 后桥接重新附着并重新启用 `Page` 域；这项对话框能力因此是公开网页页签的长期 CDP 使用者，不能被 Agent 的临时 CDP 释放逻辑误删。

### 文件边界

- `apps/electron/src/main/lib/web-tab-native-popup.ts`：新窗口策略、`did-create-window` 生命周期及安全导航处理。
- `apps/electron/src/main/lib/web-tab-javascript-dialog.ts`：CDP 事件解析、单页签请求队列、结果回传与可替换 presenter 接口。
- `apps/electron/src/main/lib/web-tab-javascript-prompt-window.ts`：受控 prompt 原生窗口与待处理请求映射。
- `apps/electron/src/preload/web-javascript-prompt.ts`：仅暴露读取请求、确认与取消三项 API。
- `apps/electron/src/renderer/components/web-browser/WebJavascriptPromptWindowApp.tsx`：prompt 输入 UI；`renderer/main.tsx` 以 `window=web-javascript-prompt` 进入该独立根节点。
- `web-tab-manager.ts`：仅装配上述能力并在记录关闭/释放时清理，不在该大文件继续堆叠窗口实现细节。

## 安全与错误处理

- 仅主进程决定是否允许新窗口、parent、Session、WebPreferences 和关闭策略；网页不能通过 features string 覆盖它们。
- 不信任 URL、标题、对话框文本、default prompt 或窗口名称；它们只作为展示数据，禁止拼接成 HTML。
- prompt IPC 以随机 request ID 关联，并同时校验窗口身份和请求仍处于待处理状态；重复、过期或跨窗口提交被忽略。
- 创建窗口、启用 CDP 或显示对话框失败时记录中文日志，并用取消结果恢复网页执行，而不是让它永久等待。

## BDD 与验证

- Given HTTP(S) 页签调用 `window.open` When 处理请求 Then 创建 parent 为主窗口的原生子窗口，且普通页签快照和持久化内容不变。
- Given 网页请求 `mailto:` 或自定义协议 When 打开窗口 Then 原生窗口被拒绝并仅调用外部协议处理。
- Given 原生子窗口再次打开 HTTP(S) 页面 When 创建请求 Then 同样创建受控子窗口并继承安全策略。
- Given WebContentsView 发出 `alert`/`confirm`/`beforeunload` CDP 事件且没有浏览器处理器 When 用户操作消息框 Then `Page.handleJavaScriptDialog` 收到正确的 accept 值。
- Given WebContentsView 发出 `prompt` When 用户确认或取消 Then CDP 分别收到输入文本或拒绝结果。
- Given 页签或主窗口在对话框期间关闭 When 清理 Then 请求被取消、监听器移除且不会向已销毁的 WebContents 发送命令。

验证命令：

```bash
bun test apps/electron/src/main/lib/web-tab-native-popup.test.ts
bun test apps/electron/src/main/lib/web-tab-javascript-dialog.test.ts
bun test apps/electron/src/main/lib/web-tab-javascript-prompt-window.test.ts
bun run typecheck
bun run --filter='@copis/electron' build:main
bun run --filter='@copis/electron' build:preload
bun run --filter='@copis/electron' build:renderer
git diff --check
```

最终仍需用户在 Electron 应用中确认：OAuth/支付类 `window.open` 弹窗、`alert`/`confirm`/`prompt` 结果回传、关闭行为和视觉效果。不得以截图替代该确认。
