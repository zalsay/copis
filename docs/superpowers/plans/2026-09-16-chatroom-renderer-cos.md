# Copis Chatroom Renderer and COS Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Electron 客户端完成聊天室 Renderer 体验和 COS 附件传输：Renderer 通过本机 Rust HTTP/SSE 使用聊天室，Electron Main 使用 `cos-nodejs-sdk-v5@3.0.0` 完成受控的 STS 上传下载，聊天室入口、房间 Tab、多人消息、结构化 Agent mention、未读和权限状态完整可用。

**Architecture:** Renderer 只调用统一前缀 `/api/chatrooms/v2` 的公开聊天室 HTTP/SSE 接口，所有房间数据和实时事件存入按 `roomId` 隔离的 Jotai atoms；SSE 监听器在 Renderer 顶层挂载，页面卸载不影响后台订阅。附件由窄 IPC 交给 Electron Main，Main 使用内部 token 请求 Rust 的一次性 COS STS、调用 COS SDK 上传或下载并回报脱敏进度，临时凭据不经过 Renderer；聊天室 Tab 作为独立 `roomId` 入口与 Agent/项目 Tab 共存。

**Tech Stack:** Electron 43、React 18、TypeScript、Jotai 2、Radix/Shadcn 风格组件、lucide-react、现有 Rust HTTP API/SSE、`cos-nodejs-sdk-v5@3.0.0`、Bun test。

**Spec:** docs/superpowers/specs/2026-09-16-copis-multi-agent-chatrooms-design.md

## Global Constraints

- 仅实现 Phase 4 Renderer 与 COS 交互；依赖 Phase 2 Rust gateway 和 Phase 3 ChatRoomAgentCoordinator 的已确认接口，不修改 edu-api、Rust gateway、Agent 协调器、AGENTS.md 或 README.md。
- Electron Main 使用现有 `cos-nodejs-sdk-v5@3.0.0`；安装前执行 `bun pm ls cos-nodejs-sdk-v5` 与 `bun why cos-nodejs-sdk-v5`，不得引入第二个 COS SDK 或升级版本。
- Working JWT 只由 Rust `AuthSession` 持有；Renderer 使用现有 `x-copis-web-token`，Main 仅使用 `getHttpApiInternalToken()` 调用 Phase 2 已保护的 internal grant/finalize 路由；所有公开聊天室 HTTP/SSE 路由统一以 `/api/chatrooms/v2` 开头。
- COS 临时凭据只存在 Main 单次上传/下载调用栈，禁止写入文件、日志、Jotai、IPC 事件、SSE、错误正文或 Renderer 返回值；Renderer 只能收到 `transferId`、阶段、进度、错误码和脱敏结果。
- COS object key 只能使用 Rust/edu-api grant 返回值，客户端不得生成、覆盖、显示或持久化 object key；上传仅允许 PutObject/分片上传/中止，下载仅允许单对象 GetObject。
- 房间、消息、成员、Agent、presence、invocation、游标和附件元数据不写入 `localStorage`；纯 UI 草稿和展开状态保留在 Jotai 内存，跨启动的 Agent 绑定由 Main 按 `room.json` 保存。
- 分享码输入只接受 4 位 `[A-Z0-9]`，客户端先转大写并直接调用 join；大小写不影响加入，服务端负责唯一性、有效性和限流，客户端不生成或猜测分享码。
- 主理人创建的聊天室 Agent 默认最多 3 个；主理人可分别控制来源记忆和 Skill 是否共享，授权只影响对应 Agent 的能力，其他成员不能看到或下载原始记忆与 Skill。
- 真人或 Agent 可以结构化 mention 一个或多个 Agent；离线 Agent 立即显示 `agent_offline` 且不排队；Agent 续唤沿用 `traceId`、`parentMessageId` 和 `depth`，达到三跳或重复目标时只展示停止原因。
- 所有业务状态使用 Jotai，组件通过现有类型化 hooks/API 访问 atoms；新增注释、日志和用户文案优先中文，日志不包含完整消息、本地绝对路径、凭据、STS 或 object key。
- 采用 BDD/TDD：每个任务先加入可复现的 Given/When/Then 失败测试，单独确认 RED，再实现最小行为确认 GREEN，并单独提交。
- Electron UI 最终必须由用户在真实应用窗口中确认；不得用截图、截图比对、`about:blank` 或只检查主 Renderer DOM 代替用户验收。

## File Structure

