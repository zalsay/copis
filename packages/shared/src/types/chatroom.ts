/** 聊天室 Agent 协调器共享契约。
 *
 * 这里的 DTO 只描述跨进程传输所需的公开字段。工作区绝对路径、session
 * 文件、设备标识和令牌等敏感信息不得通过这些类型传到 Renderer。
 */

export const CHATROOM_MAX_AGENTS = 3
export const CHATROOM_DEFAULT_CONTEXT_MESSAGES = 50
export const CHATROOM_MAX_CONTEXT_MESSAGES = 200
export const CHATROOM_MAX_DEPTH = 3
export const CHATROOM_TERMINAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
export const CHATROOM_MAX_TERMINAL_INVOCATIONS = 2_000
export const CHATROOM_MAX_ID_LENGTH = 128
export const CHATROOM_MAX_OUTPUT_TEXT_LENGTH = 200_000
export const CHATROOM_MAX_ATTACHMENT_IDS = 20

export type ChatRoomRole = 'host' | 'member'
export type ChatRoomStatus = 'active' | 'archived' | 'deleting' | 'deleted'
export type ChatRoomPresence = 'online' | 'busy' | 'offline' | 'disabled'
export type ChatRoomCapability = 'agent-ready-v1' | 'invocation-ack-v1' | 'agent-delta-frame-id-v1'
export type AgentAvailability = 'preparing' | 'online' | 'busy' | 'offline' | 'disabled' | 'configuration_error'
export type ChatRoomConnectionStatus = 'connecting' | 'connected' | 'reconnecting' | 'offline' | 'auth_expired'

export type ChatRoomReadyCommand = {
  type: 'agent.ready' | 'agent.unready'
  roomId: string
  payload: { requestId: string; roomAgentId: string }
}

export type ChatRoomCommandAck = {
  type: 'command.ack'
  roomId: string
  payload: {
    requestId: string
    command: string
    ok: boolean
    invocationId?: string
    status?: string
    errorCode?: string
  }
}

const CHATROOM_CAPABILITIES = new Set<ChatRoomCapability>([
  'agent-ready-v1',
  'invocation-ack-v1',
  'agent-delta-frame-id-v1',
])

/** 校验 ready 命令；认证主体由服务端连接上下文提供，禁止由 payload 指定。 */
export function parseChatRoomReadyCommand(value: unknown): ChatRoomReadyCommand | undefined {
  if (!isRecord(value) || !hasExactKeys(value, ['type', 'roomId', 'payload'])) return undefined
  if (value.type !== 'agent.ready' && value.type !== 'agent.unready') return undefined
  if (!isChatRoomWireId(value.roomId, 64) || !isRecord(value.payload) || !hasExactKeys(value.payload, ['requestId', 'roomAgentId'])) return undefined
  if (!isChatRoomWireId(value.payload.requestId, 128) || !isChatRoomWireId(value.payload.roomAgentId, 64)) return undefined
  return value as unknown as ChatRoomReadyCommand
}

/** 未知能力不会激活；旧服务器 404 应由 HTTP 调用方按 legacy 单独处理。 */
export function parseChatRoomCapabilities(value: unknown): ChatRoomCapability[] | undefined {
  if (!isRecord(value) || !hasExactKeys(value, ['capabilities']) || !Array.isArray(value.capabilities)) return undefined
  const enabled = new Set<ChatRoomCapability>()
  for (const capability of value.capabilities) {
    if (typeof capability === 'string' && CHATROOM_CAPABILITIES.has(capability as ChatRoomCapability)) {
      enabled.add(capability as ChatRoomCapability)
    } else if (typeof capability !== 'string') return undefined
  }
  return [...enabled]
}

