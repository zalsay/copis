# macOS 本机 Chrome 桌面视觉自动化代码审查

> 审查分支：`feat/macos-chrome-desktop-agent`
>
> 审查工作树：`/Volumes/RC500/dev/copis/.worktrees/macos-chrome-desktop-agent`
>
> 对比基线：`798401bf6c29f3d7ababf870717bdccb8009e0fb`
>
> 审查范围：共享类型、Swift helper、helper client、ChromeDesktopService、Capability、Agent RPC、HTTP 路由、媒体权限、Renderer CaptureHost、Banner、Pi Worker 工具和构建链。

## 结论

当前实现的模块拆分和主链路已经形成，但还不能按 Spec 的完成定义合并。定向 TypeScript 测试、类型检查、主进程/preload/renderer 构建和 Swift helper 编译均通过；实际链路仍有以下阻塞项：

- `setDisplayMediaRequestHandler` 使用了 Electron 请求对象中不存在的 `request.webContents`，当前实现会拒绝所有 Chrome 采集请求。
- Renderer 回传帧没有和 Main 当前等待的 `controlId` 绑定，迟到帧可能被下一次 Observe 接收。
- 直接编排路径没有完整限制 automation、delegation、remote bot 和 payment 上下文，存在错误签发本机桌面控制 capability 的路径。
- Swift helper 的 `cancel` 不能中断正在执行的同步输入命令，超时或紧急停止后仍可能继续向 Chrome 投递文本。
- 旧 Agent run 的 cleanup 没有绑定 ChromeDesktopService 的 run generation，迟到清理可能释放新 run 的控制权。

上述问题解决前，建议保持为开发分支，不进入实际 Electron/Chrome 验收。

## P1：必须在合并前修复

### 1. Display Media handler 使用不存在的 `request.webContents`，会阻塞全部采集

位置：

- `apps/electron/src/main/lib/voice-dictation-window.ts:237-263`

`setDisplayMediaRequestHandler` 的请求对象通过 `frame` 提供来源；当前代码判断：

```ts
request.frame?.parent !== null || request.webContents?.id !== win.webContents.id
```

Electron 43 的该请求对象没有 `webContents` 字段。对正常顶层请求来说，`request.webContents` 是 `undefined`，所以第二个条件恒为真，handler 直接调用 `callback({})` 并返回。后续的 `getSources()` 和目标窗口匹配逻辑不会执行。

建议：

- 只接受 `request.frame !== null`、`request.frame.parent === null`，并通过 `request.frame.webContents.id` 校验主窗口。
- 拒绝请求时使用和 Electron 43 实际运行时一致的拒绝方式；当前 `callback({})` 需要在真实运行中确认是否会正确 reject，不能只依赖类型通过。
- 增加媒体权限 handler 的测试，至少覆盖顶层主窗口请求、子 frame 请求、其他 webContents 请求和无 pending target 请求。

### 2. Renderer 帧回传没有校验 `controlId`，存在迟到帧串入下一次 Observe 的竞态

位置：

- `apps/electron/src/main/ipc/chrome-desktop.ipc.ts:32-57`
- `apps/electron/src/main/ipc/chrome-desktop.ipc.ts:111-134`
- `apps/electron/src/renderer/components/agent/ChromeDesktopCaptureHost.tsx:95-202`

Main 只保存一个全局 `pendingFrameCapture`，其中没有保存请求的 `controlId`。`FRAME_RESPONSE` 收到任何带有 `data` 的回包后都会 resolve 当前等待请求，也没有比较 `res.controlId`。

因此，Observe A 超时后，CaptureHost 的异步回调仍可能发送 A 的帧；如果此时 Observe B 已经建立等待，A 的帧会被当成 B 的帧返回。Service 只检查图片时间戳，并不知道这张图片来自哪个控制代次。

建议：

- `pendingFrameCapture` 保存 `controlId`、请求序号和发送窗口的 `webContents.id`。
- 回传时必须匹配 `controlId` 和请求序号；不匹配的回包丢弃并记录短 ID，不能 resolve 当前请求。
- CaptureHost 内部增加帧请求串行锁或 request generation，旧请求完成后不得向新请求发送结果。
- 增加“旧请求超时后新请求已建立，旧回包到达”的回归测试。

### 3. Capability 签发边界在不同运行入口不一致