| Path | Responsibility |
| --- | --- |
| `packages/shared/src/types/chatroom.ts` | Phase 3 已有聊天室共享契约；本阶段只扩展公共房间/消息/附件/传输 DTO、COS IPC 方法和脱敏结果。 |
| `packages/shared/src/types/index.ts` | 保持 Phase 3 聊天室类型导出，新增类型仍从既有 `chatroom.ts` 导出。 |
| `packages/shared/src/index.ts` | 保持现有共享入口导出，不新增重复 constants 模块。 |
| `apps/electron/src/main/lib/chatroom-cos-service.ts` | Main 内部请求 STS、COS SDK 上传/下载、进度、取消和 finalize。 |
| `apps/electron/src/main/lib/chatroom-cos-service.test.ts` | Fake grant/COS client 驱动的 STS、进度、取消、finalize 和敏感字段边界测试。 |
| `apps/electron/src/main/ipc/chatrooms.ipc.ts` | 在 Phase 3 既有聊天室 IPC handler 中扩展 Main-only COS transfer 与文件选择。 |
| `apps/electron/src/main/ipc/chatrooms-cos.ipc.test.ts` | IPC 参数校验、既有 channel 注册、Renderer 不可取得 STS/路径测试。 |
| `apps/electron/src/main/ipc.ts` | 注册聊天室 IPC handlers。 |
| `apps/electron/src/preload/index.ts` | 在既有 `electronAPI.chatrooms` 上暴露 transfer API 和取消订阅函数，不返回本地路径或 STS。 |
| `apps/electron/src/renderer/lib/chatroom-api.ts` | Rust gateway 聊天室 HTTP client、响应校验和稳定错误映射。 |
| `apps/electron/src/renderer/lib/chatroom-api.test.ts` | 创建/加入/消息/附件元数据和错误映射 BDD 测试。 |
| `apps/electron/src/renderer/lib/chatroom-sse.ts` | 带 web token 的 fetch streaming SSE client、重连和注销。 |
| `apps/electron/src/renderer/lib/chatroom-sse.test.ts` | 事件解析、断线退避、房间过滤和关闭页面后连接保留测试。 |
| `apps/electron/src/renderer/atoms/chatroom-atoms.ts` | 按 roomId 隔离的房间、消息、presence、invocation、附件、游标、未读、草稿状态。 |
| `apps/electron/src/renderer/atoms/chatroom-atoms.test.ts` | Jotai store reducer/selector、重复事件、未读、离线和 mention 状态测试。 |
| `apps/electron/src/renderer/components/chatroom/ChatroomSseInitializer.tsx` | Renderer 顶层全局 SSE 生命周期与 atom 更新。 |
| `apps/electron/src/renderer/components/chatroom/ChatroomView.tsx` | 房间头部、消息流、输入区和左右布局。 |
| `apps/electron/src/renderer/components/chatroom/ChatroomComposer.tsx` | 结构化 mention、附件状态、断线禁用和手动重试。 |
| `apps/electron/src/renderer/components/chatroom/ChatroomMembersPanel.tsx` | 成员、Agent presence、host 设置与 3-agent 上限展示。 |
| `apps/electron/src/renderer/components/chatroom/ChatroomCreateDialog.tsx` | 房间创建、分享码、Agent 工作区和记忆/Skill 共享选择。 |
| `apps/electron/src/renderer/components/chatroom/ChatroomJoinDialog.tsx` | 4 位分享码自动大写和直接加入。 |
| `apps/electron/src/renderer/components/chatroom/*.test.tsx` | 左侧入口、创建/加入、消息、mention、附件和角色权限测试。 |
| `apps/electron/src/renderer/atoms/tab-atoms.ts` | 新增独立 chatroom Tab 类型和 roomId 打开/关闭辅助函数。 |
| `apps/electron/src/renderer/atoms/tab-atoms.test.ts` | Agent/项目 Tab 不被聊天室替换、同房间聚焦和多房间并存测试。 |
| `apps/electron/src/renderer/components/tabs/TabContent.tsx` | 渲染 ChatroomView。 |
| `apps/electron/src/renderer/components/tabs/MainArea.tsx` | 聊天室 Tab 不触发 Agent 预览分屏。 |
| `apps/electron/src/renderer/components/tabs/TabBar.tsx` | 聊天室 Tab 标题、状态点和关闭行为。 |
| `apps/electron/src/renderer/components/app-shell/CopisWorkingSidebar.tsx` | 左侧“聊天室”分组、未读/连接状态、加入/创建图标按钮。 |
| `apps/electron/src/renderer/main.tsx` | 挂载全局 ChatroomSseInitializer。 |
| `apps/electron/package.json` | 将 COS SDK 声明为 Electron runtime dependency。 |
| `bun.lock` | 锁定 Electron workspace 的 `cos-nodejs-sdk-v5@3.0.0`。 |
| `apps/electron/electron-builder.yml` | 允许 COS SDK 进入 Electron runtime 包，继续排除发布脚本密钥。 |
| `scripts/functional-module-boundary.test.ts` | 反向更新 COS runtime 边界断言并保证长期发布凭据仍只在仓库脚本。 |

## Interfaces