/** 私有 ACK 不属于可广播的 ChatRoomEventEnvelope。 */
export function parseChatRoomCommandAck(value: unknown, expectedRoomId?: string): ChatRoomCommandAck | undefined {
  if (!isRecord(value) || !hasExactKeys(value, ['type', 'roomId', 'payload']) || value.type !== 'command.ack') return undefined
  if (!isChatRoomWireId(value.roomId, 64) || (expectedRoomId !== undefined && value.roomId !== expectedRoomId)) return undefined
  const payload = value.payload
  if (!isRecord(payload)) return undefined
  const allowed = ['requestId', 'command', 'ok', 'invocationId', 'status', 'errorCode']
  if (!Reflect.ownKeys(payload).every((key) => typeof key === 'string' && allowed.includes(key))) return undefined
  const allowedCommands = ['agent.ready', 'agent.unready', 'agent.accepted', 'agent.running', 'agent.delta', 'agent.completed', 'agent.failed']
  if (!hasRequiredKeys(payload, ['requestId', 'command', 'ok']) || !isChatRoomWireId(payload.requestId, 128) || typeof payload.command !== 'string' || !allowedCommands.includes(payload.command) || typeof payload.ok !== 'boolean') return undefined
  if (payload.invocationId !== undefined && !isChatRoomWireId(payload.invocationId, 64)) return undefined
  if (payload.status !== undefined && (typeof payload.status !== 'string' || !['created', 'accepted', 'running', 'completed', 'failed', 'rejected'].includes(payload.status))) return undefined
  if (payload.errorCode !== undefined && !isChatRoomWireId(payload.errorCode, 64)) return undefined
  return value as unknown as ChatRoomCommandAck
}

function isChatRoomWireId(value: unknown, maxBytes: number): value is string {
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0 || new TextEncoder().encode(value).length > maxBytes) return false
  return !/[\s\u0000-\u001f\u007f\u0080-\u009f/?#\\]/u.test(value)
}
export type ChatRoomAttachmentPhase =
  | 'waiting_authorization'
  | 'uploading'
  | 'validating'
  | 'ready'
  | 'downloading'
  | 'failed'
  | 'cancelled'

/** 仅暴露本地聊天室管理能力，不包含发送消息或 Rust 上报通道。 */
export const CHATROOM_IPC_CHANNELS = {
  LIST_LOCAL_ROOMS: 'chatrooms:list-local-rooms',
  PROVISION_AGENT: 'chatrooms:provision-agent',
  UPDATE_AGENT: 'chatrooms:update-agent',
  REMOVE_AGENT: 'chatrooms:remove-agent',
  SYNC_AGENT_SKILLS: 'chatrooms:sync-agent-skills',
  RESPOND_PERMISSION: 'chatrooms:respond-permission',
  PERMISSION_REQUESTED: 'chatrooms:permission-requested',
  LOCAL_CONFIG_CHANGED: 'chatrooms:local-config-changed',
  SELECT_AND_UPLOAD: 'chatrooms:select-and-upload',
  START_DOWNLOAD: 'chatrooms:start-download',
  CANCEL_TRANSFER: 'chatrooms:cancel-transfer',
  TRANSFER_PROGRESS: 'chatrooms:transfer-progress',
} as const

/** Renderer 可见的远端聊天室概要。分享码只在服务端允许的成员范围内返回。 */
export interface ChatRoomSummary {
  roomId: string
  name: string
  role: ChatRoomRole
  hostUserId?: string
  status: ChatRoomStatus
  shareCode?: string
  memberCount: number
  unreadCount: number
  connectionStatus: ChatRoomConnectionStatus
}

export interface ChatRoomMember {
  userId: string
  displayName: string
  avatar?: string
  role: ChatRoomRole
  presence: ChatRoomPresence
}

export interface ChatRoomAgent {
  agentId: string
  displayName: string
  avatar?: string
  status: ChatRoomPresence
  /** 服务端派生的运行就绪状态；不从成员在线状态推断。 */
  availability?: AgentAvailability
  busy: boolean
  memoryShared: boolean
  skillsShared: boolean
}

/** 成员可读的 invocation 元数据，仅用于按精确调用 ID 归属运行状态。 */
export interface ChatRoomInvocationMetadata {
  invocationId: string
  roomId: string
  traceId: string
  targetAgentId: string
  triggerMessageId: string
  depth: number
  status: ChatRoomInvocationStatus
  failureCode?: string
  finishedAt?: string | number
}

