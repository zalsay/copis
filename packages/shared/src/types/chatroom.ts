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
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = new Set(keys)
  return Object.keys(value).every((key) => expected.has(key)) && keys.every((key) => key in value)
}

function isBoundedId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= CHATROOM_MAX_ID_LENGTH
}

function isBoundedText(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length <= maxLength
}

function isBoundedIdArray(value: unknown, maxLength: number): value is string[] {
  return Array.isArray(value) && value.length <= maxLength && value.every((item) => isBoundedId(item))
}

function isSender(value: unknown): value is ChatRoomSender {
  if (!isRecord(value) || !hasExactKeys(value, ['type', 'id', 'displayName'])) return false
  return (value.type === 'user' || value.type === 'agent') && isBoundedId(value.id) && isBoundedText(value.displayName, CHATROOM_MAX_ID_LENGTH)
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
    Array.isArray(value) &&
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
  if (!Object.keys(value).every((key) => keys.includes(key))) return false
  if (!('messageId' in value) || !('sender' in value) || !('text' in value) || !('createdAt' in value)) return false
  return (
    isBoundedId(value.messageId) &&
    isSender(value.sender) &&
    isBoundedText(value.text, CHATROOM_MAX_OUTPUT_TEXT_LENGTH) &&
    typeof value.createdAt === 'number' &&
    Number.isFinite(value.createdAt) &&
    (value.attachmentIds === undefined || isBoundedIdArray(value.attachmentIds, CHATROOM_MAX_ATTACHMENT_IDS)) &&
    (value.mentionedAgentIds === undefined || isBoundedIdArray(value.mentionedAgentIds, CHATROOM_MAX_AGENTS)) &&
    (value.invocationChain === undefined || isInvocationChain(value.invocationChain))
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
    Array.isArray(value.messages) &&
    value.messages.length <= CHATROOM_MAX_CONTEXT_MESSAGES &&
    value.messages.every((message) => isContextMessage(message)) &&
    typeof value.receivedAt === 'number' &&
    Number.isFinite(value.receivedAt)
  )
}