后续任务沿用 Phase 3 已有的 `ChatRoom*` 契约，不创建平行类型；以下仅列出 Phase 4 新增或扩展的签名。

    // packages/shared/src/types/chatroom.ts
    export type ChatRoomRole = 'host' | 'member'
    export type ChatRoomStatus = 'active' | 'archived' | 'deleting' | 'deleted'
    export type ChatRoomPresence = 'online' | 'busy' | 'offline' | 'disabled'
    export type ChatRoomConnectionStatus = 'connecting' | 'connected' | 'reconnecting' | 'offline' | 'auth_expired'
    export type ChatRoomAttachmentPhase = 'waiting_authorization' | 'uploading' | 'validating' | 'ready' | 'downloading' | 'failed' | 'cancelled'

    export interface ChatRoomSummary {
      roomId: string; name: string; role: ChatRoomRole; status: ChatRoomStatus
      shareCode?: string; memberCount: number; unreadCount: number
      connectionStatus: ChatRoomConnectionStatus
    }
    export interface ChatRoomMember { userId: string; displayName: string; avatar?: string; role: ChatRoomRole; presence: ChatRoomPresence }
    export interface ChatRoomAgent {
      agentId: string; displayName: string; avatar?: string; status: ChatRoomPresence
      busy: boolean; memoryShared: boolean; skillsShared: boolean
    }
    export interface ChatRoomMessage {
      messageId: string; roomId: string; seq: number; senderType: 'user' | 'agent' | 'system'
      senderId: string; content: string; mentionAgentIds: string[]; attachmentIds: string[]
      clientMessageId: string; traceId?: string; parentMessageId?: string; depth: number; createdAt: string
    }
    export interface ChatRoomInvocation {
      invocationId: string; roomId: string; traceId: string; targetAgentId: string
      triggerMessageId: string; depth: number; status: 'created' | 'accepted' | 'running' | 'completed' | 'failed' | 'rejected'
      failureCode?: string; delta?: string; errorMessage?: string
    }
    export interface ChatRoomAttachment { attachmentId: string; roomId: string; originalName: string; mimeType: string; sizeBytes: number; status: 'pending' | 'ready' | 'attached' | 'deleted'; messageId?: string }
    export interface ChatRoomTransferState { transferId: string; attachmentId?: string; roomId: string; originalName?: string; phase: ChatRoomAttachmentPhase; progress: number; errorCode?: string }
    export interface ChatRoomEventEnvelope { type: string; roomId?: string; seq?: number; latestSeq?: number; payload: unknown }

    export interface ChatRoomCreateInput { name: string; shareCode: string }
    export interface ChatRoomJoinInput { shareCode: string }
    export interface ChatRoomSendMessageInput { roomId: string; content: string; mentionAgentIds: string[]; attachmentIds: string[]; clientMessageId: string }
    export interface ChatRoomDownloadRequest { transferId: string; roomId: string; attachmentId: string; target: 'user' | 'agent_inbox' }
    export interface ChatRoomTransferResult { transferId: string; attachmentId?: string; originalName?: string; phase: 'ready' | 'failed' | 'cancelled'; errorCode?: string }

    // packages/shared/src/types/chatroom.ts; add these properties to the existing Phase 3 object in place:
    // SELECT_AND_UPLOAD: 'chatrooms:select-and-upload'
    // START_DOWNLOAD: 'chatrooms:start-download'
    // CANCEL_TRANSFER: 'chatrooms:cancel-transfer'
    // TRANSFER_PROGRESS: 'chatrooms:transfer-progress'

    // apps/electron/src/main/lib/chatroom-cos-service.ts; these jobs remain Main-only
    export interface ChatRoomUploadJob { transferId: string; roomId: string; filePath: string }
    export interface ChatRoomDownloadJob extends ChatRoomDownloadRequest { destinationPath: string }
    export interface ChatRoomCosGrantClient {
      requestUploadGrant(input: { roomId: string; originalName: string; mimeType: string; sizeBytes: number; sha256: string }): Promise<CosSdkGrant>
      requestDownloadGrant(input: { roomId: string; attachmentId: string }): Promise<CosSdkGrant>
      finalizeUpload(input: { roomId: string; attachmentId: string; sizeBytes: number; sha256: string; etag: string }): Promise<void>
    }
    export interface CosSdkGrant { attachmentId: string; bucket: string; region: string; objectKey: string; tmpSecretId: string; tmpSecretKey: string; sessionToken: string; startTime: number; expiredTime: number; action: 'upload' | 'download' }
    export interface ChatRoomCosService { selectAndUpload(input: { transferId: string; roomId: string }): Promise<ChatRoomTransferResult>; upload(input: ChatRoomUploadJob): Promise<ChatRoomTransferResult>; download(input: ChatRoomDownloadJob): Promise<ChatRoomTransferResult>; cancel(transferId: string): Promise<void>; onProgress(listener: (state: ChatRoomTransferState) => void): () => void }

    // apps/electron/src/renderer/lib/chatroom-api.ts
    export interface ChatRoomApi {
      listRooms(): Promise<ChatRoomSummary[]>; getRoom(roomId: string): Promise<{ room: ChatRoomSummary; members: ChatRoomMember[]; agents: ChatRoomAgent[] }>
      createRoom(input: ChatRoomCreateInput): Promise<{ room: ChatRoomSummary }>; joinRoom(input: ChatRoomJoinInput): Promise<{ room: ChatRoomSummary; members: ChatRoomMember[]; agents: ChatRoomAgent[] }>
      listMessages(roomId: string, beforeSeq?: number): Promise<{ messages: ChatRoomMessage[]; nextBeforeSeq?: number }>; sendMessage(input: ChatRoomSendMessageInput): Promise<ChatRoomMessage>
      removeAgent(roomId: string, agentId: string): Promise<void>; requestDownload(roomId: string, attachmentId: string, target: 'user' | 'agent_inbox'): Promise<void>
      subscribe(roomIds: string[], onEvent: (event: ChatRoomEventEnvelope) => void, onStatus: (status: ChatRoomConnectionStatus) => void): () => void
    }

### Task 1: Extend Existing Shared Chatroom Contracts

**Files:**
- Modify: `packages/shared/src/types/chatroom.ts` (Phase 3 already created this file and `CHATROOM_IPC_CHANNELS`)
- Create: `packages/shared/src/types/chatroom-renderer.test.ts`
- Modify: `packages/shared/src/types/index.ts`

**Interfaces:**
- Extends the existing `ChatRoom*` types and `CHATROOM_IPC_CHANNELS`; it does not create a second chatroom module or constants file.
- Consumes the Phase 2 public event shape and Phase 3 `ChatRoomElectronAPI`/Agent DTOs; shared Renderer types do not contain JWT, STS secrets, object keys or local paths.

- [ ] **Step 1: Write the failing BDD tests**

  Add tests asserting: a lower-case `a7k2` join input normalizes to `A7K2`; a room create DTO is exactly `{ name, shareCode }`; a message carries two structured Agent IDs without caller-supplied `traceId`, `parentMessageId` or `depth`; transfer state may include `originalName` but no path/key/STS; `CHATROOM_IPC_CHANNELS` is extended in place with `SELECT_AND_UPLOAD`, `START_DOWNLOAD`, `CANCEL_TRANSFER` and `TRANSFER_PROGRESS`; existing `provisionAgent` remains available for post-create Agent setup.

- [ ] **Step 2: Run test to verify RED**

  Run: `bun test packages/shared/src/types/chatroom-renderer.test.ts`

  Expected: FAIL because the existing shared module has not yet been extended with the Renderer/COS contracts.