/** 服务端消息 DTO；trace/depth 只允许作为服务端响应的一部分出现。 */
export interface ChatRoomMessage {
  messageId: string
  roomId: string
  seq: number
  senderType: 'user' | 'agent' | 'system'
  senderId: string
  content: string
  mentionAgentIds: string[]
  attachmentIds: string[]
  clientMessageId: string
  traceId?: string
  parentMessageId?: string
  depth: number
  createdAt: string
}

export interface ChatRoomInvocation {
  invocationId: string
  roomId: string
  traceId: string
  targetAgentId: string
  triggerMessageId: string
  depth: number
  status: ChatRoomInvocationStatus
  failureCode?: string
  delta?: string
  errorMessage?: string
  /** Renderer 首次观察到本次调用的时间，用于运行指示器计时。 */
  startedAt?: number
}

export interface ChatRoomAttachment {
  attachmentId: string
  roomId: string
  originalName: string
  mimeType: string
  sizeBytes: number
  status: 'pending' | 'ready' | 'attached' | 'deleted'
  messageId?: string
}

export interface ChatRoomTransferState {
  transferId: string
  attachmentId?: string
  roomId: string
  originalName?: string
  phase: ChatRoomAttachmentPhase
  progress: number
  errorCode?: string
}

export interface ChatRoomEventEnvelope {
  type: string
  roomId?: string
  seq?: number
  latestSeq?: number
  code?: string
  payload: unknown
}

/** Renderer -> Rust：客户端只提交房间名和主理人创建的分享码。 */
export interface ChatRoomCreateInput {
  name: string
  shareCode: string
}

export interface ChatRoomJoinInput {
  shareCode: string
}

/** Renderer -> Rust：服务端负责生成 trace/depth 等调用链字段。 */
export interface ChatRoomSendMessageInput {
  roomId: string
  content: string
  mentionAgentIds: string[]
  attachmentIds: string[]
  clientMessageId: string
}

export type ChatRoomDownloadRequest = {
  transferId: string
  roomId: string
  attachmentId: string
} & (
  | { target: 'user'; roomAgentId?: never }
  | { target: 'agent_inbox'; roomAgentId: string }
)

export interface ChatRoomTransferResult {
  transferId: string
  attachmentId?: string
  originalName?: string
  phase: 'ready' | 'failed' | 'cancelled'
  errorCode?: string
}

/** Renderer 边界的分享码规范化；服务端仍负责有效性、唯一性和限流。 */
export function normalizeChatRoomShareCode(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim().toUpperCase()
  return /^[A-Z0-9]{4}$/.test(normalized) ? normalized : undefined
}

export type ChatRoomInvocationStatus =
  | 'created'
  | 'accepted'
  | 'running'
  | 'completed'
  | 'failed'
  | 'rejected'

export type ChatRoomInvocationFailureCode =
  | 'room_not_found'
  | 'room_archived'
  | 'not_room_member'
  | 'share_code_invalid'
  | 'share_code_rate_limited'
  | 'agent_limit_reached'
  | 'agent_offline'
  | 'agent_busy'
  | 'invocation_duplicate'
  | 'invocation_depth_exceeded'
  | 'host_approval_timeout'
  | 'host_approval_denied'
  | 'attachment_not_ready'
  | 'attachment_forbidden'
  | 'realtime_reconnecting'
  | 'gateway_disconnected'
  | 'app_quit'
  | 'invalid_invocation'
  | 'invalid_output'
  | 'room_agent_not_found'
  | 'internal_error'

export type ChatRoomSenderType = 'user' | 'agent'

export interface ChatRoomSender {
  type: ChatRoomSenderType
  id: string
  displayName: string
}

export interface ChatRoomInvocationChainEntry {
  agentId: string
  invocationId: string
}

export interface ChatRoomContextMessage {
  messageId: string
  sender: ChatRoomSender
  text: string
  createdAt: number
  attachmentIds?: string[]
  mentionedAgentIds?: string[]
  invocationChain?: ChatRoomInvocationChainEntry[]
}

export interface ChatRoomAgentInvocation {
  invocationId: string
  roomId: string
  traceId: string
  targetAgentId: string
  triggerMessageId: string
  depth: number
  sender: ChatRoomSender
  messages: ChatRoomContextMessage[]
  receivedAt: number
}

