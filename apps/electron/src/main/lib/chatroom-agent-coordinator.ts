import { existsSync, lstatSync } from 'node:fs'
import type {
  AgentMessage, AgentSendInput, AgentStreamPayload, ChatRoomAgentInvocation,
  ChatRoomAgentLocalConfig, ChatRoomAgentOutput,
  ChatRoomLocalRoomConfig, ChatRoomPermissionRequest, ChatRoomPermissionResponse,
  ChatRoomRustApi, ChatRoomInvocationFailureCode, ChatRoomInvocationRecord, ChatRoomLifecycleResult,
  ChatRoomInvocationStatusResult, ChatRoomLegacyTerminalProof, ChatRoomLocalIdentity,
  PermissionRequest, ProvisionChatRoomAgentInput, RemoveChatRoomAgentInput,
  SyncChatRoomAgentSkillsInput, UpdateChatRoomAgentInput,
} from '@copis/shared'
import { CHATROOM_DEFAULT_CONTEXT_MESSAGES, CHATROOM_MAX_DEPTH, canonicalizeChatRoomAgentDisplayName, normalizeChatRoomContextMessageCount } from '@copis/shared'
import { AgentPermissionService, permissionService } from './agent-permission-service'
import { parseAndSanitizeChatRoomAgentOutput, sanitizeChatRoomText, type ChatRoomOutputSanitizerContext } from './chatroom-output-sanitizer'
import { getChatRoomAgentInboxPath, getChatRoomAgentProjectPath, getChatRoomAgentSessionDir, getChatRoomAgentSkillsSnapshotPath, getChatRoomPath } from './config-paths'
import type { ChatRoomHiddenSessionStore } from './chatroom-hidden-session-store'
import type { ChatRoomWorkspaceStore } from './chatroom-workspace-store'
import type { ChatRoomPendingResultInput, ChatRoomPendingResultRecord } from './chatroom-workspace-store'
import { computeChatRoomSkillSnapshotDigest } from './chatroom-skill-snapshot'
import type { ChatRoomSkillSnapshotResult, SyncChatRoomAgentSkillSnapshotInput } from './chatroom-skill-snapshot'
import { computeChatRoomReplyDigest } from './chatroom-reply-digest'
import { randomUUID } from 'node:crypto'
import type { ChatRoomAgentReadinessState, ChatRoomReadinessStatus } from './chatroom-readiness-coordinator'
import type { ChatRoomGatewayOrigin, ChatRoomTrustedFailureResult } from './chatroom-execution-types'
import { ChatRoomManagementJournal, type ChatRoomManagementMode, type ChatRoomManagementOperation } from './chatroom-management-journal'
import type {
  ChatRoomLegacyRemovalConfirmation,
  ChatRoomManagementOperationStatus,
  ChatRoomManagementReceipt,
  ChatRoomPublicAgentRoster,
} from './chatroom-management-client'
import type { TrustedChatRoomAgentRuntimeContext } from './agent-rpc-runtime-context'

type HeadlessRunner = (input: AgentSendInput, callbacks: {
  onError: (error: string) => void
  onComplete: (messages?: AgentMessage[]) => void
  onTitleUpdated: (title: string) => void
  source?: 'chatroom'
  trustedRuntimeContext?: TrustedChatRoomAgentRuntimeContext
  signal?: AbortSignal
  trustedRunId?: string
  isTrustedRunCurrent?: () => Promise<boolean>
}) => Promise<void>
type AgentStopper = (sessionId: string, trustedRunId?: string) => Promise<void>
const STOP_AGENT_TIMEOUT_MS = 1_000
const LIFECYCLE_CONFIRM_TIMEOUT_MS = 6_500
const MAX_PENDING_TERMINAL_RESULTS = 32
const STOP_REASON_PRIORITY: Record<'logout' | 'gateway_disconnected' | 'app_quit', number> = { gateway_disconnected: 1, logout: 2, app_quit: 3 }

/** Task 7 的 bridge 接缝；兼容静态加载和旧 handler 测试。 */
export interface ChatRoomAgentCoordinatorFacade {
  handleInvocation(input: ChatRoomAgentInvocation): Promise<'accepted' | 'duplicate'>
  handleTrustedServerFailure(input: { roomId: string; invocationId: string; failureCode: ChatRoomInvocationFailureCode; origin: ChatRoomGatewayOrigin }): Promise<ChatRoomTrustedFailureResult>
  handleGatewayDisconnected(): Promise<void>
  stopAll(reason: 'logout' | 'gateway_disconnected' | 'app_quit'): Promise<{ stoppedSessionIds: string[]; releasedRoomAgentIds: string[] }>
  dispose(): Promise<void>
  resumeAfterAuthentication?(): Promise<void>
  provisionAgent?(input: ProvisionChatRoomAgentInput): Promise<ChatRoomAgentLocalConfig>
  updateAgent?(input: UpdateChatRoomAgentInput): Promise<ChatRoomAgentLocalConfig>
  removeAgent?(input: RemoveChatRoomAgentInput): Promise<void>
  syncAgentSkills?(input: SyncChatRoomAgentSkillsInput): Promise<ChatRoomAgentLocalConfig>
  respondToPermission?(input: ChatRoomPermissionResponse): Promise<void>
  requestWorkerPermission?(input: { sessionId: string; requestId: string; toolName: string; toolInput: Record<string, unknown>; description?: string }): Promise<{ behavior: 'allow' | 'deny'; message?: string }>
  listLocalRooms?(): ChatRoomLocalRoomConfig[]
  listCurrentIdentityLocalRooms?(): Promise<ChatRoomLocalRoomConfig[]>
  getLocalReadinessGeneration?(): string | undefined
  isLocalReadinessGenerationCurrent?(generation: string): boolean
  onPermissionRequested?(listener: (request: ChatRoomPermissionRequest) => void): () => void
  onLocalConfigChanged?(listener: (room: ChatRoomLocalRoomConfig) => void): () => void
  getAgentRuntimeReadiness?(roomId: string, roomAgentId: string): ChatRoomAgentReadinessState | undefined
  onAgentRuntimeReadinessChanged?(listener: (state: ChatRoomAgentReadinessState) => void): () => void
}
type ChatRoomLease = { roomId: string; roomAgentId: string }
interface RejectedInvocationGuard {
  identity: ChatRoomLocalIdentity
  generation: number
  lifecycle: 'ready' | 'auth_required' | 'disconnected' | 'stopping' | 'disposed'
  createdRecord: ChatRoomInvocationRecord
}
type ChatRoomMainRustApi = Omit<ChatRoomRustApi, 'releaseAgentLeases'> & {
  releaseAgentLeases(input: { roomAgentIds: string[]; leases: ChatRoomLease[]; reason: 'logout' | 'gateway_disconnected' | 'app_quit' }): Promise<void>
  getRoomHostUserId(roomId: string): Promise<string>
  getRoomAgentRoster(roomId: string, options?: { signal?: AbortSignal }): Promise<ChatRoomPublicAgentRoster>
  getRoomRealtimeStatus(roomId: string): Promise<{ ready: boolean; epoch: number } & Partial<ChatRoomReadinessStatus>>
  registerAgent(input: { roomId: string; displayName: string; deviceId: string; hostUserId: string; operationId?: string; memoryShared?: boolean; skillsShared?: boolean }): Promise<string | ChatRoomManagementReceipt>
  unregisterAgent(roomId: string, agentId: string, management?: { operationId: string; deviceId: string; hostUserId: string; mode: ChatRoomManagementMode }): Promise<void | ChatRoomManagementReceipt | ChatRoomLegacyRemovalConfirmation>
  probeAgentManagementVersion(): Promise<boolean>
  updateAgentSharing(input: { roomId: string; roomAgentId: string; operationId: string; deviceId: string; hostUserId: string; mode: 'v1'; memoryShared: boolean; skillsShared: boolean }): Promise<ChatRoomManagementReceipt>
  renewAgentLease(roomId: string, agentId: string, deviceId: string): Promise<void>
  lookupManagementOperation(input: { roomId: string; displayName: string; deviceId: string; hostUserId: string; operationId: string; memoryShared?: boolean; skillsShared?: boolean; mode?: ChatRoomManagementMode }): Promise<ChatRoomManagementOperationStatus>
  bindExecution?(input: { invocation: ChatRoomAgentInvocation; targetAgentId: string; sessionId: string; workerRunId: string; origin: ChatRoomGatewayOrigin }): Promise<boolean>
  releaseExecution?(input: { invocation: ChatRoomAgentInvocation; targetAgentId: string; sessionId: string; workerRunId: string; origin: ChatRoomGatewayOrigin }): Promise<boolean>
}
export interface ChatRoomAgentEventListener { (sessionId: string, payload: AgentStreamPayload): void }
export interface ChatRoomNextHopInput { parent: ChatRoomAgentInvocation; output: ChatRoomAgentOutput; targetAgentId: string; depth: number }
export interface ChatRoomAgentCoordinatorDependencies {
  store: ChatRoomWorkspaceStore
  rustApi: ChatRoomMainRustApi
  managementJournal?: ChatRoomManagementJournal
  getCurrentUserId(): Promise<string | undefined>
  getDeviceId(): string
  getSensitiveValues(): string[]
  getSourceWorkspaceSlug?(workspaceId: string): string | undefined
  runAgentHeadless: HeadlessRunner
  stopAgent: AgentStopper
  stopAgentTimeoutMs?: number
  permissionTimeoutMs?: number
  leaseRecoveryRetryMs?: number
  pendingFailureRetryBudgetMs?: number
  createTimeoutSignal?(timeoutMs: number): AbortSignal
  subscribeAgentEvents(listener: ChatRoomAgentEventListener): () => void
  createHiddenSessionStore(roomId: string, agent: ChatRoomAgentLocalConfig): ChatRoomHiddenSessionStore
  registerSessionStorageOverride(sessionId: string, storage: ChatRoomHiddenSessionStore): () => void
  syncSkills(input: SyncChatRoomAgentSkillSnapshotInput): ChatRoomSkillSnapshotResult
  reportDiagnostic?(message: string): void
  permissionService?: Pick<AgentPermissionService, 'respondToPermission' | 'openExternalApproval'>
  allowLegacyInvocations?: boolean
  readiness?: {
    reconcileRoomAgents(roomId: string): Promise<void>
    invalidateConnection(): void
    configurationChanged(roomId: string): Promise<void>
    authorizeRecovery(roomId: string, roomAgentId: string): Promise<void>
    authenticationRefreshed(): void
    dispose(): Promise<void>
    getState(roomId: string, roomAgentId: string): ChatRoomAgentReadinessState | undefined
    onStateChanged(listener: (state: ChatRoomAgentReadinessState) => void): () => void
  }
  now(): number
}
interface ActiveRun { invocation: ChatRoomAgentInvocation; config: ChatRoomAgentLocalConfig; userId: string; deviceId: string; generation: number; origin?: ChatRoomGatewayOrigin; executionBound?: boolean; executionBindingReleased?: boolean; serverTerminalReceived?: boolean; terminalRevocation?: { promise: Promise<ChatRoomTrustedFailureResult>; resolve: (value: ChatRoomTrustedFailureResult) => void }; stopRequested: boolean; terminal: boolean; terminalConfirmed: boolean; cleanupDone: boolean; failureClaim?: { code: ChatRoomInvocationFailureCode; message: string }; pendingInput?: ChatRoomPendingResultInput; completionClaimed: boolean; lastDeltaAt: number; workerRunId: string; sessionRelease?: () => void; requestAbort?: AbortController; executionAbort: AbortController; finalization?: Promise<void> }
interface PendingFailureClaim { roomId: string; invocationId: string; traceId: string; targetAgentId: string; triggerMessageId: string; depth: number; code: ChatRoomInvocationFailureCode; message: string; hostUserId: string; deviceId: string; runGeneration: number }
interface PendingFailureRetryOperation { epoch: number; controller: AbortController }
export interface ChatRoomPendingResult {
  roomId: string
  invocationId: string
  traceId: string
  targetAgentId: string
  triggerMessageId: string
  depth: number
  output: ChatRoomAgentOutput
  replyDigest: string
}
interface PendingPermission { request: PermissionRequest; invocationId: string; roomId: string; hostUserId: string; expiresAt: number; timer: ReturnType<typeof setTimeout> }
function latestAssistantText(messages: AgentMessage[] | undefined): string {
  return messages?.filter((message) => message.role === 'assistant').map((message) => typeof message.content === 'string' ? message.content : '').at(-1) ?? ''
}
function failureMessage(code: ChatRoomInvocationFailureCode): string {
  return ({ agent_offline: 'Agent 当前离线', agent_busy: 'Agent 正在处理其他消息', invocation_depth_exceeded: '调用深度已达到上限', gateway_disconnected: '聊天室网关已断开', host_approval_timeout: '主理人授权超时', host_approval_denied: '主理人拒绝了操作' } as Partial<Record<ChatRoomInvocationFailureCode, string>>)[code] ?? '聊天室 Agent 执行失败'
}
function isConfirmedLifecycleReceipt(result: unknown, expected: { roomId: string; invocationId: string; command: ChatRoomLifecycleResult['command']; status: ChatRoomLifecycleResult['status'] }): boolean {
  if (!result || typeof result !== 'object') return false
  const receipt = result as Partial<ChatRoomLifecycleResult>
  return receipt.outcome === 'confirmed'
    && ((receipt.mode === 'legacy' && receipt.source === 'server-event')
      || (receipt.mode === 'invocation-ack-v1' && receipt.source === 'private-ack' && receipt.confirmed === true && typeof receipt.requestId === 'string' && receipt.requestId.length > 0))
    && receipt.roomId === expected.roomId && receipt.invocationId === expected.invocationId
    && receipt.command === expected.command && receipt.status === expected.status
    && typeof receipt.generation === 'number' && Number.isSafeInteger(receipt.generation) && receipt.generation > 0
}
function isPrivateAck(result: unknown, expected: { roomId: string; invocationId: string; command: 'agent.completed' | 'agent.failed'; status: 'completed' | 'failed' }): boolean {
  if (!result || typeof result !== 'object') return false
  const receipt = result as Partial<ChatRoomLifecycleResult>
  return receipt.outcome === 'confirmed' && receipt.mode === 'invocation-ack-v1' && receipt.source === 'private-ack'
    && receipt.confirmed === true && typeof receipt.requestId === 'string' && receipt.requestId.length > 0
    && receipt.roomId === expected.roomId && receipt.invocationId === expected.invocationId
    && receipt.command === expected.command && receipt.status === expected.status
    && typeof receipt.generation === 'number' && Number.isSafeInteger(receipt.generation) && receipt.generation > 0
}
function isExactPlainObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== null && prototype !== Object.prototype) return false
  const actual = Reflect.ownKeys(value)
  return actual.length === keys.length && actual.every((key) => typeof key === 'string' && keys.includes(key))
}
function isValidPublicAgentRoster(value: unknown): value is ChatRoomPublicAgentRoster {
  if (!isExactPlainObject(value, ['roomId', 'hostUserId', 'agents'])
    || typeof value.roomId !== 'string' || typeof value.hostUserId !== 'string'
    || !Array.isArray(value.agents) || value.agents.length > 3) return false
  const seenIds = new Set<string>()
  for (const agent of value.agents) {
    if (!isExactPlainObject(agent, ['roomAgentId', 'displayName'])
      || typeof agent.roomAgentId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(agent.roomAgentId)
      || typeof agent.displayName !== 'string'
      || canonicalizeChatRoomAgentDisplayName(agent.displayName) !== agent.displayName
      || seenIds.has(agent.roomAgentId)) return false
    seenIds.add(agent.roomAgentId)
  }
  return true
}
function isLegacyTerminalProofForRecord(value: unknown, record: ChatRoomPendingResultRecord): value is ChatRoomLegacyTerminalProof {
  if (record.expectedStatus === 'completed') {
    return isExactPlainObject(value, ['kind', 'replyClientMessageId', 'replyDigest'])
      && value.kind === 'matched-server-event-v1'
      && value.replyClientMessageId === record.clientMessageId
      && value.replyDigest === record.replyDigest
  }
  return isExactPlainObject(value, ['kind', 'failureCode'])
    && value.kind === 'matched-server-event-v1'
    && value.failureCode === record.failureCode
}
function isLegacyTerminalLifecycleProof(value: unknown, record: ChatRoomPendingResultRecord): boolean {
  const command = record.expectedStatus === 'completed' ? 'agent.completed' : 'agent.failed'
  const common = ['outcome', 'mode', 'source', 'roomId', 'invocationId', 'command', 'status', 'generation']
  return isExactPlainObject(value, [...common, 'terminalProof'])
    && value.outcome === 'confirmed' && value.mode === 'legacy' && value.source === 'server-event'
    && value.roomId === record.roomId && value.invocationId === record.invocationId
    && value.command === command && value.status === record.expectedStatus
    && typeof value.generation === 'number' && Number.isSafeInteger(value.generation) && value.generation > 0
    && isLegacyTerminalProofForRecord(value.terminalProof, record)
}
function isLegacyTerminalStatusProof(value: unknown, record: ChatRoomPendingResultRecord): boolean {
  const common = ['outcome', 'mode', 'source', 'roomId', 'invocationId', 'traceId', 'status', 'generation']
  return isExactPlainObject(value, [...common, 'terminalProof'])
    && value.outcome === 'Confirmed' && value.mode === 'legacy' && value.source === 'server-event'
    && value.roomId === record.roomId && value.invocationId === record.invocationId
    && value.traceId === record.traceId && value.status === record.expectedStatus
    && typeof value.generation === 'number' && Number.isSafeInteger(value.generation) && value.generation > 0
    && isLegacyTerminalProofForRecord(value.terminalProof, record)
}
function isTerminalLifecycleProofForRecord(value: unknown, record: ChatRoomPendingResultRecord): boolean {
  return isPrivateAck(value, {
    roomId: record.roomId,
    invocationId: record.invocationId,
    command: record.expectedStatus === 'completed' ? 'agent.completed' : 'agent.failed',
    status: record.expectedStatus,
  }) || isLegacyTerminalLifecycleProof(value, record)
}
function sameInvocationRecord(left: ChatRoomInvocationRecord, right: ChatRoomInvocationRecord): boolean {
  const leftKeys = Object.keys(left).sort()
  const rightKeys = Object.keys(right).sort()
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && left[key as keyof ChatRoomInvocationRecord] === right[key as keyof ChatRoomInvocationRecord])
}
function pendingRecoveryKey(identityKey: string, record: ChatRoomPendingResultRecord): string {
  return [identityKey, record.roomId, record.invocationId, record.recordRevision].join('\0')
}
function samePendingResultRecord(left: ChatRoomPendingResultRecord, right: ChatRoomPendingResultRecord): boolean {
  if (left.recordRevision !== right.recordRevision || left.hostUserId !== right.hostUserId || left.deviceId !== right.deviceId
    || left.roomId !== right.roomId || left.invocationId !== right.invocationId || left.traceId !== right.traceId
    || left.targetAgentId !== right.targetAgentId || left.triggerMessageId !== right.triggerMessageId
    || left.clientMessageId !== right.clientMessageId || left.depth !== right.depth || left.createdAt !== right.createdAt
    || left.expectedStatus !== right.expectedStatus) return false
  if (left.expectedStatus === 'failed' || right.expectedStatus === 'failed') {
    return left.expectedStatus === 'failed' && right.expectedStatus === 'failed' && left.failureCode === right.failureCode
  }
  return left.expectedStatus === 'completed' && right.expectedStatus === 'completed'
    && left.replyDigest === right.replyDigest
    && left.output.text === right.output.text
    && left.output.mentionedAgentIds.length === right.output.mentionedAgentIds.length
    && left.output.mentionedAgentIds.every((id, index) => id === right.output.mentionedAgentIds[index])
    && left.output.attachmentIds.length === right.output.attachmentIds.length
    && left.output.attachmentIds.every((id, index) => id === right.output.attachmentIds[index])
}

