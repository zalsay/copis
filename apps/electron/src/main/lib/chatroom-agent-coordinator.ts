import { existsSync, lstatSync } from 'node:fs'
import type {
  AgentMessage, AgentSendInput, AgentStreamPayload, ChatRoomAgentInvocation,
  ChatRoomAgentLocalConfig, ChatRoomAgentOutput, ChatRoomAgentRuntimeContext,
  ChatRoomLocalRoomConfig, ChatRoomPermissionRequest, ChatRoomPermissionResponse,
  ChatRoomRustApi, ChatRoomInvocationFailureCode, ChatRoomInvocationRecord,
  PermissionRequest, ProvisionChatRoomAgentInput, RemoveChatRoomAgentInput,
  SyncChatRoomAgentSkillsInput, UpdateChatRoomAgentInput,
} from '@copis/shared'
import { CHATROOM_MAX_DEPTH } from '@copis/shared'
import { AgentPermissionService, permissionService } from './agent-permission-service'
import { parseAndSanitizeChatRoomAgentOutput, sanitizeChatRoomText, type ChatRoomOutputSanitizerContext } from './chatroom-output-sanitizer'
import { getChatRoomAgentInboxPath, getChatRoomAgentProjectPath, getChatRoomAgentSessionDir, getChatRoomAgentSkillsSnapshotPath, getChatRoomPath } from './config-paths'
import type { ChatRoomHiddenSessionStore } from './chatroom-hidden-session-store'
import type { ChatRoomWorkspaceStore } from './chatroom-workspace-store'
import { computeChatRoomSkillSnapshotDigest } from './chatroom-skill-snapshot'
import type { ChatRoomSkillSnapshotResult, SyncChatRoomAgentSkillSnapshotInput } from './chatroom-skill-snapshot'

type HeadlessRunner = (input: AgentSendInput, callbacks: {
  onError: (error: string) => void
  onComplete: (messages?: AgentMessage[]) => void
  onTitleUpdated: (title: string) => void
  source?: 'chatroom'
  trustedRuntimeContext?: ChatRoomAgentRuntimeContext
}) => Promise<void>
type AgentStopper = (sessionId: string) => Promise<void>
const STOP_AGENT_TIMEOUT_MS = 1_000
const REPORT_COMPLETION_TIMEOUT_MS = 1_000
const TERMINAL_CONFIRM_TIMEOUT_MS = 2_000
const STOP_REASON_PRIORITY: Record<'logout' | 'gateway_disconnected' | 'app_quit', number> = { gateway_disconnected: 1, logout: 2, app_quit: 3 }