- [ ] **Step 3: Implement the minimum contracts**

  Extend the existing `chatroom.ts` exports in place with `ChatRoomSummary`, `ChatRoomMember`, `ChatRoomAgent`, `ChatRoomMessage`, `ChatRoomInvocation`, `ChatRoomAttachment`, `ChatRoomTransferState`, `ChatRoomEventEnvelope`, `ChatRoomCreateInput`, `ChatRoomJoinInput`, `ChatRoomSendMessageInput`, `ChatRoomDownloadRequest` and `ChatRoomTransferResult`. Keep `ChatRoomCreateInput` exactly `{ name: string; shareCode: string }`; keep `ChatRoomSendMessageInput` limited to room/content/mention IDs/attachment IDs/clientMessageId, with trace/depth fields absent. Extend the existing `CHATROOM_IPC_CHANNELS` object rather than redeclaring it, and extend the existing `ChatRoomElectronAPI` with `startUpload(input: { transferId: string; roomId: string })`, `startDownload(input: ChatRoomDownloadRequest)`, `cancelTransfer(transferId: string)` and `onTransferProgress(callback: (state: ChatRoomTransferState) => void): () => void`. Preserve Phase 3 `provisionAgent` and normalize the four-character code at the Renderer boundary.

- [ ] **Step 4: Run test to verify GREEN**

  Run: `bun test packages/shared/src/types/chatroom-renderer.test.ts`

  Expected: all contract, normalization and sensitive-field assertions PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add packages/shared/src/types/chatroom.ts packages/shared/src/types/chatroom-renderer.test.ts packages/shared/src/types/index.ts
  git commit -m "feat(shared): extend chatroom renderer contracts"
  ```

### Task 2: Main COS Transfer Service

**Files:**
- Create: `apps/electron/src/main/lib/chatroom-cos-service.ts`
- Create: `apps/electron/src/main/lib/chatroom-cos-service.test.ts`
- Modify: `apps/electron/package.json`
- Modify: `bun.lock`

**Interfaces:**
- Consumes `getHttpApiInternalToken()` from `main/lib/http-api-server.ts`, `HTTP_API_HOST`/port configuration, `CosSdkGrant` and `ChatRoomTransfer*` from Task 1.
- Produces Main-only `ChatRoomCosService`, `ChatRoomCosGrantClient`, `ChatRoomUploadJob` and `ChatRoomDownloadJob`; no method returns a grant or local path.

- [ ] **Step 1: Check the existing dependency before writing tests**

  Run: `bun pm ls cos-nodejs-sdk-v5` and `bun why cos-nodejs-sdk-v5`.

  Expected: the repository resolves `cos-nodejs-sdk-v5@3.0.0` from the root publishing scripts and no newer version is selected. Use the installed `index.d.ts` signatures for `sliceUploadFile`, `abortUploadTask`, `downloadFile`, `onTaskReady` and `onProgress`.

- [ ] **Step 2: Write the failing BDD tests**

  With injected fake grant client and fake COS SDK, cover:

  ```ts
  test('Main 选择文件后读取 metadata/SHA256，只请求一次上传授权并 finalize', async () => {})
  test('分片上传把 SDK progress 映射为脱敏 transfer state', async () => {})
  test('取消上传调用 abortUploadTask 且不会 finalize', async () => {})
  test('下载只使用服务端 objectKey 并把结果写到 Main 选择的目标', async () => {})
  test('下载到 Agent inbox 只解析绑定房间的隔离目录', async () => {})
  test('STS 和 objectKey 不出现在进度、结果、错误和日志', async () => {})
  ```

  Assert that `selectAndUpload({ transferId, roomId })` opens the Main file picker, computes metadata and SHA-256, receives a grant containing `attachmentId`, and passes the grant only to the SDK before finalize. Credentials remain in the fake SDK call only, `finalizeUpload` receives the SDK ETag/declared hash, and a Renderer-facing result may include `originalName` but has no path, grant or object key.

- [ ] **Step 3: Run test to verify RED**

  Run: `bun test apps/electron/src/main/lib/chatroom-cos-service.test.ts`

  Expected: FAIL because the service and injected SDK boundary do not exist.

- [ ] **Step 4: Implement grant, upload, download, progress and cancellation**

  Add an internal HTTP client that calls the Phase 2 protected grant/finalize routes with `X-Copis-Internal-Token`; parse only the seven Rust whitelist fields plus `attachmentId`, and reject a mismatched action. `selectAndUpload({ transferId, roomId })` opens `dialog.showOpenDialog`, reads the selected file's name/MIME/size/SHA-256 in Main, requests an upload grant without an attachment ID, receives the server `attachmentId` and `objectKey`, passes the key unchanged to `sliceUploadFile`, registers `onTaskReady` and `onProgress`, calls finalize, then clears all credential/key/path references in `finally`. For download, `startDownload` requests a grant by attachment ID and calls `downloadFile` with the returned key and a Main-only destination: `dialog.showSaveDialog` for `target: 'user'`, or the bound Agent's isolated `project/inbox/` for `target: 'agent_inbox'`. `cancel` looks up the in-memory SDK task and calls `abortUploadTask`; unknown or already-finished IDs return stable `transfer_not_found`. Never log request bodies, credentials, paths or keys.

  Add `cos-nodejs-sdk-v5: "3.0.0"` under `apps/electron` runtime `dependencies` and update `bun.lock` using the existing Bun workspace lockfile. Do not move the root publishing dependency or add publish scripts to Electron.

- [ ] **Step 5: Run test to verify GREEN**

  Run: `bun test apps/electron/src/main/lib/chatroom-cos-service.test.ts`

  Expected: all upload/download/cancel/finalize/progress and secret-boundary tests PASS.

- [ ] **Step 6: Commit**

  ```bash
  git add apps/electron/src/main/lib/chatroom-cos-service.ts apps/electron/src/main/lib/chatroom-cos-service.test.ts apps/electron/package.json bun.lock
  git commit -m "feat(electron): add chatroom cos transfers"
  ```

### Task 3: Extend Existing Chatroom IPC and Preload Boundary

**Files:**
- Modify: `apps/electron/src/main/ipc/chatrooms.ipc.ts` (Phase 3 already created this handler)
- Create: `apps/electron/src/main/ipc/chatrooms-cos.ipc.test.ts`
- Modify: `apps/electron/src/main/ipc.ts`
- Modify: `apps/electron/src/preload/index.ts`

**Interfaces:**
- Consumes the extended `CHATROOM_IPC_CHANNELS`, Main-only `ChatRoomCosService`, `ChatRoomTransferResult` and the existing `ChatRoomElectronAPI` from Tasks 1–2.
- Produces `window.electronAPI.chatrooms.startUpload({ transferId, roomId })`, `.startDownload({ transferId, roomId, attachmentId, target })`, `.cancelTransfer(transferId)` and `.onTransferProgress`; no preload method returns `CosSdkGrant`, `filePath` or a local path.

- [ ] **Step 1: Write the failing BDD tests**

  Add IPC tests that invoke `startUpload` with only `{ transferId, roomId }`, prove the Main handler opens a file picker and passes no path back, reject empty IDs and cancelled dialogs, deliver progress with `originalName` allowed but no path/key/STS, and prove `Object.keys` of every preload result does not contain any grant field. Assert the existing Phase 3 handler is registered once by `registerIpcHandlers`.

- [ ] **Step 2: Run test to verify RED**

  Run: `bun test apps/electron/src/main/ipc/chatrooms-cos.ipc.test.ts`

  Expected: FAIL because the existing handler has not been extended with COS transfer methods.

- [ ] **Step 3: Implement the narrow bridge**

  Extend the existing Phase 3 handlers with `selectAndUpload({ transferId, roomId })` and `startDownload({ transferId, roomId, attachmentId, target })`. Main opens the file picker, computes metadata/SHA-256, requests the upload grant without `attachmentId`, and calls `ChatRoomCosService.selectAndUpload`; the grant's server `attachmentId` and `objectKey` stay in Main. For `target: 'user'`, open `dialog.showSaveDialog`; for `target: 'agent_inbox'`, resolve the bound Agent's isolated `project/inbox/` in Main. Forward progress through `webContents.send(CHATROOM_IPC_CHANNELS.TRANSFER_PROGRESS, state)` with optional `originalName`, and return only `ChatRoomTransferResult`. Extend the existing `ChatRoomElectronAPI` in preload with `startUpload`, `startDownload`, `cancelTransfer` and `onTransferProgress`; no path-bearing input is returned. Keep Agent invocation acceptance/result bridge in the existing Phase 3 Main coordinator; do not expose it as a separate Renderer API.

- [ ] **Step 4: Run test to verify GREEN**

  Run: `bun test apps/electron/src/main/ipc/chatrooms-cos.ipc.test.ts`

  Expected: all validation, listener cleanup, result-shaping and registration tests PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add apps/electron/src/main/ipc/chatrooms.ipc.ts apps/electron/src/main/ipc/chatrooms-cos.ipc.test.ts apps/electron/src/main/ipc.ts apps/electron/src/preload/index.ts packages/shared/src/types/chatroom.ts
  git commit -m "feat(electron): extend chatroom transfer ipc"
  ```