位置：

- `apps/electron/src/main/lib/agent-rpc-service.ts:854-868`
- `apps/electron/src/main/lib/agent-orchestrator.ts:1927-1933`
- `apps/electron/src/main/lib/chrome-desktop-capability.ts:20-52`
- `apps/electron/src/main/lib/agent-prompt-builder.ts:193-202`

Capability 模块虽然定义了 `isAutomationRun`、`isDelegationRun`、`isRemoteBotRun` 和 `isPaymentRun`，但调用方没有完整传入这些可信上下文：

- `agent-rpc-service.ts` 只排除了聊天室、automation、delegation 和 professional runtime，没有排除 `workingPaymentFlow` 或 remote bot，并且对应 options 没有传 `isPaymentRun` / `isRemoteBotRun`。
- `agent-orchestrator.ts` 只用 `!isChatroomRun` 作为资格条件，automation/delegation 等 `triggeredBy` 可能直接获得 capability。
- Prompt 在 macOS 上无条件宣称 Chrome Desktop 能力存在，即使当前模型不支持图片、当前运行没有 capability 或当前上下文被禁止使用。

这会导致本机控制能力与 Spec 要求的“只给用户主会话、非自动化、非委派、非远程、非支付运行”不一致。

建议：

- 在 Main 建立唯一的 `canIssueChromeDesktopCapability`，只接受可信运行上下文，不能由 renderer/HTTP DTO 自报 `triggeredBy` 或权限字段。
- 明确排除 `triggeredBy !== 'user'`、chatroom、automation、delegation、app connector/远程桥接、working payment 和其他远程机器人入口。
- Agent prompt 只有在本轮 query 实际带有 `chromeDesktopControl` 时才注入。
- 增加矩阵测试，覆盖每个入口与每个 `triggeredBy`，并验证“没有 capability 时不会注册七个工具”。

### 4. Swift helper 的取消协议不能中断正在执行的输入

位置：

- `apps/electron/native/chrome-desktop-helper/main.swift:251-276`
- `apps/electron/native/chrome-desktop-helper/main.swift:336-352`
- `apps/electron/src/main/lib/chrome-desktop-helper-client.ts:258-265`
- `apps/electron/src/main/lib/chrome-desktop-service.ts:443-449`

Swift 主循环使用同步 `readLine()`，收到 `type` 后会在同一个线程中完整执行 `performType()`，然后才回到主循环读取下一条 stdin。Electron 发送的 `cancel` 会排在当前 `type` 命令之后，`isCancelled` 只能在文本输入完成后才被设置，因此无法中断长文本输入。

同时，Service 的动作超时分支只进入 `paused`，没有保证停止正在运行的 helper 动作。结果可能是：Main 已经把控制状态改成暂停，helper 仍继续向 Chrome 输入文本。

建议：

- 将命令读取与动作执行解耦，使用串行动作队列加独立取消信号；取消命令必须能在当前动作执行期间被处理。
- 或者为每个输入动作启动短生命周期 helper，并在取消/超时时终止该 helper；必须确保按键/鼠标释放。
- Service 在 `CHROME_ACTION_UNCERTAIN`、紧急停止、焦点丢失和窗口关闭路径统一调用可验证的 cancel/terminate，并等待 helper 进入已停止状态。
- 增加“4096 字符输入期间立即停止”的测试，验证停止后不会继续发送后续事件。

### 5. 旧 run 的清理没有绑定 Chrome Desktop 控制代次

位置：

- `apps/electron/src/main/lib/agent-rpc-service.ts:1120-1138`
- `apps/electron/src/main/lib/agent-orchestrator.ts:2795-2805`
- `apps/electron/src/main/lib/chrome-desktop-service.ts:59-87`
- `apps/electron/src/main/lib/chrome-desktop-service.ts:831-845`

`ActiveControlRecord` 保存了 `runGeneration`，Service 也维护 `nextRunGeneration`，但释放时没有接收或校验 generation。`releaseSessionControl(sessionId)` 只按 session 匹配。

如果同一 session 的旧 run 在新 run 已开始后迟到进入 `finally` 或 finalize，它可以释放新 run 的控制权；`finalizeAgentRpcRun` 还会按 session 取当前 pending record，不能证明 finalize 对应的是哪一个 run。