/** Task 7 的 bridge 接缝；兼容静态加载和旧 handler 测试。 */
export interface ChatRoomAgentCoordinatorFacade {
  handleInvocation(input: ChatRoomAgentInvocation): Promise<'accepted' | 'duplicate'>
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
  onPermissionRequested?(listener: (request: ChatRoomPermissionRequest) => void): () => void
  onLocalConfigChanged?(listener: (room: ChatRoomLocalRoomConfig) => void): () => void
}
type ChatRoomLease = { roomId: string; roomAgentId: string }
type ChatRoomMainRustApi = Omit<ChatRoomRustApi, 'releaseAgentLeases'> & {
  releaseAgentLeases(input: { roomAgentIds: string[]; leases: ChatRoomLease[]; reason: 'logout' | 'gateway_disconnected' | 'app_quit' }): Promise<void>
  getRoomHostUserId(roomId: string): Promise<string>
  getRoomRealtimeStatus(roomId: string): Promise<{ ready: boolean; epoch: number }>
  registerAgent(input: { roomId: string; displayName: string; deviceId: string; hostUserId: string }): Promise<string>
  unregisterAgent(roomId: string, agentId: string): Promise<void>
  renewAgentLease(roomId: string, agentId: string, deviceId: string): Promise<void>
  findRegisteredAgent(input: { roomId: string; displayName: string; deviceId: string; hostUserId: string }): Promise<{ agentId: string; leaseVerified: boolean } | undefined>
}
export interface ChatRoomAgentEventListener { (sessionId: string, payload: AgentStreamPayload): void }
export interface ChatRoomNextHopInput { parent: ChatRoomAgentInvocation; output: ChatRoomAgentOutput; targetAgentId: string; depth: number }
export interface ChatRoomAgentCoordinatorDependencies {
  store: ChatRoomWorkspaceStore
  rustApi: ChatRoomMainRustApi
  getCurrentUserId(): Promise<string | undefined>
  getDeviceId(): string
  getSensitiveValues(): string[]
  getSourceWorkspaceSlug?(workspaceId: string): string | undefined
  runAgentHeadless: HeadlessRunner
  stopAgent: AgentStopper
  stopAgentTimeoutMs?: number
  permissionTimeoutMs?: number
  leaseRecoveryRetryMs?: number
  subscribeAgentEvents(listener: ChatRoomAgentEventListener): () => void
  createHiddenSessionStore(roomId: string, agent: ChatRoomAgentLocalConfig): ChatRoomHiddenSessionStore
  registerSessionStorageOverride(sessionId: string, storage: ChatRoomHiddenSessionStore): () => void
  syncSkills(input: SyncChatRoomAgentSkillSnapshotInput): ChatRoomSkillSnapshotResult
  reportDiagnostic?(message: string): void
  permissionService?: Pick<AgentPermissionService, 'respondToPermission' | 'openExternalApproval'>
  now(): number
}
interface ActiveRun { invocation: ChatRoomAgentInvocation; config: ChatRoomAgentLocalConfig; stopRequested: boolean; terminal: boolean; terminalConfirmed: boolean; cleanupDone: boolean; failureClaim?: { code: ChatRoomInvocationFailureCode; message: string }; completionClaimed: boolean; lastDeltaAt: number; sessionRelease?: () => void; finalization?: Promise<void> }
interface PendingPermission { request: PermissionRequest; invocationId: string; roomId: string; hostUserId: string; expiresAt: number; timer: ReturnType<typeof setTimeout> }
function latestAssistantText(messages: AgentMessage[] | undefined): string {
  return messages?.filter((message) => message.role === 'assistant').map((message) => typeof message.content === 'string' ? message.content : '').at(-1) ?? ''
}
function failureMessage(code: ChatRoomInvocationFailureCode): string {
  return ({ agent_offline: 'Agent 当前离线', agent_busy: 'Agent 正在处理其他消息', invocation_depth_exceeded: '调用深度已达到上限', gateway_disconnected: '聊天室网关已断开', host_approval_timeout: '主理人授权超时', host_approval_denied: '主理人拒绝了操作' } as Partial<Record<ChatRoomInvocationFailureCode, string>>)[code] ?? '聊天室 Agent 执行失败'
}

