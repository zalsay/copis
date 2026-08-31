# Task 2 修复报告

## 范围

- workflow-owned 页签提升为公开页签后启动 JavaScript dialog bridge。
- 可恢复 CDP detach 时，重连并完成 `Page.enable` 后拒绝 Chromium 尚未解除的对话框；销毁或 bridge dispose 后不发送 CDP 命令。
- 使用每个对话框独立的 `AbortSignal` 取消 presenter；prompt 子窗口按请求映射关闭并清理，不影响其它宿主窗口。

## RED

先新增回归测试，再运行：

```text
bun test apps/electron/src/main/lib/web-tab-javascript-dialog.test.ts
```

结果：失败 2 项。detach 回归的最后一次命令仍是 `Page.enable`，没有 `Page.handleJavaScriptDialog({ accept: false })`；bridge dispose 回归收到的 presenter signal 为 `undefined`。

```text
bun test apps/electron/src/main/lib/web-tab-javascript-prompt-window.test.ts
```

结果：新增 AbortSignal 回归因旧实现不监听 signal 而保持未决，按 TDD RED 要求终止该进程；原有前两项已通过。

```text
bun test apps/electron/src/main/lib/web-tab-manager-promotion.test.ts
```

结果：失败，提升 workflow 页签后 bridge 启动次数为 0（期望 1）。

## GREEN

以下 focused 回归全部通过：

```text
bun test apps/electron/src/main/lib/web-tab-javascript-dialog.test.ts        # 9 pass
bun test apps/electron/src/main/lib/web-tab-javascript-prompt-window.test.ts # 10 pass
bun test apps/electron/src/main/lib/web-tab-manager-promotion.test.ts         # 1 pass
```

补充验证：

```text
bun run typecheck
bun run --filter='@copis/electron' build:main
git diff --check
```

三项均以退出码 0 完成。

## 提交

实现提交：`26dca46b`（`fix(web): recover javascript dialog bridge lifecycle`）。

manager 中仅暂存 promotion bridge-start hunk；favicon/reload 等既有用户改动未暂存、未提交。未恢复用户删除的 `web-tab-manager.test.ts`。