export interface ChatRoomAgentOutput {
  text: string
  mentionedAgentIds: string[]
  attachmentIds: string[]
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

export interface ChatRoomInvocationRecord {
  invocationId: string
  roomId: string
  traceId: string
  targetAgentId: string
  triggerMessageId: string
  depth: number
  status: ChatRoomInvocationStatus
  createdAt: number
  updatedAt: number
  acceptedAt?: number
  startedAt?: number
  finishedAt?: number
  failureCode?: ChatRoomInvocationFailureCode
  failureMessage?: string
}

export interface ChatRoomLocalRoomConfig {
  roomId: string
  hostUserId: string
  deviceId: string
  lastProcessedSeq: number
  agents: ChatRoomAgentLocalConfig[]
  invocations: ChatRoomInvocationRecord[]
  createdAt: number
  updatedAt: number
}

export interface ChatRoomLocalIdentity {
  hostUserId: string
  deviceId: string
}

export interface ChatRoomPermissionContext {
  roomId: string
  roomAgentId: string
  invocationId: string
  traceId: string
  originalSender: ChatRoomSender
  invocationChain: ChatRoomInvocationChainEntry[]
}

/** 发给主理人窗口的权限请求只包含脱敏摘要。 */
export interface ChatRoomPermissionRequest extends ChatRoomPermissionContext {
  requestId: string
  toolName: string
  summary: string
  createdAt: number
  expiresAt: number
}

export interface ChatRoomPermissionResponse {
  requestId: string
  behavior: 'allow' | 'deny'
}

export interface ProvisionChatRoomAgentInput {
  roomId: string
  sourceWorkspaceId: string
  displayName: string
  channelId: string
  modelId?: string
  contextMessageCount?: number
  memorySharingEnabled?: boolean
  skillSharingEnabled?: boolean
}

export interface UpdateChatRoomAgentInput {
  roomId: string
  roomAgentId: string
  displayName?: string
  channelId?: string
  modelId?: string
  contextMessageCount?: number
  memorySharingEnabled?: boolean
  skillSharingEnabled?: boolean
}

export interface RemoveChatRoomAgentInput {
  roomId: string
  roomAgentId: string
}

export interface SyncChatRoomAgentSkillsInput {
  roomId: string
  roomAgentId: string
}

/** Renderer 可见的聊天室 Agent 脱敏视图。 */
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
  localAvailability?: AgentAvailability
}

/** Renderer 可见的聊天室脱敏视图。 */
export interface ChatRoomLocalRoomView {
  roomId: string
  agents: ChatRoomAgentLocalView[]
  updatedAt: number
}

/** 聊天室在 Renderer 中使用的最小本地管理 API。 */
export interface ChatRoomElectronAPI {
  listLocalRooms(): Promise<ChatRoomLocalRoomView[]>
  provisionAgent(input: ProvisionChatRoomAgentInput): Promise<ChatRoomAgentLocalView>
  updateAgent(input: UpdateChatRoomAgentInput): Promise<ChatRoomAgentLocalView>
  removeAgent(input: RemoveChatRoomAgentInput): Promise<void>
  syncAgentSkills(input: SyncChatRoomAgentSkillsInput): Promise<ChatRoomAgentLocalView>
  respondPermission(input: ChatRoomPermissionResponse): Promise<void>
  onPermissionRequested(callback: (request: ChatRoomPermissionRequest) => void): () => void
  onLocalConfigChanged(callback: (room: ChatRoomLocalRoomView) => void): () => void
  startUpload(input: { transferId: string; roomId: string }): Promise<ChatRoomTransferResult>
  startDownload(input: ChatRoomDownloadRequest): Promise<ChatRoomTransferResult>
  cancelTransfer(transferId: string): Promise<void>
  onTransferProgress(callback: (state: ChatRoomTransferState) => void): () => void
}

