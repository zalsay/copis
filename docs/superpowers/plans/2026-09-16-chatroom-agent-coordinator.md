# Chatroom Agent Coordinator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Electron Main 中实现聊天室 Agent 的本地绑定、隐藏 workspace/session、可信运行上下文、并行 invocation、权限审批、结构化输出和 Rust internal bridge，并通过 Shared/IPC/Preload 向主理人 UI 暴露最小本地管理能力。

**Architecture:** Rust `ChatRoomGateway` 仍是 edu-api 的唯一认证出口，并通过受 internal token 保护的本机路由把定向 invocation 交给 Electron Main。`ChatRoomAgentCoordinator` 只信任 Rust bridge 输入，在本机 `room.json` 中维护 Agent 绑定和有界幂等记录，为每个 roomAgentId 注册隐藏 session backend，并用 Main-only runtime context 把执行 workspace、来源 Memory scope 和 Skill snapshot 分开；所有 Agent 状态经 `ChatRoomRustApi` 回传 Rust，不直接访问 edu-api。Renderer 只能通过类型化 IPC 配置本地 Agent、响应主理人权限和接收脱敏权限事件，不能提交 runtime override、STS、对象 Key 或绝对路径。

**Tech Stack:** TypeScript 5、Electron 43、Bun test、现有 Pi Agent runtime、Jotai 消费端契约、JSON/JSONL 本地文件、Rust loopback HTTP internal token。

**Spec:** `docs/superpowers/specs/2026-09-16-copis-multi-agent-chatrooms-design.md`

## Global Constraints

- 本计划仅覆盖规格“阶段三：本地 Agent 协调器”及其必要的 Shared/Preload/IPC 和 Rust internal bridge 接缝；edu-api、Rust WebSocket Gateway、Renderer/Jotai 聊天室页面和 COS 上传下载由独立计划交付。
- Rust 已在前置阶段提供 `/api/internal/chatrooms/**` 路由并校验 `X-Copis-Internal-Token`；Electron Main 不持有 Working JWT，也不直接访问 edu-api。
- 一个房间最多 3 个 Agent；同一条消息提及多个 Agent 时并行执行，不串行等待。
- `depth` 表示 invocation 跳数，允许执行 `0 | 1 | 2`；下一跳为 `3` 时拒绝并回传 `invocation_depth_exceeded`。
- 同一 `traceId + roomAgentId` 最多执行一次；重复投递返回已记录状态，不再次启动 Agent。
- terminal invocation 记录保留 30 天；每个房间最多保留最近 2,000 条 terminal 记录，非 terminal 记录不参与裁剪。
- 主理人设备或 Gateway 离线时立即停止尚未完成的 invocation 并回传失败；不排队、不延迟启动、不在恢复连接后自动重放。
- 聊天室 Agent 输出协议固定为 `{ text, mentionedAgentIds, attachmentIds }`；纯文本中的 `@名称` 不触发下一跳。
- Memory 共享默认关闭；开启时固定为来源工作区 scope 的 `visible`，只允许 `memory_recall` 和 `memory_read`，禁止写回。
- Skill 共享默认关闭；开启或显式同步时复制来源工作区当前启用 Skill 到 `skills-snapshot/`，运行时只读取快照。
- 敏感权限只能由主理人本机批准；普通成员只接收远端脱敏状态，不接收命令、路径、工具参数或凭据。
- 本地配置使用 `writeJsonFileAtomic()`；不使用 `localStorage`，不新增本地数据库。
- 新增注释、日志和错误信息优先使用中文；日志禁止包含消息正文、Memory/Skill 内容、绝对路径、token、密钥、STS 和对象 Key。
- 所有 Renderer 状态后续由 Jotai 管理；本计划的 Preload API 不维护状态。
- 不修改 `AGENTS.md` 或 `README.md`；功能状态变化后的文档同步必须另行取得用户许可。
- Electron UI 的真实交互和视觉效果最终由用户在实际应用窗口确认，不使用截图代替。
- 实施时按仓库规则递增受影响 package patch 版本；版本变更与最终文档授权由执行者在整体验收阶段统一处理。

---

## File Map

| File | Responsibility |
|---|---|
| `packages/shared/src/types/chatroom.ts` | 聊天室本地 Agent、invocation、结构化输出、权限、IPC DTO 和通道常量的唯一共享契约 |
| `packages/shared/src/types/index.ts` | 导出聊天室契约 |
| `packages/shared/src/types/agent.ts` | 给 `AgentExternalRunSource` 增加 `chatroom` |
| `apps/electron/src/main/lib/client-device-id.ts` | 安装级稳定 deviceId，兼容迁移 web-sync 的旧 deviceId |
| `apps/electron/src/main/lib/config-paths.ts` | 聊天室根目录、room.json、Agent workspace、session、Skill snapshot 路径 helper |
| `apps/electron/src/main/lib/chatroom-workspace-store.ts` | room.json 校验、Agent 绑定、invocation 幂等、30 天保留和 2,000 条压缩 |
| `apps/electron/src/main/lib/chatroom-hidden-session-store.ts` | 隐藏 session meta/JSONL adapter，不进入普通会话索引 |
| `apps/electron/src/main/lib/agent-session-manager.ts` | 注册按 sessionId 路由的外部 session storage override |
| `apps/electron/src/main/lib/agent-rpc-runtime-context.ts` | Main-only 可信 runtime override 注册表 |
| `apps/electron/src/main/lib/agent-rpc-service.ts` | 独立 execution workspace、memory source scope、Skill snapshot 和文件权限根 |
| `apps/electron/src/main/lib/agent-orchestrator.ts` | 同步可信 runtime context 和聊天室专用权限 sink |
| `apps/electron/src/main/lib/agent-service.ts` | `runAgentHeadless()` 注册 `chatroom` 来源与可信 runtime context |
| `apps/electron/src/main/lib/chatroom-skill-snapshot.ts` | 安全复制启用 Skill、生成摘要并原子替换快照 |
| `apps/electron/src/main/lib/chatroom-rust-client.ts` | Main 到 Rust loopback 的 invocation 状态客户端 |
| `apps/electron/src/main/lib/chatroom-output-sanitizer.ts` | 解析结构化输出并清理敏感内容 |
| `apps/electron/src/main/lib/chatroom-agent-coordinator.ts` | provision、并行执行、幂等、深度、离线停止、权限和状态回传 |
| `apps/electron/src/main/lib/http-api-handler.ts` | Rust stdout bridge 的 invocation/disconnect 分发入口 |
| `apps/electron/src/main/ipc/chatrooms.ipc.ts` | 本地 Agent 配置、Skill 同步、权限响应 IPC |
| `apps/electron/src/main/ipc.ts` | 注册 `registerChatRoomIpcHandlers()` |
| `apps/electron/src/preload/index.ts` | 暴露 `electronAPI.chatrooms`，不暴露 runtime override 或敏感字段 |
| `apps/electron/src/main/index.ts` | 初始化 coordinator，并在关闭 Rust 前停止聊天室运行 |

## Cross-Task Interfaces

以下签名是任务间契约；后续任务不得自行改名。需要调整时先回改本节和所有消费者。

```ts
export type ChatRoomInvocationStatus =
  | 'created' | 'accepted' | 'running' | 'completed' | 'failed' | 'rejected'

export interface ChatRoomAgentOutput {
  text: string
  mentionedAgentIds: string[]
  attachmentIds: string[]
}

export interface ChatRoomAgentInvocation {
  invocationId: string
  roomId: string
  traceId: string
  targetAgentId: string
  triggerMessageId: string
  depth: number
  sender: { type: 'user' | 'agent'; id: string; displayName: string }
  messages: ChatRoomContextMessage[]
  receivedAt: number
}

export interface ChatRoomAgentLocalConfig {
  roomAgentId: string
  displayName: string
  sourceWorkspaceId: string
  sessionId: string
  channelId: string
  modelId?: string
  contextMessageCount: number
  memorySharingEnabled: boolean
  skillSharingEnabled: boolean
  skillSnapshotDigest?: string
  archivedAt?: number
}

export interface ChatRoomAgentRuntimeContext {
  executionWorkspace: {
    root: string
    projectRoot: string
    inboxRoot: string
    sessionRoot: string
  }
  memorySource?: { workspaceSlug: string; policy: 'visible' }
  skillSnapshotPath?: string
  permissionContext: ChatRoomPermissionContext
}

export interface ChatRoomRustApi {
  reportAccepted(input: { invocationId: string }): Promise<void>
  reportRunning(input: { invocationId: string }): Promise<void>
  reportDelta(input: { invocationId: string; delta: string }): Promise<void>
  reportCompleted(input: { invocationId: string; output: ChatRoomAgentOutput }): Promise<void>
  reportFailed(input: { invocationId: string; code: ChatRoomInvocationFailureCode; message: string }): Promise<void>
  releaseAgentLeases(input: {
    roomAgentIds: string[]
    reason: 'logout' | 'gateway_disconnected' | 'app_quit'
  }): Promise<void>
}
```

Rust Phase 2 必须提供并冻结以下 bridge 路径，Phase 3 只消费它们：