### Task 4: Renderer API, SSE and Jotai State

**Files:**
- Create: `apps/electron/src/renderer/lib/chatroom-api.ts`
- Create: `apps/electron/src/renderer/lib/chatroom-api.test.ts`
- Create: `apps/electron/src/renderer/lib/chatroom-sse.ts`
- Create: `apps/electron/src/renderer/lib/chatroom-sse.test.ts`
- Create: `apps/electron/src/renderer/atoms/chatroom-atoms.ts`
- Create: `apps/electron/src/renderer/atoms/chatroom-atoms.test.ts`
- Create: `apps/electron/src/renderer/components/chatroom/ChatroomSseInitializer.tsx`
- Modify: `apps/electron/src/renderer/main.tsx`

**Interfaces:**
- Consumes `ChatRoomApi` and existing Phase 3 `ChatRoomElectronAPI` entities, the existing `RENDERER_HTTP_API_BASE_URL`, `withHttpApiWebToken`, and Rust gateway public routes from Phase 2.
- Produces `chatRoomApi`, `ChatRoomSseClient`, `ChatRoomSseInitializer`, and atoms named `chatRoomRoomsAtom`, `chatRoomDetailsAtom`, `chatRoomMessagesAtom`, `chatRoomCursorsAtom`, `chatRoomConnectionStatusAtom`, `chatRoomInvocationsAtom`, `chatRoomTransfersAtom`, `chatRoomDraftsAtom`, `chatRoomMentionAgentIdsAtom` and `chatRoomUnreadCountsAtom`.

- [ ] **Step 1: Write the failing BDD tests**

  Add tests for:

  ```ts
  test('加入请求将小写分享码转为大写并直接调用 join', async () => {})
  test('创建请求只发送 name/shareCode，不携带 Agent 配置', async () => {})
  test('HTTP 非 2xx 映射稳定 code 且不把内部响应原样抛出', async () => {})
  test('SSE 按 event/data 帧解析并清理函数停止请求', async () => {})
  test('断线状态进入 reconnecting，页面卸载只移除页面订阅', async () => {})
  test('同一 roomId 的消息、游标、未读和草稿互不污染', async () => {})
  test('离线 Agent 事件是 terminal failure 且发送操作不进入本地队列', async () => {})
  ```

  Fake `fetch` with a streaming response and assert every request contains the existing web token but no `Authorization` bearer token.

- [ ] **Step 2: Run tests to verify RED**

  Run separately: `bun test apps/electron/src/renderer/lib/chatroom-api.test.ts`, `bun test apps/electron/src/renderer/lib/chatroom-sse.test.ts`, `bun test apps/electron/src/renderer/atoms/chatroom-atoms.test.ts`

  Expected: FAIL because the API client, SSE parser and atoms do not exist.

