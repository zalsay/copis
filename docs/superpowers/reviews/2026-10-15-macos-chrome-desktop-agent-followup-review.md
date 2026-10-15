# macOS 本机 Chrome 桌面视觉自动化修复后复审

> 复审分支：`feat/macos-chrome-desktop-agent`
>
> 复审工作树：`/Volumes/RC500/dev/copis/.worktrees/macos-chrome-desktop-agent`
>
> 修复提交：`d49b0fda2dea6666b1dcf3c65a28652cf88e1013`
>
> 对照上一轮审查：`docs/superpowers/reviews/2026-10-15-macos-chrome-desktop-agent-review.md`

## 结论

本次修复关闭了上一轮的大部分问题，但仍不能按完成定义合并。当前状态为：**基础链路可以继续验证，安全边界和视觉帧正确性还需要修复**。

已确认关闭的上一轮问题包括：

- Display Media 顶层 frame 校验不再使用不存在的 `request.webContents`。
- Chrome source 改为结构化 `windowId` 精确匹配，不再使用 `includes()`。
- 权限 request handler 在拒绝后立即返回。
- Main/Renderer 帧回传增加 `controlId`、`requestId` 和 `webContentsId` 关联。
- helper 的 stdin 读取与动作执行解耦，`cancel` 可以异步设置取消状态。
- Unicode 输入按 `Character` 处理 UTF-16，emoji 代理对不再拆开发送。
- capability eligibility 增加用户触发、聊天室、自动化、委派、远程、支付、专业模式和图片模型矩阵。
- action history 增加输入 hash、容量、TTL、control 绑定和清理。
- paused/error 进入 helper cancel 与采集流清理。
- Electron 屏幕权限改为由 `systemPreferences.getMediaAccessStatus('screen')` 查询。
- 开发启动链路加入 `build:chrome-desktop-helper`。

## P1：仍需修复

### 1. Agent RPC 路径仍把远程连接当作本地用户运行

位置：

- `apps/electron/src/main/lib/agent-rpc-service.ts:730`
- `apps/electron/src/main/lib/agent-rpc-service.ts:759-768`

`prepareAgentRpcRun()` 已计算 `isAppConnector`，但签发 Chrome capability 时固定传入：

```ts
isRemoteBotRun: false,
isPaymentRun: false,
```

因此 Feishu、WeChat、DingTalk 或其他 app connector 路径只要 `triggeredBy` 没有被标为 automation/delegation，仍可能获得本机 Chrome 控制 capability。该路径也没有把 `isAppConnector` 映射到 `isRemoteBotRun`。

建议：

- 将 `isAppConnector`、可信 remote source 和 payment flow 纳入统一 eligibility 输入。
- `isRemoteBotRun` 不应由调用方写死为 `false`；应由 Main 根据可信 source/context 派生。
- 增加 Agent RPC 级测试，确认 app connector、Feishu、WeChat、DingTalk 和 payment 运行均不带 `chromeDesktopControl`，且系统提示词不出现 Chrome Desktop 章节。

### 2. Rust Agent RPC complete 没有传回 capability token，旧 run 防护在真实 RPC 链路中仍可能失效

位置：

- `apps/electron/src/main/lib/agent-rpc-service.ts:1132-1152`
- `apps/electron/src/main/lib/http-api-handler.ts:1236-1260`
- `native/http-api-server/src/main.rs:4238-4262`

TypeScript finalize 现在支持通过 `chromeDesktopCapabilityToken` 判断旧 run，但 Rust `finalize_worker_run()` 实际只向 Main 发送：

- `sessionId`
- `stoppedByUser`
- `resultSubtype`
- `resultErrors`

它没有携带 Chrome capability token。因此 `finalizeAgentRpcRun()` 会回退到当前 `pendingAgentRpcRuns.get(sessionId)` 的 token：

```ts
const chromeDesktopToken = input.chromeDesktopCapabilityToken ?? pending?.chromeDesktopCapabilityToken
```

旧 run finalize 迟到时，`input.chromeDesktopCapabilityToken` 为空，`isStaleRun` 为 false，仍可能把当前 pending run 的 token 当成旧 run token 使用。

建议：

- 在 Worker/Rust 完成帧中携带本次 run 的不可伪造 capability identity，至少包括 Chrome capability token 或独立 run generation。
- `finalizeAgentRpcRun()` 对缺失 identity 的完成帧采取保守策略：只能完成无桌面控制的兼容 run，不能释放当前 Chrome control。
- 增加真实 `prepare → Rust worker complete → finalize` 的迟到旧 run 测试，而不是只测试直接调用 finalize 函数。

### 3. `requestVideoFrameCallback` 没有比较新旧帧序号，仍可能把同一画面当成新 Observe

位置：

- `apps/electron/src/renderer/components/agent/ChromeDesktopCaptureHost.tsx:35-40`
- `apps/electron/src/renderer/components/agent/ChromeDesktopCaptureHost.tsx:154-175`

修复后增加了 `lastPresentedTimeRef`，但实现只在 callback 中写入：

```ts
lastPresentedTimeRef.current = frameTime
```

