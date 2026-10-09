import { randomUUID } from 'node:crypto'
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  rmdirSync,
} from 'node:fs'
import { join } from 'node:path'
import {
  CHATROOM_DEFAULT_CONTEXT_MESSAGES,
  CHATROOM_MAX_AGENTS,
  CHATROOM_MAX_CONTEXT_MESSAGES,
  CHATROOM_MAX_DEPTH,
  CHATROOM_MAX_ID_LENGTH,
  CHATROOM_MAX_OUTPUT_TEXT_LENGTH,
  CHATROOM_MAX_TERMINAL_INVOCATIONS,
  CHATROOM_TERMINAL_RETENTION_MS,
  canonicalizeChatRoomAgentDisplayName,
  isChatRoomAgentDisplayName,
  normalizeChatRoomContextMessageCount,
  type ChatRoomAgentLocalConfig,
  type ChatRoomAgentOutput,
  type ChatRoomInvocationFailureCode,
  type ChatRoomInvocationRecord,
  type ChatRoomLocalIdentity,
  type ChatRoomLocalRoomConfig,
  type ProvisionChatRoomAgentInput,
  type UpdateChatRoomAgentInput,
  type RemoveChatRoomAgentInput,
} from '@copis/shared'
import {
  getChatRoomAgentPath,
  getChatRoomConfigPath,
  getChatRoomPath,
  getChatRoomAgentSkillsSnapshotPath,
  getChatRoomsRootPath,
} from './config-paths'
import {
  CHATROOM_CONFIG_MAX_BYTES,
  readJsonFileSafeDetailed,
  writeJsonFileAtomic,
  writeJsonFileAtomicDurable,
} from './safe-file'
import type { ChatRoomSkillSnapshotResult } from './chatroom-skill-snapshot'
import { computeChatRoomReplyDigest, normalizeChatRoomReplyOutput } from './chatroom-reply-digest'

interface ChatRoomWorkspaceStoreOptions {
  identity?: ChatRoomLocalIdentity
  now?: () => number
}

type StoreConstructorInput = ChatRoomWorkspaceStoreOptions | ChatRoomLocalIdentity
type PersistedRoomConfig = ChatRoomLocalRoomConfig & { version: 1 }

interface ChatRoomPendingResultBase {
  hostUserId: string
  deviceId: string
  roomId: string
  invocationId: string
  traceId: string
  targetAgentId: string
  triggerMessageId: string
  depth: number
  clientMessageId: string
  createdAt: number
}

export type ChatRoomPendingResultInput = ChatRoomPendingResultBase & (
  | { expectedStatus: 'completed'; output: ChatRoomAgentOutput; replyDigest: string; failureCode?: never }
  | { expectedStatus: 'failed'; failureCode: ChatRoomInvocationFailureCode; output?: never; replyDigest?: never }
)

export type ChatRoomPendingResultRecord = ChatRoomPendingResultInput & { recordRevision: string }

interface PersistedPendingResults {
  version: 1
  records: ChatRoomPendingResultRecord[]
}

const INVOCATION_STATUSES = new Set(['created', 'accepted', 'running', 'completed', 'failed', 'rejected'])
const INVOCATION_FAILURE_CODES = new Set([
  'room_not_found', 'room_archived', 'not_room_member', 'share_code_invalid', 'share_code_rate_limited',
  'agent_limit_reached', 'agent_offline', 'agent_busy', 'invocation_duplicate', 'invocation_depth_exceeded',
  'host_approval_timeout', 'host_approval_denied', 'attachment_not_ready', 'attachment_forbidden',
  'realtime_reconnecting', 'gateway_disconnected', 'app_quit', 'invalid_invocation', 'invalid_output',
  'room_agent_not_found', 'internal_error',
] satisfies ChatRoomInvocationFailureCode[])
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'rejected'])
const CHATROOM_COMPONENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const PENDING_RESULTS_FILE = 'pending-results.json'
const PENDING_RESULTS_MAX_RECORDS = 32
const PENDING_RESULT_MAX_BYTES = 192 * 1024
const PENDING_RESULTS_MAX_BYTES = 3 * 1024 * 1024

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional])
  const keys = Object.keys(value)
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key))
    && keys.every((key) => allowed.has(key))
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= CHATROOM_MAX_ID_LENGTH
}

function isPathComponent(value: unknown): value is string {
  return typeof value === 'string' && CHATROOM_COMPONENT_PATTERN.test(value)
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.length <= CHATROOM_MAX_OUTPUT_TEXT_LENGTH
}

function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isContextCount(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 1
    && value <= CHATROOM_MAX_CONTEXT_MESSAGES
}

function isTerminal(status: string): boolean {
  return TERMINAL_STATUSES.has(status)
}