```text
Rust -> Electron stdout bridge:
POST /api/internal/chatrooms/invocations
POST /api/internal/chatrooms/disconnected

Electron Main -> Rust loopback:
POST /api/internal/chatrooms/invocations/{invocationId}/accepted
POST /api/internal/chatrooms/invocations/{invocationId}/running
POST /api/internal/chatrooms/invocations/{invocationId}/delta
POST /api/internal/chatrooms/invocations/{invocationId}/completed
POST /api/internal/chatrooms/invocations/{invocationId}/failed
```

---

### Task 1: Shared Chatroom Contracts

**Files:**
- Create: `packages/shared/src/types/chatroom.ts`
- Modify: `packages/shared/src/types/index.ts`
- Modify: `packages/shared/src/types/agent.ts`
- Test: `packages/shared/src/types/chatroom.test.ts`

**Interfaces:**
- Consumes: 规格中的 roomAgentId、invocation、权限和结构化输出字段。
- Produces: `CHATROOM_IPC_CHANNELS`、所有 `ChatRoom*` DTO、`AgentExternalRunSource = ... | 'chatroom'`。

- [ ] **Step 1: Write the failing contract test**

```ts
import { expect, test } from 'bun:test'
import { CHATROOM_IPC_CHANNELS, isChatRoomAgentOutput, normalizeChatRoomContextMessageCount } from './chatroom'

test('Given 结构化 Agent 输出 When 校验 Then 只接受三个固定字段的有界对象', () => {
  expect(isChatRoomAgentOutput({ text: '完成', mentionedAgentIds: ['agent-b'], attachmentIds: [] })).toBe(true)
  expect(isChatRoomAgentOutput({ text: '完成', mentionedAgentIds: '@agent-b', attachmentIds: [] })).toBe(false)
  expect(isChatRoomAgentOutput({ text: '完成', mentionedAgentIds: [], attachmentIds: [], token: 'secret' })).toBe(false)
})

test('Given 上下文数量越界 When 归一化 Then 限制在 1 到 200 且默认 50', () => {
  expect(normalizeChatRoomContextMessageCount(undefined)).toBe(50)
  expect(normalizeChatRoomContextMessageCount(0)).toBe(1)
  expect(normalizeChatRoomContextMessageCount(500)).toBe(200)
})

test('Given Chatroom IPC 常量 When 读取 Then 通道只覆盖 Main 本地能力', () => {
  expect(CHATROOM_IPC_CHANNELS.PROVISION_AGENT).toBe('chatrooms:provision-agent')
  expect(Object.values(CHATROOM_IPC_CHANNELS)).not.toContain('chatrooms:send-message')
})
```

- [ ] **Step 2: Run the test and verify the missing module failure**

Run: `bun test packages/shared/src/types/chatroom.test.ts`

Expected: FAIL because `./chatroom` does not exist.

- [ ] **Step 3: Add the exact shared types and validation helpers**

```ts
export const CHATROOM_MAX_AGENTS = 3
export const CHATROOM_DEFAULT_CONTEXT_MESSAGES = 50
export const CHATROOM_MAX_CONTEXT_MESSAGES = 200
export const CHATROOM_MAX_DEPTH = 3
export const CHATROOM_TERMINAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
export const CHATROOM_MAX_TERMINAL_INVOCATIONS = 2_000

export const CHATROOM_IPC_CHANNELS = {
  LIST_LOCAL_ROOMS: 'chatrooms:list-local-rooms',
  PROVISION_AGENT: 'chatrooms:provision-agent',
  UPDATE_AGENT: 'chatrooms:update-agent',
  REMOVE_AGENT: 'chatrooms:remove-agent',
  SYNC_AGENT_SKILLS: 'chatrooms:sync-agent-skills',
  RESPOND_PERMISSION: 'chatrooms:respond-permission',
  PERMISSION_REQUESTED: 'chatrooms:permission-requested',
  LOCAL_CONFIG_CHANGED: 'chatrooms:local-config-changed',
} as const
```

Add exact DTOs for `ChatRoomContextMessage`, `ChatRoomAgentInvocation`, `ChatRoomAgentOutput`, `ChatRoomAgentLocalConfig`, `ChatRoomLocalRoomConfig`, `ChatRoomInvocationRecord`, `ChatRoomPermissionContext`, `ChatRoomPermissionRequest`, `ChatRoomPermissionResponse`, `ProvisionChatRoomAgentInput`, `UpdateChatRoomAgentInput`, `RemoveChatRoomAgentInput`, `SyncChatRoomAgentSkillsInput`, `ChatRoomInvocationFailureCode`, and `ChatRoomRustApi`. Bound all IDs to nonblank strings of at most 128 characters, output text to 200,000 characters, and arrays to at most 3 Agent IDs or 20 attachment IDs. `isChatRoomAgentOutput()` rejects unknown keys.

- [ ] **Step 4: Export the module and extend the trusted source union**

Add `export * from './chatroom'` to `types/index.ts` and change the union in `agent.ts`:

```ts
export type AgentExternalRunSource = 'feishu' | 'dingtalk' | 'wechat' | 'bridge' | 'delegation' | 'chatroom'
```

- [ ] **Step 5: Run focused tests and shared typecheck**

```bash
bun test packages/shared/src/types/chatroom.test.ts
bun run --filter='@copis/shared' typecheck
```

Expected: PASS with no TypeScript errors.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/types/chatroom.ts packages/shared/src/types/chatroom.test.ts packages/shared/src/types/index.ts packages/shared/src/types/agent.ts
git commit -m "feat(shared): define chatroom agent contracts"
```

---

### Task 2: Stable Client Device ID and Chatroom Paths

**Files:**
- Create: `apps/electron/src/main/lib/client-device-id.ts`
- Create: `apps/electron/src/main/lib/client-device-id.test.ts`
- Modify: `apps/electron/src/main/lib/config-paths.ts`
- Modify: `apps/electron/src/main/lib/web-sync-coordinator.ts`
- Test: `apps/electron/src/main/lib/web-sync-coordinator.test.ts`

**Interfaces:**
- Consumes: `writeJsonFileAtomic()` and existing `web-sync-state.json` deviceId.
- Produces: `getOrCreateClientDeviceId(): string` and exact path helpers used by all local stores.

- [ ] **Step 1: Write failing BDD tests for stable ID and migration**

```ts
test('Given 尚无 client-device.json 且 web-sync 已有 deviceId When 首次读取 Then 迁移旧 ID 并原子保存', () => {
  writeFileSync(webSyncPath, JSON.stringify({ deviceId: 'legacy-device', serverCursor: 0 }))
  expect(getOrCreateClientDeviceId()).toBe('legacy-device')
  expect(readJsonFileSafe<{ deviceId: string }>(clientDevicePath)?.deviceId).toBe('legacy-device')
})

test('Given client-device.json 已存在 When 多次读取 Then 始终返回同一 UUID', () => {
  const first = getOrCreateClientDeviceId()
  expect(getOrCreateClientDeviceId()).toBe(first)
  expect(first).toMatch(/^[0-9a-f-]{36}$/)
})

test('Given 非法 roomId When 解析聊天室路径 Then 拒绝目录穿越', () => {
  expect(() => getChatRoomPath('../escape')).toThrow('roomId 参数不正确')
})
```

- [ ] **Step 2: Run tests and verify missing exports**

Run: `bun test apps/electron/src/main/lib/client-device-id.test.ts`

Expected: FAIL because `client-device-id.ts` and chatroom path helpers do not exist.

- [ ] **Step 3: Add safe path helpers**

Add a private path-component validator using `/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/`. Export:

```ts
getClientDevicePath(): string
getChatRoomsRootPath(): string
getChatRoomPath(roomId: string): string
getChatRoomConfigPath(roomId: string): string
getChatRoomAgentPath(roomId: string, roomAgentId: string): string
getChatRoomAgentSessionDir(roomId: string, roomAgentId: string): string
getChatRoomAgentSessionMetaPath(roomId: string, roomAgentId: string): string
getChatRoomAgentSessionMessagesPath(roomId: string, roomAgentId: string): string
getChatRoomAgentProjectPath(roomId: string, roomAgentId: string): string
getChatRoomAgentInboxPath(roomId: string, roomAgentId: string): string
getChatRoomAgentSkillsSnapshotPath(roomId: string, roomAgentId: string): string
```

All paths remain inside `getAgentWorkspacesDir()/chatrooms`; validate components before `join()`.

- [ ] **Step 4: Implement the shared device ID source**

```ts
interface ClientDeviceFile { version: 1; deviceId: string; createdAt: number }
```

Precedence is valid `client-device.json`, then valid `web-sync-state.json.deviceId`, then `randomUUID()`. Write with `writeJsonFileAtomic(getClientDevicePath(), value, false, 0o600)` and never log the deviceId. Update `WebSyncCoordinator.loadState()` to call `getOrCreateClientDeviceId()` instead of generating another UUID.

- [ ] **Step 5: Run both tests independently**

```bash
bun test apps/electron/src/main/lib/client-device-id.test.ts
bun test apps/electron/src/main/lib/web-sync-coordinator.test.ts
```

Expected: both PASS; web sync and chatroom return the same stable ID.

- [ ] **Step 6: Commit**

```bash
git add apps/electron/src/main/lib/client-device-id.ts apps/electron/src/main/lib/client-device-id.test.ts apps/electron/src/main/lib/config-paths.ts apps/electron/src/main/lib/web-sync-coordinator.ts apps/electron/src/main/lib/web-sync-coordinator.test.ts
git commit -m "feat(electron): share stable client device id"
```

---

### Task 3: Atomic Room Configuration and Bounded Invocation Ledger

**Files:**
- Create: `apps/electron/src/main/lib/chatroom-workspace-store.ts`
- Test: `apps/electron/src/main/lib/chatroom-workspace-store.test.ts`

**Interfaces:**
- Consumes: Task 1 DTOs, Task 2 path helpers, `readJsonFileSafe()` and `writeJsonFileAtomic()`.
- Produces: `ChatRoomWorkspaceStore`, the authoritative local binding and idempotency ledger.

- [ ] **Step 1: Write failing storage BDD tests**

```ts
test('Given room 无配置 When provision 第一个 Agent Then 建立隔离目录并原子写 room.json', () => {
  const saved = store.provisionAgent(roomIdentity, agentInput)
  expect(saved.agents).toHaveLength(1)
  expect(existsSync(getChatRoomAgentInboxPath('room-1', 'agent-a'))).toBe(true)
  expect(existsSync(join(tempHome, '.copis', 'agent-sessions.json'))).toBe(false)
})