/**
 * Main 模块之间传递的可信运行时编译期契约。
 * 该类型不得嵌入任何 IPC DTO；执行路径和其他敏感字段不能进入 Renderer。
 */
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
  /** Main-only sink；完整 PermissionRequest 不得进入 Renderer 或 HTTP DTO。 */
  requestPermission?: (request: import('./agent').PermissionRequest) => void
}

export interface ChatRoomRustApi {
  reportAccepted(input: { invocationId: string }, options?: { signal?: AbortSignal }): Promise<ChatRoomLifecycleResult>
  reportRunning(input: { invocationId: string }, options?: { signal?: AbortSignal }): Promise<ChatRoomLifecycleResult>
  reportDelta(input: { invocationId: string; delta: string }): Promise<void>
  reportCompleted(input: { invocationId: string; output: ChatRoomAgentOutput }, options?: { signal?: AbortSignal }): Promise<ChatRoomLifecycleResult>
  reportFailed(input: {
    invocationId: string
    code: ChatRoomInvocationFailureCode
    message: string
  }, options?: { signal?: AbortSignal }): Promise<ChatRoomLifecycleResult>
  queryInvocationStatus(input: ChatRoomInvocationStatusQuery, options?: { signal?: AbortSignal }): Promise<ChatRoomInvocationStatusResult>
  releaseAgentLeases(input: {
    roomAgentIds: string[]
    reason: 'logout' | 'gateway_disconnected' | 'app_quit'
  }): Promise<void>
}

/** Main-only lifecycle receipt. This type is never part of an IPC/Renderer DTO. */
interface ChatRoomLifecycleResultBase {
  roomId: string
  invocationId: string
  command: 'agent.accepted' | 'agent.running' | 'agent.completed' | 'agent.failed'
  status: 'accepted' | 'running' | 'completed' | 'failed'
  generation: number
}

/** Native 已匹配到的 legacy terminal event 结果；Main-only，不能进入 IPC/Renderer DTO。 */
export type ChatRoomLegacyTerminalProof =
  | { kind: 'matched-server-event-v1'; replyClientMessageId: string; replyDigest: string }
  | { kind: 'matched-server-event-v1'; failureCode: ChatRoomInvocationFailureCode }

export type ChatRoomLifecycleResult =
  | (ChatRoomLifecycleResultBase & {
      outcome: 'confirmed'
      mode: 'invocation-ack-v1'
      source: 'private-ack'
      confirmed: true
      requestId: string
    })
  | (ChatRoomLifecycleResultBase & {
      outcome: 'confirmed'
      mode: 'legacy'
      source: 'server-event'
      command: 'agent.accepted'
      status: 'accepted' | 'running'
    })
  | (ChatRoomLifecycleResultBase & {
      outcome: 'confirmed'
      mode: 'legacy'
      source: 'server-event'
      command: 'agent.completed'
      status: 'completed'
      terminalProof: Extract<ChatRoomLegacyTerminalProof, { replyClientMessageId: string }>
    })
  | (ChatRoomLifecycleResultBase & {
      outcome: 'confirmed'
      mode: 'legacy'
      source: 'server-event'
      command: 'agent.failed'
      status: 'failed'
      terminalProof: Extract<ChatRoomLegacyTerminalProof, { failureCode: ChatRoomInvocationFailureCode }>
    })
  | (ChatRoomLifecycleResultBase & {
      outcome: 'advisory'
      mode: 'legacy'
      source: 'accepted-event+local-advisory'
      command: 'agent.running'
      status: 'running'
    })

/** Main-only query contract constructed exclusively from the local persisted invocation/result record. */
export interface ChatRoomInvocationStatusQuery {
  roomId: string
  invocationId: string
  deviceId: string
  traceId: string
  targetAgentId: string
  triggerMessageId: string
  depth: number
  expectedStatus: 'completed' | 'failed'
  failureCode: ChatRoomInvocationFailureCode | ''
  clientMessageId: string
  replyDigest: string
}

