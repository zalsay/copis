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
} as const

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
}

export interface ChatRoomRustApi {
  reportAccepted(input: { invocationId: string }): Promise<void>
  reportRunning(input: { invocationId: string }): Promise<void>
  reportDelta(input: { invocationId: string; delta: string }): Promise<void>
  reportCompleted(input: { invocationId: string; output: ChatRoomAgentOutput }): Promise<void>
  reportFailed(input: {
    invocationId: string
    code: ChatRoomInvocationFailureCode
    message: string
  }): Promise<void>
  releaseAgentLeases(input: {
    roomAgentIds: string[]
    reason: 'logout' | 'gateway_disconnected' | 'app_quit'
  }): Promise<void>
}

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
  if (typeof value !== 'string' || value.trim().length === 0) return false
  if (new TextEncoder().encode(value.trim()).byteLength > 128) return false
  return !Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0)
    return codePoint !== undefined && (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f))
  })
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