function sameContent(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function clone<T>(value: T): T {
  if (value === undefined) return value
  return JSON.parse(JSON.stringify(value)) as T
}

function identityMatches(left: ChatRoomLocalIdentity, right: ChatRoomLocalIdentity): boolean {
  return left.hostUserId === right.hostUserId && left.deviceId === right.deviceId
}

function assertIdentity(identity: ChatRoomLocalIdentity): void {
  if (!isId(identity.hostUserId) || !isId(identity.deviceId)) throw new Error('identity_invalid')
}

function validatePendingResult(value: unknown, stored: boolean): asserts value is ChatRoomPendingResultInput | ChatRoomPendingResultRecord {
  if (!isRecord(value)) throw new Error('invalid_pending_result')
  const common = ['hostUserId', 'deviceId', 'roomId', 'invocationId', 'traceId', 'targetAgentId', 'triggerMessageId', 'depth', 'clientMessageId', 'createdAt']
  const revision = stored ? ['recordRevision'] : []
  if (value.expectedStatus === 'completed') {
    if (!hasExactKeys(value, [...common, 'expectedStatus', 'output', 'replyDigest', ...revision])
      || !isId(value.hostUserId) || !isId(value.deviceId) || !isPathComponent(value.roomId)
      || !isId(value.invocationId) || !isId(value.traceId) || !isPathComponent(value.targetAgentId)
      || !isId(value.triggerMessageId) || !Number.isSafeInteger(value.depth) || Number(value.depth) < 0
      || Number(value.depth) > CHATROOM_MAX_DEPTH || !isId(value.clientMessageId) || !isTimestamp(value.createdAt)
      || (stored && !isId(value.recordRevision)) || !isRecord(value.output)
      || !hasExactKeys(value.output, ['text', 'attachmentIds', 'mentionedAgentIds'])
      || typeof value.output.text !== 'string'
      || !Array.isArray(value.output.attachmentIds) || !Array.isArray(value.output.mentionedAgentIds)
      || !/^[a-f0-9]{64}$/u.test(String(value.replyDigest))) {
      throw new Error('invalid_pending_result')
    }
    const normalizedOutput = normalizeChatRoomReplyOutput(value.output as unknown as ChatRoomAgentOutput)
    if (Buffer.byteLength(normalizedOutput.text, 'utf8') > PENDING_RESULT_MAX_BYTES) {
      throw new Error('pending_result_too_large')
    }
    if (computeChatRoomReplyDigest({ clientMessageId: value.clientMessageId, ...normalizedOutput }) !== value.replyDigest) {
      throw new Error('invalid_pending_result_digest')
    }
    return
  }
  if (value.expectedStatus === 'failed'
    && hasExactKeys(value, [...common, 'expectedStatus', 'failureCode', ...revision])
    && isId(value.hostUserId) && isId(value.deviceId) && isPathComponent(value.roomId)
    && isId(value.invocationId) && isId(value.traceId) && isPathComponent(value.targetAgentId)
    && isId(value.triggerMessageId) && Number.isSafeInteger(value.depth) && Number(value.depth) >= 0
    && Number(value.depth) <= CHATROOM_MAX_DEPTH && isId(value.clientMessageId) && isTimestamp(value.createdAt)
    && typeof value.failureCode === 'string'
    && INVOCATION_FAILURE_CODES.has(value.failureCode as ChatRoomInvocationFailureCode)
    && (!stored || isId(value.recordRevision))) {
    return
  }
  throw new Error('invalid_pending_result')
}

function normalizePendingInput(input: ChatRoomPendingResultInput): ChatRoomPendingResultInput {
  validatePendingResult(input, false)
  const metadata: ChatRoomPendingResultBase = {
    hostUserId: input.hostUserId,
    deviceId: input.deviceId,
    roomId: input.roomId,
    invocationId: input.invocationId,
    traceId: input.traceId,
    targetAgentId: input.targetAgentId,
    triggerMessageId: input.triggerMessageId,
    depth: input.depth,
    clientMessageId: input.clientMessageId,
    createdAt: input.createdAt,
  }
  if (input.expectedStatus === 'failed') return { ...metadata, expectedStatus: 'failed', failureCode: input.failureCode }
  if (Buffer.byteLength(input.output.text, 'utf8') > PENDING_RESULT_MAX_BYTES) {
    throw new Error('pending_result_too_large')
  }
  const output = normalizeChatRoomReplyOutput(input.output)
  const normalized: ChatRoomPendingResultInput = {
    ...metadata,
    expectedStatus: 'completed',
    output,
    replyDigest: input.replyDigest,
  }
  validatePendingResult(normalized, false)
  if (Buffer.byteLength(JSON.stringify(normalized), 'utf8') > PENDING_RESULT_MAX_BYTES) {
    throw new Error('pending_result_too_large')
  }
  return normalized
}

function withoutRecordRevision(record: ChatRoomPendingResultRecord): ChatRoomPendingResultInput {
  const { recordRevision: _revision, ...input } = record
  return input
}

function pendingDeliveryKey(record: Pick<ChatRoomPendingResultInput, 'targetAgentId' | 'clientMessageId'>): string {
  return JSON.stringify([record.targetAgentId, record.clientMessageId])
}

function assertDirectory(path: string, label: string): void {
  let stats
  try {
    stats = lstatSync(path)
  } catch (error) {
    throw new Error(`${label}_path_unavailable`, { cause: error })
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) throw new Error(`${label}_path_not_directory`)
}

function ensureDirectory(parent: string, name: string, label: string, created?: string[]): string {
  assertDirectory(parent, `${label}_parent`)
  const path = join(parent, name)
  let wasCreated = false
  try {
    lstatSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    mkdirSync(path)
    wasCreated = true
  }
  if (wasCreated) created?.push(path)
  assertDirectory(path, label)
  return path
}

function rollbackDirectories(created: string[]): void {
  for (const path of [...created].reverse()) {
    try {
      const stats = lstatSync(path)
      if (stats.isDirectory()) rmdirSync(path)
    } catch {
      // 回滚只处理本次创建且仍为空的目录，保留其他进程或用户内容。
    }
  }
}

function assertOptionalRegularFile(path: string, label: string): void {
  let stats
  try {
    stats = lstatSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw new Error(`${label}_path_unavailable`, { cause: error })
  }
  if (!stats.isFile()) throw new Error(`${label}_path_not_file`)
}

function validateAgent(value: unknown): asserts value is ChatRoomAgentLocalConfig {
  if (!isRecord(value) || !hasExactKeys(value,
    ['roomAgentId', 'displayName', 'sourceWorkspaceId', 'sessionId', 'channelId', 'contextMessageCount', 'memorySharingEnabled', 'skillSharingEnabled'],
    ['modelId', 'skillSnapshotDigest', 'archivedAt'])) {
    throw new Error('invalid_room_config')
  }
  const canonicalDisplayName = canonicalizeChatRoomAgentDisplayName(value.displayName)
  if (!isPathComponent(value.roomAgentId) || canonicalDisplayName === undefined
    || !isId(value.sourceWorkspaceId) || !isId(value.sessionId)
    || !isId(value.channelId) || !isContextCount(value.contextMessageCount)
    || typeof value.memorySharingEnabled !== 'boolean' || typeof value.skillSharingEnabled !== 'boolean') {
    throw new Error('invalid_room_config')
  }
  value.displayName = canonicalDisplayName
  if (Object.prototype.hasOwnProperty.call(value, 'modelId') && value.modelId !== undefined && !isId(value.modelId)) {
    throw new Error('invalid_room_config')
  }
  if (Object.prototype.hasOwnProperty.call(value, 'skillSnapshotDigest')
    && value.skillSnapshotDigest !== undefined && !isText(value.skillSnapshotDigest)) {
    throw new Error('invalid_room_config')
  }
  if (Object.prototype.hasOwnProperty.call(value, 'archivedAt')
    && value.archivedAt !== undefined && !isTimestamp(value.archivedAt)) {
    throw new Error('invalid_room_config')
  }
}

function validateInvocation(value: unknown, expectedRoomId: string): asserts value is ChatRoomInvocationRecord {
  if (!isRecord(value) || !hasExactKeys(value,
    ['invocationId', 'roomId', 'traceId', 'targetAgentId', 'triggerMessageId', 'depth', 'status', 'createdAt', 'updatedAt'],
    ['acceptedAt', 'startedAt', 'finishedAt', 'failureCode', 'failureMessage'])) {
    throw new Error('invalid_room_config')
  }
  if (!isId(value.invocationId) || value.roomId !== expectedRoomId || !isId(value.traceId)
    || !isId(value.targetAgentId) || !isId(value.triggerMessageId)
    || typeof value.depth !== 'number' || !Number.isSafeInteger(value.depth) || value.depth < 0 || value.depth > CHATROOM_MAX_DEPTH
    || typeof value.status !== 'string' || !INVOCATION_STATUSES.has(value.status)
    || !isTimestamp(value.createdAt) || !isTimestamp(value.updatedAt) || value.updatedAt < value.createdAt) {
    throw new Error('invalid_room_config')
  }
  const timestampFields = ['acceptedAt', 'startedAt', 'finishedAt'] as const
  let previous = value.createdAt
  for (const field of timestampFields) {
    const item = value[field]
    if (item === undefined) continue
    if (!isTimestamp(item) || item < previous || item > value.updatedAt) throw new Error('invalid_room_config')
    previous = item
  }
  if (value.startedAt !== undefined && value.acceptedAt === undefined) throw new Error('invalid_room_config')
  if (value.failureCode !== undefined && (typeof value.failureCode !== 'string'
    || !INVOCATION_FAILURE_CODES.has(value.failureCode as ChatRoomInvocationFailureCode))) {
    throw new Error('invalid_room_config')
  }
  if (value.failureMessage !== undefined && !isText(value.failureMessage)) throw new Error('invalid_room_config')
  const hasFailure = value.failureCode !== undefined || value.failureMessage !== undefined
  switch (value.status) {
    case 'created':
      if (value.acceptedAt !== undefined || value.startedAt !== undefined || value.finishedAt !== undefined || hasFailure) {
        throw new Error('invalid_room_config')
      }
      break
    case 'accepted':
      if (value.acceptedAt === undefined || value.startedAt !== undefined || value.finishedAt !== undefined || hasFailure) {
        throw new Error('invalid_room_config')
      }
      break
    case 'running':
      if (value.acceptedAt === undefined || value.startedAt === undefined || value.finishedAt !== undefined || hasFailure) {
        throw new Error('invalid_room_config')
      }
      break
    case 'completed':
      if (value.finishedAt === undefined || hasFailure) throw new Error('invalid_room_config')
      break
    case 'failed':
    case 'rejected':
      if (value.finishedAt === undefined || typeof value.failureCode !== 'string'
        || typeof value.failureMessage !== 'string' || value.failureMessage.length === 0) {
        throw new Error('invalid_room_config')
      }
      break
  }
}

function validateConfig(value: unknown, expectedRoomId: string, expectedIdentity?: ChatRoomLocalIdentity): asserts value is PersistedRoomConfig {
  if (!isRecord(value) || !hasExactKeys(value,
    ['version', 'roomId', 'hostUserId', 'deviceId', 'lastProcessedSeq', 'agents', 'invocations', 'createdAt', 'updatedAt'])) {
    throw new Error('invalid_room_config')
  }
  if (value.version !== 1 || value.roomId !== expectedRoomId || !isId(value.hostUserId) || !isId(value.deviceId)
    || !isTimestamp(value.createdAt) || !isTimestamp(value.updatedAt) || value.updatedAt < value.createdAt
    || typeof value.lastProcessedSeq !== 'number' || !Number.isSafeInteger(value.lastProcessedSeq) || value.lastProcessedSeq < 0
    || !Array.isArray(value.agents) || !Array.isArray(value.invocations)
    || value.agents.filter((agent) => isRecord(agent) && agent.archivedAt === undefined).length > CHATROOM_MAX_AGENTS) {
    throw new Error('invalid_room_config')
  }
  if (expectedIdentity && !identityMatches(expectedIdentity, { hostUserId: value.hostUserId, deviceId: value.deviceId })) {
    throw new Error('identity_mismatch')
  }
  const agentIds = new Set<string>()
  const sessionIds = new Set<string>()
  const displayNames = new Set<string>()
  for (const agent of value.agents) {
    validateAgent(agent)
    if (agentIds.has(agent.roomAgentId)) throw new Error('duplicate_room_agent_id')
    if (sessionIds.has(agent.sessionId)) throw new Error('duplicate_session_id')
    const displayName = agent.displayName.trim().toLowerCase()
    if (agent.archivedAt === undefined && displayNames.has(displayName)) throw new Error('display_name_conflict')
    agentIds.add(agent.roomAgentId)
    sessionIds.add(agent.sessionId)
    if (agent.archivedAt === undefined) displayNames.add(displayName)
  }
  const invocationIds = new Set<string>()
  for (const invocation of value.invocations) {
    validateInvocation(invocation, expectedRoomId)
    if (!agentIds.has(invocation.targetAgentId)) throw new Error('room_agent_not_found')
    if (invocationIds.has(invocation.invocationId)) throw new Error('duplicate_invocation_id')
    invocationIds.add(invocation.invocationId)
  }
}

function normalizeInvocations(records: ChatRoomInvocationRecord[], now: number): ChatRoomInvocationRecord[] {
  const cutoff = now - CHATROOM_TERMINAL_RETENTION_MS
  const active = records.filter((record) => !isTerminal(record.status))
  const terminal = records
    .filter((record) => isTerminal(record.status) && (record.finishedAt ?? record.updatedAt) >= cutoff)
    .sort((left, right) => (right.finishedAt ?? right.updatedAt) - (left.finishedAt ?? left.updatedAt))
    .slice(0, CHATROOM_MAX_TERMINAL_INVOCATIONS)
  return [...active, ...terminal]
}

export class ChatRoomWorkspaceStore {
  private expectedIdentity?: ChatRoomLocalIdentity
  private readonly now: () => number

  constructor(input: StoreConstructorInput = {}) {
    if ('hostUserId' in input && 'deviceId' in input) {
      assertIdentity(input)
      this.expectedIdentity = { ...input }
      this.now = 'now' in input && typeof input.now === 'function' ? input.now as () => number : () => Date.now()
      return
    }
    if (input.identity) {
      assertIdentity(input.identity)
      this.expectedIdentity = { ...input.identity }
    }
    this.now = input.now ?? (() => Date.now())
  }

  read(roomId: string): ChatRoomLocalRoomConfig | undefined {
    return this.load(roomId, this.now())
  }

  list(): ChatRoomLocalRoomConfig[] {
    const roomsRoot = getChatRoomsRootPath()
    const result: ChatRoomLocalRoomConfig[] = []
    for (const entry of readdirSync(roomsRoot)) {
      const path = join(roomsRoot, entry)
      assertDirectory(path, '聊天室')
      try {
        const config = this.read(entry)
        if (config) result.push(config)
      } catch (error) {
        if (error instanceof Error && error.message === 'identity_mismatch') continue
        throw error
      }
    }
    return result
  }

  /** 生命周期批量处理：隔离坏房间，不能阻止其他房间续租或断线清理。 */
  listRestorableRooms(): ChatRoomLocalRoomConfig[] {
    const roomsRoot = getChatRoomsRootPath()
    const result: ChatRoomLocalRoomConfig[] = []
    for (const entry of readdirSync(roomsRoot)) {
      try {
        assertDirectory(join(roomsRoot, entry), '聊天室')
        const config = this.read(entry)
        if (config) result.push(config)
      } catch (error) {
        if (!(error instanceof Error && error.message === 'identity_mismatch')) console.warn('[聊天室] 跳过损坏的本地房间配置')
      }
    }
    return result
  }

  provisionAgent(identity: ChatRoomLocalIdentity, input: ProvisionChatRoomAgentInput, serverAgentId?: string, options?: { roomCreatedAt?: number }): ChatRoomLocalRoomConfig {
    assertIdentity(identity)
    if (serverAgentId !== undefined && !isPathComponent(serverAgentId)) throw new Error('invalid_agent_input')
    if (options?.roomCreatedAt !== undefined && !isTimestamp(options.roomCreatedAt)) throw new Error('invalid_management_operation_room_identity')
    if (this.expectedIdentity && !identityMatches(this.expectedIdentity, identity)) throw new Error('identity_mismatch')
    if (!isPathComponent(input.roomId) || !isId(input.sourceWorkspaceId)
      || !isChatRoomAgentDisplayName(input.displayName) || !isId(input.channelId)) {
      throw new Error('invalid_agent_input')
    }
    if (input.contextMessageCount !== undefined && !isContextCount(input.contextMessageCount)) {
      throw new Error('invalid_context_message_count')
    }
    if (input.modelId !== undefined && !isId(input.modelId)) throw new Error('invalid_agent_input')
    if (input.memorySharingEnabled !== undefined && typeof input.memorySharingEnabled !== 'boolean') {
      throw new Error('invalid_agent_input')
    }
    if (input.skillSharingEnabled !== undefined && typeof input.skillSharingEnabled !== 'boolean') {
      throw new Error('invalid_agent_input')
    }
    const createdDirectories: string[] = []
    try {
      this.ensureRoomDirectories(input.roomId, createdDirectories)
      const previous = this.load(input.roomId, this.now())
      const timestamp = this.now()
      if (previous && options?.roomCreatedAt !== undefined && previous.createdAt !== options.roomCreatedAt) {
        throw new Error('management_operation_room_identity_mismatch')
      }
      const config: PersistedRoomConfig = previous ?? {
        version: 1,
        roomId: input.roomId,
        hostUserId: identity.hostUserId,
        deviceId: identity.deviceId,
        lastProcessedSeq: 0,
        agents: [],
        invocations: [],
        createdAt: options?.roomCreatedAt ?? timestamp,
        updatedAt: Math.max(timestamp, options?.roomCreatedAt ?? timestamp),
      }
      if (!identityMatches(identity, { hostUserId: config.hostUserId, deviceId: config.deviceId })) throw new Error('identity_mismatch')
      if (config.agents.filter((agent) => agent.archivedAt === undefined).length >= CHATROOM_MAX_AGENTS) throw new Error('agent_limit_reached')
      const canonicalDisplayName = canonicalizeChatRoomAgentDisplayName(input.displayName)
      if (!canonicalDisplayName) throw new Error('invalid_agent_input')
      const displayName = canonicalDisplayName.toLowerCase()
      if (config.agents.some((agent) => agent.archivedAt === undefined && agent.displayName.trim().toLowerCase() === displayName)) {
        throw new Error('display_name_conflict')
      }
      const roomAgentId = serverAgentId ?? `agent-${randomUUID()}`
      if (config.agents.some((agent) => agent.roomAgentId === roomAgentId)) throw new Error('duplicate_agent_id')
      const sessionId = `session-${randomUUID()}`
      const agent: ChatRoomAgentLocalConfig = {
        roomAgentId,
        displayName: canonicalDisplayName,
        sourceWorkspaceId: input.sourceWorkspaceId,
        sessionId,
        channelId: input.channelId,
        ...(input.modelId === undefined ? {} : { modelId: input.modelId }),
        contextMessageCount: input.contextMessageCount === undefined
          ? CHATROOM_DEFAULT_CONTEXT_MESSAGES
          : normalizeChatRoomContextMessageCount(input.contextMessageCount),
        memorySharingEnabled: input.memorySharingEnabled ?? false,
        skillSharingEnabled: input.skillSharingEnabled ?? false,
      }
      this.ensureAgentDirectories(input.roomId, roomAgentId, createdDirectories)
      const next: PersistedRoomConfig = { ...config, agents: [...config.agents, agent], updatedAt: timestamp }
      this.persist(config, next)
      if (!this.expectedIdentity) this.expectedIdentity = { ...identity }
      return clone(next)
    } catch (error) {
      rollbackDirectories(createdDirectories)
      throw error
    }
  }

  updateAgent(input: UpdateChatRoomAgentInput): ChatRoomLocalRoomConfig {
    if (!isPathComponent(input.roomId) || !isPathComponent(input.roomAgentId)) throw new Error('invalid_agent_input')
    if (input.contextMessageCount !== undefined && !isContextCount(input.contextMessageCount)) throw new Error('invalid_context_message_count')
    if (input.channelId !== undefined && !isId(input.channelId)) throw new Error('invalid_agent_input')
    if (input.modelId !== undefined && !isId(input.modelId)) throw new Error('invalid_agent_input')
    if (input.memorySharingEnabled !== undefined && typeof input.memorySharingEnabled !== 'boolean') {
      throw new Error('invalid_agent_input')
    }
    if (input.skillSharingEnabled !== undefined && typeof input.skillSharingEnabled !== 'boolean') {
      throw new Error('invalid_agent_input')
    }
    const current = this.load(input.roomId, this.now())
    if (!current) throw new Error('room_not_found')
    const index = current.agents.findIndex((agent) => agent.roomAgentId === input.roomAgentId)
    if (index < 0) throw new Error('room_agent_not_found')
    const existingAgent = current.agents[index]!
    const nextAgent: ChatRoomAgentLocalConfig = { ...existingAgent }
    if (input.displayName !== undefined) {
      if (!isChatRoomAgentDisplayName(input.displayName)) throw new Error('invalid_agent_input')
      if (current.agents.some((agent, candidateIndex) => candidateIndex !== index && agent.archivedAt === undefined
        && agent.displayName.trim().toLowerCase() === input.displayName!.trim().toLowerCase())) {
        throw new Error('display_name_conflict')
      }
      nextAgent.displayName = canonicalizeChatRoomAgentDisplayName(input.displayName)!
    }
    for (const key of ['channelId', 'modelId', 'contextMessageCount', 'memorySharingEnabled', 'skillSharingEnabled'] as const) {
      if (input[key] !== undefined) (nextAgent as unknown as Record<string, unknown>)[key] = input[key]
    }
    const agents = [...current.agents]
    agents[index] = nextAgent
    if (sameContent(current.agents, agents)) return clone(current)
    const next = { ...current, agents, updatedAt: this.now() }
    this.persist(current, next)
    return clone(next)
  }

  /** 仅在 Skill 快照完成原子替换后记录摘要；不把快照路径写入 room.json。 */
  updateAgentSkillSnapshot(roomId: string, roomAgentId: string, result: ChatRoomSkillSnapshotResult): ChatRoomLocalRoomConfig {
    if (!isPathComponent(roomId) || !isPathComponent(roomAgentId)
      || typeof result !== 'object' || result === null
      || result.snapshotPath !== getChatRoomAgentSkillsSnapshotPath(roomId, roomAgentId)
      || typeof result.digest !== 'string' || !/^[a-f0-9]{64}$/.test(result.digest)
      || !Array.isArray(result.skillSlugs)
      || result.skillSlugs.some((slug) => !isPathComponent(slug))
      || typeof result.syncedAt !== 'number' || !Number.isSafeInteger(result.syncedAt) || result.syncedAt < 0) {
      throw new Error('invalid_skill_snapshot')
    }
    assertDirectory(result.snapshotPath, '聊天室 Agent skills-snapshot')
    let actualDigest: string
    try {
      const snapshot = require('./chatroom-skill-snapshot') as {
        computeChatRoomSkillSnapshotDigest(path: string): string
      }
      actualDigest = snapshot.computeChatRoomSkillSnapshotDigest(result.snapshotPath)
    } catch {
      throw new Error('invalid_skill_snapshot')
    }
    if (actualDigest !== result.digest) throw new Error('invalid_skill_snapshot')
    const current = this.load(roomId, this.now())
    if (!current) throw new Error('room_not_found')
    const index = current.agents.findIndex((agent) => agent.roomAgentId === roomAgentId)
    if (index < 0) throw new Error('room_agent_not_found')
    const existing = current.agents[index]!
    if (existing.skillSnapshotDigest === result.digest) return clone(current)
    const agents = [...current.agents]
    agents[index] = { ...existing, skillSnapshotDigest: result.digest }
    const next = { ...current, agents, updatedAt: this.now() }
    this.persist(current, next, true)
    return clone(next)
  }

  archiveAgent(input: RemoveChatRoomAgentInput): ChatRoomLocalRoomConfig {
    const current = this.load(input.roomId, this.now())
    if (!current) throw new Error('room_not_found')
    const index = current.agents.findIndex((agent) => agent.roomAgentId === input.roomAgentId)
    if (index < 0) throw new Error('room_agent_not_found')
    if (current.agents[index]!.archivedAt !== undefined) return clone(current)
    const agents = [...current.agents]
    agents[index] = { ...agents[index]!, archivedAt: this.now() }
    const next = { ...current, agents, updatedAt: this.now() }
    this.persist(current, next)
    return clone(next)
  }

  getAgent(roomId: string, roomAgentId: string): ChatRoomAgentLocalConfig | undefined {
    return clone(this.read(roomId)?.agents.find((agent) => agent.roomAgentId === roomAgentId))
  }

  getInvocation(roomId: string, invocationId: string): ChatRoomInvocationRecord | undefined {
    return clone(this.read(roomId)?.invocations.find((record) => record.invocationId === invocationId))
  }

  getTraceAgentInvocation(roomId: string, traceId: string, roomAgentId: string): ChatRoomInvocationRecord | undefined {
    return clone(this.read(roomId)?.invocations.find((record) => record.traceId === traceId && record.targetAgentId === roomAgentId))
  }

  /** 保存已净化的 terminal 候选；此处不代表服务端已确认。 */
  savePendingResult(input: ChatRoomPendingResultInput): ChatRoomPendingResultRecord {
    const normalized = normalizePendingInput(input)
    const room = this.requirePendingRoom(normalized.roomId)
    if (room.hostUserId !== normalized.hostUserId || room.deviceId !== normalized.deviceId) throw new Error('identity_mismatch')
    const current = this.readPendingResultsFile(normalized.roomId)
    const deliveryKey = pendingDeliveryKey(normalized)
    const sameKey = current.records.find((record) => record.invocationId === normalized.invocationId
      || pendingDeliveryKey(record) === deliveryKey)
    if (sameKey) {
      const { recordRevision: _revision, ...existing } = sameKey
      if (sameContent(existing, normalized)) return clone(sameKey)
      throw new Error('pending_result_conflict')
    }
    if (current.records.length >= PENDING_RESULTS_MAX_RECORDS) throw new Error('pending_results_full')
    const record = { ...normalized, recordRevision: randomUUID() } as ChatRoomPendingResultRecord
    const records = [...current.records, record]
    this.persistPendingResults(normalized.roomId, records)
    return clone(record)
  }

  listPendingResults(roomId: string): ChatRoomPendingResultRecord[] {
    this.requirePendingRoom(roomId)
    return clone(this.readPendingResultsFile(roomId).records)
  }

  /** Main coordinator 在 proof 后调用；旧快照不能删除后来重建的记录。 */
  removePendingResultIfUnchanged(expected: ChatRoomPendingResultRecord): boolean {
    validatePendingResult(expected, true)
    const room = this.requirePendingRoom(expected.roomId)
    if (room.hostUserId !== expected.hostUserId || room.deviceId !== expected.deviceId) throw new Error('identity_mismatch')
    const current = this.readPendingResultsFile(expected.roomId)
    const index = current.records.findIndex((record) => record.invocationId === expected.invocationId)
    if (index < 0 || !sameContent(current.records[index], expected)) return false
    const records = current.records.filter((_, recordIndex) => recordIndex !== index)
    this.persistPendingResults(expected.roomId, records)
    return true
  }

  upsertInvocation(roomId: string, record: ChatRoomInvocationRecord): ChatRoomInvocationRecord {
    const current = this.load(roomId, this.now())
    if (!current) throw new Error('room_not_found')
    validateInvocation(record, roomId)
    if (!current.agents.some((agent) => agent.roomAgentId === record.targetAgentId)) throw new Error('room_agent_not_found')
    const index = current.invocations.findIndex((item) => item.invocationId === record.invocationId)
    const traceConflict = current.invocations.find((item) => item.traceId === record.traceId
      && item.targetAgentId === record.targetAgentId && item.invocationId !== record.invocationId)
    if (traceConflict) throw new Error('invocation_duplicate')
    const invocations = [...current.invocations]
    if (index >= 0) {
      const previous = current.invocations[index]!
      if (previous.traceId !== record.traceId || previous.targetAgentId !== record.targetAgentId
        || previous.triggerMessageId !== record.triggerMessageId || previous.depth !== record.depth) {
        throw new Error('invocation_duplicate')
      }
      invocations[index] = clone(record)
    } else invocations.push(clone(record))
    const normalized = normalizeInvocations(invocations, this.now())
    const changed = !sameContent(current.invocations, normalized)
    const next = { ...current, invocations: normalized, updatedAt: changed ? this.now() : current.updatedAt }
    this.persist(current, next)
    return clone(normalized.find((item) => item.invocationId === record.invocationId) ?? record)
  }

  /**
   * 在一次 load/validate/persist 路径内完成 invocation 状态 CAS。
   * 返回 false 表示当前状态已被其它完成路径抢先转换，调用方不得继续上报。
   */
  transitionInvocation(
    roomId: string,
    invocationId: string,
    expectedStatuses: readonly ChatRoomInvocationRecord['status'][],
    update: (current: ChatRoomInvocationRecord) => ChatRoomInvocationRecord,
  ): { transitioned: boolean; record?: ChatRoomInvocationRecord } {
    const current = this.load(roomId, this.now())
    if (!current) throw new Error('room_not_found')
    const index = current.invocations.findIndex((item) => item.invocationId === invocationId)
    if (index < 0) return { transitioned: false }
    const previous = current.invocations[index]!
    if (!expectedStatuses.includes(previous.status)) return { transitioned: false, record: clone(previous) }
    const nextRecord = update(clone(previous))
    validateInvocation(nextRecord, roomId)
    const allowed: Record<ChatRoomInvocationRecord['status'], readonly ChatRoomInvocationRecord['status'][]> = {
      created: ['accepted', 'failed', 'rejected'],
      accepted: ['running', 'failed', 'rejected'],
      running: ['completed', 'failed'],
      completed: [],
      failed: [],
      rejected: [],
    }
    if (nextRecord.status === previous.status || !allowed[previous.status].includes(nextRecord.status)) {
      return { transitioned: false, record: clone(previous) }
    }
    if (nextRecord.invocationId !== previous.invocationId
      || nextRecord.traceId !== previous.traceId
      || nextRecord.targetAgentId !== previous.targetAgentId
      || nextRecord.triggerMessageId !== previous.triggerMessageId
      || nextRecord.depth !== previous.depth) {
      throw new Error('invocation_transition_identity_mismatch')
    }
    const invocations = [...current.invocations]
    invocations[index] = clone(nextRecord)
    const normalized = normalizeInvocations(invocations, this.now())
    const next = { ...current, invocations: normalized, updatedAt: this.now() }
    this.persist(current, next)
    return { transitioned: true, record: clone(nextRecord) }
  }

  compactInvocationRecords(roomId: string, now = this.now()): { terminalCount: number; records: ChatRoomInvocationRecord[] } {
    const current = this.load(roomId, now)
    if (!current) throw new Error('room_not_found')
    const records = current.invocations
    return { terminalCount: records.filter((record) => isTerminal(record.status)).length, records: clone(records) }
  }

  updateLastProcessedSeq(roomId: string, seq: number): void {
    if (!Number.isSafeInteger(seq) || seq < 0) throw new Error('invalid_sequence')
    const current = this.load(roomId, this.now())
    if (!current) throw new Error('room_not_found')
    if (current.lastProcessedSeq === seq) return
    this.persist(current, { ...current, lastProcessedSeq: seq, updatedAt: this.now() })
  }

  private load(roomId: string, now: number): PersistedRoomConfig | undefined {
    if (!isPathComponent(roomId)) throw new Error('invalid_room_id')
    const roomPath = getChatRoomPath(roomId)
    let stats
    try {
      stats = lstatSync(roomPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
    if (!stats.isDirectory()) throw new Error('room_path_not_directory')
    const agentsPath = join(roomPath, 'agents')
    assertDirectory(agentsPath, '聊天室 Agent 根')
    const configPath = getChatRoomConfigPath(roomId)
    this.assertConfigFiles(configPath)
    const result = readJsonFileSafeDetailed<unknown>(configPath, '聊天室配置', {
      maxBytes: CHATROOM_CONFIG_MAX_BYTES,
    })
    if (result.status === 'missing') return undefined
    if (result.status === 'corrupt' || result.value === null) throw new Error('room_config_unrecoverable')
    const raw = result.value
    validateConfig(raw, roomId, this.expectedIdentity)
    if (!this.expectedIdentity) {
      this.expectedIdentity = { hostUserId: raw.hostUserId, deviceId: raw.deviceId }
    }
    this.assertAgentDirectoryTree(roomPath, raw.agents)
    const normalizedInvocations = normalizeInvocations(raw.invocations, now)
    const normalized = sameContent(raw.invocations, normalizedInvocations)
      ? raw
      : { ...raw, invocations: normalizedInvocations, updatedAt: now }
    if (normalized !== raw) this.persist(raw, normalized)
    return clone(normalized)
  }

  private persist(previous: PersistedRoomConfig, next: PersistedRoomConfig, durable = false): void {
    validateConfig(next, next.roomId, this.expectedIdentity ?? { hostUserId: next.hostUserId, deviceId: next.deviceId })
    if (sameContent(previous, next)) return
    const roomPath = getChatRoomPath(next.roomId)
    assertDirectory(roomPath, '聊天室')
    this.assertAgentDirectoryTree(roomPath, next.agents)
    const configPath = getChatRoomConfigPath(next.roomId)
    this.assertConfigFiles(configPath)
    if (durable) writeJsonFileAtomicDurable(configPath, next, 0o600, false, CHATROOM_CONFIG_MAX_BYTES)
    else writeJsonFileAtomic(configPath, next, false, 0o600, CHATROOM_CONFIG_MAX_BYTES)
    assertDirectory(roomPath, '聊天室')
  }

  private assertConfigFiles(configPath: string): void {
    assertOptionalRegularFile(configPath, '聊天室配置')
    assertOptionalRegularFile(`${configPath}.tmp`, '聊天室配置临时文件')
    assertOptionalRegularFile(`${configPath}.bak`, '聊天室配置备份文件')
  }

  private requirePendingRoom(roomId: string): PersistedRoomConfig {
    if (!isPathComponent(roomId)) throw new Error('invalid_room_id')
    if (!this.expectedIdentity) throw new Error('identity_required')
    const room = this.load(roomId, this.now())
    if (!room) throw new Error('room_not_found')
    if (!identityMatches(this.expectedIdentity, { hostUserId: room.hostUserId, deviceId: room.deviceId })) {
      throw new Error('identity_mismatch')
    }
    return room
  }

  private pendingResultsPath(roomId: string): string {
    const roomPath = getChatRoomPath(roomId)
    assertDirectory(roomPath, '聊天室')
    return join(roomPath, PENDING_RESULTS_FILE)
  }

  private readPendingResultsFile(roomId: string): PersistedPendingResults {
    const path = this.pendingResultsPath(roomId)
    assertOptionalRegularFile(path, 'pending_results')
    assertOptionalRegularFile(`${path}.tmp`, 'pending_results_tmp')
    assertOptionalRegularFile(`${path}.bak`, 'pending_results_bak')
    const result = readJsonFileSafeDetailed<unknown>(path, '聊天室待确认结果', { maxBytes: PENDING_RESULTS_MAX_BYTES })
    if (result.status === 'missing') return { version: 1, records: [] }
    if (result.status === 'corrupt' || !isRecord(result.value) || result.value.version !== 1
      || !Array.isArray(result.value.records) || result.value.records.length > PENDING_RESULTS_MAX_RECORDS) {
      throw new Error('pending_results_unrecoverable')
    }
    const records: ChatRoomPendingResultRecord[] = []
    const invocationIds = new Set<string>()
    const deliveryKeys = new Set<string>()
    try {
      for (const entry of result.value.records) {
        validatePendingResult(entry, true)
        if (entry.roomId !== roomId || !this.expectedIdentity
          || entry.hostUserId !== this.expectedIdentity.hostUserId || entry.deviceId !== this.expectedIdentity.deviceId
          || invocationIds.has(entry.invocationId) || deliveryKeys.has(pendingDeliveryKey(entry))) {
          throw new Error('pending_result_scope_mismatch')
        }
        const storedEntry = entry as ChatRoomPendingResultRecord
        const normalized = normalizePendingInput(withoutRecordRevision(storedEntry))
        if (!sameContent(normalized, withoutRecordRevision(storedEntry))) throw new Error('pending_result_invalid')
        invocationIds.add(entry.invocationId)
        deliveryKeys.add(pendingDeliveryKey(entry))
        records.push(clone(storedEntry))
      }
      if (Buffer.byteLength(JSON.stringify({ version: 1, records }), 'utf8') > PENDING_RESULTS_MAX_BYTES) {
        throw new Error('pending_results_too_large')
      }
    } catch {
      throw new Error('pending_results_unrecoverable')
    }
    return { version: 1, records }
  }

  private persistPendingResults(roomId: string, records: ChatRoomPendingResultRecord[]): void {
    if (records.length > PENDING_RESULTS_MAX_RECORDS) throw new Error('pending_results_full')
    const path = this.pendingResultsPath(roomId)
    assertOptionalRegularFile(path, 'pending_results')
    assertOptionalRegularFile(`${path}.tmp`, 'pending_results_tmp')
    assertOptionalRegularFile(`${path}.bak`, 'pending_results_bak')
    const payload: PersistedPendingResults = { version: 1, records }
    if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > PENDING_RESULTS_MAX_BYTES) {
      throw new Error('pending_results_too_large')
    }
    writeJsonFileAtomicDurable(path, payload, 0o600, true, PENDING_RESULTS_MAX_BYTES)
    assertDirectory(getChatRoomPath(roomId), '聊天室')
  }

  private ensureRoomDirectories(roomId: string, created?: string[]): string {
    const roomsRoot = getChatRoomsRootPath()
    const roomPath = ensureDirectory(roomsRoot, roomId, '聊天室', created)
    ensureDirectory(roomPath, 'agents', '聊天室 Agent 根', created)
    return roomPath
  }

  private ensureAgentDirectories(roomId: string, roomAgentId: string, created?: string[]): void {
    const roomPath = this.ensureRoomDirectories(roomId, created)
    const agentsPath = join(roomPath, 'agents')
    const agentPath = ensureDirectory(agentsPath, roomAgentId, '聊天室 Agent', created)
    const sessions = ensureDirectory(agentPath, 'sessions', '聊天室 Agent sessions', created)
    const workspaceFiles = ensureDirectory(agentPath, 'workspace-files', '聊天室 Agent workspace-files', created)
    const project = ensureDirectory(workspaceFiles, 'project', '聊天室 Agent project', created)
    ensureDirectory(project, 'inbox', '聊天室 Agent inbox', created)
    ensureDirectory(agentPath, 'skills-snapshot', '聊天室 Agent skills-snapshot', created)
    assertDirectory(sessions, '聊天室 Agent sessions')
    assertDirectory(getChatRoomAgentPath(roomId, roomAgentId), '聊天室 Agent')
  }

  private assertAgentDirectoryTree(roomPath: string, agents: ChatRoomAgentLocalConfig[]): void {
    const agentsPath = join(roomPath, 'agents')
    assertDirectory(agentsPath, '聊天室 Agent 根')
    for (const agent of agents) {
      const agentPath = join(agentsPath, agent.roomAgentId)
      assertDirectory(agentPath, '聊天室 Agent')
      assertDirectory(join(agentPath, 'sessions'), '聊天室 Agent sessions')
      const project = join(agentPath, 'workspace-files', 'project')
      assertDirectory(join(agentPath, 'workspace-files'), '聊天室 Agent workspace-files')
      assertDirectory(project, '聊天室 Agent project')
      assertDirectory(join(project, 'inbox'), '聊天室 Agent inbox')
      assertDirectory(join(agentPath, 'skills-snapshot'), '聊天室 Agent skills-snapshot')
    }
  }
}