没有在本次回调前读取旧值，也没有判断 `metadata.presentedFrames` 是否比上次递增。因此 callback 触发时，即使视频源仍停留在同一帧，也会继续截取并把 `Date.now()` 作为新鲜时间戳返回。

建议：

- 保存请求前的 `lastPresentedFrames`，callback 中要求 `metadata.presentedFrames > lastPresentedFrames`。
- 如果 350ms 内没有新源帧，返回 `CHROME_FRAME_STALE` 或 `CHROME_CAPTURE_FAILED`，不要使用当前旧帧冒充新帧。
- 不要用当前编码完成时间代替源帧时间；至少在 frame metadata 中区分 `presentedFrames`、`mediaTime` 和编码时间。
- 增加两个连续 Observe 在视频静止时的测试，确认第二次不会无条件返回“新帧”。

### 4. Observe 的幂等缓存会返回空图片

位置：

- `apps/electron/src/main/lib/chrome-desktop-service.ts:277-287`
- `apps/electron/src/main/lib/chrome-desktop-service.ts:308-315`

为了避免缓存 base64，Observe 被缓存为：

```ts
image: { mimeType: 'image/jpeg', data: '' }
```

同一 `toolCallId` 重试时，Service 会直接返回这个缓存结果。Pi Worker 收到 `kind: image` 后仍会把空字符串作为图片 content 发送给模型，导致重试请求失去视觉内容。

建议二选一：

- Observe 不做结果缓存；如果同一 toolCallId 重复到达，返回明确的 `CHROME_ACTION_UNCERTAIN`，由 Agent 重新 Observe。
- 将短期图片缓存放在有 TTL 和大小上限的专用 frame cache 中，允许一次可靠重试，但在 control 释放时清空。

不能把空 base64 当作成功的图片结果返回。

## P2：建议补齐

### 5. helper 取消缺少真实中断回归

Swift helper 现在使用独立 `actionQueue` 处理输入、主线程读取 `cancel`。结构上已经支持异步取消，但现有测试只覆盖基础 helper client 通信，没有验证：

- 长文本输入期间发送 cancel。
- cancel 回包先于 type 回包时，Node pending request 是否正确收敛。
- type 被取消后是否返回 `CHROME_CANCELLED`。
- 取消发生在 mouseDown、modifier key 或滚动事件之间时是否释放输入状态。

建议增加 macOS helper 集成测试或可注入的事件发送层测试。

### 6. Display Media 拒绝回调仍使用 `callback({})`

位置：

- `apps/electron/src/main/lib/voice-dictation-window.ts:239-247`
- `apps/electron/src/main/lib/voice-dictation-window.ts:257-263`

现在请求过滤已经正确，但所有拒绝分支仍调用 `callback({})`。Electron 运行时拒绝 display media 的语义需要在 Electron 43 上实际验证；如果只传空 streams 对象不能稳定 reject，应改为明确的拒绝形式，并增加失败路径测试。

### 7. `ChromeDesktopStart` 的同 toolCallId 轮询没有绑定 capability token

位置：

- `apps/electron/src/main/lib/chrome-desktop-service.ts:342-398`

`handleStart()` 接收了 capability token 并保存到新 control，但同一 session、同一 `toolCallId` 的轮询分支只比较 session 和 toolCallId，没有比较当前请求 token。如果同一 session 的 capability 已经换代，旧 Start 轮询可能读取当前 control 状态。

建议同一轮 Start polling 同时校验 capability token；token 不匹配时返回 `CHROME_CAPABILITY_STALE`，不能继续返回 active/awaiting 状态。

## 验证结果

本次复审在隔离 worktree 中执行：

```text
bun test \
  apps/electron/src/main/lib/chrome-desktop-service.test.ts \
  apps/electron/src/main/lib/chrome-desktop-helper-client.test.ts \
  apps/electron/src/main/lib/chrome-desktop-capability.test.ts \
  apps/electron/src/main/lib/adapters/pi-chrome-desktop-tools.test.ts \
  apps/electron/src/main/ipc/chrome-desktop.ipc.test.ts \
  apps/electron/src/main/lib/voice-dictation-window.test.ts
结果：38 pass, 0 fail

bun test packages/shared/src/types/chrome-desktop.test.ts \
  apps/electron/src/main/lib/agent-rpc-service.test.ts
结果：45 pass, 0 fail

bun run typecheck
结果：各 workspace typecheck exit 0

bun run --filter='@copis/electron' build:chrome-desktop-helper
结果：arm64 Swift helper 编译 exit 0

bun run --filter='@copis/electron' build:main
结果：exit 0

bun run --filter='@copis/electron' build:preload
结果：exit 0

bun run --filter='@copis/electron' build:renderer
结果：exit 0；保留既有 Browserslist、chunk size 和动态/静态 import 警告

git diff --check HEAD^ HEAD
结果：通过
```

自动化验证通过不能替代用户在实际 Electron 窗口中打开真实 Chrome、确认预览、中文/emoji 输入、焦点切换和停止行为。当前仍需先修复上面的 P1，再安排该窗口验收。