test('Given room 已有 3 个 Agent When provision 第 4 个 Then 拒绝且配置不变', () => {
  seedThreeAgents(store)
  expect(() => store.provisionAgent(roomIdentity, fourthAgent)).toThrow('agent_limit_reached')
  expect(store.read('room-1')?.agents).toHaveLength(3)
})

test('Given terminal 记录超过 30 天且超过 2000 条 When 保存 Then 删除过期并保留最近 2000 条', () => {
  seedInvocationRecords({ terminalCount: 2105, oldestFinishedAt: now - 31 * DAY })
  const compacted = store.compactInvocationRecords('room-1', now)
  expect(compacted.terminalCount).toBe(2000)
  expect(compacted.records.some((record) => record.finishedAt! < now - 30 * DAY)).toBe(false)
})

test('Given running 记录很旧 When 压缩 Then 不裁剪非 terminal 记录', () => {
  seedRunningInvocation({ updatedAt: now - 60 * DAY })
  store.compactInvocationRecords('room-1', now)
  expect(store.getInvocation('room-1', 'inv-running')?.status).toBe('running')
})
```

- [ ] **Step 2: Run the test and verify missing store failure**

Run: `bun test apps/electron/src/main/lib/chatroom-workspace-store.test.ts`

Expected: FAIL because `ChatRoomWorkspaceStore` does not exist.

- [ ] **Step 3: Implement the persisted schema and validation**

```ts
interface ChatRoomLocalRoomConfigFile {
  version: 1
  roomId: string
  hostUserId: string
  deviceId: string
  lastProcessedSeq: number
  agents: ChatRoomAgentLocalConfig[]
  invocations: ChatRoomInvocationRecord[]
  createdAt: number
  updatedAt: number
}

export class ChatRoomWorkspaceStore {
  read(roomId: string): ChatRoomLocalRoomConfig | undefined
  list(): ChatRoomLocalRoomConfig[]
  provisionAgent(identity: ChatRoomLocalIdentity, input: ProvisionChatRoomAgentInput): ChatRoomLocalRoomConfig
  updateAgent(input: UpdateChatRoomAgentInput): ChatRoomLocalRoomConfig
  archiveAgent(input: RemoveChatRoomAgentInput): ChatRoomLocalRoomConfig
  getAgent(roomId: string, roomAgentId: string): ChatRoomAgentLocalConfig | undefined
  getInvocation(roomId: string, invocationId: string): ChatRoomInvocationRecord | undefined
  getTraceAgentInvocation(roomId: string, traceId: string, roomAgentId: string): ChatRoomInvocationRecord | undefined
  upsertInvocation(roomId: string, record: ChatRoomInvocationRecord): ChatRoomInvocationRecord
  compactInvocationRecords(roomId: string, now?: number): { terminalCount: number; records: ChatRoomInvocationRecord[] }
  updateLastProcessedSeq(roomId: string, seq: number): void
}
```

Reject mismatched host/device identity, duplicate roomAgentId/sessionId, duplicate case-insensitive display names and invalid context count. `archiveAgent()` sets `archivedAt` and never deletes directories.

- [ ] **Step 4: Implement terminal compaction exactly**

Terminal statuses are `completed | failed | rejected`. On every `read()` and `upsertInvocation()`:

```ts
const cutoff = now - CHATROOM_TERMINAL_RETENTION_MS
const active = records.filter((record) => !isTerminal(record.status))
const terminal = records
  .filter((record) => isTerminal(record.status) && (record.finishedAt ?? record.updatedAt) >= cutoff)
  .sort((a, b) => (b.finishedAt ?? b.updatedAt) - (a.finishedAt ?? a.updatedAt))
  .slice(0, CHATROOM_MAX_TERMINAL_INVOCATIONS)
return [...active, ...terminal]
```

Persist only when normalized content differs, using `writeJsonFileAtomic(roomJsonPath, file, false, 0o600)`.

- [ ] **Step 5: Run the focused store test**

Run: `bun test apps/electron/src/main/lib/chatroom-workspace-store.test.ts`

Expected: PASS, including corrupted JSON recovery and no public session/workspace index writes.

- [ ] **Step 6: Commit**

```bash
git add apps/electron/src/main/lib/chatroom-workspace-store.ts apps/electron/src/main/lib/chatroom-workspace-store.test.ts
git commit -m "feat(electron): persist chatroom agent bindings"
```

---

### Task 4: Hidden Session Storage Adapter

**Files:**
- Create: `apps/electron/src/main/lib/chatroom-hidden-session-store.ts`
- Create: `apps/electron/src/main/lib/chatroom-hidden-session-store.test.ts`
- Modify: `apps/electron/src/main/lib/agent-session-manager.ts`
- Test: `apps/electron/src/main/lib/agent-session-manager.test.ts`

**Interfaces:**
- Consumes: roomAgentId/session paths from Tasks 2–3 and existing SDKMessage serialization behavior.
- Produces: a sessionId-specific storage override that existing Agent runtime can use without listing the session publicly.

- [ ] **Step 1: Write failing tests for hidden routing**

```ts
test('Given 已注册隐藏 session backend When runtime 读写 meta 和 SDKMessage Then 只写聊天室目录', () => {
  const backend = createHiddenBackend('room-1', agentConfig)
  const unregister = registerAgentSessionStorageOverride(agentConfig.sessionId, backend)
  appendSDKMessages(agentConfig.sessionId, [userMessage])
  updateAgentSessionMeta(agentConfig.sessionId, { sdkSessionId: 'sdk-1' })
  expect(getAgentSessionSDKMessages(agentConfig.sessionId)).toHaveLength(1)
  expect(getAgentSessionMeta(agentConfig.sessionId)?.sdkSessionId).toBe('sdk-1')
  expect(listAgentSessions().some((session) => session.id === agentConfig.sessionId)).toBe(false)
  expect(existsSync(getAgentSessionMessagesPath(agentConfig.sessionId))).toBe(false)
  unregister()
})

test('Given 两个 Agent backend When 并行追加消息 Then JSONL 和 meta 不交叉', async () => {
  await Promise.all([
    Promise.resolve().then(() => appendSDKMessages('session-a', [messageA])),
    Promise.resolve().then(() => appendSDKMessages('session-b', [messageB])),
  ])
  expect(getAgentSessionSDKMessages('session-a')).toEqual([messageA])
  expect(getAgentSessionSDKMessages('session-b')).toEqual([messageB])
})
```

- [ ] **Step 2: Run tests and verify missing override failure**

```bash
bun test apps/electron/src/main/lib/chatroom-hidden-session-store.test.ts
bun test apps/electron/src/main/lib/agent-session-manager.test.ts
```

Expected: the new test FAILS because `registerAgentSessionStorageOverride` is absent; the existing manager test remains green.

- [ ] **Step 3: Add the storage override interface to the session manager**

```ts
export type AgentSessionMetaUpdates = Parameters<typeof updateAgentSessionMeta>[1]

export interface AgentSessionStorageOverride {
  getMeta(): AgentSessionMeta
  updateMeta(updates: AgentSessionMetaUpdates): AgentSessionMeta
  getAgentMessages(): AgentMessage[]
  appendAgentMessage(message: AgentMessage): void
  getSDKMessages(): SDKMessage[]
  appendSDKMessages(messages: SDKMessage[]): void
  removeSDKErrorMessage(errorUuid: string): boolean
}