- [ ] **Step 3: Implement HTTP client and SSE lifecycle**

  Implement strict response parsing for the unified `/api/chatrooms/v2` paths: list/get/create/join rooms, paged messages, send message with UUID `clientMessageId`, Agent public status, member/read cursor and attachment metadata. `createRoom` sends only `{ name, shareCode }`; the create flow provisions selected local Agents afterward through the existing `window.electronAPI.chatrooms.provisionAgent` one at a time, stopping at `CHATROOM_MAX_AGENTS = 3`. Remove any `requestUploadGrant` method; attachments call `window.electronAPI.chatrooms.startUpload({ transferId, roomId })` and `startDownload(...)`. Generate `clientMessageId` once per user send and reuse it for manual retry; callers never submit `traceId`, `parentMessageId` or `depth`, which are server-owned. Use a fetch-based SSE reader with `x-copis-web-token`, parse `event:` and multi-line `data:`, dispatch only `ChatRoomEventEnvelope`, and reconnect with bounded delays while preserving subscriptions. The `close()` method aborts only this client; `ChatRoomSseInitializer` remains mounted at `main.tsx` and subscribes to all known room IDs, so closing a ChatroomView cannot stop background unread/presence/invocation updates.

- [ ] **Step 4: Implement Jotai state reducers and selectors**

  Store messages, event cursors, presence, invocation deltas, attachment transfer states, connection status, drafts and mention IDs in room-keyed Maps. On `message.created`, advance only that room's cursor and unread count when it is not the active room; on `agent.delta`, merge by invocation ID; on `agent.completed`/`agent.failed`, clear the delta and retain the terminal state. A failed send is rendered as failed and is never queued. Expose actions for manual retry, read cursor update, room subscribe/unsubscribe and transfer-state update. Do not use `atomWithStorage` for server data.

- [ ] **Step 5: Run tests to verify GREEN**

  Run separately: `bun test apps/electron/src/renderer/lib/chatroom-api.test.ts`, `bun test apps/electron/src/renderer/lib/chatroom-sse.test.ts`, `bun test apps/electron/src/renderer/atoms/chatroom-atoms.test.ts`

  Expected: all API, streaming, room isolation, unread, retry, offline and no-token assertions PASS.

- [ ] **Step 6: Commit**

  ```bash
  git add apps/electron/src/renderer/lib/chatroom-api.ts apps/electron/src/renderer/lib/chatroom-api.test.ts apps/electron/src/renderer/lib/chatroom-sse.ts apps/electron/src/renderer/lib/chatroom-sse.test.ts apps/electron/src/renderer/atoms/chatroom-atoms.ts apps/electron/src/renderer/atoms/chatroom-atoms.test.ts apps/electron/src/renderer/components/chatroom/ChatroomSseInitializer.tsx apps/electron/src/renderer/main.tsx
  git commit -m "feat(renderer): add chatroom api sse and jotai state"
  ```

### Task 5: Chatroom Tab, Sidebar and Room UI

**Files:**
- Create: `apps/electron/src/renderer/components/chatroom/ChatroomView.tsx`
- Create: `apps/electron/src/renderer/components/chatroom/ChatroomComposer.tsx`
- Create: `apps/electron/src/renderer/components/chatroom/ChatroomMembersPanel.tsx`
- Create: `apps/electron/src/renderer/components/chatroom/ChatroomCreateDialog.tsx`
- Create: `apps/electron/src/renderer/components/chatroom/ChatroomJoinDialog.tsx`
- Create: `apps/electron/src/renderer/components/chatroom/ChatroomView.test.tsx`
- Create: `apps/electron/src/renderer/components/chatroom/ChatroomComposer.test.tsx`
- Create: `apps/electron/src/renderer/components/chatroom/ChatroomDialogs.test.tsx`
- Modify: `apps/electron/src/renderer/atoms/tab-atoms.ts`
- Modify: `apps/electron/src/renderer/atoms/tab-atoms.test.ts`
- Modify: `apps/electron/src/renderer/components/tabs/TabContent.tsx`
- Modify: `apps/electron/src/renderer/components/tabs/MainArea.tsx`
- Modify: `apps/electron/src/renderer/components/tabs/TabBar.tsx`
- Modify: `apps/electron/src/renderer/components/app-shell/CopisWorkingSidebar.tsx`

**Interfaces:**
- Consumes `chatRoomApi`, room-keyed atoms, the existing `electronAPI.chatrooms.provisionAgent` plus transfer methods and `openChatRoomTab` from Tasks 1–4.
- Produces a discriminated-union `chatroom` `TabItem` shaped as `{ id, type: 'chatroom', roomId, title }`; it has no `sessionId`. Existing `openTab` behavior for Agent/preview/tutorial remains unchanged and no ChatroomView owns global SSE.

- [ ] **Step 1: Write the failing BDD tests**

  Add tests asserting:

  ```tsx
  test('左侧聊天室标题右侧同时显示加入和创建图标', () => {})
  test('输入小写四位分享码后直接加入并打开对应 roomId tab', async () => {})
  test('创建表单只提交 name/shareCode，创建后最多逐个 provision 三个 Agent', async () => {})
  test('Agent 和项目 Tab 存在时打开聊天室不会替换它们', () => {})
  test('一条消息可结构化提及两个 Agent，离线 Agent 显示离线且不排队', async () => {})
  test('Agent 只能通过结构化 ID 触发，普通文本 @ 名称不创建 invocation', async () => {})
  test('只有完成 finalize 的附件可发送，上传中/失败状态禁用附件发送', () => {})
  test('普通成员不显示成员管理、Agent 管理、归档删除和敏感授权批准操作', () => {})
  ```

  Use a mocked Jotai store and mocked `window.electronAPI.chatrooms`; inspect semantic roles and button labels/icons, not screenshots.

- [ ] **Step 2: Run tests to verify RED**

  Run: `bun test apps/electron/src/renderer/components/chatroom/ChatroomView.test.tsx apps/electron/src/renderer/components/chatroom/ChatroomComposer.test.tsx apps/electron/src/renderer/components/chatroom/ChatroomDialogs.test.tsx apps/electron/src/renderer/atoms/tab-atoms.test.ts`

  Expected: FAIL because the `chatroom` Tab type, sidebar controls and components do not exist.