/** Main-only status proof; Unknown/Rejected are not terminal confirmations. */
export type ChatRoomInvocationStatusResult =
  | { outcome: 'Confirmed'; roomId: string; invocationId: string; traceId: string; status: 'completed'; generation: number; finishedAt: string; replyMessageId: string; replyClientMessageId: string; replyDigest: string }
  | { outcome: 'Confirmed'; roomId: string; invocationId: string; traceId: string; status: 'failed'; generation: number; finishedAt: string; failureCode: ChatRoomInvocationFailureCode }
  | { outcome: 'Confirmed'; roomId: string; invocationId: string; traceId: string; status: 'completed'; generation: number; mode: 'legacy'; source: 'server-event'; terminalProof: Extract<ChatRoomLegacyTerminalProof, { replyClientMessageId: string }> }
  | { outcome: 'Confirmed'; roomId: string; invocationId: string; traceId: string; status: 'failed'; generation: number; mode: 'legacy'; source: 'server-event'; terminalProof: Extract<ChatRoomLegacyTerminalProof, { failureCode: ChatRoomInvocationFailureCode }> }
  | { outcome: 'Unknown'; roomId: string; invocationId: string; traceId: string; generation: number }
  | { outcome: 'Rejected'; roomId: string; invocationId: string; traceId: string; generation: number }

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === null || prototype === Object.prototype
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = new Set(keys)
  const ownKeys = Reflect.ownKeys(value)
  return ownKeys.length === keys.length && ownKeys.every((key) => typeof key === 'string' && expected.has(key))
}

function hasRequiredKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
}

function isBoundedId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= CHATROOM_MAX_ID_LENGTH
}

function isBoundedText(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length <= maxLength
}

function isBoundedNonBlankText(value: unknown, maxLength: number): value is string {
  return isBoundedText(value, maxLength) && value.trim().length > 0
}

/** 聊天室 Agent 名称跨 Rust/Go/主进程的专用规则：trim 后非空、UTF-8 最多 128 字节、拒绝 Unicode Cc control。 */
export function isChatRoomAgentDisplayName(value: unknown): value is string {
  return canonicalizeChatRoomAgentDisplayName(value) !== undefined
}

/** 规范化聊天室 Agent 名称；边界空白遵循 Unicode White_Space 加 BOM。 */
export function canonicalizeChatRoomAgentDisplayName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  if (Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0)
    return codePoint !== undefined && (
      codePoint <= 0x1f
      || (codePoint >= 0x7f && codePoint <= 0x9f)
      || (codePoint >= 0xd800 && codePoint <= 0xdfff)
    )
  })) return undefined
  const canonical = value.replace(/^[\p{White_Space}\uFEFF]+|[\p{White_Space}\uFEFF]+$/gu, '')
  if (canonical.length === 0 || new TextEncoder().encode(canonical).byteLength > 128) return undefined
  return canonical
}

function isArrayIndexKey(key: string): boolean {
  const index = Number(key)
  return Number.isSafeInteger(index) && index >= 0 && index < 2 ** 32 - 1 && String(index) === key
}

/** 只接受没有 holes 且没有自定义属性的普通数组。 */
function isDenseArray(value: unknown): value is unknown[] {
  if (!Array.isArray(value)) return false
  for (const key of Reflect.ownKeys(value)) {
    if (key === 'length') continue
    if (typeof key !== 'string' || !isArrayIndexKey(key) || Number(key) >= value.length) return false
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, String(index))) return false
  }
  return true
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isContextMessageCount(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= CHATROOM_MAX_CONTEXT_MESSAGES
  )
}

function hasOptionalValue(value: Record<string, unknown>, key: string, guard: (value: unknown) => boolean): boolean {
  return !Object.prototype.hasOwnProperty.call(value, key) || guard(value[key])
}

function isInputRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!isRecord(value)) return false
  const allowed = new Set(keys)
  return Reflect.ownKeys(value).every((key) => typeof key === 'string' && allowed.has(key))
}

function isBoundedIdArray(value: unknown, maxLength: number): value is string[] {
  return isDenseArray(value) && value.length <= maxLength && value.every((item) => isBoundedId(item))
}

function isSender(value: unknown): value is ChatRoomSender {
  if (!isRecord(value) || !hasExactKeys(value, ['type', 'id', 'displayName'])) return false
  return (value.type === 'user' || value.type === 'agent') && isBoundedId(value.id) && isChatRoomAgentDisplayName(value.displayName)
}