export function registerAgentSessionStorageOverride(
  sessionId: string,
  storage: AgentSessionStorageOverride,
): () => void
```

Route only `getAgentSessionMeta`, `updateAgentSessionMeta`, `getAgentSessionMessages`, `appendAgentMessage`, `getAgentSessionSDKMessages`, `appendSDKMessages`, and `removeSDKErrorMessage` through this map. `listAgentSessions`, search, archive, move, fork, delete, normal indexes and normal paths remain unchanged. Registration rejects duplicate sessionId; unregister removes only the same adapter instance.

- [ ] **Step 4: Implement the hidden backend**

`ChatRoomHiddenSessionStore` stores `session.json` atomically and `messages.jsonl` append-only beneath `agents/{roomAgentId}/sessions/`. Use the same maximum SDK message size and UUID dedupe semantics as the ordinary manager by extracting only reusable serialization/normalization helpers into package-private exports. Serialize writes per session with synchronous file operations.

- [ ] **Step 5: Run focused regressions**

```bash
bun test apps/electron/src/main/lib/chatroom-hidden-session-store.test.ts
bun test apps/electron/src/main/lib/agent-session-manager.test.ts
```

Expected: PASS; hidden sessions work through existing runtime APIs and remain absent from public lists.

- [ ] **Step 6: Commit**

```bash
git add apps/electron/src/main/lib/chatroom-hidden-session-store.ts apps/electron/src/main/lib/chatroom-hidden-session-store.test.ts apps/electron/src/main/lib/agent-session-manager.ts apps/electron/src/main/lib/agent-session-manager.test.ts
git commit -m "feat(electron): add hidden chatroom sessions"
```

---

### Task 5: Trusted Runtime Context and Scope Separation

**Files:**
- Create: `apps/electron/src/main/lib/agent-rpc-runtime-context.ts`
- Create: `apps/electron/src/main/lib/agent-rpc-runtime-context.test.ts`
- Modify: `apps/electron/src/main/lib/agent-service.ts`
- Modify: `apps/electron/src/main/lib/agent-rpc-service.ts`
- Modify: `apps/electron/src/main/lib/agent-rpc-protocol.ts`
- Modify: `apps/electron/src/main/lib/agent-orchestrator.ts`
- Test: `apps/electron/src/main/lib/agent-rpc-service.test.ts`
- Test: `apps/electron/src/main/lib/agent-service-connector-source.test.ts`

**Interfaces:**
- Consumes: hidden session registration and `ChatRoomAgentRuntimeContext`.
- Produces: Main-only runtime scope that cannot be forged through Renderer or local public HTTP input.

- [ ] **Step 1: Write failing trust-boundary tests**

```ts
test('Given chatroom trusted runtime context When prepare run Then cwd 使用独立 project 且 memory 指向来源 workspace visible', async () => {
  const release = registerTrustedAgentRuntimeContext('session-a', runtimeContext)
  const prepared = await prepareAgentRpcRun(sendInput)
  expect(prepared.query.cwd).toBe(runtimeContext.executionWorkspace.projectRoot)
  expect(prepared.query.fileAccessPolicy?.writeRoots).toEqual([runtimeContext.executionWorkspace.projectRoot])
  expect(prepared.query.workspaceSlug).toBe('source-workspace')
  expect(prepared.query.memoryPolicy).toBe('visible')
  expect(prepared.query.additionalSkillPaths).toEqual([runtimeContext.skillSnapshotPath])
  release()
})

test('Given Renderer 请求体伪造 runtimeContext When parse RPC input Then 字段被拒绝', () => {
  expect(() => parseAgentRpcInput({ ...validInput, runtimeContext })).toThrow('不支持的请求字段')
})

test('Given Memory 共享关闭 When prepare run Then 不注入来源 scope 且 memoryPolicy 为 off', async () => {
  const prepared = await prepareWithContext({ ...runtimeContext, memorySource: undefined })
  expect(prepared.query.memoryPolicy).toBe('off')
  expect(prepared.query.workspaceSlug).toBeUndefined()
})
```

- [ ] **Step 2: Run the trust-boundary tests and verify current workspace coupling**

```bash
bun test apps/electron/src/main/lib/agent-rpc-runtime-context.test.ts
bun test apps/electron/src/main/lib/agent-rpc-service.test.ts
```

Expected: FAIL because cwd, Skill and Memory currently derive from the same ordinary workspace.

- [ ] **Step 3: Implement the Main-only registry**

```ts
interface TrustedRuntimeEntry {
  token: symbol
  context: ChatRoomAgentRuntimeContext
}

export function registerTrustedAgentRuntimeContext(
  sessionId: string,
  context: ChatRoomAgentRuntimeContext,
): () => void

export function getTrustedAgentRuntimeContext(
  sessionId: string,
): ChatRoomAgentRuntimeContext | undefined
```

Use the same stacked token/release pattern as `agent-rpc-source-context.ts`. Deep-freeze a cloned context at registration. Do not add this context to `AgentSendInput`, IPC or public HTTP DTOs.

- [ ] **Step 4: Separate execution, Memory and Skill resolution**

In both `agent-rpc-service.ts` and `agent-orchestrator.ts`, derive:

```ts
interface ResolvedAgentRuntimeScope {
  agentCwd: string
  workspaceWriteRoot: string
  workspaceName: string
  runtimeWorkspaceSlug?: string
  memoryWorkspaceSlug?: string
  memoryPolicy: MemoryPolicy
  skillPaths: string[]
  fileAccessPolicy: PiWorkerFileAccessPolicy
}
```

For chatroom context use the independent project root as cwd/write root, `memorySource.workspaceSlug` only for `appendMemoryContext()`, `visible` or `off` as the Memory policy, and only `skillSnapshotPath` as an additional Skill path. `fileAccessPolicy.writeRoots` is exactly `[projectRoot]`; read roots may add the snapshot. Do not include default/source Skills, attached directories, expert-team tools, browser capabilities, automation tools or connector cross-workspace access. Runtime environment variables point only at the execution root and never reveal the source workspace path.

- [ ] **Step 5: Extend `runAgentHeadless()` options without exposing them publicly**

```ts
export interface HeadlessAgentRunOptions {
  onError(error: string): void
  onComplete(messages?: AgentMessage[]): void
  onTitleUpdated(title: string): void
  source?: AgentExternalRunSource
  originSessionId?: string
  trustedRuntimeContext?: ChatRoomAgentRuntimeContext
}
```

When `source === 'chatroom'`, require `trustedRuntimeContext`, register trusted source and runtime context before `agentRpcGateway.run()`, and release both in `finally`. For every other source reject a supplied runtime context.

- [ ] **Step 6: Run focused tests**

```bash
bun test apps/electron/src/main/lib/agent-rpc-runtime-context.test.ts
bun test apps/electron/src/main/lib/agent-rpc-service.test.ts
bun test apps/electron/src/main/lib/agent-service-connector-source.test.ts
```

Expected: PASS; source workspace is used only for Memory identity and never as cwd/write root.

- [ ] **Step 7: Commit**

```bash
git add apps/electron/src/main/lib/agent-rpc-runtime-context.ts apps/electron/src/main/lib/agent-rpc-runtime-context.test.ts apps/electron/src/main/lib/agent-service.ts apps/electron/src/main/lib/agent-rpc-service.ts apps/electron/src/main/lib/agent-rpc-protocol.ts apps/electron/src/main/lib/agent-orchestrator.ts apps/electron/src/main/lib/agent-rpc-service.test.ts apps/electron/src/main/lib/agent-service-connector-source.test.ts
git commit -m "feat(electron): isolate chatroom agent runtime scope"
```

---

### Task 6: Read-Only Skill Snapshot

**Files:**
- Create: `apps/electron/src/main/lib/chatroom-skill-snapshot.ts`
- Test: `apps/electron/src/main/lib/chatroom-skill-snapshot.test.ts`
- Modify: `apps/electron/src/main/lib/chatroom-workspace-store.ts`

**Interfaces:**
- Consumes: `getWorkspaceSkillsDir()`, `getWorkspaceSkills()`, Task 2 snapshot path and Task 3 config updates.
- Produces: `syncChatRoomAgentSkillSnapshot()` with deterministic digest and atomic directory replacement.

- [ ] **Step 1: Write failing Skill isolation tests**

```ts
test('Given 来源工作区有启用和禁用 Skill When 同步 Then 只复制启用 Skill', () => {
  const result = syncChatRoomAgentSkillSnapshot(input)
  expect(readdirSync(result.snapshotPath).sort()).toEqual(['enabled-skill'])
  expect(result.digest).toMatch(/^[a-f0-9]{64}$/)
})

test('Given Skill 内含符号链接 When 同步 Then 拒绝且保留旧快照', () => {
  seedExistingSnapshot('old-snapshot')
  symlinkSync(outsidePath, join(sourceSkill, 'escape'))
  expect(() => syncChatRoomAgentSkillSnapshot(input)).toThrow('Skill 快照不允许符号链接')
  expect(readFileSync(oldSnapshotFile, 'utf-8')).toBe('old-snapshot')
})

test('Given 来源 Skill 后续变化 When Agent 运行但未同步 Then 快照内容不变', () => {
  const first = syncChatRoomAgentSkillSnapshot(input)
  writeFileSync(sourceFile, 'changed')
  expect(hashDirectory(first.snapshotPath)).toBe(first.digest)
})
```

- [ ] **Step 2: Run the test and verify missing service failure**

Run: `bun test apps/electron/src/main/lib/chatroom-skill-snapshot.test.ts`

Expected: FAIL because snapshot service does not exist.

- [ ] **Step 3: Implement atomic snapshot creation**

```ts
export interface SyncChatRoomAgentSkillSnapshotInput {
  roomId: string
  roomAgentId: string
  sourceWorkspaceSlug: string
}