- [ ] **Step 3: Add independent room Tabs**

  Convert `TabItem` to a discriminated union while preserving existing Agent/preview/tutorial members. Add `ChatRoomTabItem = { id: string; type: 'chatroom'; roomId: string; title: string }` and `openChatRoomTab(tabs, room): { tabs: TabItem[]; activeTabId: string }` using stable ID `chatroom:${room.roomId}`. Re-opening a room focuses its existing Tab; opening a room appends it without deleting Agent/preview/project entries. `activeSessionIdAtom` returns `null` for chatroom Tabs, and no helper fabricates a `sessionId`. Update TabBar close/status rendering and keep chatroom Tabs out of Agent preview split logic. Add coverage for multiple rooms and stale room IDs.

- [ ] **Step 4: Build sidebar, dialogs and room view**

  Add a “聊天室” group to `CopisWorkingSidebar`; its title row contains both `UserPlus` (加入) and `Plus` (创建) icon buttons with accessible labels/tooltips, including when the sidebar is collapsed. Each row shows room name, unread count and connection status. `ChatroomJoinDialog` trims and uppercases the four-character code, validates `[A-Z0-9]{4}`, calls `joinRoom`, then opens the returned room Tab immediately. `ChatroomCreateDialog` first submits exactly `{ name, shareCode }`; after the room is created, it calls existing `window.electronAPI.chatrooms.provisionAgent` once per selected source workspace with per-Agent display name and memory/Skill sharing settings, displays `n/3`, and rejects a fourth selection locally. A failed post-create provision leaves the room created and reports the specific Agent setup failure without resubmitting the room.

  `ChatroomView` renders a compact room header with share code/member count/Agent states, the central message stream and composer, and a right members panel. `ChatroomComposer` stores draft in Jotai, offers structured Agent candidates with online/busy/offline status, allows multiple mentions, creates a UUID once, sends only `{ roomId, content, mentionAgentIds, attachmentIds, clientMessageId }`, and shows a manual retry action reusing the same `clientMessageId`; it never constructs or submits `traceId`, `parentMessageId` or `depth`. Attachments call `window.electronAPI.chatrooms.startUpload({ transferId, roomId })`; Main performs selection/grant/upload/finalize and returns a sanitized result with optional `originalName`; only a `ready` result may be included in `sendMessage`. Downloads call `startDownload` with attachment ID and target. It renders `agent_offline`, `invocation_depth_exceeded`, `invocation_duplicate`, `realtime_reconnecting`, and `auth_expired` as explicit statuses without queueing. Attachment rows show waiting authorization, uploading, validating, ready or failed; COS keys, credentials and local absolute paths never render.

  `ChatroomMembersPanel` exposes host-only share-code/member/Agent/permission/archive controls. Host-created Agent rows show independent memory and Skill switches; ordinary members get read-only public Agent status and cannot approve host-sensitive tools. Preserve the existing card/shadow and icon-button conventions, keep compact headings, and avoid adding explanatory feature prose to the application surface.

- [ ] **Step 5: Run tests to verify GREEN**

  Run: `bun test apps/electron/src/renderer/components/chatroom/ChatroomView.test.tsx apps/electron/src/renderer/components/chatroom/ChatroomComposer.test.tsx apps/electron/src/renderer/components/chatroom/ChatroomDialogs.test.tsx apps/electron/src/renderer/atoms/tab-atoms.test.ts`

  Expected: all sidebar, join/create, tab isolation, mention, offline/no-queue, attachment-state and role-gating tests PASS.

- [ ] **Step 6: Commit**

  ```bash
  git add apps/electron/src/renderer/components/chatroom apps/electron/src/renderer/atoms/tab-atoms.ts apps/electron/src/renderer/atoms/tab-atoms.test.ts apps/electron/src/renderer/components/tabs/TabContent.tsx apps/electron/src/renderer/components/tabs/MainArea.tsx apps/electron/src/renderer/components/tabs/TabBar.tsx apps/electron/src/renderer/components/app-shell/CopisWorkingSidebar.tsx
  git commit -m "feat(renderer): add chatroom tabs and ui"
  ```

### Task 6: Builder Boundary, Integration Tests and Verification

**Files:**
- Modify: `apps/electron/electron-builder.yml`
- Modify: `scripts/functional-module-boundary.test.ts`
- Create: `apps/electron/src/main/lib/chatroom-cos-package-boundary.test.ts`
- Create: `apps/electron/src/renderer/components/chatroom/chatroom-integration.test.tsx`

**Interfaces:**
- Consumes all Main, preload, Renderer and shared interfaces from Tasks 1–5.
- Produces a verified Electron package boundary: runtime contains COS SDK code but no root publishing script or long-lived COS credentials; Renderer receives only transfer state and public room events.

- [ ] **Step 1: Write the failing boundary and integration tests**

  Add assertions that `apps/electron/package.json` declares exactly `cos-nodejs-sdk-v5: "3.0.0"`, `electron-builder.yml` does not exclude that package, root `package.json` still owns `publish:functional-modules`, no Electron publish script exists, and a fake upload/download run never exposes grant fields to a Renderer listener. Add an integration BDD harness for: create with `a7k2` -> room code `A7K2`; direct join; two parallel Agent invocation status rows; Agent-to-Agent depth stop; offline no queue; finalize-gated attachment; archive disables send/upload; restore re-enables them.

- [ ] **Step 2: Run tests to verify RED**

  Run separately: `bun test apps/electron/src/main/lib/chatroom-cos-package-boundary.test.ts` and `bun test apps/electron/src/renderer/components/chatroom/chatroom-integration.test.tsx`

  Expected: FAIL because the builder exclusion and old boundary assertion still describe COS as root-script-only, and the integrated UI flow is not wired.