function sameSender(left: ChatRoomSender, right: ChatRoomSender): boolean {
  return left.type === right.type && left.id === right.id && left.displayName === right.displayName
}

/** 结构化输出必须是固定三字段对象，避免把内部字段传回聊天室。 */
export function isChatRoomAgentOutput(value: unknown): value is ChatRoomAgentOutput {
  if (!isRecord(value) || !hasExactKeys(value, ['text', 'mentionedAgentIds', 'attachmentIds'])) return false
  return (
    isBoundedText(value.text, CHATROOM_MAX_OUTPUT_TEXT_LENGTH) &&
    isBoundedIdArray(value.mentionedAgentIds, CHATROOM_MAX_AGENTS) &&
    isBoundedIdArray(value.attachmentIds, CHATROOM_MAX_ATTACHMENT_IDS)
  )
}

/** 将用户设置限制在协议允许的上下文消息数量。 */
export function normalizeChatRoomContextMessageCount(value: unknown): number {
  if (value === undefined) return CHATROOM_DEFAULT_CONTEXT_MESSAGES
  if (typeof value !== 'number' || !Number.isFinite(value)) return CHATROOM_DEFAULT_CONTEXT_MESSAGES
  return Math.min(CHATROOM_MAX_CONTEXT_MESSAGES, Math.max(1, Math.floor(value)))
}

function isInvocationChain(value: unknown): value is ChatRoomInvocationChainEntry[] {
  return (
    isDenseArray(value) &&
    value.length <= CHATROOM_MAX_DEPTH &&
    value.every((entry) => {
      if (!isRecord(entry) || !hasExactKeys(entry, ['agentId', 'invocationId'])) return false
      return isBoundedId(entry.agentId) && isBoundedId(entry.invocationId)
    })
  )
}

function isContextMessage(value: unknown): value is ChatRoomContextMessage {
  if (!isRecord(value)) return false
  const keys = ['messageId', 'sender', 'text', 'createdAt', 'attachmentIds', 'mentionedAgentIds', 'invocationChain']
  if (!Reflect.ownKeys(value).every((key) => typeof key === 'string' && keys.includes(key))) return false
  if (!hasRequiredKeys(value, ['messageId', 'sender', 'text', 'createdAt'])) return false
  return (
    isBoundedId(value.messageId) &&
    isSender(value.sender) &&
    isBoundedText(value.text, CHATROOM_MAX_OUTPUT_TEXT_LENGTH) &&
    isNonNegativeSafeInteger(value.createdAt) &&
    hasOptionalValue(value, 'attachmentIds', (item) => isBoundedIdArray(item, CHATROOM_MAX_ATTACHMENT_IDS)) &&
    hasOptionalValue(value, 'mentionedAgentIds', (item) => isBoundedIdArray(item, CHATROOM_MAX_AGENTS)) &&
    hasOptionalValue(value, 'invocationChain', isInvocationChain)
  )
}

/** Rust bridge 入站校验使用的严格 invocation 判断器。 */
export function isChatRoomAgentInvocation(value: unknown): value is ChatRoomAgentInvocation {
  if (!isRecord(value)) return false
  const keys = ['invocationId', 'roomId', 'traceId', 'targetAgentId', 'triggerMessageId', 'depth', 'sender', 'messages', 'receivedAt']
  if (!hasExactKeys(value, keys)) return false
  return (
    isBoundedId(value.invocationId) &&
    isBoundedId(value.roomId) &&
    isBoundedId(value.traceId) &&
    isBoundedId(value.targetAgentId) &&
    isBoundedId(value.triggerMessageId) &&
    typeof value.depth === 'number' &&
    Number.isInteger(value.depth) &&
    value.depth >= 0 &&
    value.depth <= CHATROOM_MAX_DEPTH &&
    isSender(value.sender) &&
    isDenseArray(value.messages) &&
    value.messages.length >= 1 &&
    value.messages.length <= CHATROOM_MAX_CONTEXT_MESSAGES &&
    value.messages.every((message) => isContextMessage(message)) &&
    (value.messages[value.messages.length - 1] as ChatRoomContextMessage).messageId === value.triggerMessageId &&
    sameSender(value.messages[value.messages.length - 1]!.sender, value.sender) &&
    isNonNegativeSafeInteger(value.receivedAt)
  )
}