建议：

- capability、Chrome control 和 pending Agent run 统一使用不可伪造的 run token/generation。
- `releaseSessionControl` 改为要求 `sessionId + controlId/runGeneration`，旧 run 不匹配时只记录并返回。
- `finalizeAgentRpcRun` 不要从 `pendingAgentRpcRuns.get(sessionId)` 推断旧 run 的 token；把对应 run identity 作为可信内部完成参数保存。
- 增加“旧 run finally 迟到、新 run 已开始”的并发回归测试。

### 6. Unicode 输入按 UTF-16 code unit 逐个发送，emoji 和代理对会损坏

位置：

- `apps/electron/native/chrome-desktop-helper/main.swift:251-274`

`performType()` 使用 `Array(text.utf16)`，每次以长度 1 调用 `keyboardSetUnicodeString`。emoji 和部分扩展字符由代理对组成，当前实现会把高、低代理分别作为两个事件发送，不能保证目标输入框收到一个完整 Unicode scalar。

另外，TypeScript 层用 `text.length` 限制长度，也不是 Spec 中声明的 Unicode code point 数量。

建议：

- 按完整 Unicode scalar 或不拆分代理对的 UTF-16 chunk 发送；可以按 `String` 的 Character/UTF-16 安全边界分块。
- 长度校验与回执统一使用明确的 code point 规则，或把 Spec 改成 UTF-16 code unit 并保持实现一致。
- 增加中文、emoji、组合音标、换行前后的输入回归，实际在 Chrome 输入框验收。

### 7. 采集帧的“新鲜度”只检查回传时间，没有确认视频帧真的更新

位置：

- `apps/electron/src/renderer/components/agent/ChromeDesktopCaptureHost.tsx:158-189`
- `apps/electron/src/main/lib/chrome-desktop-service.ts:472-500`

CaptureHost 在 `drawImage(video, ...)` 后用 `Date.now()` 生成 `capturedAt`。这只能证明 Canvas 转换刚刚完成，不能证明 video 已经显示了 Chrome 的新画面。连续 Observe 可能读取同一个 video frame，但 Service 会把它当成新鲜帧。

建议：

- 使用 `HTMLVideoElement.requestVideoFrameCallback` 或等价的 frame sequence/media time，等待与上一次不同的源帧后再截取。
- 将源帧序号或媒体时间纳入回传元数据；`capturedAt` 使用源帧时间或明确区分“源帧时间”和“编码完成时间”。
- 在 Renderer 断流、暂停和恢复时清空上一帧，不能用旧画面冒充 active 状态的新观察。

### 8. actionHistory 永久保留完整截图，造成内存、隐私和跨 run 回放风险

位置：

- `apps/electron/src/main/lib/chrome-desktop-service.ts:85-87`
- `apps/electron/src/main/lib/chrome-desktop-service.ts:228-232`
- `apps/electron/src/main/lib/chrome-desktop-service.ts:503-512`
- `apps/electron/src/main/lib/chrome-desktop-service.ts:620-787`

`actionHistory` 是 Service 生命周期级别的 Map，Observe 的完整 base64 JPEG 会被放进去，停止控制、session 结束和应用关闭前都没有清理或容量限制。读取缓存时只按 `toolCallId` 匹配，也没有 session/control 绑定。

这会持续保留网页截图，并且若 toolCallId 在不同 run 中复用，可能把旧 run 的结果返回给新 run。

建议：

- idempotency cache 只保留不含图片的短回执，或把 Observe 的缓存值存为 metadata/hash 而不是 base64。
- key 至少包含 `sessionId + controlId + toolCallId`，并在 release 时清理。
- 使用有限容量和 TTL；对重复请求参数做摘要校验，不同参数不能命中同一回执。
- 增加停止后内存缓存清空和跨 run toolCallId 复用测试。

### 9. 暂停/错误状态没有一致释放采集流与 helper

位置：

- `apps/electron/src/main/lib/chrome-desktop-service.ts:810-826`
- `apps/electron/src/main/lib/chrome-desktop-service.ts:831-845`
- `apps/electron/src/renderer/components/agent/ChromeDesktopCaptureHost.tsx:80-89`
- `apps/electron/src/renderer/components/agent/ChromeDesktopBanner.tsx:91-101`