export interface ChatRoomSkillSnapshotResult {
  snapshotPath: string
  digest: string
  skillSlugs: string[]
  syncedAt: number
}

export function syncChatRoomAgentSkillSnapshot(
  input: SyncChatRoomAgentSkillSnapshotInput,
): ChatRoomSkillSnapshotResult
```

Copy only directories returned as enabled by `getWorkspaceSkills()`. Walk with `lstatSync`; reject symbolic links and resolved paths outside the active Skills root. Copy into `skills-snapshot.next-{uuid}`, hash sorted `relativePath + NUL + fileBytes` entries with SHA-256, rename current snapshot to `.previous`, rename next to final, then remove previous. On failure remove next and retain current. Set directories/files read-only after replacement (`0o500`/`0o400`); restore owner write permission only during explicit sync.

- [ ] **Step 4: Persist digest only after a successful swap**

Add `ChatRoomWorkspaceStore.updateAgentSkillSnapshot(roomId, roomAgentId, result)` and call it after rename succeeds. When sharing is disabled, runtime context omits `skillSnapshotPath`; disabling does not delete the snapshot.

- [ ] **Step 5: Run focused tests**

```bash
bun test apps/electron/src/main/lib/chatroom-skill-snapshot.test.ts
bun test apps/electron/src/main/lib/chatroom-workspace-store.test.ts
```

Expected: PASS, including no symlink traversal and rollback on copy failure.

- [ ] **Step 6: Commit**

```bash
git add apps/electron/src/main/lib/chatroom-skill-snapshot.ts apps/electron/src/main/lib/chatroom-skill-snapshot.test.ts apps/electron/src/main/lib/chatroom-workspace-store.ts apps/electron/src/main/lib/chatroom-workspace-store.test.ts
git commit -m "feat(electron): snapshot chatroom agent skills"
```

---

### Task 7: Rust Internal Client and Bridge Dispatch

**Files:**
- Create: `apps/electron/src/main/lib/chatroom-rust-client.ts`
- Test: `apps/electron/src/main/lib/chatroom-rust-client.test.ts`
- Modify: `apps/electron/src/main/lib/http-api-handler.ts`
- Test: `apps/electron/src/main/lib/http-api-handler.test.ts`

**Interfaces:**
- Consumes: Task 1 `ChatRoomRustApi`; Phase 2 internal routes and `getHttpApiInternalToken()`.
- Produces: `HttpChatRoomRustApiClient` and injected bridge callbacks for coordinator dispatch/disconnect.

- [ ] **Step 1: Write failing client and bridge tests**

```ts
test('Given accepted 回传 When 请求 Rust Then 只访问 loopback 且携带 internal token', async () => {
  await client.reportAccepted({ invocationId: 'inv-1' })
  expect(fetchImpl).toHaveBeenCalledWith(
    'http://127.0.0.1:51730/api/internal/chatrooms/invocations/inv-1/accepted',
    expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ 'X-Copis-Internal-Token': 'internal-test' }),
    }),
  )
})

test('Given Rust bridge 投递 invocation When handler 收到 Then 校验 DTO 后只调用 coordinator 一次', async () => {
  const response = await handler.handle({ method: 'POST', path: '/api/internal/chatrooms/invocations', body: JSON.stringify(invocation) })
  expect(response.status).toBe(202)
  expect(handleInvocation).toHaveBeenCalledWith(invocation)
})

test('Given 非法 invocation 或未知字段 When bridge 投递 Then 返回 400 且不执行 Agent', async () => {
  const response = await handler.handle({ method: 'POST', path: '/api/internal/chatrooms/invocations', body: '{"token":"leak"}' })
  expect(response).toEqual({ status: 400, body: { code: 'invalid_chatroom_invocation', error: '聊天室调用参数不正确' } })
  expect(handleInvocation).not.toHaveBeenCalled()
})
```

- [ ] **Step 2: Run tests and verify missing routes**

```bash
bun test apps/electron/src/main/lib/chatroom-rust-client.test.ts
bun test apps/electron/src/main/lib/http-api-handler.test.ts
```

Expected: FAIL because client and dispatch dependencies do not exist.

- [ ] **Step 3: Implement the loopback-only client**

Mirror `HttpExpertTeamRustApiClient`, but expose exactly the five `ChatRoomRustApi` methods. Validate invocationId with `/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/`, cap delta at 16 KiB per request, use `127.0.0.1`, and require a nonempty internal token for every call. Parse at most 400 characters of an error response and pass it through `redactSensitiveLogValue()` before throwing.

- [ ] **Step 4: Add injectable bridge dependencies**

Extend `HttpApiDependencies`:

```ts
handleChatRoomInvocation?: (input: ChatRoomAgentInvocation) => Promise<'accepted' | 'duplicate'>
handleChatRoomGatewayDisconnected?: () => Promise<void>
```

Recognize only exact POST paths `/api/internal/chatrooms/invocations` and `/api/internal/chatrooms/disconnected`. Parse with Task 1 validators before lazy-importing `chatroom-agent-coordinator`. Return `202` for new, `200` for duplicate, `204` for disconnect cleanup, and stable `400/405/503` otherwise. Internal route authentication remains in Rust; Electron still rejects unknown fields and oversized bodies.

- [ ] **Step 5: Run focused tests**

```bash
bun test apps/electron/src/main/lib/chatroom-rust-client.test.ts
bun test apps/electron/src/main/lib/http-api-handler.test.ts
```

Expected: PASS; no Working JWT or public web token is present in recorded requests.

- [ ] **Step 6: Commit**

```bash
git add apps/electron/src/main/lib/chatroom-rust-client.ts apps/electron/src/main/lib/chatroom-rust-client.test.ts apps/electron/src/main/lib/http-api-handler.ts apps/electron/src/main/lib/http-api-handler.test.ts
git commit -m "feat(electron): bridge chatroom invocations through Rust"
```

---

### Task 8: Structured Output Parsing and Sanitization

**Files:**
- Create: `apps/electron/src/main/lib/chatroom-output-sanitizer.ts`
- Test: `apps/electron/src/main/lib/chatroom-output-sanitizer.test.ts`
- Modify: `apps/electron/src/main/lib/agent-prompt-builder.ts`
- Test: `apps/electron/src/main/lib/agent-prompt-builder.test.ts`

**Interfaces:**
- Consumes: Task 1 output validator and Task 5 trusted runtime context.
- Produces: final safe output; only its `mentionedAgentIds` may trigger next-hop invocation.

- [ ] **Step 1: Write failing BDD tests**

```ts
test('Given 合法 JSON 输出 When 解析 Then 保留结构化 mention 和附件 ID', () => {
  expect(parseAndSanitizeChatRoomAgentOutput(
    '{"text":"请 Agent B 继续","mentionedAgentIds":["agent-b"],"attachmentIds":["att-1"]}',
    context,
  )).toEqual({ text: '请 Agent B 继续', mentionedAgentIds: ['agent-b'], attachmentIds: ['att-1'] })
})

test('Given 普通文本包含 @Agent B When 解析 Then 不产生结构化 mention', () => {
  expect(parseAndSanitizeChatRoomAgentOutput('请 @Agent B 继续', context).mentionedAgentIds).toEqual([])
})

test('Given 输出含绝对路径、环境值和 token When 清理 Then 不把敏感内容发送到 Rust', () => {
  const result = parseAndSanitizeChatRoomAgentOutput(JSON.stringify({
    text: `文件在 ${projectRoot}/secret.txt，TOKEN=${secret}`,
    mentionedAgentIds: [],
    attachmentIds: [],
  }), context)
  expect(result.text).toBe('文件在 [本地路径已隐藏]/secret.txt，TOKEN=[敏感信息已隐藏]')
})

test('Given mention 不属于当前房间或 attachment 未显式允许 When 清理 Then 丢弃对应 ID', () => {
  const result = parseAndSanitizeChatRoomAgentOutput(raw, {
    ...context,
    allowedAgentIds: ['agent-b'],
    allowedAttachmentIds: [],
  })
  expect(result.mentionedAgentIds).toEqual(['agent-b'])
  expect(result.attachmentIds).toEqual([])
})
```

- [ ] **Step 2: Run tests and verify missing parser failure**

Run: `bun test apps/electron/src/main/lib/chatroom-output-sanitizer.test.ts`

Expected: FAIL because the parser does not exist.

- [ ] **Step 3: Implement strict parsing with safe fallback**

```ts
export interface ChatRoomOutputSanitizerContext {
  executionRoots: string[]
  sensitiveValues: string[]
  allowedAgentIds: string[]
  allowedAttachmentIds: string[]
}