- [ ] **Step 3: Update builder and boundary assertions**

  Remove only the `!node_modules/cos-nodejs-sdk-v5/**` exclusion from `electron-builder.yml`; retain all existing native unpacking and runtime dependency exclusions. Update `scripts/functional-module-boundary.test.ts` to assert the new split: Electron runtime owns the SDK for short-lived chatroom STS, root scripts own long-lived publish credentials, and no credentials are present in package metadata, manifest or logs. Keep default Electron builds independent from Rust compilation and COS publishing.

- [ ] **Step 4: Run focused tests and builds**

  Run each command separately:

  ```bash
  bun test packages/shared/src/types/chatroom-renderer.test.ts
  bun test apps/electron/src/main/lib/chatroom-cos-service.test.ts
  bun test apps/electron/src/main/ipc/chatrooms-cos.ipc.test.ts
  bun test apps/electron/src/renderer/lib/chatroom-api.test.ts
  bun test apps/electron/src/renderer/lib/chatroom-sse.test.ts
  bun test apps/electron/src/renderer/atoms/chatroom-atoms.test.ts
  bun test apps/electron/src/renderer/components/chatroom/ChatroomView.test.tsx apps/electron/src/renderer/components/chatroom/ChatroomComposer.test.tsx apps/electron/src/renderer/components/chatroom/ChatroomDialogs.test.tsx
  bun test apps/electron/src/main/lib/chatroom-cos-package-boundary.test.ts
  bun test apps/electron/src/renderer/components/chatroom/chatroom-integration.test.tsx
  bun test scripts/functional-module-boundary.test.ts
  bun run typecheck
  bun run --filter='@copis/electron' build:main
  bun run --filter='@copis/electron' build:renderer
  ```

  Expected: all tests pass; main and renderer builds complete; no type errors; no test output includes Working JWT, COS credentials, object key or local absolute paths.

- [ ] **Step 5: Run final repository checks**

  Run:

  ```bash
  bun test
  git diff --check
  rg -n "tmpSecretId|tmpSecretKey|sessionToken|objectKey|Authorization|access_token|refresh_token" apps/electron/src/main/lib/chatroom-cos-service.ts apps/electron/src/main/ipc/chatrooms.ipc.ts apps/electron/src/renderer/lib/chatroom-*.ts apps/electron/src/renderer/atoms/chatroom-atoms.ts
  ```

  Expected: full tests pass; `git diff --check` is clean; sensitive identifiers occur only in internal parsing/allow-list tests and never in logs, public event builders, Jotai state or JSX text.

- [ ] **Step 6: Commit boundary changes**

  ```bash
  git add apps/electron/electron-builder.yml scripts/functional-module-boundary.test.ts apps/electron/src/main/lib/chatroom-cos-package-boundary.test.ts apps/electron/src/renderer/components/chatroom/chatroom-integration.test.tsx
  git commit -m "test: verify chatroom cos packaging boundary"
  ```

## Verification Matrix

完成后必须能复核以下关系：

| Scenario | Automated evidence |
| --- | --- |
| 主理人输入 `a7k2` 创建并由服务端返回 `A7K2` | shared normalization + API integration test；客户端不自生成分享码 |
| 普通用户输入小写分享码直接加入 | Join dialog/API test；无审批状态 |
| 左侧聊天室标题同时有加入/创建入口 | Chatroom sidebar component test；最终由用户真实窗口确认 |
| 同一窗口保留 Agent/项目 Tab 并打开多个聊天室 Tab | tab atom/component tests keyed by `chatroom:${roomId}` |
| 一条消息结构化 mention A/B 并行执行 | integration state test for two invocation IDs |
| Agent mention Agent，三跳或重复目标停止 | integration test asserts same `traceId`, depth guard and no fourth invocation |
| Agent/offline 立即失败且不排队 | composer/atom test asserts no pending queue |
| 共享记忆/Skill 只作用于对应 Agent | create/member panel tests assert host-only toggles and no raw content |
| COS 上传、进度、取消、finalize、下载 | Main fake SDK tests and transfer IPC tests |
| Renderer 不获得 JWT、STS 或 object key | preload/API/SSE/package boundary tests and `rg` audit |
| 页面关闭不停止全局实时连接 | SSE initializer lifecycle test |
| 归档/恢复与成员权限差异 | integration test plus host/member panel tests |

自动化完成后必须由用户在真实 Electron 窗口中确认：左侧聊天室分组与加入/创建图标、创建和分享码加入、多人实时消息、多 Agent 并行及 Agent 调 Agent 的停止提示、主理人授权与普通成员限制、COS 上传下载及断线/归档恢复的实际交互和视觉效果。自动化或截图不能替代这一确认。

## Plan Self-Review

- **Spec coverage:** Task 1 extends the existing shared data and IPC contracts; Task 2 covers existing COS SDK STS upload/download/progress/cancel/finalize and secret lifetime; Task 3 extends Main/preload isolation; Task 4 covers unified `/api/chatrooms/v2` HTTP/SSE/Jotai/global lifecycle; Task 5 covers sidebar, simultaneous join/create actions, independent room Tabs, mentions, offline no-queue, three-Agent limit, attachment states and host/member permissions; Task 6 covers builder/package boundary and complete verification.
- **Placeholder scan:** No forbidden placeholder language or unassigned implementation choice is used; every task has exact files, interfaces, RED/GREEN commands and a commit command.
- **Type consistency:** Phase 3 `ChatRoom*` types and `CHATROOM_IPC_CHANNELS` remain the single shared source; the Phase 4 additions `ChatRoomTransferState`, `ChatRoomTransferResult`, `CosSdkGrant`, `ChatRoomCosService`, `ChatRoomApi`, `ChatRoomEventEnvelope` and `openChatRoomTab` are consumed with the same names in later tasks.
- **Scope check:** The plan does not modify the already planned Rust gateway or Phase 3 local Agent coordinator, and it keeps long-lived COS publishing in root scripts.