/** Renderer -> Main：创建聊天室 Agent 的严格输入校验。 */
export function isProvisionChatRoomAgentInput(value: unknown): value is ProvisionChatRoomAgentInput {
  const keys = [
    'roomId',
    'sourceWorkspaceId',
    'displayName',
    'channelId',
    'modelId',
    'contextMessageCount',
    'memorySharingEnabled',
    'skillSharingEnabled',
  ] as const
  if (!isInputRecord(value, keys) || !hasRequiredKeys(value, ['roomId', 'sourceWorkspaceId', 'displayName', 'channelId'])) return false
  return (
    isBoundedId(value.roomId) &&
    isBoundedId(value.sourceWorkspaceId) &&
    isChatRoomAgentDisplayName(value.displayName) &&
    isBoundedId(value.channelId) &&
    hasOptionalValue(value, 'modelId', isBoundedId) &&
    hasOptionalValue(value, 'contextMessageCount', isContextMessageCount) &&
    hasOptionalValue(value, 'memorySharingEnabled', (item) => typeof item === 'boolean') &&
    hasOptionalValue(value, 'skillSharingEnabled', (item) => typeof item === 'boolean')
  )
}

/** Renderer -> Main：更新聊天室 Agent 的严格输入校验。 */
export function isUpdateChatRoomAgentInput(value: unknown): value is UpdateChatRoomAgentInput {
  const updateKeys = [
    'displayName',
    'channelId',
    'modelId',
    'contextMessageCount',
    'memorySharingEnabled',
    'skillSharingEnabled',
  ] as const
  const keys = ['roomId', 'roomAgentId', ...updateKeys] as const
  if (!isInputRecord(value, keys) || !hasRequiredKeys(value, ['roomId', 'roomAgentId'])) return false
  const hasUpdate = updateKeys.some((key) => Object.prototype.hasOwnProperty.call(value, key))
  return (
    hasUpdate &&
    isBoundedId(value.roomId) &&
    isBoundedId(value.roomAgentId) &&
    hasOptionalValue(value, 'displayName', isChatRoomAgentDisplayName) &&
    hasOptionalValue(value, 'channelId', isBoundedId) &&
    hasOptionalValue(value, 'modelId', isBoundedId) &&
    hasOptionalValue(value, 'contextMessageCount', isContextMessageCount) &&
    hasOptionalValue(value, 'memorySharingEnabled', (item) => typeof item === 'boolean') &&
    hasOptionalValue(value, 'skillSharingEnabled', (item) => typeof item === 'boolean')
  )
}

/** Renderer -> Main：归档 Agent 的严格输入校验。 */
export function isRemoveChatRoomAgentInput(value: unknown): value is RemoveChatRoomAgentInput {
  if (!isInputRecord(value, ['roomId', 'roomAgentId']) || !hasExactKeys(value, ['roomId', 'roomAgentId'])) return false
  return isBoundedId(value.roomId) && isBoundedId(value.roomAgentId)
}

/** Renderer -> Main：同步 Agent Skill 快照的严格输入校验。 */
export function isSyncChatRoomAgentSkillsInput(value: unknown): value is SyncChatRoomAgentSkillsInput {
  if (!isInputRecord(value, ['roomId', 'roomAgentId']) || !hasExactKeys(value, ['roomId', 'roomAgentId'])) return false
  return isBoundedId(value.roomId) && isBoundedId(value.roomAgentId)
}

/** Renderer -> Main：主理人权限响应的严格输入校验，不接受 alwaysAllow 等扩展字段。 */
export function isChatRoomPermissionResponse(value: unknown): value is ChatRoomPermissionResponse {
  if (!isInputRecord(value, ['requestId', 'behavior']) || !hasExactKeys(value, ['requestId', 'behavior'])) return false
  return isBoundedId(value.requestId) && (value.behavior === 'allow' || value.behavior === 'deny')
}