/** Main-only 聊天室 Agent 协调器；每个 Agent 独立运行，不设全局队列。 */
export class ChatRoomAgentCoordinator implements ChatRoomAgentCoordinatorFacade {
  private readonly activeRuns = new Map<string, ActiveRun>()
  private readonly pendingPermissions = new Map<string, PendingPermission>()
  private unsubscribeEvents: (() => void) | undefined
  private lifecycle: 'ready' | 'auth_required' | 'disconnected' | 'stopping' | 'disposed' = 'ready'
  private stoppingReason: 'logout' | 'gateway_disconnected' | 'app_quit' | undefined
  private disposed = false
  private stopping: Promise<{ stoppedSessionIds: string[]; releasedRoomAgentIds: string[] }> | undefined
  private leaseGeneration = 0
  private readonly releasedLeaseKeys = new Set<string>()
  private readonly provisioningRooms = new Set<string>()
  private leaseRecoveryTimer: ReturnType<typeof setTimeout> | undefined
  private leaseRecovery: Promise<void> | undefined
  private recoveryEnabled = false
  private readonly permissionListeners = new Set<(request: ChatRoomPermissionRequest) => void>()
  private readonly configListeners = new Set<(room: ChatRoomLocalRoomConfig) => void>()
  constructor(private readonly deps: ChatRoomAgentCoordinatorDependencies) {}
  listLocalRooms(): ChatRoomLocalRoomConfig[] { return this.deps.store.list() }
  onPermissionRequested(listener: (request: ChatRoomPermissionRequest) => void): () => void { this.permissionListeners.add(listener); return () => this.permissionListeners.delete(listener) }
  onLocalConfigChanged(listener: (room: ChatRoomLocalRoomConfig) => void): () => void { this.configListeners.add(listener); return () => this.configListeners.delete(listener) }
  private emitPermissionRequest(request: ChatRoomPermissionRequest): void {
    this.permissionListeners.forEach((listener) => { try { listener(request) } catch { this.deps.reportDiagnostic?.('聊天室权限通知监听器失败') } })
  }
  private emitConfig(room: ChatRoomLocalRoomConfig): void { this.configListeners.forEach((listener) => { try { listener(room) } catch { this.deps.reportDiagnostic?.('聊天室配置通知监听器失败') } }) }
  start(): void {
    if (this.disposed || this.recoveryEnabled) return
    this.unsubscribeEvents = this.deps.subscribeAgentEvents((sid, payload) => this.onAgentEvent(sid, payload))
    this.recoveryEnabled = true
    this.scheduleLeaseRecovery()
  }
  private scheduleLeaseRecovery(): void {
    if (!this.recoveryEnabled || this.disposed || this.leaseRecoveryTimer || !['ready', 'disconnected'].includes(this.lifecycle)) return
    this.leaseRecoveryTimer = setTimeout(() => {
      this.leaseRecoveryTimer = undefined
      void this.resumeLeases().catch(() => this.deps.reportDiagnostic?.('聊天室 Agent 租约恢复失败'))
    }, this.deps.leaseRecoveryRetryMs ?? 1_000)
    this.leaseRecoveryTimer.unref?.()
  }
  private assertAgentOnline(generation: number): void {
    if (this.disposed || this.lifecycle !== 'ready' || this.leaseGeneration !== generation) throw new Error('agent_offline')
  }
  private assertProvisionMayProceed(generation: number): void {
    if (this.disposed || this.lifecycle === 'auth_required' || this.lifecycle === 'stopping' || this.leaseGeneration !== generation) throw new Error('agent_offline')
  }
  private async releaseLease(roomId: string, agentId: string): Promise<boolean> {
    try {
      await this.deps.rustApi.releaseAgentLeases({ roomAgentIds: [agentId], leases: [{ roomId, roomAgentId: agentId }], reason: this.stoppingReason ?? 'gateway_disconnected' })
      return true
    } catch { this.deps.reportDiagnostic?.('聊天室 Agent 租约清理失败'); return false }
  }
  resumeLeases(): Promise<void> {
    if (this.leaseRecovery) return this.leaseRecovery
    if (this.leaseRecoveryTimer) clearTimeout(this.leaseRecoveryTimer)
    this.leaseRecoveryTimer = undefined
    this.leaseRecovery = this.restoreLeases().then((complete) => {
      if (!complete) this.scheduleLeaseRecovery()
    }, (error: unknown) => {
      this.scheduleLeaseRecovery()
      throw error
    }).finally(() => { this.leaseRecovery = undefined })
    return this.leaseRecovery
  }
  private async restoreLeases(): Promise<boolean> {
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
      let realtime: { ready: boolean; epoch: number }
      try {
        if (await this.deps.rustApi.getRoomHostUserId(room.roomId) !== hostUserId) continue
        realtime = await this.deps.rustApi.getRoomRealtimeStatus(room.roomId)
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
    return complete
  }
  async provisionAgent(input: ProvisionChatRoomAgentInput): Promise<ChatRoomAgentLocalConfig> {
    if (this.provisioningRooms.has(input.roomId)) throw new Error('agent_busy')
    this.provisioningRooms.add(input.roomId)
    try {
      const generation = this.leaseGeneration
      const hostUserId = await this.deps.getCurrentUserId()
      this.assertProvisionMayProceed(generation)
      const deviceId = this.deps.getDeviceId()
      const localRoom = this.deps.store.read(input.roomId)
      if (!hostUserId || (localRoom && (localRoom.hostUserId !== hostUserId || localRoom.deviceId !== deviceId))) throw new Error('not_room_host')
      if (localRoom?.agents.some((agent) => agent.archivedAt === undefined && agent.displayName.trim().toLowerCase() === input.displayName.trim().toLowerCase())) throw new Error('display_name_conflict')
      if (localRoom && localRoom.agents.filter((agent) => agent.archivedAt === undefined).length >= 3) throw new Error('agent_limit_reached')
      if (await this.deps.rustApi.getRoomHostUserId(input.roomId) !== hostUserId) throw new Error('not_room_host')
      const realtime = await this.deps.rustApi.getRoomRealtimeStatus(input.roomId)
      if (!realtime.ready) throw new Error('agent_offline')
      this.assertProvisionMayProceed(generation)
      if (await this.deps.getCurrentUserId() !== hostUserId || this.deps.getDeviceId() !== deviceId) throw new Error('not_room_host')
      this.assertProvisionMayProceed(generation)
      if (this.lifecycle === 'disconnected') {
        this.lifecycle = 'ready'
        this.stoppingReason = undefined
        this.releasedLeaseKeys.clear()
        await this.resumeLeases()
      }
      const assertSameRealtime = async (): Promise<void> => {
        this.assertAgentOnline(generation)
        const current = await this.deps.rustApi.getRoomRealtimeStatus(input.roomId)
        this.assertAgentOnline(generation)
        if (!current.ready || current.epoch !== realtime.epoch) throw new Error('agent_offline')
      }
      this.assertAgentOnline(generation)
      if (await this.deps.getCurrentUserId() !== hostUserId || this.deps.getDeviceId() !== deviceId) throw new Error('not_room_host')
      this.assertAgentOnline(generation)
      await assertSameRealtime()
      const registration = { roomId: input.roomId, displayName: input.displayName, deviceId, hostUserId }
      let agentId: string
      let leaseConfirmed = false
      try { agentId = await this.deps.rustApi.registerAgent(registration) }
      catch {
        const uncertain = 'Agent 注册结果不确定，请检查房间 Agent 列表，勿重复添加同名 Agent'
        let recovered: Awaited<ReturnType<ChatRoomMainRustApi['findRegisteredAgent']>>
        try { recovered = await this.deps.rustApi.findRegisteredAgent(registration) }
        catch { throw new Error(uncertain) }
        if (!recovered) throw new Error(uncertain)
        if (!recovered.leaseVerified) {
          if (!await this.releaseLease(input.roomId, recovered.agentId)) throw new Error(uncertain)
          try { await this.deps.rustApi.unregisterAgent(input.roomId, recovered.agentId) }
          catch { throw new Error('Agent 租约已释放，但远端清理未完成，请勿重复添加同名 Agent') }
          throw new Error('Agent 注册确认失败，已撤销远端 Agent，请重新尝试')
        }
        agentId = recovered.agentId
        leaseConfirmed = true
      }
      let saved = false
      try {
        await assertSameRealtime()
        this.assertAgentOnline(generation)
        if (await this.deps.getCurrentUserId() !== hostUserId || this.deps.getDeviceId() !== deviceId) throw new Error('not_room_host')
        this.assertAgentOnline(generation)
        const room = this.deps.store.provisionAgent({ hostUserId, deviceId }, input, agentId)
        saved = true
        if (!leaseConfirmed) await this.deps.rustApi.renewAgentLease(input.roomId, agentId, deviceId)
        this.assertAgentOnline(generation)
        if (await this.deps.getCurrentUserId() !== hostUserId || this.deps.getDeviceId() !== deviceId) throw new Error('not_room_host')
        this.assertAgentOnline(generation)
        await assertSameRealtime()
        this.emitConfig(room)
        return this.requireAgent(room, agentId)
      } catch (error) {
        const leaseCleaned = !(saved || leaseConfirmed) || await this.releaseLease(input.roomId, agentId)
        let localCleaned = true
        if (saved) {
          try { this.emitConfig(this.deps.store.archiveAgent({ roomId: input.roomId, roomAgentId: agentId })) }
          catch { localCleaned = false }
        }
        let remoteCleaned = true
        try { await this.deps.rustApi.unregisterAgent(input.roomId, agentId) }
        catch { remoteCleaned = false }
        if (!leaseCleaned || !localCleaned || !remoteCleaned) throw new Error('Agent 配置失败且清理未完成，请勿重复添加同名 Agent')
        throw error
      }
    } finally {
      this.provisioningRooms.delete(input.roomId)
    }
  }
  async updateAgent(input: UpdateChatRoomAgentInput): Promise<ChatRoomAgentLocalConfig> {
    await this.requireHostIdentity(input.roomId)
    const room = this.deps.store.updateAgent(input)
    this.emitConfig(room)
    return this.requireAgent(room, input.roomAgentId)
  }
  async removeAgent(input: RemoveChatRoomAgentInput): Promise<void> { await this.requireHostIdentity(input.roomId); const room = this.deps.store.archiveAgent(input); this.emitConfig(room) }
  async syncAgentSkills(input: SyncChatRoomAgentSkillsInput): Promise<ChatRoomAgentLocalConfig> {
    await this.requireHostIdentity(input.roomId)
    const config = this.requireAgent(this.deps.store.read(input.roomId), input.roomAgentId)
    const result = this.deps.syncSkills({ roomId: input.roomId, roomAgentId: input.roomAgentId, sourceWorkspaceSlug: this.deps.getSourceWorkspaceSlug?.(config.sourceWorkspaceId) ?? config.sourceWorkspaceId })
    const room = this.deps.store.updateAgentSkillSnapshot(input.roomId, input.roomAgentId, result)
    this.emitConfig(room)
    return this.requireAgent(room, input.roomAgentId)
  }
  async handleInvocation(input: ChatRoomAgentInvocation): Promise<'accepted' | 'duplicate'> {
    if (this.disposed) return 'duplicate'
    const authenticatedUserId = await this.deps.getCurrentUserId()
    const authenticatedDeviceId = this.deps.getDeviceId()
    let room = this.deps.store.read(input.roomId)
    if (room && (authenticatedUserId !== room.hostUserId || authenticatedDeviceId !== room.deviceId)) {
      await this.reportRejected(input, 'not_room_member')
      return 'accepted'
    }
    if (room && (this.activeRuns.has(input.invocationId) || this.deps.store.getInvocation(input.roomId, input.invocationId) || this.deps.store.getTraceAgentInvocation(input.roomId, input.traceId, input.targetAgentId))) return 'duplicate'
    if (room && (await this.deps.getCurrentUserId()) !== authenticatedUserId) {
      await this.reportRejected(input, 'not_room_member')
      return 'accepted'
    }
    // 身份读取包含 await；回到同步临界区前必须重新加载 room/config/ledger，避免 ABA。
    const finalUserId = await this.deps.getCurrentUserId()
    const finalRoom = this.deps.store.read(input.roomId)
    if (!finalRoom || finalUserId !== finalRoom.hostUserId || this.deps.getDeviceId() !== finalRoom.deviceId || finalUserId !== authenticatedUserId || this.deps.getDeviceId() !== authenticatedDeviceId) {
      await this.reportRejected(input, 'not_room_member', finalRoom, input.targetAgentId)
      return 'accepted'
    }
    if (finalRoom && (this.activeRuns.has(input.invocationId) || this.deps.store.getInvocation(input.roomId, input.invocationId) || this.deps.store.getTraceAgentInvocation(input.roomId, input.traceId, input.targetAgentId))) return 'duplicate'
    room = finalRoom
    const config = room?.agents.find((agent) => agent.roomAgentId === input.targetAgentId && agent.archivedAt === undefined)
    if (!room || !config) { await this.reportRejected(input, 'room_agent_not_found'); return 'accepted' }
    if (this.lifecycle === 'stopping' || this.lifecycle === 'auth_required' || this.lifecycle === 'disposed') { await this.reportRejected(input, 'agent_offline', room, input.targetAgentId); return 'accepted' }
    if (input.depth >= CHATROOM_MAX_DEPTH) { await this.reportRejected(input, 'invocation_depth_exceeded', room, input.targetAgentId); return 'accepted' }
    if ([...this.activeRuns.values()].some((run) => run.invocation.roomId === input.roomId && run.config.roomAgentId === config.roomAgentId)) { await this.reportRejected(input, 'agent_busy', room, input.targetAgentId); return 'accepted' }
    if (this.lifecycle === 'disconnected') {
      this.lifecycle = 'ready'
      this.releasedLeaseKeys.clear()
    }
    const now = this.deps.now()
    const record: ChatRoomInvocationRecord = { invocationId: input.invocationId, roomId: input.roomId, traceId: input.traceId, targetAgentId: input.targetAgentId, triggerMessageId: input.triggerMessageId, depth: input.depth, status: 'accepted', createdAt: Math.min(now, input.receivedAt), updatedAt: now, acceptedAt: now }
    this.deps.store.upsertInvocation(input.roomId, record)
    this.activeRuns.set(input.invocationId, { invocation: input, config, stopRequested: false, terminal: false, terminalConfirmed: false, cleanupDone: false, completionClaimed: false, lastDeltaAt: -Infinity })
    try {
      await this.deps.rustApi.reportAccepted({ invocationId: input.invocationId })
    } catch {
      this.deps.reportDiagnostic?.('聊天室 accepted 状态回传失败')
      await this.failTerminal(this.activeRuns.get(input.invocationId)!, 'internal_error')
      this.activeRuns.delete(input.invocationId)
      return 'accepted'
    }
    const run = this.activeRuns.get(input.invocationId)!
    run.finalization = this.execute(run)
    return 'accepted'
  }
  async handleGatewayDisconnected(): Promise<void> {
    if (this.disposed || this.lifecycle === 'auth_required' || this.lifecycle === 'disconnected') return
    await this.stopAll('gateway_disconnected')
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
      await this.failTerminal(run, 'host_approval_denied')
      void this.stopAgentBounded(run.config.sessionId)
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
      if (run) { run.stopRequested = true; await this.failTerminal(run, 'host_approval_timeout'); void this.stopAgentBounded(run.config.sessionId) }
      throw new Error('permission_expired')
    }
    clearTimeout(pending.timer); this.pendingPermissions.delete(input.requestId)
    const resolved = (this.deps.permissionService ?? permissionService).respondToPermission(input.requestId, input.behavior, false)
    if (!resolved) throw new Error('permission_not_found')
    if (input.behavior === 'deny' && run) { run.stopRequested = true; await this.failTerminal(run, 'host_approval_denied'); void this.stopAgentBounded(run.config.sessionId) }
  }
  async stopAll(reason: 'logout' | 'gateway_disconnected' | 'app_quit'): Promise<{ stoppedSessionIds: string[]; releasedRoomAgentIds: string[] }> {
    if (this.leaseRecoveryTimer) clearTimeout(this.leaseRecoveryTimer)
    this.leaseRecoveryTimer = undefined
    if (this.stopping) {
      if (this.stoppingReason && STOP_REASON_PRIORITY[reason] > STOP_REASON_PRIORITY[this.stoppingReason]) {
        this.stoppingReason = reason
        this.lifecycle = 'stopping'
      }
      return this.stopping
    }
    this.leaseGeneration++
    this.lifecycle = 'stopping'; this.stoppingReason = reason
    this.stopping = (async () => {
      const runs = [...this.activeRuns.values()]
      this.denyPendingPermissions()
      const finalized = await Promise.all(runs.map(async (run) => {
        run.stopRequested = true
        await this.failTerminal(run, reason === 'app_quit' ? 'app_quit' : reason === 'logout' ? 'internal_error' : 'gateway_disconnected')
        void this.stopAgentBounded(run.config.sessionId)
        const terminalConfirmed = await this.awaitFinalization(run)
        return terminalConfirmed && this.cleanupActiveRun(run)
      }))
      const allCleaned = finalized.every(Boolean)
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
  async resumeAfterAuthentication(): Promise<void> { const stopping = this.stopping; if (stopping) await stopping; if (this.disposed || this.stoppingReason === 'app_quit') return; if (this.lifecycle === 'auth_required') { this.lifecycle = 'ready'; this.stoppingReason = undefined; this.releasedLeaseKeys.clear() } await this.resumeLeases() }
  async dispose(): Promise<void> { if (this.disposed) return; await this.stopAll('app_quit'); this.disposed = true; this.lifecycle = 'disposed'; this.unsubscribeEvents?.(); this.unsubscribeEvents = undefined }

  private async execute(run: ActiveRun): Promise<void> {
    const { invocation, config } = run
    try {
      const hidden = this.deps.createHiddenSessionStore(invocation.roomId, config)
      run.sessionRelease = this.deps.registerSessionStorageOverride(config.sessionId, hidden)
      const context = this.createRuntimeContext(invocation, config)
      if (config.skillSharingEnabled) {
        const skillPath = context.skillSnapshotPath
        if (!skillPath || !existsSync(skillPath) || !lstatSync(skillPath).isDirectory() || !config.skillSnapshotDigest || computeChatRoomSkillSnapshotDigest(skillPath) !== config.skillSnapshotDigest) {
          await this.failTerminal(run, 'invalid_invocation')
          return
        }
      }
      const current = this.deps.store.getInvocation(invocation.roomId, invocation.invocationId); const now = this.deps.now()
      if (!current || current.status !== 'accepted') return
      const running = this.deps.store.transitionInvocation(invocation.roomId, invocation.invocationId, ['accepted'], (record) => ({ ...record, status: 'running', startedAt: now, updatedAt: now }))
      if (!running.transitioned) return
      try {
        await this.deps.rustApi.reportRunning({ invocationId: invocation.invocationId })
      } catch {
        this.deps.reportDiagnostic?.('聊天室 running 状态回传失败')
        await this.failTerminal(run, 'internal_error')
        return
      }
      let runError: string | undefined; let messages: AgentMessage[] | undefined
      const contextMessages = invocation.messages.slice(-config.contextMessageCount)
      const input: AgentSendInput = { sessionId: config.sessionId, userMessage: contextMessages.map((message) => `${message.sender.displayName}: ${message.text}`).join('\n'), rawUserMessage: contextMessages.at(-1)?.text ?? '', channelId: config.channelId, modelId: config.modelId, workspaceId: config.sourceWorkspaceId, agentRuntime: 'pi', triggeredBy: 'user' }
      await this.deps.runAgentHeadless(input, { source: 'chatroom', trustedRuntimeContext: context, onError: (error) => { runError = error }, onComplete: (completed) => { messages = completed }, onTitleUpdated: () => {} })
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
      try {
        const completionAbort = new AbortController()
        const completion = this.deps.rustApi.reportCompleted({ invocationId: invocation.invocationId, output }, { signal: completionAbort.signal })
        const completedReported = await Promise.race([
          completion.then(() => true).catch(() => false),
          new Promise<boolean>((resolve) => setTimeout(() => resolve(false), REPORT_COMPLETION_TIMEOUT_MS)),
        ])
        if (!completedReported) {
          this.deps.reportDiagnostic?.('聊天室 completed 回传超时，取消并等待确认')
          completionAbort.abort()
          await completion.catch(() => undefined)
          const finalized = await Promise.race([
            this.deps.rustApi.reportCompleted({ invocationId: invocation.invocationId, output }).then(() => true).catch(() => false),
            new Promise<boolean>((resolve) => setTimeout(() => resolve(false), TERMINAL_CONFIRM_TIMEOUT_MS)),
          ])
          if (finalized) {
            run.terminalConfirmed = true
          } else {
            this.deps.reportDiagnostic?.('聊天室 completed 终态无法确认，保留 lease')
            return
          }
        } else {
          run.terminalConfirmed = true
        }
      } catch {
        this.deps.reportDiagnostic?.('聊天室 completed 状态回传失败')
        await this.failTerminal(run, 'internal_error', true)
        return
      }
      const completedAt = this.deps.now(); const completed = this.deps.store.transitionInvocation(invocation.roomId, invocation.invocationId, ['running'], (currentRecord) => ({ ...currentRecord, status: 'completed', updatedAt: completedAt, finishedAt: completedAt }))
      if (!completed.transitioned) return
      // 下一跳由 edu-api CompleteInvocationWithReply 在同一事务中创建；Main 不重复投递。
    } catch { await this.failTerminal(run, run.stopRequested ? 'gateway_disconnected' : 'internal_error') }
    finally { for (const [requestId, pending] of this.pendingPermissions) if (pending.invocationId === invocation.invocationId) { clearTimeout(pending.timer); this.pendingPermissions.delete(requestId) }; this.cleanupActiveRun(run) }
  }
  private createSanitizerContext(invocation: ChatRoomAgentInvocation, config: ChatRoomAgentLocalConfig, room: ChatRoomLocalRoomConfig | undefined, allowedAttachmentIds: string[]): ChatRoomOutputSanitizerContext {
    return { executionRoots: [getChatRoomPath(invocation.roomId), getChatRoomAgentProjectPath(invocation.roomId, config.roomAgentId), getChatRoomAgentInboxPath(invocation.roomId, config.roomAgentId)], sensitiveValues: this.deps.getSensitiveValues(), allowedAgentIds: (room?.agents ?? []).filter((agent) => agent.archivedAt === undefined).map((agent) => agent.roomAgentId), allowedAttachmentIds }
  }
  private createRuntimeContext(invocation: ChatRoomAgentInvocation, config: ChatRoomAgentLocalConfig): ChatRoomAgentRuntimeContext {
    const permissionContext = { roomId: invocation.roomId, roomAgentId: config.roomAgentId, invocationId: invocation.invocationId, traceId: invocation.traceId, originalSender: invocation.sender, invocationChain: invocation.messages.at(-1)?.invocationChain ?? [] }
    return { executionWorkspace: { root: getChatRoomAgentProjectPath(invocation.roomId, config.roomAgentId), projectRoot: getChatRoomAgentProjectPath(invocation.roomId, config.roomAgentId), inboxRoot: getChatRoomAgentInboxPath(invocation.roomId, config.roomAgentId), sessionRoot: getChatRoomAgentSessionDir(invocation.roomId, config.roomAgentId) }, ...(config.memorySharingEnabled ? { memorySource: { workspaceSlug: this.deps.getSourceWorkspaceSlug?.(config.sourceWorkspaceId) ?? config.sourceWorkspaceId, policy: 'visible' as const } } : {}), ...(config.skillSharingEnabled ? { skillSnapshotPath: getChatRoomAgentSkillsSnapshotPath(invocation.roomId, config.roomAgentId) } : {}), permissionContext, requestPermission: (request) => this.requestPermission(invocation, config, request) }
  }
  private requestPermission(invocation: ChatRoomAgentInvocation, config: ChatRoomAgentLocalConfig, request: PermissionRequest, notifyHost = true): ChatRoomPermissionRequest | undefined {
    const timeoutMs = this.deps.permissionTimeoutMs ?? 60_000
    const expiresAt = this.deps.now() + timeoutMs; const safeToolName = request.toolName.replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 80) || '未知工具'; const safe: ChatRoomPermissionRequest = { roomId: invocation.roomId, roomAgentId: config.roomAgentId, invocationId: invocation.invocationId, traceId: invocation.traceId, originalSender: invocation.sender, invocationChain: invocation.messages.at(-1)?.invocationChain ?? [], requestId: request.requestId, toolName: safeToolName, summary: sanitizeChatRoomText(request.description, { ...this.createSanitizerContext(invocation, config, this.deps.store.read(invocation.roomId), []), allowedAgentIds: [], allowedAttachmentIds: [] }, 512), createdAt: this.deps.now(), expiresAt }
    const timer = setTimeout(() => { const pending = this.pendingPermissions.get(request.requestId); if (!pending) return; clearTimeout(pending.timer); this.pendingPermissions.delete(request.requestId); (this.deps.permissionService ?? permissionService).respondToPermission(request.requestId, 'deny', false); const run = this.activeRuns.get(invocation.invocationId); if (run) { run.stopRequested = true; void this.failTerminal(run, 'host_approval_timeout'); void this.stopAgentBounded(run.config.sessionId) } }, timeoutMs)
    if (this.pendingPermissions.has(request.requestId)) { clearTimeout(timer); (this.deps.permissionService ?? permissionService).respondToPermission(request.requestId, 'deny', false); return undefined }
    this.pendingPermissions.set(request.requestId, { request, invocationId: invocation.invocationId, roomId: invocation.roomId, hostUserId: this.deps.store.read(invocation.roomId)?.hostUserId ?? '', expiresAt, timer }); if (notifyHost) this.emitPermissionRequest(safe); void this.deps.rustApi.reportDelta({ invocationId: invocation.invocationId, delta: '等待主理人授权' }).catch(() => undefined)
    return safe
  }
  private denyPendingPermissions(): void { const service = this.deps.permissionService ?? permissionService; for (const [requestId, pending] of this.pendingPermissions) { clearTimeout(pending.timer); service.respondToPermission(requestId, 'deny', false); this.pendingPermissions.delete(requestId) } }
  private async stopAgentBounded(sessionId: string): Promise<void> { let timer: ReturnType<typeof setTimeout> | undefined; await Promise.race([this.deps.stopAgent(sessionId).catch(() => undefined), new Promise<void>((resolve) => { timer = setTimeout(resolve, this.deps.stopAgentTimeoutMs ?? STOP_AGENT_TIMEOUT_MS) })]); if (timer) clearTimeout(timer) }
  private async awaitFinalization(run: ActiveRun): Promise<boolean> { if (!run.finalization) return run.terminalConfirmed; await Promise.race([run.finalization.catch(() => undefined), new Promise<void>((resolve) => setTimeout(resolve, REPORT_COMPLETION_TIMEOUT_MS + STOP_AGENT_TIMEOUT_MS + TERMINAL_CONFIRM_TIMEOUT_MS))]); return run.terminalConfirmed }
  /** 终态已被 Rust 确认后清理本地运行态；允许 execute.finally 与 stopAll 并发调用。 */
  private cleanupActiveRun(run: ActiveRun): boolean {
    if (!run.terminalConfirmed) return false
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
      const transitioned = this.deps.store.transitionInvocation(run.invocation.roomId, run.invocation.invocationId, ['accepted', 'running'], (record) => ({ ...record, status: 'failed', updatedAt: this.deps.now(), finishedAt: this.deps.now(), failureCode: code, failureMessage: message }))
      if (!transitioned.transitioned) return
    }
    if (run.terminalConfirmed) return
    try {
      await this.deps.rustApi.reportFailed({ invocationId: run.invocation.invocationId, code: run.failureClaim.code, message: run.failureClaim.message })
      run.terminalConfirmed = true
    } catch { this.deps.reportDiagnostic?.('聊天室 terminal 状态回传失败') }
  }
  private async reportRejected(input: ChatRoomAgentInvocation, code: ChatRoomInvocationFailureCode, room?: ChatRoomLocalRoomConfig, targetAgentId?: string): Promise<void> { if (room && targetAgentId && room.agents.some((agent) => agent.roomAgentId === targetAgentId)) { const now = this.deps.now(); try { this.deps.store.upsertInvocation(input.roomId, { invocationId: input.invocationId, roomId: input.roomId, traceId: input.traceId, targetAgentId, triggerMessageId: input.triggerMessageId, depth: input.depth, status: 'failed', createdAt: Math.min(now, input.receivedAt), updatedAt: now, finishedAt: now, failureCode: code, failureMessage: failureMessage(code) }) } catch { /* 记录失败时仍只上报固定码 */ } } await this.deps.rustApi.reportFailed({ invocationId: input.invocationId, code, message: failureMessage(code) }).catch(() => this.deps.reportDiagnostic?.('聊天室 rejected 状态回传失败')) }
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