`transitionToPaused()` 只注销快捷键、恢复后台节流并广播状态，没有取消 helper 或通知 Renderer 停止 MediaStream。CaptureHost/Banner 只在 `stopped` 或 `error` 时清理 stream，因此焦点丢失和紧急停止后，暂停状态仍可能继续持有屏幕采集流。

Spec 对暂停的定义是当前控制段结束并清理活动资源；当前 UI 又提示用户“切回前台”，但实现没有恢复控制的路径，文案与状态语义不一致。

建议二选一并保持一致：

- 暂停即结束当前 control：停止 track、撤销 frame 请求、终止 helper，用户重新开始并重新授权。
- 真正支持可恢复暂停：保留流但创建新的 frame/control generation，恢复前重新校验窗口和授权，禁止复用旧 frame。

当前首版更适合第一种，且应修正文案。

### 10. 预选窗口 source 的匹配条件过宽，可能采集错误窗口

位置：

- `apps/electron/src/main/lib/voice-dictation-window.ts:250-258`

当前使用：

```ts
s.id === `window:${targetStr}:0` || s.id.includes(targetStr)
```

`includes()` 会把窗口 ID `12` 与 `112`、`120` 等 source 混淆。这样不仅会导致坐标和画面不一致，也可能把用户未选择的窗口发送给模型。

建议：

- 解析 source ID 的结构化字段，只接受 `type === 'window'` 且窗口 ID 精确相等的 source。
- 将 helper 返回的 PID、CGWindowID、Chrome bundle ID 与 Electron source 的可用字段一起复核。
- 找不到精确 source 时拒绝，不降级为整个屏幕或模糊匹配。

## P2：建议在合并前补齐

### 11. Screen Recording 状态检查的是 helper，不是实际发起采集的 Electron 进程

位置：

- `apps/electron/src/main/lib/chrome-desktop-helper-client.ts:212-220`
- `apps/electron/native/chrome-desktop-helper/main.swift:353-359`
- `apps/electron/src/main/lib/chrome-desktop-service.ts:194-203`

`CGPreflightScreenCaptureAccess()` 由 Swift helper 调用，但实际 `getDisplayMedia()` 在 Electron Renderer 中发生。两个进程在 macOS TCC 中可能对应不同的授权主体，Banner 显示的屏幕录制状态可能与真实采集状态不一致。

建议 Main 使用 Electron `systemPreferences.getMediaAccessStatus('screen')` 反映 Electron 采集进程状态；helper 只报告辅助功能权限。最终仍要在开发版和签名安装包中分别实测授权主体。

### 12. `setPermissionRequestHandler` 在 webContents 不匹配时调用 callback 后没有 return

位置：

- `apps/electron/src/main/lib/voice-dictation-window.ts:208-218`

不匹配的请求先执行 `callback(false)`，随后仍会继续进入 `display-capture` 或 `media` 分支并再次调用 callback。权限回调通常只能完成一次，重复调用会带来运行时警告或未定义行为。

建议在 `callback(false)` 后立即 `return`，并增加其他 renderer 发起权限请求的测试。

### 13. CaptureHost 的 JPEG 限制没有最后兜底验证

位置：

- `apps/electron/src/renderer/components/agent/ChromeDesktopCaptureHost.tsx:160-178`

当前只尝试质量 `0.85`、`0.65` 和一次 `0.75` 尺寸缩放。最后一次编码后没有再次验证长度，复杂页面仍可能超过声明的 1 MiB 限制。

建议用循环降低质量/尺寸，设置最小尺寸和最大尝试次数；最终仍超限时返回 `CHROME_CAPTURE_FAILED`，不要把超限图片送入 HTTP bridge。

### 14. 后台节流恢复会覆盖其他窗口原有设置

位置：

- `apps/electron/src/main/lib/chrome-desktop-service.ts:121-135`
- `apps/electron/src/main/lib/chrome-desktop-service.ts:428-429`
- `apps/electron/src/main/lib/chrome-desktop-service.ts:814-825`

开始时对所有 BrowserWindow 设置 `false`，结束时对所有 BrowserWindow 无条件设置 `true`。这会覆盖其他窗口原来关闭节流的配置，也会影响控制期间创建的新窗口。

建议只记录实际修改过的窗口和原值，结束时按 identity 恢复；或只修改固定的 CaptureHost 所在主窗口。

