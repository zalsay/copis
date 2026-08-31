# Task 2：JavaScript 对话框 CDP bridge 报告

## 实现

- 新增 `web-tab-javascript-dialog.ts`，提供可注入的 `JavascriptDialogPresenter` 和每个 WebContents 独立的串行 CDP bridge。
- `alert`、`confirm`、`beforeunload` 使用主窗口关联的 Electron 原生消息框；`prompt` 复用安全的 `showWebJavascriptPromptWindow`。
- `hasBrowserHandler=true` 的事件由 Chromium 自身处理，不重复展示。
- 对话框结果通过 `Page.handleJavaScriptDialog` 回传；prompt 确认时传递 `promptText`。
- detach 时取消在途及排队项并重新 attach/`Page.enable`；dispose 或 WebContents 销毁后不再发送 CDP 命令。
- manager 仅为公开页签创建 bridge，并在 created/destroyed/close/dispose、无痕视图替换及创建异常回滚路径清理。

## BDD/TDD 结果

- RED：bridge 文件不存在时运行 `bun test apps/electron/src/main/lib/web-tab-javascript-dialog.test.ts`，按预期因模块缺失失败。
- GREEN：7 个场景通过，覆盖 alert、confirm/beforeunload、prompt、浏览器处理器、串行队列、detach/销毁取消及 detach 重连。

## 验证

- `bun test apps/electron/src/main/lib/web-tab-javascript-dialog.test.ts`：7 pass
- `bun run typecheck`：通过
- `bun run --filter='@copis/electron' build:main`：通过
- `bun test apps/electron/src/main/lib/web-tab-native-popup.test.ts`：10 pass
- `bun test apps/electron/src/main/lib/web-bookmark-service.test.ts`：4 pass
- `bun test apps/electron/src/main/lib/web-tab-session-service.test.ts`：3 pass
- `git diff --check`：通过

## 用户实机确认

仍需用户在 Electron 实际应用窗口中打开普通 HTTP(S) 页面，确认 alert/confirm/prompt/beforeunload 的视觉效果、结果回传、关闭行为，以及与 window.open 原生子窗口并存时的交互。