export function parseAndSanitizeChatRoomAgentOutput(
  rawAssistantText: string,
  context: ChatRoomOutputSanitizerContext,
): ChatRoomAgentOutput
```

Parse only when the complete trimmed assistant text is one JSON object satisfying `isChatRoomAgentOutput()`. Invalid JSON becomes sanitized plain text with empty arrays; never scan `@name`. Normalize CRLF, strip ANSI/control characters except newline/tab, replace known execution roots before generic absolute-path patterns, replace exact sensitive values, cap text at 200,000 characters, dedupe arrays preserving order, and intersect IDs with allowlists. Do not log raw input or removed values.

- [ ] **Step 4: Add the chatroom output instruction to the system prompt**

When trusted source is `chatroom`, append an instruction requiring the final assistant message to be exactly one JSON object:

```json
{"text":"面向聊天室成员的最终答复","mentionedAgentIds":[],"attachmentIds":[]}
```

State that text `@名称` is display-only, `mentionedAgentIds` must use supplied roomAgentId values, and local files stay local unless an attachmentId was explicitly provided by the coordinator. Do not include local paths, source workspace IDs, Memory content or Skill content in the instruction.

- [ ] **Step 5: Run parser and prompt tests**

```bash
bun test apps/electron/src/main/lib/chatroom-output-sanitizer.test.ts
bun test apps/electron/src/main/lib/agent-prompt-builder.test.ts
```

Expected: PASS; malformed output remains displayable but cannot trigger another Agent.

- [ ] **Step 6: Commit**

```bash
git add apps/electron/src/main/lib/chatroom-output-sanitizer.ts apps/electron/src/main/lib/chatroom-output-sanitizer.test.ts apps/electron/src/main/lib/agent-prompt-builder.ts apps/electron/src/main/lib/agent-prompt-builder.test.ts
git commit -m "feat(electron): sanitize chatroom agent output"
```

---

### Task 9: ChatRoomAgentCoordinator, Parallelism, Depth and Host Permission

**Files:**
- Create: `apps/electron/src/main/lib/chatroom-agent-coordinator.ts`
- Test: `apps/electron/src/main/lib/chatroom-agent-coordinator.test.ts`
- Modify: `apps/electron/src/main/lib/agent-orchestrator.ts`
- Modify: `apps/electron/src/main/lib/agent-permission-service.ts`
- Test: `apps/electron/src/main/lib/agent-permission-service.test.ts`

**Interfaces:**
- Consumes: Tasks 3–8, `runAgentHeadless()`, `agentEventBus`, `stopAgent()` and current authenticated user identity.
- Produces: the single Main coordinator used by Rust bridge and IPC.

- [ ] **Step 1: Write failing concurrency and idempotency BDD tests**

```ts
test('Given 一条消息提及 3 个在线 Agent When 批量处理 Then 三个 run 在任一完成前都已启动', async () => {
  const promises = invocations.map((input) => coordinator.handleInvocation(input))
  await waitFor(() => expect(runAgentHeadless).toHaveBeenCalledTimes(3))
  expect(completedRuns).toBe(0)
  resolveAllRuns()
  await Promise.all(promises)
})

test('Given 同一 trace 已执行 Agent A When 重复 invocation 到达 Then 返回 duplicate 且不再次运行', async () => {
  await coordinator.handleInvocation(first)
  expect(await coordinator.handleInvocation({ ...first, invocationId: 'inv-duplicate' })).toBe('duplicate')
  expect(runAgentHeadless).toHaveBeenCalledTimes(1)
})

test('Given depth 为 3 When invocation 到达 Then rejected 且不启动 Agent', async () => {
  await coordinator.handleInvocation({ ...invocation, depth: 3 })
  expect(reportFailed).toHaveBeenCalledWith(expect.objectContaining({ code: 'invocation_depth_exceeded' }))
  expect(runAgentHeadless).not.toHaveBeenCalled()
})

test('Given Agent 输出结构化提及下一 Agent When depth 为 2 Then 文本完成但不创建下一跳', async () => {
  completeWith({ text: '继续处理', mentionedAgentIds: ['agent-b'], attachmentIds: [] })
  await coordinator.handleInvocation({ ...invocation, depth: 2 })
  expect(reportCompleted).toHaveBeenCalled()
  expect(createNextHop).not.toHaveBeenCalled()
})
```

- [ ] **Step 2: Write failing offline, stop and permission BDD tests**

```ts
test('Given Gateway 已断开 When invocation 到达 Then 立即 agent_offline 且不进入队列', async () => {
  await coordinator.handleGatewayDisconnected()
  await coordinator.handleInvocation(invocation)
  expect(reportFailed).toHaveBeenCalledWith(expect.objectContaining({ code: 'agent_offline' }))
  expect(runAgentHeadless).not.toHaveBeenCalled()
})

test('Given 运行中的 invocation When Gateway 断开 Then stopAgent 并记录 terminal failed', async () => {
  const running = coordinator.handleInvocation(invocation)
  await waitForRunStart()
  await coordinator.handleGatewayDisconnected()
  expect(stopAgent).toHaveBeenCalledWith(agentConfig.sessionId)
  await running
  expect(store.getInvocation('room-1', 'inv-1')?.status).toBe('failed')
})

test('Given 普通成员触发危险工具 When 请求权限 Then 仅主理人 renderer 收到脱敏上下文', async () => {
  await triggerPermissionRequest()
  expect(sendPermissionToHost).toHaveBeenCalledWith(expect.objectContaining({
    roomId: 'room-1', roomAgentId: 'agent-a', originalSender: invocation.sender,
    traceId: invocation.traceId, invocationId: invocation.invocationId,
  }))
  expect(reportDelta).toHaveBeenCalledWith(expect.objectContaining({ delta: '等待主理人授权' }))
  expect(JSON.stringify(reportDelta.mock.calls)).not.toContain('/Users/')
})

test('Given 非主理人身份或过期请求 When 响应权限 Then 拒绝且不调用底层权限服务', async () => {
  await expect(coordinator.respondToPermission(nonHostResponse)).rejects.toThrow('not_room_host')
  expect(respondToPermission).not.toHaveBeenCalled()
})
```

- [ ] **Step 3: Run the coordinator test and verify it fails before implementation**

Run: `bun test apps/electron/src/main/lib/chatroom-agent-coordinator.test.ts`

Expected: FAIL because `ChatRoomAgentCoordinator` does not exist.

- [ ] **Step 4: Implement coordinator dependencies and active-run ownership**

```ts
export interface ChatRoomAgentCoordinatorDependencies {
  store: ChatRoomWorkspaceStore
  rustApi: ChatRoomRustApi
  getCurrentUserId(): Promise<string | undefined>
  getDeviceId(): string
  runAgentHeadless: typeof runAgentHeadless
  stopAgent: typeof stopAgent
  subscribeAgentEvents(listener: ChatRoomAgentEventListener): () => void
  createHiddenSessionStore(roomId: string, agent: ChatRoomAgentLocalConfig): ChatRoomHiddenSessionStore
  syncSkills(input: SyncChatRoomAgentSkillSnapshotInput): ChatRoomSkillSnapshotResult
  createNextHop(input: ChatRoomNextHopInput): Promise<void>
  sendPermissionToHost(request: ChatRoomPermissionRequest): void
  now(): number
}