### 15. 开发模式不会自动编译 helper

位置：

- `apps/electron/package.json:17`
- `apps/electron/package.json:34-42`

`build` 会调用 `build:chrome-desktop-helper`，但 `dev:electron` 不会调用它。新 worktree 直接执行推荐的开发命令时，Main 找不到 helper，功能会显示不可用；开发者需要额外手动执行构建命令。

建议把 `build:chrome-desktop-helper` 加入开发启动链路，或在 Main 启动时给出明确的一次性构建提示。非 macOS 仍应快速跳过。

### 16. 发布构建缺少 helper 签名和授权主体验证

当前能证明 Swift helper 可以编译，但还没有证明签名 Electron 包内的 helper 能通过 macOS TCC、hardened runtime 和 notarization。

建议在发布检查中加入：

- helper 与 Electron 包的目标架构核对。
- `codesign --verify --deep --strict` 和 helper 单独签名信息检查。
- 最终安装包上首次屏幕录制、辅助功能授权和升级后授权保留验证。
- arm64 与 x64 runner 分别执行，而不是用一台机器的 helper 代替另一架构。

### 17. 关键跨层回归缺失

现有新增测试主要覆盖 Service 的抽象状态机、Capability、Pi 工具转换和 helper client 的基础通信；没有覆盖以下实际风险：

- Display Media handler 的顶层/子 frame/错误 source 选择。
- IPC 帧回传的迟到响应和控制代次隔离。
- CaptureHost 的视频帧更新、JPEG 上限和 track ended 清理。
- permission handler callback 只调用一次。
- HTTP endpoint 的真实 capability、运行上下文和错误码。
- helper 的 cancel 中断、emoji/组合字符输入和窗口 source 精确匹配。
- agent-rpc/orchestrator 中 automation、delegation、remote、payment 矩阵。
- 旧 run cleanup 迟到时不影响新控制。

这些测试应在真实实现修正后加入；仅扩大现有 Service mock 测试不能覆盖上述跨进程竞态。

### 18. 新增文件存在格式检查失败

`git diff --check` 报告 Swift helper 和构建脚本存在多处 trailing whitespace。它不直接影响运行，但会增加审查噪声，建议在合并前清理。

## 推荐修复顺序

1. 修复 Display Media handler 的请求对象判断和 source 精确匹配，先让真实采集链路能启动且不会选错窗口。
2. 修复帧回传 correlation、源帧新鲜度和 CaptureHost 生命周期。
3. 收紧所有运行入口的 capability 签发与 prompt 注入，补上 payment/remote/automation/delegation 矩阵。
4. 重做 helper cancel，使停止/超时真的能终止输入，并解决 Unicode 代理对。
5. 加入 run generation 保护、有限 idempotency cache 和统一资源清理。
6. 补齐媒体权限、IPC/HTTP、Renderer、helper 和真实签名包的回归验证。
7. 清理构建脚本、后台节流恢复和格式问题，然后再安排用户在实际 Electron + Chrome 窗口验收。

## 已执行验证

在该隔离 worktree 中执行：

```text
bun test apps/electron/src/main/lib/chrome-desktop-service.test.ts \
  apps/electron/src/main/lib/chrome-desktop-helper-client.test.ts \
  apps/electron/src/main/lib/chrome-desktop-capability.test.ts \
  apps/electron/src/main/lib/adapters/pi-chrome-desktop-tools.test.ts
结果：11 pass, 0 fail

bun test packages/shared/src/types/chrome-desktop.test.ts
结果：4 pass, 0 fail

bun run typecheck
结果：各 workspace typecheck exit 0

bun run --filter='@copis/electron' build:chrome-desktop-helper
结果：arm64 Swift helper 编译 exit 0

bun run --filter='@copis/electron' build:main
结果：exit 0

bun run --filter='@copis/electron' build:preload
结果：exit 0

bun run --filter='@copis/electron' build:renderer
结果：exit 0；仅有既有的 Browserslist、chunk size 和动态/静态 import 警告

git diff --check 798401bf6c29f3d7ababf870717bdccb8009e0fb...HEAD
结果：失败；Swift helper 和 helper 构建脚本有 trailing whitespace
```

本次审查没有修改实现代码、`AGENTS.md` 或 `README.md`。