/** Main-only 聊天室 Agent 协调器；每个 Agent 独立运行，不设全局队列。 */
export class ChatRoomAgentCoordinator implements ChatRoomAgentCoordinatorFacade {
  private readonly activeRuns = new Map<string, ActiveRun>()
  private readonly pendingResults = new Map<string, ChatRoomPendingResult>()
  private readonly volatilePendingResults = new Map<string, ChatRoomPendingResult>()
  private readonly pendingResultRecords = new Map<string, ChatRoomPendingResultRecord>()
  private readonly unconfirmedTerminalIds = new Set<string>()
  private readonly pendingFailureClaims = new Map<string, PendingFailureClaim>()
  private readonly pendingPermissions = new Map<string, PendingPermission>()
  private unsubscribeEvents: (() => void) | undefined
  private lifecycle: 'ready' | 'auth_required' | 'disconnected' | 'stopping' | 'disposed' = 'ready'
  private stoppingReason: 'logout' | 'gateway_disconnected' | 'app_quit' | undefined
  private terminalOperationEpoch = 0
  private pendingFailureRetryOperation: PendingFailureRetryOperation | undefined
  private pendingStatusRecoveryOperation: AbortController | undefined
  private pendingRecoveryIdentityKey: string | undefined
  private pendingRecoveryProgress: { ownerKey: string; lastVisitedRecordKey: string } | undefined
  private readonly blockedPendingStatusKeys = new Set<string>()
  private disposed = false
  private stopping: Promise<{ stoppedSessionIds: string[]; releasedRoomAgentIds: string[] }> | undefined
  private leaseGeneration = 0
  private managementAuthEpoch = 0
  private readonly managementJournal: ChatRoomManagementJournal
  private readonly releasedLeaseKeys = new Set<string>()
  private readonly provisioningRooms = new Set<string>()
  private leaseRecoveryTimer: ReturnType<typeof setTimeout> | undefined
  private leaseRecovery: Promise<void> | undefined
  private leaseRecoveryRequested = false
  private pendingRecoveryRetryAttempt = 0
  private recoveryEnabled = false
  private readonly permissionListeners = new Set<(request: ChatRoomPermissionRequest) => void>()
  private readonly configListeners = new Set<(room: ChatRoomLocalRoomConfig) => void>()
  constructor(private readonly deps: ChatRoomAgentCoordinatorDependencies) { this.managementJournal = deps.managementJournal ?? new ChatRoomManagementJournal() }
  listLocalRooms(): ChatRoomLocalRoomConfig[] { return this.deps.store.list() }
  getLocalReadinessGeneration(): string | undefined {
    if (this.disposed || ['auth_required', 'stopping', 'disposed'].includes(this.lifecycle)) return undefined
    return `${this.managementAuthEpoch}\0${this.leaseGeneration}\0${this.lifecycle}\0${this.deps.getDeviceId()}`
  }
  isLocalReadinessGenerationCurrent(generation: string): boolean {
    return this.getLocalReadinessGeneration() === generation
  }
  async listCurrentIdentityLocalRooms(): Promise<ChatRoomLocalRoomConfig[]> {
    const authEpoch = this.managementAuthEpoch
    const leaseGeneration = this.leaseGeneration
    const lifecycle = this.lifecycle
    const deviceId = this.deps.getDeviceId()
    const lifecycleIsReadable = () => !this.disposed
      && this.managementAuthEpoch === authEpoch
      && this.leaseGeneration === leaseGeneration
      && this.lifecycle === lifecycle
      && !['auth_required', 'stopping', 'disposed'].includes(this.lifecycle)
      && this.deps.getDeviceId() === deviceId
    if (!lifecycleIsReadable()) return []
    let hostUserId: string | undefined
    try { hostUserId = await this.deps.getCurrentUserId() } catch { return [] }
    if (!hostUserId || !lifecycleIsReadable()) return []
    let rooms: ChatRoomLocalRoomConfig[]
    try { rooms = this.deps.store.list() } catch { return [] }
    let confirmedUserId: string | undefined
    try { confirmedUserId = await this.deps.getCurrentUserId() } catch { return [] }
    if (!confirmedUserId || confirmedUserId !== hostUserId || !lifecycleIsReadable()) return []
    return rooms.filter((room) => room.hostUserId === hostUserId && room.deviceId === deviceId)
  }
  /** Main-only 交接给 Task 3c3 的未确认结果；不暴露给 Renderer。 */
  listPendingResults(): ChatRoomPendingResult[] { return [...this.pendingResults.values()].map((item) => ({ ...item, output: { ...item.output, mentionedAgentIds: [...item.output.mentionedAgentIds], attachmentIds: [...item.output.attachmentIds] } })) }
  /** 兼容旧 Main 接口；调用者提供的摘要不是服务端 proof，不能清除 pending。 */
  acknowledgePendingResult(_input: { roomId: string; invocationId: string; replyDigest: string }): boolean { return false }
  onPermissionRequested(listener: (request: ChatRoomPermissionRequest) => void): () => void { this.permissionListeners.add(listener); return () => this.permissionListeners.delete(listener) }
  onLocalConfigChanged(listener: (room: ChatRoomLocalRoomConfig) => void): () => void { this.configListeners.add(listener); return () => this.configListeners.delete(listener) }
  private emitPermissionRequest(request: ChatRoomPermissionRequest): void {
    this.permissionListeners.forEach((listener) => { try { listener(request) } catch { this.deps.reportDiagnostic?.('聊天室权限通知监听器失败') } })
  }
  private emitConfig(room: ChatRoomLocalRoomConfig, explicitRecoveryAgentId?: string): void {
    this.configListeners.forEach((listener) => { try { listener(room) } catch { this.deps.reportDiagnostic?.('聊天室配置通知监听器失败') } })
    const reconcile = explicitRecoveryAgentId
      ? this.deps.readiness?.authorizeRecovery(room.roomId, explicitRecoveryAgentId)
      : this.deps.readiness?.configurationChanged(room.roomId)
    void reconcile?.catch(() => this.deps.reportDiagnostic?.('聊天室 Agent 就绪状态同步失败'))
    if (this.recoveryEnabled) void this.resumeLeases().catch(() => this.deps.reportDiagnostic?.('聊天室 Agent 租约恢复失败'))
  }
  getAgentRuntimeReadiness(roomId: string, roomAgentId: string): ChatRoomAgentReadinessState | undefined {
    return this.deps.readiness?.getState(roomId, roomAgentId)
  }
  onAgentRuntimeReadinessChanged(listener: (state: ChatRoomAgentReadinessState) => void): () => void {
    return this.deps.readiness?.onStateChanged(listener) ?? (() => {})
  }
  private pendingRecordsForIdentity(hostUserId: string, deviceId: string, onUnreadableRoom?: () => void): ChatRoomPendingResultRecord[] {
    const records: ChatRoomPendingResultRecord[] = []
    for (const room of this.deps.store.listRestorableRooms()) {
      if (room.hostUserId !== hostUserId || room.deviceId !== deviceId) continue
      let roomRecords: ChatRoomPendingResultRecord[]
      try { roomRecords = this.deps.store.listPendingResults(room.roomId) }
      catch (error) {
        if (!onUnreadableRoom) throw error
        onUnreadableRoom()
        continue
      }
      for (const record of roomRecords) {
        if (record.hostUserId !== hostUserId || record.deviceId !== deviceId || record.roomId !== room.roomId) continue
        records.push(record)
      }
    }
    return records
  }
  private recordPendingResult(record: ChatRoomPendingResultRecord): void {
    this.pendingResultRecords.set(record.invocationId, record)
    this.volatilePendingResults.delete(record.invocationId)
    if (record.expectedStatus === 'completed') {
      this.pendingResults.set(record.invocationId, {
        roomId: record.roomId, invocationId: record.invocationId, traceId: record.traceId,
        targetAgentId: record.targetAgentId, triggerMessageId: record.triggerMessageId, depth: record.depth,
        output: record.output, replyDigest: record.replyDigest,
      })
    }
    this.unconfirmedTerminalIds.add(record.invocationId)
  }
  private savePendingResult(input: ChatRoomPendingResultInput): ChatRoomPendingResultRecord {
    const record = this.deps.store.savePendingResult(input)
    this.recordPendingResult(record)
    return record
  }
  private pendingInputForRun(run: ActiveRun, expectedStatus: 'completed', output: ChatRoomAgentOutput, replyDigest: string): ChatRoomPendingResultInput
  private pendingInputForRun(run: ActiveRun, expectedStatus: 'failed', failureCode: ChatRoomInvocationFailureCode): ChatRoomPendingResultInput
  private pendingInputForRun(run: ActiveRun, expectedStatus: 'completed' | 'failed', value: ChatRoomAgentOutput | ChatRoomInvocationFailureCode, replyDigest?: string): ChatRoomPendingResultInput {
    if (run.pendingInput) return run.pendingInput
    const { invocation } = run
    const base = {
      hostUserId: run.userId, deviceId: run.deviceId, roomId: invocation.roomId,
      invocationId: invocation.invocationId, traceId: invocation.traceId,
      targetAgentId: invocation.targetAgentId, triggerMessageId: invocation.triggerMessageId,
      clientMessageId: invocation.triggerMessageId, depth: invocation.depth,
      createdAt: this.deps.now(),
    }
    run.pendingInput = expectedStatus === 'completed'
      ? { ...base, expectedStatus, output: value as ChatRoomAgentOutput, replyDigest: replyDigest! }
      : { ...base, expectedStatus, failureCode: value as ChatRoomInvocationFailureCode }
    return run.pendingInput
  }
  private savePendingFailureClaim(claim: PendingFailureClaim): ChatRoomPendingResultRecord {
    const existing = this.deps.store.listPendingResults(claim.roomId).find((record) => record.invocationId === claim.invocationId)
    if (existing) {
      if (existing.expectedStatus !== 'failed' || existing.hostUserId !== claim.hostUserId || existing.deviceId !== claim.deviceId
        || existing.traceId !== claim.traceId || existing.targetAgentId !== claim.targetAgentId
        || existing.triggerMessageId !== claim.triggerMessageId || existing.clientMessageId !== claim.triggerMessageId
        || existing.depth !== claim.depth || existing.failureCode !== claim.code) {
        throw new Error('pending_result_conflict')
      }
      this.recordPendingResult(existing)
      return existing
    }
    const input: ChatRoomPendingResultInput = {
      hostUserId: claim.hostUserId, deviceId: claim.deviceId, roomId: claim.roomId,
      invocationId: claim.invocationId, traceId: claim.traceId, targetAgentId: claim.targetAgentId,
      triggerMessageId: claim.triggerMessageId, clientMessageId: claim.triggerMessageId,
      depth: claim.depth, expectedStatus: 'failed', failureCode: claim.code,
      createdAt: this.deps.store.getInvocation(claim.roomId, claim.invocationId)?.createdAt ?? this.deps.now(),
    }
    return this.savePendingResult(input)
  }
  private recordMatchesPending(invocation: ChatRoomInvocationRecord | undefined, pending: ChatRoomPendingResultRecord): invocation is ChatRoomInvocationRecord {
    return Boolean(invocation && invocation.roomId === pending.roomId && invocation.invocationId === pending.invocationId
      && invocation.traceId === pending.traceId && invocation.targetAgentId === pending.targetAgentId
      && invocation.triggerMessageId === pending.triggerMessageId && invocation.depth === pending.depth)
  }
  private async commitPendingTerminal(record: ChatRoomPendingResultRecord, proof: ChatRoomInvocationStatusResult | ChatRoomLifecycleResult): Promise<boolean> {
    const expectedStatus = record.expectedStatus
    if (proof.outcome === 'confirmed') {
      if (!isTerminalLifecycleProofForRecord(proof, record)) return false
    } else if (proof.outcome !== 'Confirmed' || proof.roomId !== record.roomId || proof.invocationId !== record.invocationId || proof.traceId !== record.traceId || proof.status !== expectedStatus) {
      return false
    } else if ('mode' in proof && proof.mode === 'legacy') {
      if (!isLegacyTerminalStatusProof(proof, record)) return false
    } else if (expectedStatus === 'completed') {
      if (!('replyClientMessageId' in proof) || proof.replyClientMessageId !== record.clientMessageId || proof.replyDigest !== record.replyDigest) return false
    } else if (!('failureCode' in proof) || proof.failureCode !== record.failureCode) {
      return false
    }
    if (!this.hasSamePendingRecord(record)) { this.deps.reportDiagnostic?.('聊天室 pending revision 已变化，拒绝旧 proof 提交'); return false }
    const local = this.deps.store.getInvocation(record.roomId, record.invocationId)
    if (!this.recordMatchesPending(local, record)) return false
    // Pending 与 room ledger 是两个文件；同步双检与下方无 await 临界区避免同一 coordinator 的迟到 proof 跨 revision 落账。
    if (!this.hasSamePendingRecord(record)) { this.deps.reportDiagnostic?.('聊天室 pending revision 已变化，拒绝旧 proof 提交'); return false }
    const updatedAt = this.deps.now()
    const terminal = expectedStatus === 'completed' ? 'completed' : 'failed'
    const alreadyTerminal = local.status === terminal && (terminal !== 'failed' || local.failureCode === record.failureCode)
    if (!alreadyTerminal) {
      try {
        const transitioned = this.deps.store.transitionInvocation(record.roomId, record.invocationId, ['created', 'accepted', 'running'], (current) => ({
          ...current, status: terminal, updatedAt, finishedAt: updatedAt,
          ...(terminal === 'failed' ? { failureCode: record.failureCode!, failureMessage: failureMessage(record.failureCode!) } : {}),
        }))
        if (!transitioned.transitioned) { this.deps.reportDiagnostic?.('聊天室已确认结果但本地 invocation 状态未能提交，保留待确认文件'); return false }
      } catch { this.deps.reportDiagnostic?.('聊天室已确认结果但本地 invocation 落账失败，保留待确认文件'); return false }
    }
    try {
      if (!this.deps.store.removePendingResultIfUnchanged(record)) { this.deps.reportDiagnostic?.('聊天室 pending revision 已变化，保留待确认文件'); return false }
    } catch { this.deps.reportDiagnostic?.('聊天室已确认结果的本地待确认文件清理失败'); return false }
    this.pendingResultRecords.delete(record.invocationId)
    this.pendingResults.delete(record.invocationId)
    this.volatilePendingResults.delete(record.invocationId)
    this.unconfirmedTerminalIds.delete(record.invocationId)
    this.pendingFailureClaims.delete(record.invocationId)
    return true
  }
  private hasSamePendingRecord(record: ChatRoomPendingResultRecord): boolean {
    try {
      const current = this.deps.store.listPendingResults(record.roomId).find((candidate) => candidate.invocationId === record.invocationId)
      return Boolean(current && samePendingResultRecord(current, record))
    } catch { return false }
  }
  private async pendingOwnerIsCurrent(record: ChatRoomPendingResultRecord, generation: number, hostUserId: string, deviceId: string, signal?: AbortSignal): Promise<boolean> {
    if (this.disposed || this.leaseGeneration !== generation || this.deps.getDeviceId() !== deviceId) return false
    const currentUserId = await this.raceWithAbort(this.deps.getCurrentUserId().catch(() => undefined), signal)
    const room = this.deps.store.read(record.roomId)
    return !signal?.aborted && !this.disposed && this.leaseGeneration === generation && currentUserId === hostUserId
      && this.deps.getDeviceId() === deviceId && room?.hostUserId === hostUserId && room.deviceId === deviceId
      && record.hostUserId === hostUserId && record.deviceId === deviceId
  }
  private async confirmPendingRecord(record: ChatRoomPendingResultRecord, generation: number, hostUserId: string, deviceId: string, signal?: AbortSignal): Promise<'confirmed' | 'unknown' | 'rejected'> {
    if (signal?.aborted) return 'unknown'
    if (!await this.pendingOwnerIsCurrent(record, generation, hostUserId, deviceId, signal)) return signal?.aborted ? 'unknown' : 'rejected'
    const local = this.deps.store.getInvocation(record.roomId, record.invocationId)
    if (!this.recordMatchesPending(local, record)) return 'unknown'
    const query = {
      roomId: record.roomId, invocationId: record.invocationId, deviceId, traceId: record.traceId,
      targetAgentId: record.targetAgentId, triggerMessageId: record.triggerMessageId, depth: record.depth,
      expectedStatus: record.expectedStatus,
      failureCode: record.expectedStatus === 'failed' ? record.failureCode : '',
      clientMessageId: record.clientMessageId,
      replyDigest: record.expectedStatus === 'completed' ? record.replyDigest : '',
    } as const
    let result: ChatRoomInvocationStatusResult
    try {
      const timeout = this.timeoutSignal(LIFECYCLE_CONFIRM_TIMEOUT_MS)
      const controller = new AbortController()
      const relayAbort = () => controller.abort()
      signal?.addEventListener('abort', relayAbort, { once: true })
      timeout.addEventListener('abort', relayAbort, { once: true })
      try {
        const request = this.deps.rustApi.queryInvocationStatus(query, { signal: controller.signal })
        const response = await this.raceWithAbort(request, controller.signal)
        if (!response) return 'unknown'
        result = response
      }
      finally { signal?.removeEventListener('abort', relayAbort); timeout.removeEventListener('abort', relayAbort); controller.abort() }
    } catch { return 'unknown' }
    if (result.outcome === 'Rejected') return 'rejected'
    if (result.outcome !== 'Confirmed' || result.roomId !== record.roomId || result.invocationId !== record.invocationId || result.traceId !== record.traceId) return 'unknown'
    if (result.status !== record.expectedStatus) return 'unknown'
    if ('mode' in result && result.mode === 'legacy') {
      if (!isLegacyTerminalStatusProof(result, record)) return 'unknown'
    } else if (record.expectedStatus === 'completed') {
      if (!('replyClientMessageId' in result) || result.replyClientMessageId !== record.clientMessageId || result.replyDigest !== record.replyDigest) return 'unknown'
    } else if (!('failureCode' in result) || result.failureCode !== record.failureCode) return 'unknown'
    if (signal?.aborted) return 'unknown'
    if (!await this.pendingOwnerIsCurrent(record, generation, hostUserId, deviceId, signal)) return signal?.aborted ? 'unknown' : 'rejected'
    return await this.commitPendingTerminal(record, result) ? 'confirmed' : 'unknown'
  }
  private async restorePendingResults(hostUserId: string, deviceId: string, generation: number): Promise<boolean> {
    const identityKey = `${hostUserId}\0${deviceId}`
    if (this.pendingRecoveryIdentityKey !== identityKey) {
      this.pendingRecoveryIdentityKey = identityKey
      this.blockedPendingStatusKeys.clear()
    }
    let unreadableRoom = false
    let records: ChatRoomPendingResultRecord[]
    try { records = this.pendingRecordsForIdentity(hostUserId, deviceId, () => { unreadableRoom = true }) }
    catch { this.pendingRecoveryRetryAttempt++; this.deps.reportDiagnostic?.('聊天室待确认结果读取失败，保留本地文件'); return false }
    if (unreadableRoom) this.deps.reportDiagnostic?.('聊天室不可读房间的 pending 文件已保留，继续恢复其他房间')
    for (const record of records) this.recordPendingResult(record)
    const currentRecordKeys = new Set(records.map((record) => pendingRecoveryKey(identityKey, record)))
    for (const key of this.blockedPendingStatusKeys) if (!currentRecordKeys.has(key)) this.blockedPendingStatusKeys.delete(key)
    const progressOwnerKey = `${identityKey}\0${generation}`
    const priorRecordKey = this.pendingRecoveryProgress?.ownerKey === progressOwnerKey
      ? this.pendingRecoveryProgress.lastVisitedRecordKey
      : undefined
    const priorRecordIndex = priorRecordKey
      ? records.findIndex((record) => pendingRecoveryKey(identityKey, record) === priorRecordKey)
      : -1
    const operation = new AbortController()
    this.pendingStatusRecoveryOperation = operation
    const batchDeadline = this.timeoutSignal(LIFECYCLE_CONFIRM_TIMEOUT_MS)
    const abortAtDeadline = () => operation.abort()
    batchDeadline.addEventListener('abort', abortAtDeadline, { once: true })
    let complete = !unreadableRoom
    let cursor = records.length === 0 ? 0 : (priorRecordIndex + 1) % records.length
    let visitedRecords = 0
    let visitOrder = 0
    let progressVisitOrder = 0
    const retainProgress = (recordKey: string, order: number): void => {
      if (order <= progressVisitOrder || operation.signal.aborted
        || this.pendingStatusRecoveryOperation !== operation || this.leaseGeneration !== generation) return
      progressVisitOrder = order
      this.pendingRecoveryProgress = { ownerKey: progressOwnerKey, lastVisitedRecordKey: recordKey }
    }
    const worker = async (): Promise<void> => {
      while (!operation.signal.aborted && visitedRecords < records.length) {
        const record = records[cursor]!
        cursor = (cursor + 1) % records.length
        visitedRecords++
        const order = ++visitOrder
        if (!record) return
        const recordKey = pendingRecoveryKey(identityKey, record)
        if (this.pendingStatusRecoveryOperation !== operation || operation.signal.aborted || this.leaseGeneration !== generation) {
          complete = false
          return
        }
        if (this.blockedPendingStatusKeys.has(recordKey)) {
          retainProgress(recordKey, order)
          continue
        }
        if (!await this.pendingOwnerIsCurrent(record, generation, hostUserId, deviceId, operation.signal)) { complete = false; return }
        retainProgress(recordKey, order)
        if (operation.signal.aborted || this.pendingStatusRecoveryOperation !== operation || this.leaseGeneration !== generation) {
          complete = false
          return
        }
        const outcome = await this.confirmPendingRecord(record, generation, hostUserId, deviceId, operation.signal).catch(() => 'unknown' as const)
        if (outcome === 'rejected') {
          if (operation.signal.aborted || !await this.pendingOwnerIsCurrent(record, generation, hostUserId, deviceId, operation.signal)) { complete = false; return }
          const key = pendingRecoveryKey(identityKey, record)
          // 拒绝缓存精确保留当前合法 revision；超过 32 条时不能淘汰旧键，否则同身份会重复查询已拒绝记录。
          this.blockedPendingStatusKeys.add(key)
          this.deps.reportDiagnostic?.('聊天室单条待确认结果 proof 被拒绝，保留该 revision 并继续恢复其他记录')
          continue
        }
        if (outcome === 'unknown') complete = false
      }
      if (operation.signal.aborted) complete = false
    }
    try {
      await Promise.all(Array.from({ length: Math.min(4, records.length) }, () => worker()))
      if (complete) this.pendingRecoveryRetryAttempt = 0
      else this.pendingRecoveryRetryAttempt++
      return complete
    } finally {
      batchDeadline.removeEventListener('abort', abortAtDeadline)
      operation.abort()
      if (this.pendingStatusRecoveryOperation === operation) this.pendingStatusRecoveryOperation = undefined
    }
  }
  private hasPersistedPendingResults(): boolean {
    let rooms: ChatRoomLocalRoomConfig[]
    try {
      rooms = this.deps.store.listRestorableRooms()
    } catch { return false }
    for (const room of rooms) {
      try { if (this.deps.store.listPendingResults(room.roomId).length > 0) return true }
      catch { return true }
    }
    return false
  }
  start(): void {
    if (this.disposed || this.recoveryEnabled) return
    this.unsubscribeEvents = this.deps.subscribeAgentEvents((sid, payload) => this.onAgentEvent(sid, payload))
    this.recoveryEnabled = true
    this.scheduleLeaseRecovery()
  }
  private scheduleLeaseRecovery(): void {
    if (!this.recoveryEnabled || this.disposed || this.leaseRecoveryTimer || !['ready', 'disconnected'].includes(this.lifecycle)) return
    const baseDelay = this.deps.leaseRecoveryRetryMs ?? 1_000
    const exponent = Math.min(this.pendingRecoveryRetryAttempt, 5)
    const delay = Math.min(baseDelay * 2 ** exponent, 30_000)
    this.leaseRecoveryTimer = setTimeout(() => {
      this.leaseRecoveryTimer = undefined
      void this.resumeLeases().catch(() => this.deps.reportDiagnostic?.('聊天室 Agent 租约恢复失败'))
    }, delay)
    this.leaseRecoveryTimer.unref?.()
  }
  private assertAgentOnline(generation: number): void {
    if (this.disposed || this.lifecycle !== 'ready' || this.leaseGeneration !== generation) throw new Error('agent_offline')
  }
  private assertProvisionMayProceed(generation: number): void {
    if (this.disposed || this.lifecycle === 'auth_required' || this.lifecycle === 'stopping' || this.leaseGeneration !== generation) throw new Error('agent_offline')
  }
  private assertManagementAllowed(epoch: number): void {
    if (this.disposed || this.managementAuthEpoch !== epoch || this.lifecycle === 'auth_required'
      || (this.lifecycle === 'stopping' && this.stoppingReason !== 'gateway_disconnected')) throw new Error('agent_offline')
  }
  private managementRoomFingerprint(room: ChatRoomLocalRoomConfig | undefined): string {
    if (!room) return 'missing'
    return JSON.stringify({
      roomId: room.roomId, hostUserId: room.hostUserId, deviceId: room.deviceId, createdAt: room.createdAt,
      agents: room.agents.map((agent) => ({ roomAgentId: agent.roomAgentId, displayName: agent.displayName, archivedAt: agent.archivedAt,
        sourceWorkspaceId: agent.sourceWorkspaceId, sessionId: agent.sessionId, channelId: agent.channelId, modelId: agent.modelId,
        contextMessageCount: agent.contextMessageCount, memorySharingEnabled: agent.memorySharingEnabled, skillSharingEnabled: agent.skillSharingEnabled,
      })).sort((left, right) => left.roomAgentId.localeCompare(right.roomAgentId)),
    })
  }
  private managementRoomIdentityMatches(operation: ChatRoomManagementOperation, room: ChatRoomLocalRoomConfig | undefined): boolean {
    if (!room) return operation.roomWasMissing && operation.phase !== 'local_saved'
    return room.roomId === operation.roomId && room.hostUserId === operation.hostUserId && room.deviceId === operation.deviceId
      && room.createdAt === operation.roomCreatedAt
  }
  private managementLocalAgentPayloadMatches(operation: ChatRoomManagementOperation, agent: ChatRoomAgentLocalConfig): boolean {
    const input = operation.input
    return agent.roomAgentId === operation.roomAgentId
      && agent.displayName === input.displayName && agent.sourceWorkspaceId === input.sourceWorkspaceId
      && agent.channelId === input.channelId && agent.modelId === input.modelId
      && agent.contextMessageCount === normalizeChatRoomContextMessageCount(input.contextMessageCount ?? CHATROOM_DEFAULT_CONTEXT_MESSAGES)
      && agent.memorySharingEnabled === (input.memorySharingEnabled ?? false)
      && agent.skillSharingEnabled === (input.skillSharingEnabled ?? false)
  }
  private managementLocalAgentConfigMatches(operation: ChatRoomManagementOperation, agent: ChatRoomAgentLocalConfig): boolean {
    return this.managementLocalAgentPayloadMatches(operation, agent) && agent.archivedAt === undefined
  }
  private finishSavedProvision(identity: ChatRoomLocalIdentity, operation: ChatRoomManagementOperation, room: ChatRoomLocalRoomConfig, agent: ChatRoomAgentLocalConfig): ChatRoomAgentLocalConfig {
    let completed = operation
    let completionRecorded = operation.phase === 'local_saved'
    if (operation.phase === 'remote_created') {
      try {
        completed = this.managementJournal.updateRegistration(identity, operation.operationId, { phase: 'local_saved' })
        completionRecorded = true
      }
      catch { this.deps.reportDiagnostic?.('聊天室配置已保存，管理journal完成标记失败，保留远端operation恢复信息') }
    }
    this.emitConfig(room)
    if (completionRecorded) {
      try { this.managementJournal.removeRegistration(identity, completed.operationId) }
      catch { this.deps.reportDiagnostic?.('聊天室配置已保存，管理journal清理失败，后续可按本地Agent恢复') }
    }
    return agent
  }
  private managementReceiptAgentId(receipt: ChatRoomManagementReceipt, operation: ChatRoomManagementOperation, identity: ChatRoomLocalIdentity): string {
    const expectedMemory = operation.input.memorySharingEnabled ?? false
    const expectedSkills = operation.input.skillSharingEnabled ?? false
    const numericOwnerMatches = !/^\d+$/u.test(identity.hostUserId) || String(receipt.ownerUserId) === identity.hostUserId
    if (receipt.version !== 1 || receipt.operationId !== operation.operationId || receipt.roomId !== operation.roomId
      || !numericOwnerMatches || receipt.action !== 'register' || receipt.status !== 'registered'
      || receipt.displayName !== operation.input.displayName || receipt.memoryShared !== expectedMemory || receipt.skillsShared !== expectedSkills
      || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(receipt.roomAgentId)) {
      throw new Error('聊天室管理注册回执与 operation 不匹配；journal 已保留')
    }
    return receipt.roomAgentId
  }
  private assertManagementRemovalReceipt(value: void | ChatRoomManagementReceipt | ChatRoomLegacyRemovalConfirmation, operationId: string, roomId: string, roomAgentId: string, identity: ChatRoomLocalIdentity): void {
    if (value && 'mode' in value && value.mode === 'legacy') {
      if (value.outcome === 'confirmed' && value.roomId === roomId && value.roomAgentId === roomAgentId) return
      throw new Error('旧版聊天室 Agent 精确删除未确认；journal 已保留')
    }
    const receipt = value as ChatRoomManagementReceipt | undefined
    if (!receipt || receipt.version !== 1 || receipt.operationId !== operationId || receipt.roomId !== roomId
      || (/^\d+$/u.test(identity.hostUserId) && String(receipt.ownerUserId) !== identity.hostUserId)
      || receipt.roomAgentId !== roomAgentId || receipt.action !== 'remove' || receipt.status !== 'removed'
      || typeof receipt.memoryShared !== 'boolean' || typeof receipt.skillsShared !== 'boolean') {
      throw new Error('聊天室 Agent 精确删除回执未确认；journal 已保留')
    }
  }
  private assertManagementSharingReceipt(value: ChatRoomManagementReceipt, operation: ChatRoomManagementOperation, identity: ChatRoomLocalIdentity): void {
    const sharing = operation.sharing
    if (!sharing || value.version !== 1 || value.operationId !== operation.operationId || value.roomId !== operation.roomId
      || (/^\d+$/u.test(identity.hostUserId) && String(value.ownerUserId) !== identity.hostUserId)
      || value.roomAgentId !== operation.roomAgentId || value.action !== 'update-sharing' || value.status !== 'updated'
      || value.memoryShared !== sharing.memoryShared || value.skillsShared !== sharing.skillsShared) {
      throw new Error('聊天室共享设置精确回执未确认；journal 已保留')
    }
  }
  private assertManagementOperationLocal(
    epoch: number,
    identity: ChatRoomLocalIdentity,
    roomFingerprint: string,
    operationId: string,
    expectedRevision?: number,
  ): ChatRoomManagementOperation {
    this.assertManagementAllowed(epoch)
    if (this.deps.getDeviceId() !== identity.deviceId) throw new Error('not_room_host')
    const operation = this.managementJournal.getOperation(identity, operationId)
    if (!operation || operation.hostUserId !== identity.hostUserId || operation.deviceId !== identity.deviceId) throw new Error('management_operation_owner_mismatch')
    if (expectedRevision !== undefined && (operation.revision ?? 0) !== expectedRevision) throw new Error('management_operation_revision_changed')
    const room = this.deps.store.read(operation.roomId)
    if (!this.managementRoomIdentityMatches(operation, room)) throw new Error('management_operation_room_identity_mismatch')
    if (this.managementRoomFingerprint(room) !== roomFingerprint) throw new Error('room_config_changed')
    return operation
  }
  private async assertManagementLocalFence(
    epoch: number,
    identity: ChatRoomLocalIdentity,
    roomFingerprint: string,
    operationId: string,
    expectedRevision?: number,
  ): Promise<void> {
    this.assertManagementOperationLocal(epoch, identity, roomFingerprint, operationId, expectedRevision)
    const currentUser = await this.deps.getCurrentUserId()
    this.assertManagementOperationLocal(epoch, identity, roomFingerprint, operationId, expectedRevision)
    if (currentUser !== identity.hostUserId) throw new Error('not_room_host')
  }
  private async assertManagementFence(
    epoch: number,
    identity: ChatRoomLocalIdentity,
    roomFingerprint: string,
    operationId: string,
    expectedRevision?: number,
  ): Promise<void> {
    await this.assertManagementLocalFence(epoch, identity, roomFingerprint, operationId, expectedRevision)
    const operation = this.managementJournal.getOperation(identity, operationId)!
    const hostUserId = await this.deps.rustApi.getRoomHostUserId(operation.roomId)
    await this.assertManagementLocalFence(epoch, identity, roomFingerprint, operationId, expectedRevision)
    if (hostUserId !== identity.hostUserId) throw new Error('not_room_host')
  }
  private async raceWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T | undefined> {
    if (!signal) return promise
    if (signal.aborted) return undefined
    let onAbort: (() => void) | undefined
    const aborted = new Promise<undefined>((resolve) => {
      onAbort = () => resolve(undefined)
      signal.addEventListener('abort', onAbort, { once: true })
    })
    try { return await Promise.race([promise, aborted]) }
    finally { if (onAbort) signal.removeEventListener('abort', onAbort) }
  }
  private timeoutSignal(timeoutMs: number): AbortSignal {
    return this.deps.createTimeoutSignal?.(timeoutMs) ?? AbortSignal.timeout(timeoutMs)
  }
  private async failureOwnerIsCurrent(claim: PendingFailureClaim, stillCurrent: () => boolean, signal?: AbortSignal): Promise<boolean> {
    if (!stillCurrent() || signal?.aborted) return false
    const identity = await this.raceWithAbort(this.deps.getCurrentUserId().catch(() => undefined), signal)
    if (!stillCurrent() || signal?.aborted || identity !== claim.hostUserId) return false
    const deviceId = this.deps.getDeviceId()
    const room = this.deps.store.read(claim.roomId)
    const record = this.deps.store.getInvocation(claim.roomId, claim.invocationId)
    return stillCurrent() && !signal?.aborted
      && deviceId === claim.deviceId
      && room?.hostUserId === claim.hostUserId && room.deviceId === claim.deviceId
      && record?.roomId === claim.roomId && record.traceId === claim.traceId
      && record.targetAgentId === claim.targetAgentId && record.triggerMessageId === claim.triggerMessageId
      && record.depth === claim.depth && ['created', 'accepted', 'running'].includes(record.status)
  }
  private lifecycleConfirmed(result: unknown, run: ActiveRun, command: ChatRoomLifecycleResult['command'], status: ChatRoomLifecycleResult['status']): boolean {
    return isConfirmedLifecycleReceipt(result, { roomId: run.invocation.roomId, invocationId: run.invocation.invocationId, command, status })
  }
  private isLegacyRunningAdvisory(result: unknown, run: ActiveRun): boolean {
    if (!result || typeof result !== 'object') return false
    const receipt = result as Partial<ChatRoomLifecycleResult>
    return receipt.outcome === 'advisory' && receipt.mode === 'legacy'
      && receipt.source === 'accepted-event+local-advisory'
      && receipt.roomId === run.invocation.roomId && receipt.invocationId === run.invocation.invocationId
      && receipt.command === 'agent.running' && receipt.status === 'running'
      && typeof receipt.generation === 'number' && Number.isSafeInteger(receipt.generation) && receipt.generation > 0
  }
  private async requestLifecycle<T>(run: ActiveRun, request: (signal: AbortSignal) => Promise<T>): Promise<T | undefined> {
    const controller = new AbortController()
    run.requestAbort = controller
    let timer: ReturnType<typeof setTimeout> | undefined
    let onAbort: (() => void) | undefined
    const aborted = new Promise<undefined>((resolve) => {
      onAbort = () => resolve(undefined)
      controller.signal.addEventListener('abort', onAbort, { once: true })
      timer = setTimeout(() => controller.abort(), LIFECYCLE_CONFIRM_TIMEOUT_MS)
    })
    const pending = request(controller.signal).catch(() => undefined)
    try { return await Promise.race([pending, aborted]) }
    finally {
      if (timer) clearTimeout(timer)
      if (onAbort) controller.signal.removeEventListener('abort', onAbort)
      if (run.requestAbort === controller) run.requestAbort = undefined
    }
  }
  private async isRunCurrent(run: ActiveRun): Promise<boolean> {
    if (this.activeRuns.get(run.invocation.invocationId) !== run || run.stopRequested || run.terminal || this.disposed
      || this.lifecycle !== 'ready' || this.leaseGeneration !== run.generation
      || this.deps.getDeviceId() !== run.deviceId) return false
    const userId = await this.deps.getCurrentUserId()
    const room = this.deps.store.read(run.invocation.roomId)
    return this.activeRuns.get(run.invocation.invocationId) === run && !run.stopRequested && !run.terminal
      && !this.disposed && this.lifecycle === 'ready' && this.leaseGeneration === run.generation
      && userId === run.userId && this.deps.getDeviceId() === run.deviceId
      && room?.hostUserId === run.userId && room.deviceId === run.deviceId
      && room.agents.some((agent) => agent.roomAgentId === run.config.roomAgentId && agent.archivedAt === undefined)
  }
  private async trustedTerminalOwnerIsCurrent(run: ActiveRun, expectedRecord: ChatRoomInvocationRecord, expectedPending: ChatRoomPendingResultRecord[] | undefined): Promise<'current' | 'stale' | 'unknown'> {
    if (this.activeRuns.get(run.invocation.invocationId) !== run) { this.deps.reportDiagnostic?.('聊天室服务端终态 ActiveRun owner 已替换'); return 'stale' }
    if (this.disposed || this.lifecycle !== 'ready' || this.leaseGeneration !== run.generation) { this.deps.reportDiagnostic?.('聊天室服务端终态连接生命周期已变化'); return 'stale' }
    if (this.deps.getDeviceId() !== run.deviceId) { this.deps.reportDiagnostic?.('聊天室服务端终态设备已变化'); return 'stale' }
    let userId: string | undefined
    try { userId = await this.deps.getCurrentUserId() } catch { return 'unknown' }
    if (this.activeRuns.get(run.invocation.invocationId) !== run) { this.deps.reportDiagnostic?.('聊天室服务端终态 ActiveRun owner 在身份读取期间已替换'); return 'stale' }
    if (this.disposed || this.lifecycle !== 'ready' || this.leaseGeneration !== run.generation) { this.deps.reportDiagnostic?.('聊天室服务端终态连接生命周期在身份读取期间已变化'); return 'stale' }
    if (userId !== run.userId) { this.deps.reportDiagnostic?.('聊天室服务端终态主理人身份已变化'); return 'stale' }
    if (this.deps.getDeviceId() !== run.deviceId) { this.deps.reportDiagnostic?.('聊天室服务端终态设备在身份读取期间已变化'); return 'stale' }
    const room = this.deps.store.read(run.invocation.roomId)
    const config = room?.agents.find((agent) => agent.roomAgentId === run.config.roomAgentId && agent.archivedAt === undefined)
    const record = this.deps.store.getInvocation(run.invocation.roomId, run.invocation.invocationId)
    if (!room || room.hostUserId !== run.userId || room.deviceId !== run.deviceId || !config
      || JSON.stringify(config) !== JSON.stringify(run.config) || !record || !sameInvocationRecord(record, expectedRecord)) { this.deps.reportDiagnostic?.('聊天室服务端终态房间或 invocation 元数据已变化'); return 'stale' }
    let pending: ChatRoomPendingResultRecord[]
    try { pending = this.deps.store.listPendingResults(run.invocation.roomId).filter((item) => item.invocationId === run.invocation.invocationId) }
    catch { return 'unknown' }
    if (expectedPending === undefined || JSON.stringify(pending) !== JSON.stringify(expectedPending)) { this.deps.reportDiagnostic?.('聊天室服务端终态 pending revision 已变化'); return 'stale' }
    return 'current'
  }
  private async releaseUnstartedRun(run: ActiveRun): Promise<void> {
    await this.releaseExecutionBinding(run)
    if (this.activeRuns.get(run.invocation.invocationId) === run) this.releaseRunResources(run)
  }
  private async releaseExecutionBinding(run: ActiveRun): Promise<boolean> {
    if (!run.origin || run.executionBindingReleased) return true
    const released = await this.deps.rustApi.releaseExecution?.({
      invocation: run.invocation, targetAgentId: run.config.roomAgentId, sessionId: run.config.sessionId,
      workerRunId: run.workerRunId, origin: run.origin,
    }).catch(() => false) === true
    if (released) run.executionBindingReleased = true
    return released
  }
  private async releaseUnclaimedInvocationSource(input: ChatRoomAgentInvocation, room: ChatRoomLocalRoomConfig, origin?: ChatRoomGatewayOrigin): Promise<void> {
    if (!origin) return
    const agent = room.agents.find((candidate) => candidate.roomAgentId === input.targetAgentId)
    if (!agent) return
    await this.deps.rustApi.releaseExecution?.({
      invocation: input,
      targetAgentId: agent.roomAgentId,
      sessionId: agent.sessionId,
      workerRunId: randomUUID(),
      origin,
    }).catch(() => false)
  }
  private pendingFailureClaimForRun(run: ActiveRun, failureClaim: { code: ChatRoomInvocationFailureCode; message: string }): PendingFailureClaim {
    const { invocation } = run
    return {
      roomId: invocation.roomId,
      invocationId: invocation.invocationId,
      traceId: invocation.traceId,
      targetAgentId: invocation.targetAgentId,
      triggerMessageId: invocation.triggerMessageId,
      depth: invocation.depth,
      ...failureClaim,
      hostUserId: run.userId,
      deviceId: run.deviceId,
      runGeneration: run.generation,
    }
  }
  private async failUnstartedRun(run: ActiveRun): Promise<void> {
    if (run.serverTerminalReceived) return
    await this.failTerminal(run, 'internal_error')
    await this.releaseUnstartedRun(run)
  }
  private async releaseLease(roomId: string, agentId: string): Promise<boolean> {
    try {
      await this.deps.rustApi.releaseAgentLeases({ roomAgentIds: [agentId], leases: [{ roomId, roomAgentId: agentId }], reason: this.stoppingReason ?? 'gateway_disconnected' })
      return true
    } catch { this.deps.reportDiagnostic?.('聊天室 Agent 租约清理失败'); return false }
  }
  resumeLeases(): Promise<void> {
    if (this.leaseRecovery) {
      this.leaseRecoveryRequested = true
      return this.leaseRecovery
    }
    if (this.leaseRecoveryTimer) clearTimeout(this.leaseRecoveryTimer)
    this.leaseRecoveryTimer = undefined
    const renewedLeaseKeys = new Set<string>()
    this.leaseRecovery = (async () => {
      let complete = true
      do {
        this.leaseRecoveryRequested = false
        complete = await this.restoreLeases(renewedLeaseKeys)
      } while (this.leaseRecoveryRequested && !this.disposed && ['ready', 'disconnected'].includes(this.lifecycle))
      if (!complete) this.scheduleLeaseRecovery()
    })().catch((error: unknown) => {
      this.scheduleLeaseRecovery()
      throw error
    }).finally(() => {
      this.leaseRecovery = undefined
      if (this.leaseRecoveryRequested && !this.disposed && ['ready', 'disconnected'].includes(this.lifecycle)) {
        this.leaseRecoveryRequested = false
        void this.resumeLeases().catch(() => this.deps.reportDiagnostic?.('聊天室 Agent 租约恢复失败'))
      }
    })
    return this.leaseRecovery
  }
  private async restoreLeases(renewedLeaseKeys: Set<string>): Promise<boolean> {
    const generation = this.leaseGeneration
    const hostUserId = await this.deps.getCurrentUserId()
    const deviceId = this.deps.getDeviceId()
    if (!hostUserId || this.disposed || !['ready', 'disconnected'].includes(this.lifecycle) || generation !== this.leaseGeneration) return false
    let rooms: ChatRoomLocalRoomConfig[]
    try { rooms = this.deps.store.listRestorableRooms() }
    catch { this.deps.reportDiagnostic?.('聊天室本地配置读取失败，无法恢复 Agent 租约'); return false }
    let complete = true
    for (const room of rooms) {
      if (room.hostUserId !== hostUserId || room.deviceId !== deviceId) continue
      let realtime: { ready: boolean; epoch: number } & Partial<ChatRoomReadinessStatus>
      try {
        if (await this.deps.rustApi.getRoomHostUserId(room.roomId) !== hostUserId) continue
        realtime = await this.deps.rustApi.getRoomRealtimeStatus(room.roomId)
        if (realtime.mode === 'modern' || realtime.capabilityState === 'preparing') {
          void this.deps.readiness?.reconcileRoomAgents(room.roomId).catch(() => this.deps.reportDiagnostic?.('聊天室 Agent 就绪状态同步失败'))
          continue
        }
        if (!realtime.ready) { complete = false; continue }
        if (await this.deps.getCurrentUserId() !== hostUserId || this.deps.getDeviceId() !== deviceId) return false
        this.assertProvisionMayProceed(generation)
        if (this.lifecycle === 'disconnected') {
          this.lifecycle = 'ready'
          this.stoppingReason = undefined
          this.releasedLeaseKeys.clear()
        }
      } catch { complete = false; this.deps.reportDiagnostic?.('聊天室 Agent 租约恢复失败'); continue }
      const sameRealtime = async (): Promise<boolean> => {
        if (this.leaseGeneration !== generation || this.lifecycle !== 'ready') return false
        const current = await this.deps.rustApi.getRoomRealtimeStatus(room.roomId)
        return current.ready && current.epoch === realtime.epoch && this.leaseGeneration === generation && this.lifecycle === 'ready'
      }
      for (const agent of room.agents) {
        if (agent.archivedAt !== undefined) continue
        const leaseKey = `${generation}\0${hostUserId}\0${deviceId}\0${room.roomId}\0${agent.roomAgentId}\0${realtime.epoch}`
        try {
          if (this.managementJournal.hasPendingForAgent({ hostUserId, deviceId }, room.roomId, agent.roomAgentId)) {
            complete = false
            continue
          }
        } catch {
          complete = false
          continue
        }
        if (renewedLeaseKeys.has(leaseKey)) continue
        let renewalAttempted = false
        try {
          this.assertAgentOnline(generation)
          if (await this.deps.getCurrentUserId() !== hostUserId || this.deps.getDeviceId() !== deviceId) return false
          this.assertAgentOnline(generation)
          if (!await sameRealtime()) return false
          this.assertAgentOnline(generation)
          renewalAttempted = true
          await this.deps.rustApi.renewAgentLease(room.roomId, agent.roomAgentId, deviceId)
          if (!await sameRealtime() || await this.deps.getCurrentUserId() !== hostUserId || this.deps.getDeviceId() !== deviceId || this.leaseGeneration !== generation || this.lifecycle !== 'ready') {
            await this.releaseLease(room.roomId, agent.roomAgentId)
            return false
          }
          renewedLeaseKeys.add(leaseKey)
        } catch {
          if (!await sameRealtime().catch(() => false)) {
            if (renewalAttempted) await this.releaseLease(room.roomId, agent.roomAgentId)
            return false
          }
          complete = false
          this.deps.reportDiagnostic?.('聊天室 Agent 租约恢复失败')
        }
      }
    }
    const pendingComplete = await this.restorePendingResults(hostUserId, deviceId, generation)
    return complete && pendingComplete
  }
  async provisionAgent(input: ProvisionChatRoomAgentInput): Promise<ChatRoomAgentLocalConfig> {
    if (this.provisioningRooms.has(input.roomId)) throw new Error('agent_busy')
    this.provisioningRooms.add(input.roomId)
    try {
      const authEpoch = this.managementAuthEpoch
      this.assertManagementAllowed(authEpoch)
      const hostUserId = await this.deps.getCurrentUserId()
      this.assertManagementAllowed(authEpoch)
      const deviceId = this.deps.getDeviceId()
      if (!hostUserId) throw new Error('not_room_host')
      const identity: ChatRoomLocalIdentity = { hostUserId, deviceId }
      let localRoom = this.deps.store.read(input.roomId)
      if (localRoom && (localRoom.hostUserId !== hostUserId || localRoom.deviceId !== deviceId)) throw new Error('not_room_host')
      let roomFingerprint = this.managementRoomFingerprint(localRoom)
      const existingOperation = this.managementJournal.findRegistration(identity, input.roomId, input.displayName)
      const canonicalDisplayName = canonicalizeChatRoomAgentDisplayName(input.displayName)
      if (!canonicalDisplayName) throw new Error('invalid_agent_input')
      const canonicalName = canonicalDisplayName.toLocaleLowerCase('en-US')
      const operationMayHaveReachedServer = existingOperation !== undefined && existingOperation.phase !== 'prepared'
      if (!operationMayHaveReachedServer) {
        const duplicate = localRoom?.agents.some((agent) => agent.archivedAt === undefined && agent.displayName.trim().toLocaleLowerCase('en-US') === canonicalName)
        const atLimit = Boolean(localRoom && localRoom.agents.filter((agent) => agent.archivedAt === undefined).length >= 3)
        if (duplicate || atLimit) {
          if (existingOperation?.phase === 'prepared') this.managementJournal.removeRegistration(identity, existingOperation.operationId)
          throw new Error(duplicate ? 'display_name_conflict' : 'agent_limit_reached')
        }
      }
      const host = await this.deps.rustApi.getRoomHostUserId(input.roomId)
      this.assertManagementAllowed(authEpoch)
      const currentUserId = await this.deps.getCurrentUserId()
      this.assertManagementAllowed(authEpoch)
      if (host !== hostUserId || currentUserId !== hostUserId || this.deps.getDeviceId() !== deviceId
        || this.managementRoomFingerprint(this.deps.store.read(input.roomId)) !== roomFingerprint) throw new Error('not_room_host')

      let operation = this.managementJournal.prepareRegistration(identity, input, localRoom)
      if (!this.managementRoomIdentityMatches(operation, localRoom)) throw new Error('management_operation_room_identity_mismatch')
      const registration = {
        roomId: input.roomId, displayName: operation.input.displayName, deviceId, hostUserId,
        memoryShared: operation.input.memorySharingEnabled ?? false,
        skillsShared: operation.input.skillSharingEnabled ?? false,
      }
      if (operation.phase === 'legacy_unknown' || operation.phase === 'legacy_cleanup_unknown') {
        throw new Error('旧版聊天室服务不支持安全恢复；注册/补偿结果未知，journal 已保留，请勿重复操作')
      }
      const existingRemoteAgent = operation.roomAgentId
        ? localRoom?.agents.find((agent) => agent.roomAgentId === operation.roomAgentId)
        : undefined
      if (existingRemoteAgent) {
        if (!localRoom) throw new Error('management_operation_local_mismatch')
        if (!this.managementLocalAgentPayloadMatches(operation, existingRemoteAgent)) {
          throw new Error('management_operation_local_mismatch')
        }
        if (operation.phase === 'compensation_pending') {
          if (existingRemoteAgent.archivedAt === undefined) {
            localRoom = this.deps.store.archiveAgent({ roomId: operation.roomId, roomAgentId: operation.roomAgentId! })
            this.emitConfig(localRoom)
            roomFingerprint = this.managementRoomFingerprint(localRoom)
          } else {
            this.emitConfig(localRoom)
          }
        } else if (operation.phase === 'remote_created' || operation.phase === 'local_saved') {
          if (!this.managementLocalAgentConfigMatches(operation, existingRemoteAgent)) {
            throw new Error('management_operation_local_mismatch')
          }
          await this.assertManagementFence(authEpoch, identity, roomFingerprint, operation.operationId)
          return this.finishSavedProvision(identity, operation, localRoom, existingRemoteAgent)
        } else {
          throw new Error('management_operation_local_mismatch')
        }
      } else if (operation.phase === 'local_saved') {
        throw new Error('management_operation_local_mismatch')
      }
      if (operation.phase === 'compensation_pending') {
        await this.assertManagementFence(authEpoch, identity, roomFingerprint, operation.operationId)
        const receipt = await this.deps.rustApi.unregisterAgent(operation.roomId, operation.roomAgentId!, {
          operationId: operation.compensationOperationId!, deviceId, hostUserId, mode: 'v1',
        })
        await this.assertManagementFence(authEpoch, identity, roomFingerprint, operation.operationId)
        this.assertManagementRemovalReceipt(receipt, operation.compensationOperationId!, operation.roomId, operation.roomAgentId!, identity)
        this.managementJournal.removeRegistration(identity, operation.operationId)
        throw new Error('上次本地写入失败，远端 Agent 已按原 operation 安全撤销；请确认后重新操作')
      }

      let roomAgentId = operation.phase === 'remote_created' ? operation.roomAgentId : undefined
      if (!roomAgentId) {
        if (operation.phase !== 'prepared' && operation.mode === undefined) {
          throw new Error('management_operation_mode_unknown')
        }
        if (operation.phase !== 'prepared' && operation.mode === 'legacy') {
          throw new Error('旧版聊天室服务的管理结果未知；journal 已保留，禁止升级协议或重复注册')
        }
        await this.assertManagementFence(authEpoch, identity, roomFingerprint, operation.operationId)
        let status: Awaited<ReturnType<ChatRoomMainRustApi['lookupManagementOperation']>>
        try { status = await this.deps.rustApi.lookupManagementOperation({ ...registration, operationId: operation.operationId, mode: operation.mode }) }
        catch (statusError) {
          await this.assertManagementFence(authEpoch, identity, roomFingerprint, operation.operationId)
          throw new Error('聊天室 Agent 注册 operation 状态未知；journal 已保留，不会按名称认领或创建新 operation', { cause: statusError })
        }
        await this.assertManagementFence(authEpoch, identity, roomFingerprint, operation.operationId)
        if (!status || !('mode' in status)) throw new Error('聊天室管理状态响应不正确')

        if (status.mode === 'legacy') {
          if (operation.mode === 'v1' || operation.phase !== 'prepared') {
            throw new Error('管理操作仍未确认且服务端暂不支持 operation 恢复；journal 已保留，禁止重复注册')
          }
          if (registration.memoryShared || registration.skillsShared) {
            this.managementJournal.removeRegistration(identity, operation.operationId)
            throw new Error('旧版聊天室服务不支持 Agent 共享设置；请升级服务端后重试')
          }
          operation = this.managementJournal.updateRegistration(identity, operation.operationId, { mode: 'legacy', phase: 'submitting' })
          let result: string | ChatRoomManagementReceipt
          try { result = await this.deps.rustApi.registerAgent(registration) }
          catch (error) {
            await this.assertManagementFence(authEpoch, identity, roomFingerprint, operation.operationId)
            this.managementJournal.updateRegistration(identity, operation.operationId, { phase: 'legacy_unknown' })
            throw new Error('旧版聊天室服务注册结果未知；已保留 journal，不会自动重发，请先确认远端状态', { cause: error })
          }
          await this.assertManagementFence(authEpoch, identity, roomFingerprint, operation.operationId)
          if (typeof result !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(result)) throw new Error('旧版聊天室服务未返回有效 Agent ID')
          operation = this.managementJournal.updateRegistration(identity, operation.operationId, { phase: 'remote_created', roomAgentId: result })
          roomAgentId = operation.roomAgentId
        } else {
          if (operation.mode === 'legacy') throw new Error('旧版服务器操作未知；不能切换协议或重复注册')
          if (status.receipt) {
            const statusAgentId = this.managementReceiptAgentId(status.receipt, operation, identity)
            operation = this.managementJournal.updateRegistration(identity, operation.operationId, {
              mode: 'v1', phase: 'remote_created', roomAgentId: statusAgentId,
            })
            roomAgentId = operation.roomAgentId
          } else {
            const currentRoom = this.deps.store.read(input.roomId)
            const duplicate = currentRoom?.agents.some((agent) => agent.archivedAt === undefined && agent.displayName.trim().toLocaleLowerCase('en-US') === canonicalName)
            const atLimit = Boolean(currentRoom && currentRoom.agents.filter((agent) => agent.archivedAt === undefined).length >= 3)
            if (duplicate || atLimit) {
              if (operation.phase === 'prepared') {
                this.managementJournal.removeRegistration(identity, operation.operationId)
                throw new Error(duplicate ? 'display_name_conflict' : 'agent_limit_reached')
              }
              throw new Error('注册 operation 仍未知且房间本地配置已冲突；journal 已保留，不会删除或创建新 operation')
            }
            operation = this.managementJournal.updateRegistration(identity, operation.operationId, { mode: 'v1', phase: 'submitting' })
            let result: string | ChatRoomManagementReceipt
            try { result = await this.deps.rustApi.registerAgent({ ...registration, operationId: operation.operationId }) }
            catch (error) {
              await this.assertManagementFence(authEpoch, identity, roomFingerprint, operation.operationId)
              operation = this.managementJournal.updateRegistration(identity, operation.operationId, { phase: 'unknown' })
              let recovered: Awaited<ReturnType<ChatRoomMainRustApi['lookupManagementOperation']>>
              try { recovered = await this.deps.rustApi.lookupManagementOperation({ ...registration, operationId: operation.operationId, mode: operation.mode }) }
              catch (statusError) {
                await this.assertManagementFence(authEpoch, identity, roomFingerprint, operation.operationId)
                throw new Error('聊天室 Agent 注册结果未知；operation journal 已保留，状态查询未能确认', { cause: statusError })
              }
              await this.assertManagementFence(authEpoch, identity, roomFingerprint, operation.operationId)
              if (!recovered || !('mode' in recovered) || recovered.mode !== 'v1') {
                throw new Error('聊天室 Agent 注册结果未知；operation journal 已保留', { cause: error })
              }
              if (recovered.receipt) {
                this.managementReceiptAgentId(recovered.receipt, operation, identity)
                result = recovered.receipt
              } else {
                const managementError = error instanceof Error ? error as Error & { httpStatus?: unknown; code?: unknown } : undefined
                const knownConflict = managementError?.httpStatus === 409
                  && (managementError.code === 'agent_name_conflict' || managementError.code === 'agent_limit_reached')
                if (knownConflict) {
                  this.managementJournal.removeRegistration(identity, operation.operationId)
                  throw new Error(managementError.code === 'agent_name_conflict' ? '远端已存在同名 Agent，请更换名称' : '远端 Agent 数量已达上限', { cause: error })
                }
                operation = this.managementJournal.updateRegistration(identity, operation.operationId, { phase: 'submitting' })
                try { result = await this.deps.rustApi.registerAgent({ ...registration, operationId: operation.operationId }) }
                catch (retryError) {
                  await this.assertManagementFence(authEpoch, identity, roomFingerprint, operation.operationId)
                  this.managementJournal.updateRegistration(identity, operation.operationId, { phase: 'unknown' })
                  let finalStatus: Awaited<ReturnType<ChatRoomMainRustApi['lookupManagementOperation']>>
                  try { finalStatus = await this.deps.rustApi.lookupManagementOperation({ ...registration, operationId: operation.operationId, mode: operation.mode }) }
                  catch (statusError) {
                    await this.assertManagementFence(authEpoch, identity, roomFingerprint, operation.operationId)
                    throw new Error('聊天室 Agent 注册结果仍未知；operation journal 已保留，状态查询未能确认', { cause: statusError })
                  }
                  await this.assertManagementFence(authEpoch, identity, roomFingerprint, operation.operationId)
                  if (!finalStatus || !('mode' in finalStatus) || finalStatus.mode !== 'v1' || !finalStatus.receipt) {
                    throw new Error('聊天室 Agent 注册结果仍未知；operation journal 已保留，不会创建新 operation', { cause: retryError })
                  }
                  this.managementReceiptAgentId(finalStatus.receipt, operation, identity)
                  result = finalStatus.receipt
                }
              }
            }
            await this.assertManagementFence(authEpoch, identity, roomFingerprint, operation.operationId)
            if (typeof result === 'string') {
              this.managementJournal.updateRegistration(identity, operation.operationId, { phase: 'unknown' })
              throw new Error('聊天室管理注册回执与 operation 不匹配；journal 已保留')
            }
            const receiptAgentId = this.managementReceiptAgentId(result, operation, identity)
            operation = this.managementJournal.updateRegistration(identity, operation.operationId, {
              phase: 'remote_created', mode: 'v1', roomAgentId: receiptAgentId,
            })
            roomAgentId = operation.roomAgentId
          }
        }
      }

      await this.assertManagementFence(authEpoch, identity, roomFingerprint, operation.operationId)
      let room: ChatRoomLocalRoomConfig
      try {
        const currentRoom = this.deps.store.read(input.roomId)
        if (currentRoom?.agents.some((agent) => agent.archivedAt === undefined && agent.displayName.trim().toLocaleLowerCase('en-US') === canonicalName)) {
          throw new Error('display_name_conflict')
        }
        if (currentRoom && currentRoom.agents.filter((agent) => agent.archivedAt === undefined).length >= 3) throw new Error('agent_limit_reached')
        room = this.deps.store.provisionAgent(identity, operation.input, roomAgentId!, { roomCreatedAt: operation.roomCreatedAt })
      } catch (error) {
        try {
          const partiallySavedRoom = this.deps.store.read(input.roomId)
          if (!this.managementRoomIdentityMatches(operation, partiallySavedRoom)) throw new Error('management_operation_room_identity_mismatch')
          const partiallySavedAgent = partiallySavedRoom?.agents.find((agent) => agent.roomAgentId === roomAgentId)
          if (partiallySavedAgent) {
            if (!this.managementLocalAgentConfigMatches(operation, partiallySavedAgent)) throw new Error('management_operation_local_mismatch')
            return this.finishSavedProvision(identity, operation, partiallySavedRoom!, partiallySavedAgent)
          }
          roomFingerprint = this.managementRoomFingerprint(partiallySavedRoom)
          await this.assertManagementFence(authEpoch, identity, roomFingerprint, operation.operationId)
          if (operation.mode === 'legacy') {
            operation = this.managementJournal.updateRegistration(identity, operation.operationId, { phase: 'legacy_cleanup_unknown' })
            await this.deps.rustApi.unregisterAgent(input.roomId, roomAgentId!)
          } else {
            const compensationOperationId = operation.compensationOperationId ?? randomUUID()
            operation = this.managementJournal.updateRegistration(identity, operation.operationId, {
              phase: 'compensation_pending', compensationOperationId,
            })
            const receipt = await this.deps.rustApi.unregisterAgent(input.roomId, roomAgentId!, { operationId: compensationOperationId, deviceId, hostUserId, mode: 'v1' })
            await this.assertManagementFence(authEpoch, identity, roomFingerprint, operation.operationId)
            this.assertManagementRemovalReceipt(receipt, compensationOperationId, input.roomId, roomAgentId!, identity)
          }
          if (operation.mode === 'legacy') await this.assertManagementFence(authEpoch, identity, roomFingerprint, operation.operationId)
          this.managementJournal.removeRegistration(identity, operation.operationId)
          throw error
        } catch (compensationError) {
          if (compensationError === error) throw error
          throw new Error('Agent 本地配置失败，远端精确补偿尚未确认；journal 已保留，请勿重新注册', { cause: compensationError })
        }
      }
      const savedAgent = this.requireAgent(room, roomAgentId!)
      return this.finishSavedProvision(identity, operation, room, savedAgent)
    } finally {
      this.provisioningRooms.delete(input.roomId)
    }
  }
  async updateAgent(input: UpdateChatRoomAgentInput): Promise<ChatRoomAgentLocalConfig> {
    const identity = await this.requireHostIdentity(input.roomId)
    const currentRoom = this.deps.store.read(input.roomId)
    const currentAgent = this.requireAgent(currentRoom, input.roomAgentId)
    if (currentAgent.archivedAt !== undefined) throw new Error('room_agent_archived')
    const sharing = {
      memoryShared: input.memorySharingEnabled ?? currentAgent.memorySharingEnabled,
      skillsShared: input.skillSharingEnabled ?? currentAgent.skillSharingEnabled,
    }
    const sharingChanged = sharing.memoryShared !== currentAgent.memorySharingEnabled
      || sharing.skillsShared !== currentAgent.skillSharingEnabled
    let resumeSharingOperation = false
    let cleanedLocalSavedOperation = false
    const existingOperation = this.managementJournal.findOperationForAgent(identity, input.roomId, input.roomAgentId)
    if (existingOperation?.phase === 'local_saved') {
      const payloadMatches = this.managementRoomIdentityMatches(existingOperation, currentRoom)
        && this.managementLocalAgentPayloadMatches(existingOperation, currentAgent)
      const localTruthMatches = existingOperation.action === 'update-sharing'
        ? currentAgent.memorySharingEnabled === existingOperation.sharing?.memoryShared
          && currentAgent.skillSharingEnabled === existingOperation.sharing?.skillsShared
        : existingOperation.action === undefined || existingOperation.action === 'register'
          ? this.managementLocalAgentConfigMatches(existingOperation, currentAgent)
          : false
      if (!payloadMatches || !localTruthMatches) throw new Error('management_operation_local_mismatch')
      const fingerprint = this.managementRoomFingerprint(currentRoom)
      await this.assertManagementFence(this.managementAuthEpoch, identity, fingerprint, existingOperation.operationId)
      this.managementJournal.removeRegistration(identity, existingOperation.operationId, existingOperation.revision ?? 0)
      cleanedLocalSavedOperation = true
    } else if (existingOperation) {
      if ((existingOperation.action ?? 'register') !== 'update-sharing'
        || existingOperation.sharing?.memoryShared !== sharing.memoryShared
        || existingOperation.sharing.skillsShared !== sharing.skillsShared) {
        throw new Error('management_operation_pending')
      }
      resumeSharingOperation = true
    }
    if (cleanedLocalSavedOperation && !sharingChanged
      && Object.keys(input).every((key) => ['roomId', 'roomAgentId', 'memorySharingEnabled', 'skillSharingEnabled'].includes(key))) {
      return currentAgent
    }
    if (!sharingChanged && !resumeSharingOperation) {
      const room = this.deps.store.updateAgent(input)
      this.emitConfig(room, input.roomAgentId)
      return this.requireAgent(room, input.roomAgentId)
    }
    if (currentAgent.archivedAt !== undefined) throw new Error('room_agent_archived')
    if (Object.keys(input).some((key) => !['roomId', 'roomAgentId', 'memorySharingEnabled', 'skillSharingEnabled'].includes(key))) {
      throw new Error('management_sharing_mixed_update_unsupported')
    }
    const room = currentRoom!
    const operation = this.managementJournal.prepareSharingUpdate(identity, room, currentAgent, sharing)
    const fingerprint = this.managementRoomFingerprint(room)
    const epoch = this.managementAuthEpoch
    await this.assertManagementFence(epoch, identity, fingerprint, operation.operationId)
    let current = operation
    if (current.phase !== 'remote_updated') {
      if (current.mode === undefined) {
        if (current.phase !== 'prepared') throw new Error('management_operation_mode_unknown')
        const revision = current.revision ?? 0
        const modernManagement = await this.deps.rustApi.probeAgentManagementVersion()
        await this.assertManagementFence(epoch, identity, fingerprint, operation.operationId, revision)
        if (!modernManagement) {
          this.managementJournal.removeRegistration(identity, operation.operationId, revision)
          throw new Error('旧版聊天室服务不支持安全更新共享设置')
        }
      } else if (current.mode !== 'v1') throw new Error('management_operation_mode_mismatch')
      const currentRevision = current.revision ?? 0
      current = this.managementJournal.updateOperation(identity, operation.operationId,
        { mode: 'v1', phase: 'submitting' }, 'update-sharing', currentRevision)
      const submittedRevision = current.revision ?? 0
      let receipt: ChatRoomManagementReceipt
      try {
        receipt = await this.deps.rustApi.updateAgentSharing({
          roomId: current.roomId, roomAgentId: current.roomAgentId!, operationId: current.operationId,
          deviceId: identity.deviceId, hostUserId: identity.hostUserId, mode: 'v1',
          memoryShared: sharing.memoryShared, skillsShared: sharing.skillsShared,
        })
      } catch (error) {
        try {
          await this.assertManagementLocalFence(epoch, identity, fingerprint, operation.operationId, submittedRevision)
          this.managementJournal.updateOperation(identity, operation.operationId, { phase: 'unknown' }, 'update-sharing', submittedRevision)
        }
        catch { this.deps.reportDiagnostic?.('聊天室共享操作状态未知且journal更新失败') }
        throw error
      }
      await this.assertManagementFence(epoch, identity, fingerprint, operation.operationId, submittedRevision)
      this.assertManagementSharingReceipt(receipt, current, identity)
      current = this.managementJournal.updateOperation(identity, current.operationId, { phase: 'remote_updated' }, 'update-sharing', submittedRevision)
    }
    await this.assertManagementFence(epoch, identity, fingerprint, current.operationId, current.revision ?? 0)
    const updatedRoom = this.deps.store.updateAgent({
      roomId: input.roomId, roomAgentId: input.roomAgentId,
      memorySharingEnabled: sharing.memoryShared, skillSharingEnabled: sharing.skillsShared,
    })
    try {
      current = this.managementJournal.updateOperation(identity, current.operationId, { phase: 'local_saved' }, 'update-sharing', current.revision ?? 0)
    } catch {
      this.deps.reportDiagnostic?.('聊天室共享已持久化，journal完成标记失败，保留远端操作回执')
      this.emitConfig(updatedRoom, input.roomAgentId)
      return this.requireAgent(updatedRoom, input.roomAgentId)
    }
    this.emitConfig(updatedRoom, input.roomAgentId)
    try { this.managementJournal.removeRegistration(identity, current.operationId, current.revision ?? 0) }
    catch { this.deps.reportDiagnostic?.('聊天室共享已保存，管理journal清理失败') }
    return this.requireAgent(updatedRoom, input.roomAgentId)
  }
  async removeAgent(input: RemoveChatRoomAgentInput): Promise<void> {
    const identity = await this.requireHostIdentity(input.roomId)
    const room = this.deps.store.read(input.roomId)
    const agent = this.requireAgent(room, input.roomAgentId)
    const existingOperation = this.managementJournal.findOperationForAgent(identity, input.roomId, input.roomAgentId, 'remove')
    if (existingOperation?.mode === 'legacy' && existingOperation.phase === 'legacy_unknown') {
      throw new Error('旧版聊天室删除结果未知且无远端操作回执；journal 已保留，不能盲目重试')
    }
    const fingerprint = this.managementRoomFingerprint(room)
    const epoch = this.managementAuthEpoch
    let operation: ChatRoomManagementOperation
    if (agent.archivedAt !== undefined) {
      if (!existingOperation) throw new Error('management_operation_not_found')
      if (!this.managementRoomIdentityMatches(existingOperation, room)
        || !this.managementLocalAgentPayloadMatches(existingOperation, agent)) throw new Error('management_operation_room_identity_mismatch')
      operation = existingOperation
      await this.assertManagementFence(epoch, identity, fingerprint, operation.operationId)
      if (operation.phase === 'local_saved') {
        this.managementJournal.removeRegistration(identity, existingOperation.operationId, operation.revision ?? 0)
        return
      }
      if (operation.phase === 'remote_removed') {
        operation = this.managementJournal.updateOperation(identity, operation.operationId, { phase: 'local_saved' }, 'remove', operation.revision ?? 0)
        this.managementJournal.removeRegistration(identity, operation.operationId, operation.revision ?? 0)
        return
      }
    } else {
      operation = existingOperation ?? this.managementJournal.prepareRemoval(identity, room!, agent)
      if (operation.phase === 'local_saved') throw new Error('management_operation_local_mismatch')
    }
    // 先触发 journal-aware readiness 立即撤销 runtime ready；失败仍保留 pending 屏障。
    await this.deps.readiness?.configurationChanged(input.roomId)
    await this.assertManagementFence(epoch, identity, fingerprint, operation.operationId)
    const runs = [...this.activeRuns.values()].filter((run) => run.invocation.roomId === input.roomId && run.config.roomAgentId === agent.roomAgentId)
    for (const run of runs) { run.stopRequested = true; run.executionAbort.abort(); run.requestAbort?.abort() }
    this.denyAgentPendingPermissions(input.roomId, agent.roomAgentId)
    for (const run of runs) {
      const stoppedPromise = this.stopAgentBounded(run.config.sessionId, run.workerRunId)
      await this.failTerminal(run, 'agent_offline')
      const stopped = await stoppedPromise
      const finalized = run.terminalConfirmed || await this.awaitFinalization(run)
      const nativeStopped = stopped && (!run.executionBound || await this.releaseExecutionBinding(run))
      const terminalRecord = this.deps.store.getInvocation(input.roomId, run.invocation.invocationId)
      let durablePending = false
      try { durablePending = this.deps.store.listPendingResults(input.roomId).some((record) => record.invocationId === run.invocation.invocationId) }
      catch { durablePending = false }
      const terminalStateKnown = Boolean(terminalRecord && ['completed', 'failed'].includes(terminalRecord.status))
      if (!stopped || !nativeStopped || (!finalized && !terminalStateKnown && !durablePending)) {
        throw new Error('聊天室 Agent 本地/native 停止或唯一结果持久化未知；移除操作已保留')
      }
    }
    await this.assertManagementFence(epoch, identity, fingerprint, operation.operationId, operation.revision ?? 0)
    let receipt: void | ChatRoomManagementReceipt | ChatRoomLegacyRemovalConfirmation
    if (operation.phase !== 'remote_removed') {
      let managementMode = operation.mode
      let expectedRevision = operation.revision ?? 0
      if (managementMode === undefined) {
        if (operation.phase !== 'prepared') throw new Error('management_operation_mode_unknown')
        const modernManagement = await this.deps.rustApi.probeAgentManagementVersion()
        await this.assertManagementFence(epoch, identity, fingerprint, operation.operationId, expectedRevision)
        managementMode = modernManagement ? 'v1' : 'legacy'
      }
      operation = this.managementJournal.updateOperation(identity, operation.operationId,
        { mode: managementMode, phase: 'submitting' }, 'remove', expectedRevision)
      expectedRevision = operation.revision ?? 0
      if (managementMode === 'legacy') {
        if (!await this.releaseLease(input.roomId, agent.roomAgentId)) throw new Error('旧版聊天室 Agent 精确租约释放未确认；journal 已保留')
        await this.assertManagementFence(epoch, identity, fingerprint, operation.operationId, expectedRevision)
        operation = this.managementJournal.updateOperation(identity, operation.operationId, { phase: 'legacy_unknown' }, 'remove', expectedRevision)
        expectedRevision = operation.revision ?? 0
      }
      try {
        receipt = await this.deps.rustApi.unregisterAgent(input.roomId, agent.roomAgentId, {
          operationId: operation.operationId, deviceId: identity.deviceId, hostUserId: identity.hostUserId, mode: managementMode,
        })
      } catch (error) {
        if (managementMode === 'v1') {
          try {
            await this.assertManagementLocalFence(epoch, identity, fingerprint, operation.operationId, expectedRevision)
            this.managementJournal.updateOperation(identity, operation.operationId, { phase: 'unknown' }, 'remove', expectedRevision)
          } catch { this.deps.reportDiagnostic?.('聊天室移除结果未知，但身份或operation revision已变化；保留最后已确认阶段') }
        }
        throw error
      }
      await this.assertManagementFence(epoch, identity, fingerprint, operation.operationId, expectedRevision)
      this.assertManagementRemovalReceipt(receipt, operation.operationId, input.roomId, agent.roomAgentId, identity)
      operation = this.managementJournal.updateOperation(identity, operation.operationId, { phase: 'remote_removed' }, 'remove', expectedRevision)
    } else {
      await this.assertManagementFence(epoch, identity, fingerprint, operation.operationId, operation.revision ?? 0)
    }
    for (const run of runs) {
      const released = run.terminalConfirmed ? this.cleanupActiveRun(run) : this.releaseRunResources(run)
      if (!released) throw new Error('聊天室 Agent 已远端移除，本机会话资源清理未确认；journal 已保留')
    }
    const savedRoom = agent.archivedAt === undefined
      ? this.deps.store.archiveAgent(input)
      : this.deps.store.read(input.roomId)!
    try {
      operation = this.managementJournal.updateOperation(identity, operation.operationId, { phase: 'local_saved' }, 'remove', operation.revision ?? 0)
    } catch {
      this.deps.reportDiagnostic?.('聊天室远端已移除，本地归档成功但journal完成标记失败')
      this.emitConfig(savedRoom)
      return
    }
    this.emitConfig(savedRoom)
    try { this.managementJournal.removeRegistration(identity, operation.operationId, operation.revision ?? 0) }
    catch { this.deps.reportDiagnostic?.('聊天室 Agent 已归档，管理journal清理失败') }
  }
  async syncAgentSkills(input: SyncChatRoomAgentSkillsInput): Promise<ChatRoomAgentLocalConfig> {
    await this.requireHostIdentity(input.roomId)
    const config = this.requireAgent(this.deps.store.read(input.roomId), input.roomAgentId)
    const result = this.deps.syncSkills({ roomId: input.roomId, roomAgentId: input.roomAgentId, sourceWorkspaceSlug: this.deps.getSourceWorkspaceSlug?.(config.sourceWorkspaceId) ?? config.sourceWorkspaceId })
    const room = this.deps.store.updateAgentSkillSnapshot(input.roomId, input.roomAgentId, result)
    this.emitConfig(room)
    return this.requireAgent(room, input.roomAgentId)
  }
  async handleInvocation(input: ChatRoomAgentInvocation, origin?: ChatRoomGatewayOrigin): Promise<'accepted' | 'duplicate'> {
    if (this.disposed) return 'duplicate'
    if (!origin && !this.deps.allowLegacyInvocations) return 'duplicate'
    if (origin && (!Number.isSafeInteger(origin.clientGeneration) || origin.clientGeneration <= 0
      || !Number.isSafeInteger(origin.socketGeneration) || origin.socketGeneration <= 0
      || !Number.isSafeInteger(origin.authEpoch) || origin.authEpoch < 0)) return 'duplicate'
    const generation = this.leaseGeneration
    const authenticatedUserId = await this.deps.getCurrentUserId()
    if (generation !== this.leaseGeneration || this.disposed) return 'duplicate'
    const authenticatedDeviceId = this.deps.getDeviceId()
    let room = this.deps.store.read(input.roomId)
    if (room && (authenticatedUserId !== room.hostUserId || authenticatedDeviceId !== room.deviceId)) {
      await this.reportRejected(input, 'not_room_member')
      return 'accepted'
    }
    if (room && this.activeRuns.has(input.invocationId)) return 'duplicate'
    if (room && (this.deps.store.getInvocation(input.roomId, input.invocationId) || this.deps.store.getTraceAgentInvocation(input.roomId, input.traceId, input.targetAgentId))) {
      await this.releaseUnclaimedInvocationSource(input, room, origin)
      return 'duplicate'
    }
    if (room && (await this.deps.getCurrentUserId()) !== authenticatedUserId) {
      await this.reportRejected(input, 'not_room_member')
      return 'accepted'
    }
    if (generation !== this.leaseGeneration || this.disposed) return 'duplicate'
    // 身份读取包含 await；回到同步临界区前必须重新加载 room/config/ledger，避免 ABA。
    const finalUserId = await this.deps.getCurrentUserId()
    const finalRoom = this.deps.store.read(input.roomId)
    if (generation !== this.leaseGeneration || this.disposed) return 'duplicate'
    if (!finalRoom || finalUserId !== finalRoom.hostUserId || this.deps.getDeviceId() !== finalRoom.deviceId || finalUserId !== authenticatedUserId || this.deps.getDeviceId() !== authenticatedDeviceId) {
      await this.reportRejected(input, 'not_room_member', finalRoom, input.targetAgentId)
      return 'accepted'
    }
    if (finalRoom && this.activeRuns.has(input.invocationId)) return 'duplicate'
    if (finalRoom && (this.deps.store.getInvocation(input.roomId, input.invocationId) || this.deps.store.getTraceAgentInvocation(input.roomId, input.traceId, input.targetAgentId))) {
      await this.releaseUnclaimedInvocationSource(input, finalRoom, origin)
      return 'duplicate'
    }
    room = finalRoom
    const config = room?.agents.find((agent) => agent.roomAgentId === input.targetAgentId && agent.archivedAt === undefined)
    if (!room || !config) { await this.reportRejected(input, 'room_agent_not_found'); return 'accepted' }
    // 先为可信本地 Agent 建立 created 上下文，使拒绝回传能经 Rust client 严格校验；这不是服务端 accepted/failed 证明。
    const now = this.deps.now()
    const record: ChatRoomInvocationRecord = { invocationId: input.invocationId, roomId: input.roomId, traceId: input.traceId, targetAgentId: input.targetAgentId, triggerMessageId: input.triggerMessageId, depth: input.depth, status: 'created', createdAt: Math.min(now, input.receivedAt), updatedAt: now }
    const createdRecord = this.deps.store.upsertInvocation(input.roomId, record)
    const rejectionGuard: RejectedInvocationGuard = {
      identity: { hostUserId: finalUserId!, deviceId: authenticatedDeviceId },
      generation,
      lifecycle: this.lifecycle,
      createdRecord,
    }
    let managementPending = true
    try { managementPending = this.managementJournal.hasPendingForAgent({ hostUserId: finalUserId!, deviceId: authenticatedDeviceId }, input.roomId, input.targetAgentId) }
    catch { managementPending = true }
    if (managementPending) {
      await this.reportRejected(input, 'agent_offline', room, input.targetAgentId, rejectionGuard)
      return 'accepted'
    }
    if (this.lifecycle === 'stopping' || this.lifecycle === 'auth_required' || this.lifecycle === 'disposed') { await this.reportRejected(input, 'agent_offline', room, input.targetAgentId, rejectionGuard); return 'accepted' }
    if (input.depth >= CHATROOM_MAX_DEPTH) { await this.reportRejected(input, 'invocation_depth_exceeded', room, input.targetAgentId, rejectionGuard); return 'accepted' }
    let pendingRecords: ChatRoomPendingResultRecord[]
    try { pendingRecords = this.pendingRecordsForIdentity(finalUserId!, authenticatedDeviceId) }
    catch { this.deps.reportDiagnostic?.('聊天室待确认结果读取失败，拒绝新执行且保留本地文件'); await this.reportRejected(input, 'agent_busy', room, input.targetAgentId, rejectionGuard); return 'accepted' }
    if (this.pendingStatusRecoveryOperation) {
      await this.reportRejected(input, 'agent_busy', room, input.targetAgentId, rejectionGuard)
      this.deps.reportDiagnostic?.('聊天室待确认结果恢复正在进行，拒绝新执行并保留本地记录')
      return 'accepted'
    }
    const outstanding = new Set<string>([
      ...this.activeRuns.keys(), ...this.unconfirmedTerminalIds,
      ...pendingRecords.map((record) => record.invocationId),
    ])
    if (pendingRecords.length > MAX_PENDING_TERMINAL_RESULTS || outstanding.size >= MAX_PENDING_TERMINAL_RESULTS) {
      await this.reportRejected(input, 'agent_busy', room, input.targetAgentId, rejectionGuard)
      this.deps.reportDiagnostic?.('聊天室待确认结果已达到恢复上限，拒绝新执行但保留所有已有回复')
      return 'accepted'
    }
    if ([...this.activeRuns.values()].some((run) => run.invocation.roomId === input.roomId && run.config.roomAgentId === config.roomAgentId)) { await this.reportRejected(input, 'agent_busy', room, input.targetAgentId, rejectionGuard); return 'accepted' }
    if (this.lifecycle === 'disconnected') {
      this.lifecycle = 'ready'
      this.releasedLeaseKeys.clear()
    }
    this.activeRuns.set(input.invocationId, { invocation: input, config, userId: finalUserId!, deviceId: authenticatedDeviceId, generation, origin: origin ? { ...origin } : undefined, stopRequested: false, terminal: false, terminalConfirmed: false, cleanupDone: false, completionClaimed: false, lastDeltaAt: -Infinity, workerRunId: randomUUID(), executionAbort: new AbortController() })
    const run = this.activeRuns.get(input.invocationId)
    if (!run) return 'accepted'
    const accepted = await this.requestLifecycle(run, (signal) => this.deps.rustApi.reportAccepted({ invocationId: input.invocationId }, { signal }))
    if (!await this.isRunCurrent(run)) { await this.releaseUnstartedRun(run); return 'accepted' }
    const acceptedOriginMatched = !origin || (accepted && typeof accepted === 'object' && (accepted as Partial<ChatRoomLifecycleResult>).generation === origin.socketGeneration)
    if (!acceptedOriginMatched) { this.deps.reportDiagnostic?.('聊天室 accepted proof 来源代际不匹配，不启动 SDK'); await this.failUnstartedRun(run); return 'accepted' }
    if (!this.lifecycleConfirmed(accepted, run, 'agent.accepted', 'accepted')) {
      if (this.lifecycleConfirmed(accepted, run, 'agent.accepted', 'running')) {
        const stampedAt = this.deps.now()
        this.deps.store.transitionInvocation(input.roomId, input.invocationId, ['created'], (current) => ({ ...current, status: 'running', acceptedAt: stampedAt, startedAt: stampedAt, updatedAt: stampedAt }))
        await this.releaseUnstartedRun(run)
        return 'accepted'
      }
      this.deps.reportDiagnostic?.('聊天室 accepted 状态未获服务端确认，保留本地 created 占位')
      await this.failUnstartedRun(run)
      return 'accepted'
    }
    const acceptedAt = this.deps.now()
    const acceptedRecord = this.deps.store.transitionInvocation(input.roomId, input.invocationId, ['created'], (current) => ({ ...current, status: 'accepted', acceptedAt, updatedAt: acceptedAt }))
    if (!await this.isRunCurrent(run)) { await this.releaseUnstartedRun(run); return 'accepted' }
    if (!acceptedRecord.transitioned) { await this.failUnstartedRun(run); return 'accepted' }
    const runningReceipt = await this.requestLifecycle(run, (signal) => this.deps.rustApi.reportRunning({ invocationId: input.invocationId }, { signal }))
    if (!await this.isRunCurrent(run)) { await this.releaseUnstartedRun(run); return 'accepted' }
    const confirmedRunning = this.lifecycleConfirmed(runningReceipt, run, 'agent.running', 'running')
    const legacyAdvisory = this.isLegacyRunningAdvisory(runningReceipt, run)
    const runningOriginMatched = !origin || (runningReceipt && typeof runningReceipt === 'object' && (runningReceipt as Partial<ChatRoomLifecycleResult>).generation === origin.socketGeneration)
    if ((!confirmedRunning && !legacyAdvisory) || !runningOriginMatched) {
      this.deps.reportDiagnostic?.('聊天室 running 状态未获服务端确认，不启动 SDK')
      await this.failUnstartedRun(run)
      return 'accepted'
    }
    const startedAt = this.deps.now()
    const runningRecord = this.deps.store.transitionInvocation(input.roomId, input.invocationId, ['accepted'], (current) => ({ ...current, status: 'running', startedAt, updatedAt: startedAt }))
    if (!await this.isRunCurrent(run)) { await this.releaseUnstartedRun(run); return 'accepted' }
    if (!runningRecord.transitioned) { await this.failUnstartedRun(run); return 'accepted' }
    if (origin) {
      let bound = false
      try {
        bound = await this.deps.rustApi.bindExecution?.({ invocation: input, targetAgentId: config.roomAgentId, sessionId: config.sessionId, workerRunId: run.workerRunId, origin }) === true
      } catch { bound = false }
      if (!bound || !await this.isRunCurrent(run)) {
        await this.releaseExecutionBinding(run)
        this.deps.reportDiagnostic?.('聊天室 Native execution binding 未确认，不启动 SDK')
        run.stopRequested = true
        run.executionAbort.abort()
        await this.failUnstartedRun(run)
        return 'accepted'
      }
      run.executionBound = true
    }
    if (this.pendingStatusRecoveryOperation) {
      this.deps.reportDiagnostic?.('聊天室待确认结果恢复期间不启动新的 SDK')
      await this.failUnstartedRun(run)
      return 'accepted'
    }
    run.finalization = this.execute(run)
    return 'accepted'
  }
  async handleGatewayDisconnected(): Promise<void> {
    this.deps.readiness?.invalidateConnection()
    if (this.disposed || this.lifecycle === 'auth_required' || this.lifecycle === 'disconnected') return
    await this.stopAll('gateway_disconnected')
  }
  /** Rust 通过受控 internal bridge 转交的当前 socket terminal proof；只撤销精确活动 run。 */
  async handleTrustedServerFailure(input: { roomId: string; invocationId: string; failureCode: ChatRoomInvocationFailureCode; origin: ChatRoomGatewayOrigin }): Promise<ChatRoomTrustedFailureResult> {
    const run = this.activeRuns.get(input.invocationId)
    if (!run) return 'ignored'
    while (run.terminalRevocation) {
      const previous = run.terminalRevocation
      const previousResult = await previous.promise
      if (previousResult !== 'retry') return previousResult
      if (run.terminalRevocation !== previous) continue
      run.terminalRevocation = undefined
    }
    let resolveRevocation!: (value: ChatRoomTrustedFailureResult) => void
    const revocationPromise = new Promise<ChatRoomTrustedFailureResult>((resolve) => { resolveRevocation = resolve })
    const operation = { promise: revocationPromise, resolve: resolveRevocation }
    run.terminalRevocation = operation
    let result: ChatRoomTrustedFailureResult = 'ignored'
    try { result = await this.applyTrustedServerFailure(run, input); return result }
    catch { result = 'retry'; this.deps.reportDiagnostic?.('聊天室服务端终态 handoff 落账异常，保留 owner 等待重试'); return result }
    finally {
      operation.resolve(result)
      if (result === 'ignored' && this.activeRuns.get(input.invocationId) === run && run.terminalRevocation === operation) run.terminalRevocation = undefined
    }
  }