export class ChatRoomAgentCoordinator {
  start(): void
  provisionAgent(input: ProvisionChatRoomAgentInput): Promise<ChatRoomAgentLocalConfig>
  updateAgent(input: UpdateChatRoomAgentInput): Promise<ChatRoomAgentLocalConfig>
  removeAgent(input: RemoveChatRoomAgentInput): Promise<void>
  syncAgentSkills(input: SyncChatRoomAgentSkillsInput): Promise<ChatRoomAgentLocalConfig>
  handleInvocation(input: ChatRoomAgentInvocation): Promise<'accepted' | 'duplicate'>
  handleGatewayDisconnected(): Promise<void>
  respondToPermission(input: ChatRoomPermissionResponse): Promise<void>
  stopAll(reason: 'logout' | 'gateway_disconnected' | 'app_quit'): Promise<{
    stoppedSessionIds: string[]
    releasedRoomAgentIds: string[]
  }>
  dispose(): Promise<void>
}
```

Maintain `activeRuns: Map<invocationId, { sessionId; roomId; roomAgentId; abortController }>` and `pendingPermissions: Map<requestId, { invocationId; sessionId; hostUserId; expiresAt }>` only in Main memory. Do not build a process-wide invocation queue.

- [ ] **Step 5: Implement validation and state transitions**

For each invocation:

1. Reject when Gateway is disconnected, `depth >= 3`, local room/Agent is missing or archived, host/device mismatches, or the Agent is already active.
2. Return `duplicate` when either invocationId or `traceId + targetAgentId` already exists.
3. Persist `accepted` before `rustApi.reportAccepted()`.
4. Register the hidden session backend and trusted runtime context.
5. Persist/report `running`, then call `runAgentHeadless()` with `source: 'chatroom'`.
6. Forward only sanitized text deltas, at most one 16 KiB report every 50 ms per invocation.
7. Parse final output, persist/report `completed`, then request next hops only for structured IDs that are not in the trace ledger and only when `depth + 1 < 3`.
8. On error, timeout, stop or disconnect, persist/report one terminal failure; use compare-and-set so late callbacks cannot overwrite terminal state.
9. In `finally`, clear permissions, release runtime/session registrations and remove `activeRuns`.

- [ ] **Step 6: Route permission requests through the host-only sink**

Extend trusted runtime context with `requestPermission(request: PermissionRequest): void`. When present, `agent-orchestrator.ts` calls this sink instead of normal Agent permission IPC. The coordinator enriches a display-safe copy with roomId, roomAgentId, original sender, traceId and invocationId; full `PermissionRequest` remains only in Main memory. `respondToPermission()` re-reads authenticated user and local host, requires exact request ownership and expiry, forces `alwaysAllow = false`, then calls `permissionService.respondToPermission(requestId, behavior, false)`. A 60-second timeout denies and fails with `host_approval_timeout`.

- [ ] **Step 7: Run coordinator and permission regressions**

```bash
bun test apps/electron/src/main/lib/chatroom-agent-coordinator.test.ts
bun test apps/electron/src/main/lib/agent-permission-service.test.ts
```

Expected: PASS for three-Agent parallel start, duplicate delivery, three-hop stop, offline no-queue, disconnect stop and host-only permission response.

- [ ] **Step 8: Commit**

```bash
git add apps/electron/src/main/lib/chatroom-agent-coordinator.ts apps/electron/src/main/lib/chatroom-agent-coordinator.test.ts apps/electron/src/main/lib/agent-orchestrator.ts apps/electron/src/main/lib/agent-permission-service.ts apps/electron/src/main/lib/agent-permission-service.test.ts
git commit -m "feat(electron): coordinate chatroom agents"
```

---

### Task 10: Shared Electron API, IPC/Preload Bridge and Lifecycle Cleanup

**Files:**
- Modify: `packages/shared/src/types/chatroom.ts`
- Modify: `apps/electron/src/preload/index.ts`
- Create: `apps/electron/src/preload/chatrooms-preload.test.ts`
- Create: `apps/electron/src/main/ipc/chatrooms.ipc.ts`
- Create: `apps/electron/src/main/ipc-tests/chatrooms.test.ts`
- Modify: `apps/electron/src/main/ipc.ts`
- Modify: `apps/electron/src/main/ipc/working-account.ipc.ts`
- Test: `apps/electron/src/main/ipc-tests/working-account.test.ts`
- Modify: `apps/electron/src/main/lib/http-api-handler.ts`
- Test: `apps/electron/src/main/lib/http-api-handler.test.ts`
- Modify: `apps/electron/src/main/lib/http-api-server.ts`
- Test: `apps/electron/src/main/lib/http-api-server-runtime.test.ts`
- Modify: `apps/electron/src/main/index.ts`
- Create: `apps/electron/src/main/chatroom-lifecycle.test.ts`

**Interfaces:**
- Consumes: Task 1 shared DTO/validators, Task 7 Rust internal routes/client, Task 9 `ChatRoomAgentCoordinator`.
- Produces: shared `ChatRoomElectronAPI`, registered Main IPC, the preload bridge, validated Rust invocation/disconnect dispatch, and ordered `stopAll + lease release` for logout, Gateway disconnect and application quit.

- [ ] **Step 1: Add failing shared/preload contract tests**

Add the following compile-time/runtime contract to `packages/shared/src/types/chatroom.test.ts` and `chatrooms-preload.test.ts`:

```ts
import type { ChatRoomElectronAPI } from '@copis/shared'

const expectedMethods: Array<keyof ChatRoomElectronAPI> = [
  'listLocalRooms',
  'provisionAgent',
  'updateAgent',
  'removeAgent',
  'syncAgentSkills',
  'respondPermission',
  'onPermissionRequested',
  'onLocalConfigChanged',
]

test('Given preload 初始化 When 暴露 chatrooms Then 仅提供 shared contract 中的本地能力', () => {
  expect(Object.keys(exposedElectronApi.chatrooms).sort()).toEqual(expectedMethods.sort())
  expect(JSON.stringify(exposedElectronApi.chatrooms)).not.toContain('trustedRuntimeContext')
  expect(JSON.stringify(exposedElectronApi.chatrooms)).not.toContain('internalToken')
})

test('Given chatroom push listener When 取消订阅 Then 移除同一个包装 listener', () => {
  const callback = mock(() => {})
  const unsubscribe = exposedElectronApi.chatrooms.onPermissionRequested(callback)
  unsubscribe()
  expect(removeListener).toHaveBeenCalledWith(
    CHATROOM_IPC_CHANNELS.PERMISSION_REQUESTED,
    on.mock.calls.find(([channel]) => channel === CHATROOM_IPC_CHANNELS.PERMISSION_REQUESTED)?.[1],
  )
})
```

- [ ] **Step 2: Run the shared/preload tests and verify RED**

```bash
bun test packages/shared/src/types/chatroom.test.ts
bun test apps/electron/src/preload/chatrooms-preload.test.ts
```

Expected: FAIL because `ChatRoomElectronAPI` and `electronAPI.chatrooms` do not exist.

- [ ] **Step 3: Define the shared Electron API and redacted view types**

Add these exact interfaces to `packages/shared/src/types/chatroom.ts`:

```ts
export interface ChatRoomAgentLocalView {
  roomAgentId: string
  displayName: string
  sourceWorkspaceId: string
  channelId: string
  modelId?: string
  contextMessageCount: number
  memorySharingEnabled: boolean
  skillSharingEnabled: boolean
  skillSnapshotDigest?: string
  archived: boolean
}

export interface ChatRoomLocalRoomView {
  roomId: string
  agents: ChatRoomAgentLocalView[]
  updatedAt: number
}

export interface ChatRoomElectronAPI {
  listLocalRooms(): Promise<ChatRoomLocalRoomView[]>
  provisionAgent(input: ProvisionChatRoomAgentInput): Promise<ChatRoomAgentLocalView>
  updateAgent(input: UpdateChatRoomAgentInput): Promise<ChatRoomAgentLocalView>
  removeAgent(input: RemoveChatRoomAgentInput): Promise<void>
  syncAgentSkills(input: SyncChatRoomAgentSkillsInput): Promise<ChatRoomAgentLocalView>
  respondPermission(input: ChatRoomPermissionResponse): Promise<void>
  onPermissionRequested(callback: (request: ChatRoomPermissionRequest) => void): () => void
  onLocalConfigChanged(callback: (room: ChatRoomLocalRoomView) => void): () => void
}
```

`ChatRoomAgentLocalView` intentionally omits hostUserId, deviceId, sessionId, source workspace slug, paths and invocation ledger. Add `chatrooms: ChatRoomElectronAPI` to the preload `ElectronAPI` interface; do not duplicate the method signatures inline.

- [ ] **Step 4: Add failing Main IPC tests**

```ts
test('Given 主窗口 provision 请求 When IPC handler 执行 Then 校验输入并返回脱敏 view', async () => {
  registerChatRoomIpcHandlers({ getCoordinator, getMainWindow })
  const result = await registered(CHATROOM_IPC_CHANNELS.PROVISION_AGENT)(mainFrameEvent, input)
  expect(provisionAgent).toHaveBeenCalledWith(input)
  expect(result).toEqual(expectedAgentView)
  expect(JSON.stringify(result)).not.toContain('/Users/')
})

test('Given 非主窗口 sender When 修改 Agent 或响应权限 Then 拒绝', async () => {
  await expect(
    registered(CHATROOM_IPC_CHANNELS.RESPOND_PERMISSION)(otherWindowEvent, response),
  ).rejects.toThrow('不允许的请求来源')
  expect(respondToPermission).not.toHaveBeenCalled()
})

test('Given coordinator 产生权限请求 When 广播 Then 只发送脱敏 ChatRoomPermissionRequest 到主窗口', () => {
  emitPermissionRequest(safeRequest)
  expect(mainWindow.webContents.send).toHaveBeenCalledWith(
    CHATROOM_IPC_CHANNELS.PERMISSION_REQUESTED,
    safeRequest,
  )
  expect(JSON.stringify(mainWindow.webContents.send.mock.calls)).not.toContain('toolInput')
})
```

- [ ] **Step 5: Run Main IPC test and verify RED**

Run: `bun test apps/electron/src/main/ipc-tests/chatrooms.test.ts`

Expected: FAIL because `registerChatRoomIpcHandlers()` is absent.

- [ ] **Step 6: Implement IPC registration and preload bridge**

```ts
export interface RegisterChatRoomIpcOptions {
  getCoordinator(): ChatRoomAgentCoordinator
  getMainWindow(): BrowserWindow | null
}

export function registerChatRoomIpcHandlers(
  options?: Partial<RegisterChatRoomIpcOptions>,
): void
```

Register the six invoke channels from `CHATROOM_IPC_CHANNELS`. Each handler must validate the shared DTO, require `event.sender === getMainWindow()?.webContents`, call the coordinator, and convert results through one `toChatRoomLocalRoomView()`/`toChatRoomAgentLocalView()` implementation. Subscribe once to coordinator permission/config events and skip destroyed windows. Import and call `registerChatRoomIpcHandlers()` once from `registerIpcHandlers()`.

In preload, implement `ChatRoomElectronAPI` only with `ipcRenderer.invoke`, `ipcRenderer.on` and matching `removeListener`. Do not expose Rust reporting methods, lease release, `stopAll`, local paths, deviceId, runtime context or full permission tool input.

- [ ] **Step 7: Add failing Rust internal-handler tests**

Extend `http-api-handler.test.ts` with exact routes:

```ts
test('Given Rust internal invocation POST When DTO 合法 Then coordinator 接收且返回 202', async () => {
  const result = await handleHttpApiRequest(
    { method: 'POST', path: '/api/internal/chatrooms/invocations', body: JSON.stringify(invocation) },
    deps,
  )
  expect(result).toEqual({ status: 202, body: { status: 'accepted' } })
  expect(handleChatRoomInvocation).toHaveBeenCalledWith(invocation)
})