  private async applyTrustedServerFailure(run: ActiveRun, input: { roomId: string; invocationId: string; failureCode: ChatRoomInvocationFailureCode; origin: ChatRoomGatewayOrigin }): Promise<ChatRoomTrustedFailureResult> {
    if (run.invocation.roomId !== input.roomId || !run.origin
      || run.origin.clientGeneration !== input.origin.clientGeneration
      || run.origin.socketGeneration !== input.origin.socketGeneration
      || run.origin.authEpoch !== input.origin.authEpoch) return 'ignored'
    const repeatedRevocation = run.stopRequested && run.terminal && run.failureClaim?.code === input.failureCode
    if (!repeatedRevocation && (!await this.isRunCurrent(run) || this.activeRuns.get(input.invocationId) !== run || run.terminal || run.stopRequested)) return 'ignored'
    const currentRecord = this.deps.store.getInvocation(input.roomId, input.invocationId)
    if (!currentRecord || !['created', 'accepted', 'running'].includes(currentRecord.status)) return 'ignored'
    if (run.terminalConfirmed || run.completionClaimed) {
      // A completed candidate is unique user output; terminal revocation may stop its owner but never discard that candidate.
    }
    if (!repeatedRevocation) {
      run.serverTerminalReceived = true
      run.stopRequested = true
      run.terminal = true
      run.failureClaim = { code: input.failureCode, message: failureMessage(input.failureCode) }
      run.requestAbort?.abort()
      run.executionAbort.abort()
      for (const [requestId, pending] of this.pendingPermissions) {
        if (pending.invocationId !== input.invocationId || pending.roomId !== input.roomId) continue
        clearTimeout(pending.timer)
        this.pendingPermissions.delete(requestId)
        ;(this.deps.permissionService ?? permissionService).respondToPermission(requestId, 'deny', false)
      }
    }

    let pendingBefore: ChatRoomPendingResultRecord[] | undefined
    try { pendingBefore = this.deps.store.listPendingResults(input.roomId).filter((item) => item.invocationId === input.invocationId) }
    catch { pendingBefore = undefined }
    if (!await this.stopAgentBounded(run.config.sessionId, run.workerRunId)) {
      this.deps.reportDiagnostic?.('聊天室 Native owner stop 未确认，保留本地运行记录等待重试')
      return 'retry'
    }
    const ownerStatus = await this.trustedTerminalOwnerIsCurrent(run, currentRecord, pendingBefore)
    if (ownerStatus !== 'current') {
      this.deps.reportDiagnostic?.('聊天室服务端失败证明停止后 owner 或元数据已变化，拒绝写入旧终态')
      if (ownerStatus === 'unknown') return 'retry'
      this.releaseRunResources(run)
      return 'ignored'
    }

    const now = this.deps.now()
    const transition = this.deps.store.transitionInvocation(input.roomId, input.invocationId, ['created', 'accepted', 'running'], (current) => ({
      ...current,
      status: 'failed',
      updatedAt: now,
      finishedAt: now,
      failureCode: input.failureCode,
      failureMessage: run.failureClaim!.message,
    }))
    if (!transition.transitioned) {
      this.deps.reportDiagnostic?.('聊天室服务端失败证明已收到但本地状态无法提交，保留运行记录供恢复')
      this.releaseRunResources(run)
      return 'ignored'
    }
    // 此终态来自当前认证 socket 的 server event，不需再次向服务端申领 terminal。
    run.terminalConfirmed = true
    const pending = this.pendingResultRecords.get(input.invocationId)
    const matchingFailedPending = pending
      && pending.expectedStatus === 'failed'
      && pending.failureCode === input.failureCode
      && pending.hostUserId === run.userId && pending.deviceId === run.deviceId
      && pending.roomId === run.invocation.roomId && pending.invocationId === run.invocation.invocationId
      && pending.traceId === run.invocation.traceId && pending.targetAgentId === run.invocation.targetAgentId
      && pending.triggerMessageId === run.invocation.triggerMessageId
      && pending.clientMessageId === run.invocation.triggerMessageId && pending.depth === run.invocation.depth
    if (matchingFailedPending) {
      try {
        if (this.deps.store.removePendingResultIfUnchanged(pending)) {
          this.pendingResultRecords.delete(input.invocationId)
          this.pendingResults.delete(input.invocationId)
          this.volatilePendingResults.delete(input.invocationId)
        } else this.deps.reportDiagnostic?.('聊天室服务端失败证明后的 pending revision 已变化，保留待确认文件')
      } catch { this.deps.reportDiagnostic?.('聊天室服务端失败证明后的 pending 清理失败，保留待确认文件') }
    }
    this.unconfirmedTerminalIds.delete(input.invocationId)
    this.pendingFailureClaims.delete(input.invocationId)
    this.cleanupActiveRun(run)
    return 'handled'
  }
  async requestWorkerPermission(input: { sessionId: string; requestId: string; toolName: string; toolInput: Record<string, unknown>; description?: string }): Promise<{ behavior: 'allow' | 'deny'; message?: string }> {
    const run = [...this.activeRuns.values()].find((candidate) => candidate.config.sessionId === input.sessionId)
    if (!run || run.terminal || run.stopRequested) return { behavior: 'deny', message: '聊天室运行已结束' }
    if (this.pendingPermissions.has(input.requestId)) return { behavior: 'deny', message: 'permission_request_duplicate' }
    const request: PermissionRequest = { requestId: input.requestId, sessionId: input.sessionId, toolName: input.toolName, toolInput: input.toolInput, description: input.description ?? '聊天室 Agent 请求主理人授权', dangerLevel: 'dangerous', allowAlways: false }
    const service = this.deps.permissionService ?? permissionService
    const hostRequest = this.requestPermission(run.invocation, run.config, request, false)
    try {
      const result = await service.openExternalApproval(request, AbortSignal.timeout(this.deps.permissionTimeoutMs ?? 60_000), () => { if (hostRequest) this.emitPermissionRequest(hostRequest) })
      return result.behavior === 'allow' ? { behavior: 'allow' } : { behavior: 'deny', message: result.message }
    } catch {
      const pending = this.pendingPermissions.get(input.requestId)
      if (pending) {
        clearTimeout(pending.timer)
        this.pendingPermissions.delete(input.requestId)
      }
      run.stopRequested = true
      run.executionAbort.abort()
      await this.failTerminal(run, 'host_approval_denied')
      void this.stopAgentBounded(run.config.sessionId, run.workerRunId)
      return { behavior: 'deny', message: '权限请求发送失败' }
    }
  }
  async respondToPermission(input: ChatRoomPermissionResponse): Promise<void> {
    const pending = this.pendingPermissions.get(input.requestId)
    if (!pending) throw new Error('permission_not_found')
    const userId = await this.deps.getCurrentUserId(); const room = this.deps.store.read(pending.roomId)
    const run = this.activeRuns.get(pending.invocationId)
    if (!room || !run || run.config.sessionId !== pending.request.sessionId || userId !== pending.hostUserId || userId !== room.hostUserId || room.deviceId !== this.deps.getDeviceId()) throw new Error('not_room_host')
    if (this.deps.now() >= pending.expiresAt) {
      clearTimeout(pending.timer)
      this.pendingPermissions.delete(input.requestId)
      const service = this.deps.permissionService ?? permissionService
      service.respondToPermission(input.requestId, 'deny', false)
      if (run) { run.stopRequested = true; run.executionAbort.abort(); await this.failTerminal(run, 'host_approval_timeout'); void this.stopAgentBounded(run.config.sessionId, run.workerRunId) }
      throw new Error('permission_expired')
    }
    clearTimeout(pending.timer); this.pendingPermissions.delete(input.requestId)
    const resolved = (this.deps.permissionService ?? permissionService).respondToPermission(input.requestId, input.behavior, false)
    if (!resolved) throw new Error('permission_not_found')
    if (input.behavior === 'deny' && run) { run.stopRequested = true; run.executionAbort.abort(); await this.failTerminal(run, 'host_approval_denied'); void this.stopAgentBounded(run.config.sessionId, run.workerRunId) }
  }
  async stopAll(reason: 'logout' | 'gateway_disconnected' | 'app_quit'): Promise<{ stoppedSessionIds: string[]; releasedRoomAgentIds: string[] }> {
    if (reason !== 'gateway_disconnected') this.managementAuthEpoch++
    if (this.leaseRecoveryTimer) clearTimeout(this.leaseRecoveryTimer)
    this.leaseRecoveryTimer = undefined
    if (this.stopping) {
      if (this.stoppingReason && STOP_REASON_PRIORITY[reason] > STOP_REASON_PRIORITY[this.stoppingReason]) {
        this.stoppingReason = reason
        this.lifecycle = 'stopping'
        this.terminalOperationEpoch++
        this.pendingFailureRetryOperation?.controller.abort()
        this.pendingStatusRecoveryOperation?.abort()
        for (const run of this.activeRuns.values()) { run.executionAbort.abort(); run.requestAbort?.abort() }
      }
      return this.stopping
    }
    this.leaseGeneration++
    this.deps.readiness?.invalidateConnection()
    this.terminalOperationEpoch++
    this.pendingFailureRetryOperation?.controller.abort()
    this.pendingStatusRecoveryOperation?.abort()
    this.lifecycle = 'stopping'; this.stoppingReason = reason
    const stopEpoch = this.terminalOperationEpoch
    this.stopping = (async () => {
      const runs = [...this.activeRuns.values()]
      this.denyPendingPermissions()
      const finalized = await Promise.all(runs.map(async (run) => {
        run.stopRequested = true
        run.executionAbort.abort()
        run.requestAbort?.abort()
        const stopped = this.stopAgentBounded(run.config.sessionId, run.workerRunId)
        await this.failTerminal(run, reason === 'app_quit' ? 'app_quit' : reason === 'logout' ? 'internal_error' : 'gateway_disconnected')
        await stopped
        const terminalConfirmed = await this.awaitFinalization(run)
        return terminalConfirmed && this.cleanupActiveRun(run)
      }))
      const activeInvocationIds = new Set(runs.map((run) => run.invocation.invocationId))
      const retryClaims = [...this.pendingFailureClaims.entries()]
        .filter(([invocationId]) => !activeInvocationIds.has(invocationId) || this.terminalOperationEpoch !== stopEpoch)
        .map(([, claim]) => claim)
      await this.retryPendingFailuresBounded(retryClaims)
      const allCleaned = finalized.every(Boolean) && this.unconfirmedTerminalIds.size === 0 && !this.hasPersistedPendingResults()
      const leases = allCleaned
        ? this.deps.store.listRestorableRooms().flatMap((room) => room.agents.filter((agent) => agent.archivedAt === undefined).map((agent) => ({ roomId: room.roomId, roomAgentId: agent.roomAgentId })))
        : []
      const uniqueLeases = [...new Map(leases.map((lease) => [`${lease.roomId}\0${lease.roomAgentId}`, lease])).values()]
      const pendingLeases = uniqueLeases.filter((lease) => !this.releasedLeaseKeys.has(`${lease.roomId}\0${lease.roomAgentId}`))
      const releasedRoomAgentIds: string[] = []
      for (let index = 0; index < pendingLeases.length; index += 3) {
        const batch = pendingLeases.slice(index, index + 3)
        try {
          await this.deps.rustApi.releaseAgentLeases({ roomAgentIds: batch.map((lease) => lease.roomAgentId), leases: batch, reason })
          batch.forEach((lease) => {
            this.releasedLeaseKeys.add(`${lease.roomId}\0${lease.roomAgentId}`)
            releasedRoomAgentIds.push(lease.roomAgentId)
          })
        } catch {
          this.deps.reportDiagnostic?.('聊天室 Agent lease 释放失败')
        }
      }
      return { stoppedSessionIds: runs.map((run) => run.config.sessionId), releasedRoomAgentIds }
    })().finally(() => {
      // 即使目录读取或终态清理失败，也不能保留 rejected Promise 并永久锁住协调器。
      const finalReason = this.stoppingReason ?? reason
      this.stopping = undefined
      this.lifecycle = finalReason === 'logout' ? 'auth_required' : finalReason === 'gateway_disconnected' ? 'disconnected' : 'stopping'
      if (finalReason === 'gateway_disconnected') this.scheduleLeaseRecovery()
    })
    return this.stopping
  }
  async resumeAfterAuthentication(): Promise<void> { const stopping = this.stopping; if (stopping) await stopping; if (this.disposed || this.stoppingReason === 'app_quit') return; this.deps.readiness?.authenticationRefreshed(); if (this.lifecycle === 'auth_required') { this.lifecycle = 'ready'; this.stoppingReason = undefined; this.releasedLeaseKeys.clear() } await this.resumeLeases() }
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.terminalOperationEpoch++
    this.pendingFailureRetryOperation?.controller.abort()
    this.pendingStatusRecoveryOperation?.abort()
    for (const run of this.activeRuns.values()) { run.executionAbort.abort(); run.requestAbort?.abort() }
    await this.stopAll('app_quit')
    await this.deps.readiness?.dispose()
    this.disposed = true; this.lifecycle = 'disposed'; this.unsubscribeEvents?.(); this.unsubscribeEvents = undefined
  }

  private async execute(run: ActiveRun): Promise<void> {
    const { invocation, config } = run
    try {
      if (run.executionAbort.signal.aborted || !await this.isRunCurrent(run)) return
      const roster = await this.deps.rustApi.getRoomAgentRoster(invocation.roomId, { signal: run.executionAbort.signal })
      if (run.executionAbort.signal.aborted || !await this.isRunCurrent(run)) return
      const currentRoom = this.deps.store.read(invocation.roomId)
      if (!isValidPublicAgentRoster(roster)
        || roster.roomId !== invocation.roomId
        || roster.hostUserId !== run.userId
        || currentRoom?.hostUserId !== run.userId
        || currentRoom.deviceId !== run.deviceId
        || !roster.agents.some((agent) => agent.roomAgentId === config.roomAgentId)) {
        await this.failTerminal(run, 'invalid_invocation')
        return
      }
      const hidden = this.deps.createHiddenSessionStore(invocation.roomId, config)
      run.sessionRelease = this.deps.registerSessionStorageOverride(config.sessionId, hidden)
      const context = this.createRuntimeContext(invocation, config, roster.agents)
      if (config.skillSharingEnabled) {
        const skillPath = context.skillSnapshotPath
        if (!skillPath || !existsSync(skillPath) || !lstatSync(skillPath).isDirectory() || !config.skillSnapshotDigest || computeChatRoomSkillSnapshotDigest(skillPath) !== config.skillSnapshotDigest) {
          await this.failTerminal(run, 'invalid_invocation')
          return
        }
      }
      const current = this.deps.store.getInvocation(invocation.roomId, invocation.invocationId)
      if (!current || current.status !== 'running') return
      let runError: string | undefined; let messages: AgentMessage[] | undefined
      const contextMessages = invocation.messages.slice(-config.contextMessageCount)
      const input: AgentSendInput = { sessionId: config.sessionId, userMessage: contextMessages.map((message) => `${message.sender.displayName}: ${message.text}`).join('\n'), rawUserMessage: contextMessages.at(-1)?.text ?? '', channelId: config.channelId, modelId: config.modelId, workspaceId: config.sourceWorkspaceId, agentRuntime: 'pi', triggeredBy: 'user' }
      await this.deps.runAgentHeadless(input, { source: 'chatroom', trustedRuntimeContext: context, signal: run.executionAbort.signal, trustedRunId: run.workerRunId, isTrustedRunCurrent: () => this.isRunCurrent(run), onError: (error) => { runError = error }, onComplete: (completed) => { messages = completed }, onTitleUpdated: () => {} })
      if (!await this.isRunCurrent(run)) return
      if (run.stopRequested || runError) { await this.failTerminal(run, run.stopRequested ? 'gateway_disconnected' : 'internal_error'); return }
      const room = this.deps.store.read(invocation.roomId)
      const allowedAttachmentIds = [...new Set(invocation.messages.flatMap((message) => message.attachmentIds ?? []))]
      const sanitizerContext = this.createSanitizerContext(invocation, config, room, allowedAttachmentIds)
      const output = parseAndSanitizeChatRoomAgentOutput(latestAssistantText(messages), sanitizerContext)
      if (run.terminal || run.completionClaimed) return
      const record = this.deps.store.getInvocation(invocation.roomId, invocation.invocationId)
      if (!record || ['completed', 'failed', 'rejected'].includes(record.status)) return
      // 先在 Main 同步临界区声明完成权，断连/拒绝的 late callback 不得倒写 failed。
      run.completionClaimed = true
      const replyDigest = computeChatRoomReplyDigest({ ...output, clientMessageId: invocation.triggerMessageId })
      this.volatilePendingResults.set(invocation.invocationId, { roomId: invocation.roomId, invocationId: invocation.invocationId, traceId: invocation.traceId, targetAgentId: invocation.targetAgentId, triggerMessageId: invocation.triggerMessageId, depth: invocation.depth, output, replyDigest })
      let pendingRecord: ChatRoomPendingResultRecord
      try { pendingRecord = this.savePendingResult(this.pendingInputForRun(run, 'completed', output, replyDigest)) }
      catch {
        this.unconfirmedTerminalIds.add(invocation.invocationId)
        this.deps.reportDiagnostic?.('聊天室回复待确认文件写入失败，未上报 completed；保留当前进程内回复且不会重跑 SDK')
        return
      }
      const completedReceipt = await this.requestLifecycle(run, (signal) => this.deps.rustApi.reportCompleted({ invocationId: invocation.invocationId, output }, { signal }))
      if (!await this.isRunCurrent(run)) return
      if (!isTerminalLifecycleProofForRecord(completedReceipt, pendingRecord)) {
        this.deps.reportDiagnostic?.('聊天室 completed 终态未确认，保留结果供后续 Main 确认')
        return
      }
      if (await this.commitPendingTerminal(pendingRecord, completedReceipt as ChatRoomLifecycleResult)) run.terminalConfirmed = true
      else this.deps.reportDiagnostic?.('聊天室 completed 已获服务端私有 ACK，但本地终态落账或 pending 清理失败，保留待确认文件')
      // 下一跳由 edu-api CompleteInvocationWithReply 在同一事务中创建；Main 不重复投递。
    } catch { if (!run.serverTerminalReceived) await this.failTerminal(run, run.stopRequested ? 'gateway_disconnected' : 'internal_error') }
    finally {
      for (const [requestId, pending] of this.pendingPermissions) if (pending.invocationId === invocation.invocationId) { clearTimeout(pending.timer); this.pendingPermissions.delete(requestId) }
      const revocation = run.terminalRevocation
      if (revocation && await revocation.promise === 'retry') return
      if (run.executionBound) await this.releaseExecutionBinding(run)
      this.releaseRunResources(run)
    }
  }
  private createSanitizerContext(invocation: ChatRoomAgentInvocation, config: ChatRoomAgentLocalConfig, room: ChatRoomLocalRoomConfig | undefined, allowedAttachmentIds: string[]): ChatRoomOutputSanitizerContext {
    return { executionRoots: [getChatRoomPath(invocation.roomId), getChatRoomAgentProjectPath(invocation.roomId, config.roomAgentId), getChatRoomAgentInboxPath(invocation.roomId, config.roomAgentId)], sensitiveValues: this.deps.getSensitiveValues(), allowedAgentIds: (room?.agents ?? []).filter((agent) => agent.archivedAt === undefined).map((agent) => agent.roomAgentId), allowedAttachmentIds }
  }
  private createRuntimeContext(invocation: ChatRoomAgentInvocation, config: ChatRoomAgentLocalConfig, publicAgentRoster: TrustedChatRoomAgentRuntimeContext['publicAgentRoster']): TrustedChatRoomAgentRuntimeContext {
    const permissionContext = { roomId: invocation.roomId, roomAgentId: config.roomAgentId, invocationId: invocation.invocationId, traceId: invocation.traceId, originalSender: invocation.sender, invocationChain: invocation.messages.at(-1)?.invocationChain ?? [] }
    return { executionWorkspace: { root: getChatRoomAgentProjectPath(invocation.roomId, config.roomAgentId), projectRoot: getChatRoomAgentProjectPath(invocation.roomId, config.roomAgentId), inboxRoot: getChatRoomAgentInboxPath(invocation.roomId, config.roomAgentId), sessionRoot: getChatRoomAgentSessionDir(invocation.roomId, config.roomAgentId) }, ...(config.memorySharingEnabled ? { memorySource: { workspaceSlug: this.deps.getSourceWorkspaceSlug?.(config.sourceWorkspaceId) ?? config.sourceWorkspaceId, policy: 'visible' as const } } : {}), ...(config.skillSharingEnabled ? { skillSnapshotPath: getChatRoomAgentSkillsSnapshotPath(invocation.roomId, config.roomAgentId) } : {}), publicAgentRoster: publicAgentRoster?.map(({ roomAgentId, displayName }) => ({ roomAgentId, displayName })), permissionContext, requestPermission: (request) => this.requestPermission(invocation, config, request) }
  }
  private requestPermission(invocation: ChatRoomAgentInvocation, config: ChatRoomAgentLocalConfig, request: PermissionRequest, notifyHost = true): ChatRoomPermissionRequest | undefined {
    const timeoutMs = this.deps.permissionTimeoutMs ?? 60_000
    const expiresAt = this.deps.now() + timeoutMs; const safeToolName = request.toolName.replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 80) || '未知工具'; const safe: ChatRoomPermissionRequest = { roomId: invocation.roomId, roomAgentId: config.roomAgentId, invocationId: invocation.invocationId, traceId: invocation.traceId, originalSender: invocation.sender, invocationChain: invocation.messages.at(-1)?.invocationChain ?? [], requestId: request.requestId, toolName: safeToolName, summary: sanitizeChatRoomText(request.description, { ...this.createSanitizerContext(invocation, config, this.deps.store.read(invocation.roomId), []), allowedAgentIds: [], allowedAttachmentIds: [] }, 512), createdAt: this.deps.now(), expiresAt }
    const timer = setTimeout(() => { const pending = this.pendingPermissions.get(request.requestId); if (!pending) return; clearTimeout(pending.timer); this.pendingPermissions.delete(request.requestId); (this.deps.permissionService ?? permissionService).respondToPermission(request.requestId, 'deny', false); const run = this.activeRuns.get(invocation.invocationId); if (run) { run.stopRequested = true; run.executionAbort.abort(); void this.failTerminal(run, 'host_approval_timeout'); void this.stopAgentBounded(run.config.sessionId, run.workerRunId) } }, timeoutMs)
    if (this.pendingPermissions.has(request.requestId)) { clearTimeout(timer); (this.deps.permissionService ?? permissionService).respondToPermission(request.requestId, 'deny', false); return undefined }
    this.pendingPermissions.set(request.requestId, { request, invocationId: invocation.invocationId, roomId: invocation.roomId, hostUserId: this.deps.store.read(invocation.roomId)?.hostUserId ?? '', expiresAt, timer }); if (notifyHost) this.emitPermissionRequest(safe); void this.deps.rustApi.reportDelta({ invocationId: invocation.invocationId, delta: '等待主理人授权' }).catch(() => undefined)
    return safe
  }
  private denyPendingPermissions(): void { const service = this.deps.permissionService ?? permissionService; for (const [requestId, pending] of this.pendingPermissions) { clearTimeout(pending.timer); service.respondToPermission(requestId, 'deny', false); this.pendingPermissions.delete(requestId) } }
  private denyAgentPendingPermissions(roomId: string, roomAgentId: string): void {
    const service = this.deps.permissionService ?? permissionService
    for (const [requestId, pending] of this.pendingPermissions) {
      const run = this.activeRuns.get(pending.invocationId)
      if (pending.roomId !== roomId || run?.config.roomAgentId !== roomAgentId) continue
      clearTimeout(pending.timer)
      service.respondToPermission(requestId, 'deny', false)
      this.pendingPermissions.delete(requestId)
    }
  }
  private async stopAgentBounded(sessionId: string, trustedRunId?: string): Promise<boolean> { let timer: ReturnType<typeof setTimeout> | undefined; try { return await Promise.race([this.deps.stopAgent(sessionId, trustedRunId).then(() => true, () => false), new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), this.deps.stopAgentTimeoutMs ?? STOP_AGENT_TIMEOUT_MS) })]) } finally { if (timer) clearTimeout(timer) } }
  private async awaitFinalization(run: ActiveRun): Promise<boolean> {
    if (!run.finalization) return run.terminalConfirmed
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([run.finalization.catch(() => undefined), new Promise<void>((resolve) => { timer = setTimeout(resolve, STOP_AGENT_TIMEOUT_MS + 100) })])
    } finally { if (timer) clearTimeout(timer) }
    return run.terminalConfirmed
  }
  /** 终态已被 Rust 确认后清理本地运行态；允许 execute.finally 与 stopAll 并发调用。 */
  private cleanupActiveRun(run: ActiveRun): boolean {
    if (!run.terminalConfirmed) return false
    return this.releaseRunResources(run)
  }
  private releaseRunResources(run: ActiveRun): boolean {
    if (run.cleanupDone) return true
    try { run.sessionRelease?.() } catch { this.deps.reportDiagnostic?.('聊天室会话存储清理失败'); return false }
    run.sessionRelease = undefined
    run.cleanupDone = true
    if (this.activeRuns.get(run.invocation.invocationId) === run) this.activeRuns.delete(run.invocation.invocationId)
    return true
  }
  private onAgentEvent(sessionId: string, payload: AgentStreamPayload): void {
    const run = [...this.activeRuns.values()].find((candidate) => candidate.config.sessionId === sessionId)
    if (!run || run.terminal || this.deps.now() - run.lastDeltaAt < 50) return
    let text = ''
    if (payload.kind === 'sdk_message' && payload.message.type === 'assistant') {
      const content = (payload.message as unknown as { message?: { content?: unknown } }).message?.content
      if (Array.isArray(content)) text = content.filter((item) => typeof item === 'object' && item !== null && (item as { type?: unknown }).type === 'text').map((item) => typeof (item as { text?: unknown }).text === 'string' ? (item as { text: string }).text : '').join('')
    }
    if (!text) return
    run.lastDeltaAt = this.deps.now()
    const room = this.deps.store.read(run.invocation.roomId)
    const safeDelta = sanitizeChatRoomText(text, this.createSanitizerContext(run.invocation, run.config, room, []), 16 * 1024)
    void this.deps.rustApi.reportDelta({ invocationId: run.invocation.invocationId, delta: safeDelta }).catch(() => this.deps.reportDiagnostic?.('聊天室增量回传失败'))
  }
  private async failTerminal(run: ActiveRun, code: ChatRoomInvocationFailureCode, allowCompletionClaim = false): Promise<void> {
    if (run.completionClaimed && !allowCompletionClaim) return
    if (!run.failureClaim) {
      const message = failureMessage(code)
      run.failureClaim = { code, message }
      run.terminal = true
    }
    if (run.terminalConfirmed) return
    const failureClaim = run.failureClaim
    const pendingClaim = this.pendingFailureClaimForRun(run, failureClaim)
    const operationEpoch = this.terminalOperationEpoch
    const stillCurrent = () => this.activeRuns.get(run.invocation.invocationId) === run
      && run.failureClaim === failureClaim && this.terminalOperationEpoch === operationEpoch
    try {
      if (!await this.failureOwnerIsCurrent(pendingClaim, stillCurrent)) { this.retainPendingFailure(run); return }
      let pendingRecord: ChatRoomPendingResultRecord
      try { pendingRecord = this.savePendingResult(this.pendingInputForRun(run, 'failed', failureClaim.code)) }
      catch { this.retainPendingFailure(run); this.deps.reportDiagnostic?.('聊天室失败待确认文件写入失败，未上报 failed'); return }
      const receipt = await this.requestLifecycle(run, (signal) => this.deps.rustApi.reportFailed({ invocationId: run.invocation.invocationId, code: failureClaim.code, message: failureClaim.message }, { signal }))
      if (!await this.failureOwnerIsCurrent(pendingClaim, stillCurrent)) { this.retainPendingFailure(run); return }
      if (!isTerminalLifecycleProofForRecord(receipt, pendingRecord)) { this.retainPendingFailure(run); return }
      if (await this.commitPendingTerminal(pendingRecord, receipt as ChatRoomLifecycleResult)) run.terminalConfirmed = true
      else this.retainPendingFailure(run)
    } catch { this.retainPendingFailure(run); this.deps.reportDiagnostic?.('聊天室 terminal 状态回传失败') }
  }
  private retainPendingFailure(run: ActiveRun): void {
    const failureClaim = run.failureClaim ?? { code: 'internal_error' as const, message: failureMessage('internal_error') }
    const claim = this.pendingFailureClaimForRun(run, failureClaim)
    this.unconfirmedTerminalIds.add(claim.invocationId)
    this.pendingFailureClaims.set(claim.invocationId, claim)
  }
  private async retryPendingFailuresBounded(claims: PendingFailureClaim[]): Promise<void> {
    if (claims.length === 0) return
    const operation: PendingFailureRetryOperation = { epoch: this.terminalOperationEpoch, controller: new AbortController() }
    this.pendingFailureRetryOperation = operation
    const budgetMs = Math.max(0, Math.min(LIFECYCLE_CONFIRM_TIMEOUT_MS, this.deps.pendingFailureRetryBudgetMs ?? LIFECYCLE_CONFIRM_TIMEOUT_MS))
    const timer = setTimeout(() => operation.controller.abort(), budgetMs)
    try {
      let cursor = 0
      const worker = async (): Promise<void> => {
        while (!operation.controller.signal.aborted && cursor < Math.min(claims.length, MAX_PENDING_TERMINAL_RESULTS)) {
          const claim = claims[cursor++]!
          await this.retryPendingFailure(claim, operation).catch(() => false)
        }
      }
      await Promise.all(Array.from({ length: Math.min(4, claims.length) }, () => worker()))
    } finally {
      clearTimeout(timer)
      operation.controller.abort()
      if (this.pendingFailureRetryOperation === operation) this.pendingFailureRetryOperation = undefined
    }
  }
  private async retryPendingFailure(claim: PendingFailureClaim, operation: PendingFailureRetryOperation): Promise<boolean> {
    const signal = operation.controller.signal
    const stillCurrent = () => !signal.aborted
      && this.pendingFailureRetryOperation === operation
      && this.terminalOperationEpoch === operation.epoch
      && this.pendingFailureClaims.get(claim.invocationId) === claim
    if (!await this.failureOwnerIsCurrent(claim, stillCurrent, signal)) return false
    let pendingRecord: ChatRoomPendingResultRecord
    try { pendingRecord = this.savePendingFailureClaim(claim) }
    catch { this.deps.reportDiagnostic?.('聊天室失败待确认文件写入失败，保留 claim'); return false }
    const controller = new AbortController()
    const relayAbort = () => controller.abort()
    signal.addEventListener('abort', relayAbort, { once: true })
    let receipt: unknown
    try {
      const request = this.deps.rustApi.reportFailed({ invocationId: claim.invocationId, code: claim.code, message: claim.message }, { signal: controller.signal }).catch(() => undefined)
      receipt = await this.raceWithAbort(request, signal)
    } catch { receipt = undefined }
    finally { signal.removeEventListener('abort', relayAbort); if (!controller.signal.aborted) controller.abort() }
    if (!await this.failureOwnerIsCurrent(claim, stillCurrent, signal)) return false
    if (!isTerminalLifecycleProofForRecord(receipt, pendingRecord)) return false
    if (!stillCurrent()) return false
    return await this.commitPendingTerminal(pendingRecord, receipt as ChatRoomLifecycleResult)
  }
  private async reportRejected(input: ChatRoomAgentInvocation, code: ChatRoomInvocationFailureCode, room?: ChatRoomLocalRoomConfig, targetAgentId?: string, guard?: RejectedInvocationGuard): Promise<void> {
    const invocation = room && targetAgentId ? this.deps.store.getInvocation?.(input.roomId, input.invocationId) : undefined
    if (!room || !targetAgentId || !room.agents.some((agent) => agent.roomAgentId === targetAgentId)
      || !invocation || invocation.status !== 'created' || invocation.traceId !== input.traceId
      || invocation.targetAgentId !== targetAgentId || invocation.triggerMessageId !== input.triggerMessageId
      || invocation.depth !== input.depth || !guard || !sameInvocationRecord(invocation, guard.createdRecord)
      || room.hostUserId !== guard.identity.hostUserId || room.deviceId !== guard.identity.deviceId) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const aborted = new Promise<undefined>((resolve) => {
      const onAbort = () => resolve(undefined)
      controller.signal.addEventListener('abort', onAbort, { once: true })
      timer = setTimeout(() => controller.abort(), LIFECYCLE_CONFIRM_TIMEOUT_MS)
    })
    const request = this.deps.rustApi.reportFailed({ invocationId: input.invocationId, code, message: failureMessage(code) }, { signal: controller.signal }).catch(() => undefined)
    let receipt: unknown
    try { receipt = await Promise.race([request, aborted]) }
    finally { if (timer) clearTimeout(timer); controller.abort() }
    if (!isConfirmedLifecycleReceipt(receipt, { roomId: input.roomId, invocationId: input.invocationId, command: 'agent.failed', status: 'failed' })) return
    let currentUserId: string | undefined
    try { currentUserId = await this.deps.getCurrentUserId() } catch { return }
    if (this.disposed || this.leaseGeneration !== guard.generation || this.lifecycle !== guard.lifecycle
      || currentUserId !== guard.identity.hostUserId || this.deps.getDeviceId() !== guard.identity.deviceId) return
    let currentRoom: ChatRoomLocalRoomConfig | undefined
    let currentRecord: ChatRoomInvocationRecord | undefined
    try {
      currentRoom = this.deps.store.read(input.roomId)
      currentRecord = this.deps.store.getInvocation(input.roomId, input.invocationId)
    } catch { return }
    const currentAgent = currentRoom?.agents.find((agent) => agent.roomAgentId === targetAgentId && agent.archivedAt === undefined)
    if (!currentRoom || currentRoom.hostUserId !== guard.identity.hostUserId || currentRoom.deviceId !== guard.identity.deviceId
      || !currentAgent || !currentRecord || !sameInvocationRecord(currentRecord, guard.createdRecord)) return
    const now = this.deps.now()
    try { this.deps.store.transitionInvocation(input.roomId, input.invocationId, ['created'], (current) => ({ ...current, status: 'failed', updatedAt: now, finishedAt: now, failureCode: code, failureMessage: failureMessage(code) })) }
    catch { /* 记录失败时仍只回报固定服务端 proof。 */ }
  }
  private async requireHostIdentity(roomId: string): Promise<{ hostUserId: string; deviceId: string }> { const userId = await this.deps.getCurrentUserId(); const room = this.deps.store.read(roomId); if (!room || !userId || room.hostUserId !== userId || room.deviceId !== this.deps.getDeviceId()) throw new Error('not_room_host'); return { hostUserId: userId, deviceId: this.deps.getDeviceId() } }
  private requireAgent(room: ChatRoomLocalRoomConfig | undefined, id: string): ChatRoomAgentLocalConfig { const agent = room?.agents.find((candidate) => candidate.roomAgentId === id); if (!agent) throw new Error('room_agent_not_found'); return agent }
}

let registeredCoordinator: ChatRoomAgentCoordinatorFacade | undefined
let registrationToken = 0
export type ChatRoomAgentCoordinatorRegistration = ChatRoomAgentCoordinatorFacade | undefined
const registrationListeners = new Set<(registration: ChatRoomAgentCoordinatorRegistration) => void>()
function notifyCoordinatorRegistration(registration: ChatRoomAgentCoordinatorRegistration): void {
  registrationListeners.forEach((listener) => { try { listener(registration) } catch { /* 单个注册监听失败不影响其他监听 */ } })
}
export function onChatRoomAgentCoordinatorRegistered(listener: (registration: ChatRoomAgentCoordinatorRegistration) => void): () => void {
  registrationListeners.add(listener)
  if (registeredCoordinator) listener(registeredCoordinator)
  return () => registrationListeners.delete(listener)
}
export function registerChatRoomAgentCoordinator(coordinator: ChatRoomAgentCoordinatorFacade): () => void {
  const token = ++registrationToken
  registeredCoordinator = coordinator
  notifyCoordinatorRegistration(coordinator)
  return () => {
    if (registrationToken !== token || registeredCoordinator !== coordinator) return
    registeredCoordinator = undefined
    notifyCoordinatorRegistration(undefined)
  }
}
export function getChatRoomAgentCoordinator(): ChatRoomAgentCoordinatorFacade { if (!registeredCoordinator) throw new Error('聊天室协调器尚未注册'); return registeredCoordinator }