test('Given Rust internal disconnected POST When 收到 Then stopAll gateway_disconnected 并返回 204', async () => {
  const result = await handleHttpApiRequest(
    { method: 'POST', path: '/api/internal/chatrooms/disconnected' },
    deps,
  )
  expect(handleChatRoomGatewayDisconnected).toHaveBeenCalledTimes(1)
  expect(result).toEqual({ status: 204 })
})

test('Given chatroom internal route 使用非 POST 或非法字段 When 处理 Then 400/405 且不调 coordinator', async () => {
  expect((await handleHttpApiRequest({ method: 'GET', path: '/api/internal/chatrooms/invocations' }, deps)).status).toBe(405)
  expect((await handleHttpApiRequest({ method: 'POST', path: '/api/internal/chatrooms/invocations', body: '{"token":"x"}' }, deps)).status).toBe(400)
  expect(handleChatRoomInvocation).not.toHaveBeenCalled()
})
```

- [ ] **Step 8: Run internal-handler tests and verify RED**

Run: `bun test apps/electron/src/main/lib/http-api-handler.test.ts`

Expected: FAIL because the exact chatroom internal routes are not dispatched.

- [ ] **Step 9: Wire the internal handler without widening trust**

Extend `HttpApiDependencies` exactly as defined in Task 7. Route only exact paths and POST. Parse with `isChatRoomAgentInvocation()` before lazy-loading the coordinator. Return stable codes `invalid_chatroom_invocation`, `chatroom_coordinator_unavailable` and `method_not_allowed`. The Rust process remains responsible for checking `X-Copis-Internal-Token` before forwarding through stdout; Electron must still reject malformed/unknown fields. Do not add these routes to Renderer web-token APIs.

- [ ] **Step 10: Add failing logout, disconnect and quit-order tests**

```ts
test('Given 用户登出 When 清理认证 Then 先停止聊天室并释放租约再 logout', async () => {
  await invokeWorkingLogout()
  expect(callOrder).toEqual(['coordinator.stopAll:logout', 'rust.releaseAgentLeases:logout', 'working.logout'])
})

test('Given Rust 子进程意外退出 When exit listener 触发 Then stopAll 且不排队 lease 重试', async () => {
  rustChild.emit('exit', 1, null)
  await flushPromises()
  expect(stopAll).toHaveBeenCalledWith('gateway_disconnected')
  expect(scheduleRetry).not.toHaveBeenCalled()
})

test('Given 应用退出且有运行中聊天室 Agent When before-quit Then stopAll 和 lease release 先于 Rust stop', async () => {
  await runBeforeQuitFlow()
  expect(callOrder).toEqual([
    'coordinator.stopAll:app_quit',
    'rust.releaseAgentLeases:app_quit',
    'agents.stopAll',
    'httpApi.stop',
    'coordinator.dispose',
  ])
})
```

- [ ] **Step 11: Run lifecycle tests and verify RED**

```bash
bun test apps/electron/src/main/ipc-tests/working-account.test.ts
bun test apps/electron/src/main/lib/http-api-server-runtime.test.ts
bun test apps/electron/src/main/chatroom-lifecycle.test.ts
```

Expected: FAIL because logout and HTTP process exit do not yet notify the coordinator and quit ordering does not include lease release.

- [ ] **Step 12: Implement one idempotent cleanup path**

Add to `ChatRoomAgentCoordinator`:

```ts
stopAll(reason: 'logout' | 'gateway_disconnected' | 'app_quit'): Promise<{
  stoppedSessionIds: string[]
  releasedRoomAgentIds: string[]
}>
```

The method atomically disables new invocation acceptance, snapshots active runs, denies/clears pending permissions, awaits `Promise.allSettled(stopAgent(sessionId))`, marks nonterminal records failed, and then calls `rustApi.releaseAgentLeases({ roomAgentIds, reason })`. Lease release is best-effort with a 1-second bound: log only IDs shortened by `shortLogId`, never credentials or paths. On `gateway_disconnected`, a failed release is dropped rather than queued. Repeated calls return the same in-flight Promise; after completion they are no-ops for already released leases.

Add to `http-api-server.ts`:

```ts
export type HttpApiServerExitReason = 'error' | 'unexpected_exit'

export function addHttpApiServerExitListener(
  listener: (reason: HttpApiServerExitReason) => void,
): () => void
```

Notify listeners only when the managed Rust process fails while `stopping === false`; intentional `stopHttpApiServer()` must not emit disconnect. Register one listener during app startup that calls `coordinator.stopAll('gateway_disconnected')` without retry.

Extend `registerWorkingAccountIpcHandlers()` dependencies with `stopChatRoomAgents(reason: 'logout'): Promise<void>` and await it before `client.logout()`, preserving auth long enough for lease release. The Rust-originated `/api/working/auth/logout` handler must call the same cleanup dependency before clearing auth, so IPC and HTTP logout cannot diverge.

In `before-quit`, extend the first guarded asynchronous phase to await `coordinator.stopAll('app_quit')` before `stopAllAgents()`. Only the second pass may call `stopHttpApiServer()`, followed by idempotent `coordinator.dispose()`.

- [ ] **Step 13: Run GREEN tests for every Task 10 boundary**

```bash
bun test packages/shared/src/types/chatroom.test.ts
bun test apps/electron/src/preload/chatrooms-preload.test.ts
bun test apps/electron/src/main/ipc-tests/chatrooms.test.ts
bun test apps/electron/src/main/ipc-tests/working-account.test.ts
bun test apps/electron/src/main/lib/http-api-handler.test.ts
bun test apps/electron/src/main/lib/http-api-server-runtime.test.ts
bun test apps/electron/src/main/chatroom-lifecycle.test.ts
bun run --filter='@copis/shared' typecheck
bun run --filter='@copis/electron' build:main
bun run --filter='@copis/electron' build:preload
```

Expected: every command exits 0; IPC/preload expose only the shared surface, both logout paths stop/release before auth removal, unexpected Rust exit causes one no-queue cleanup, and app quit releases leases before Rust stops.

- [ ] **Step 14: Commit**

```bash
git add packages/shared/src/types/chatroom.ts packages/shared/src/types/chatroom.test.ts
git add apps/electron/src/preload/index.ts apps/electron/src/preload/chatrooms-preload.test.ts
git add apps/electron/src/main/ipc/chatrooms.ipc.ts apps/electron/src/main/ipc-tests/chatrooms.test.ts apps/electron/src/main/ipc.ts
git add apps/electron/src/main/ipc/working-account.ipc.ts apps/electron/src/main/ipc-tests/working-account.test.ts
git add apps/electron/src/main/lib/http-api-handler.ts apps/electron/src/main/lib/http-api-handler.test.ts
git add apps/electron/src/main/lib/http-api-server.ts apps/electron/src/main/lib/http-api-server-runtime.test.ts
git add apps/electron/src/main/index.ts apps/electron/src/main/chatroom-lifecycle.test.ts apps/electron/src/main/lib/chatroom-agent-coordinator.ts apps/electron/src/main/lib/chatroom-rust-client.ts
git commit -m "feat(electron): expose and clean up chatroom agents"
```

Do not stage or modify `AGENTS.md` or `README.md` without explicit user permission.

## Plan Self-Review

- Spec coverage: Tasks 1–10 cover Shared/Preload/IPC, stable deviceId, atomic room config, hidden session/workspace, execution/Memory/Skill separation, Skill snapshot, parallel invocation, idempotency/depth, structured output, offline no-queue, host-only permission, output sanitization, Rust internal bridge, logout/disconnect/quit cleanup and lease release.
- Scope boundary: Renderer/Jotai room UI, Rust WebSocket transport and COS transfer remain in their separate phase plans; this plan only defines the `ChatRoomElectronAPI` they consume.
- Type consistency: `ChatRoomAgentInvocation`, `ChatRoomAgentRuntimeContext`, `ChatRoomRustApi`, `ChatRoomElectronAPI` and coordinator method names are defined once and reused by later tasks.
- Persistence bound: terminal records use 30 days and at most 2,000 entries per room; nonterminal entries are not silently discarded.
- Security boundary: Renderer cannot submit runtime overrides or receive deviceId, hidden sessionId, local paths, invocation ledger, Working JWT, STS or full dangerous tool inputs.
- Lifecycle boundary: logout and app quit stop runs and release leases before removing auth/stopping Rust; unexpected disconnect stops once and never queues replay.
- Documentation boundary: no task edits `AGENTS.md` or `README.md` without later explicit permission.
