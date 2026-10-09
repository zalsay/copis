import type { AgentAvailability, ChatRoomAgentLocalConfig, ChatRoomLocalIdentity, ChatRoomLocalRoomConfig } from '@copis/shared'

export interface ChatRoomReadinessStatus {
  ready: boolean
  epoch: number
  capabilityState: 'preparing' | 'ready' | 'legacy'
  mode: 'modern' | 'legacy'
  socketGeneration: number
  snapshotReady: boolean
  selectedCapabilities: string[]
}

export interface ChatRoomReadyReceipt {
  outcome: 'confirmed'
  mode: 'agent-ready-v1'
  source: 'private-ack'
  requestId: string
  roomId: string
  roomAgentId: string
  command: 'agent.ready' | 'agent.unready'
  generation: number
}

export interface ChatRoomReadinessApi {
  getRoomHostUserId(roomId: string, options?: { signal?: AbortSignal }): Promise<string>
  getRoomRealtimeStatus(roomId: string, options?: { signal?: AbortSignal }): Promise<ChatRoomReadinessStatus>
  readyAgent(roomId: string, roomAgentId: string, options?: { signal?: AbortSignal }): Promise<unknown>
  unreadyAgent(roomId: string, roomAgentId: string, options?: { signal?: AbortSignal }): Promise<unknown>
}

export interface ChatRoomAgentReadinessState {
  roomId: string
  roomAgentId: string
  availability: AgentAvailability
  reason?: string
  updatedAt: number
}

interface ChatRoomReadinessDependencies {
  store: { read(roomId: string): ChatRoomLocalRoomConfig | undefined }
  api: ChatRoomReadinessApi
  getIdentity(): ChatRoomLocalIdentity | undefined
  hasPendingManagement(roomId: string, roomAgentId: string, identity: ChatRoomLocalIdentity): boolean
  checkAgent(agent: ChatRoomAgentLocalConfig, room: ChatRoomLocalRoomConfig): Promise<{ available: boolean; reason?: string; permanent?: boolean }>
  onStateChanged?(state: ChatRoomAgentReadinessState): void
  retryBaseMs?: number
  now?: () => number
}

interface BlockedRoomReadiness {
  identityKey: string
  reason: string
  code: string
  authenticationRequired: boolean
}

type BlockedAgentReadiness = BlockedRoomReadiness

const RETRY_MAX_MS = 30_000

export class ChatRoomReadinessError extends Error {
  constructor(message: string, readonly outcome: 'Unknown' | 'Rejected', readonly code?: string, readonly httpStatus?: number) {
    super(message)
    this.name = 'ChatRoomReadinessError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isConfirmedReadyReceipt(value: unknown, roomId: string, roomAgentId: string, generation: number): value is ChatRoomReadyReceipt {
  if (!isRecord(value)) return false
  const keys = ['outcome', 'mode', 'source', 'requestId', 'roomId', 'roomAgentId', 'command', 'generation']
  return Object.keys(value).length === keys.length
    && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
    && value.outcome === 'confirmed' && value.mode === 'agent-ready-v1' && value.source === 'private-ack'
    && typeof value.requestId === 'string' && value.requestId.length > 0
    && value.roomId === roomId && value.roomAgentId === roomAgentId
    && (value.command === 'agent.ready' || value.command === 'agent.unready')
    && value.generation === generation
}

export class ChatRoomReadinessCoordinator {
  private readonly inFlight = new Map<string, Promise<void>>()
  private readonly operations = new Map<string, AbortController>()
  private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly retryAttempts = new Map<string, number>()
  private readonly states = new Map<string, ChatRoomAgentReadinessState>()
  private readonly stateListeners = new Set<(state: ChatRoomAgentReadinessState) => void>()
  private readonly blockedRooms = new Map<string, BlockedRoomReadiness>()
  private readonly blockedAgents = new Map<string, BlockedAgentReadiness>()
  private connectionEpoch = 0
  private disposed = false

  constructor(private readonly deps: ChatRoomReadinessDependencies) {}

  getState(roomId: string, roomAgentId: string): ChatRoomAgentReadinessState | undefined {
    return this.states.get(this.key(roomId, roomAgentId))
  }

  onStateChanged(listener: (state: ChatRoomAgentReadinessState) => void): () => void {
    this.stateListeners.add(listener)
    return () => this.stateListeners.delete(listener)
  }

  private key(roomId: string, roomAgentId = ''): string { return `${roomId}\u0000${roomAgentId}` }
  private identityKey(identity: ChatRoomLocalIdentity): string { return `${identity.hostUserId}\u0000${identity.deviceId}` }
  private sameAgentConfig(left: ChatRoomAgentLocalConfig | undefined, right: ChatRoomAgentLocalConfig): boolean {
    return Boolean(left && JSON.stringify(left) === JSON.stringify(right))
  }
  private sameRoomAgentConfigs(left: ChatRoomLocalRoomConfig, right: ChatRoomLocalRoomConfig | undefined): boolean {
    return Boolean(right && left.roomId === right.roomId && left.hostUserId === right.hostUserId && left.deviceId === right.deviceId
      && JSON.stringify(left.agents) === JSON.stringify(right.agents))
  }
  private current(roomId: string, epoch: number, controller: AbortController): boolean {
    return !this.disposed && epoch === this.connectionEpoch && !controller.signal.aborted
      && this.operations.get(roomId) === controller
  }
  private trustedContextIsCurrent(roomId: string, room: ChatRoomLocalRoomConfig, identity: ChatRoomLocalIdentity, epoch: number, controller: AbortController): boolean {
    const currentIdentity = this.deps.getIdentity()
    return this.current(roomId, epoch, controller)
      && currentIdentity?.hostUserId === identity.hostUserId && currentIdentity.deviceId === identity.deviceId
      && this.sameRoomAgentConfigs(room, this.deps.store.read(roomId))
  }

  private hasPendingManagement(roomId: string, roomAgentId: string, identity: ChatRoomLocalIdentity): boolean {
    try { return this.deps.hasPendingManagement(roomId, roomAgentId, identity) }
    catch { return true }
  }

  private async confirmManagementUnready(
    roomId: string,
    roomAgentId: string,
    generation: number,
    room: ChatRoomLocalRoomConfig,
    identity: ChatRoomLocalIdentity,
    epoch: number,
    controller: AbortController,
  ): Promise<boolean> {
    const receipt = await this.deps.api.unreadyAgent(roomId, roomAgentId, { signal: controller.signal })
    return this.trustedContextIsCurrent(roomId, room, identity, epoch, controller)
      && isConfirmedReadyReceipt(receipt, roomId, roomAgentId, generation) && receipt.command === 'agent.unready'
  }

  private publish(roomId: string, roomAgentId: string, availability: AgentAvailability, reason?: string): void {
    const state: ChatRoomAgentReadinessState = { roomId, roomAgentId, availability, ...(reason ? { reason } : {}), updatedAt: (this.deps.now ?? Date.now)() }
    this.states.set(this.key(roomId, roomAgentId), state)
    try { this.deps.onStateChanged?.(state) } catch { /* 状态订阅者不能中断 reconcile。 */ }
    for (const listener of this.stateListeners) {
      try { listener(state) } catch { /* 状态订阅者不能中断 reconcile。 */ }
    }
  }

  private scheduleRetry(roomId: string, permanent = false): void {
    if (permanent || this.disposed || this.retryTimers.has(roomId)) return
    const attempt = this.retryAttempts.get(roomId) ?? 0
    const delay = Math.min((this.deps.retryBaseMs ?? 1_000) * 2 ** Math.min(attempt, 5), RETRY_MAX_MS)
    this.retryAttempts.set(roomId, attempt + 1)
    const timer = setTimeout(() => {
      this.retryTimers.delete(roomId)
      void this.reconcileRoomAgents(roomId)
    }, delay)
    timer.unref?.()
    this.retryTimers.set(roomId, timer)
  }

  reconcileRoomAgents(roomId: string): Promise<void> {
    if (this.disposed) return Promise.resolve()
    const existing = this.inFlight.get(roomId)
    if (existing) return existing
    const retryTimer = this.retryTimers.get(roomId)
    if (retryTimer) clearTimeout(retryTimer)
    this.retryTimers.delete(roomId)
    const controller = new AbortController()
    const epoch = this.connectionEpoch
    this.operations.set(roomId, controller)
    const operation = this.reconcile(roomId, epoch, controller)
      .finally(() => {
        if (this.operations.get(roomId) === controller) this.operations.delete(roomId)
        if (this.inFlight.get(roomId) === operation) this.inFlight.delete(roomId)
      })
    this.inFlight.set(roomId, operation)
    return operation
  }

  private async reconcile(roomId: string, epoch: number, controller: AbortController): Promise<void> {
    const room = this.deps.store.read(roomId)
    const identity = this.deps.getIdentity()
    if (!room) return
    if (!identity || room.hostUserId !== identity.hostUserId || room.deviceId !== identity.deviceId) {
      for (const agent of room.agents) this.publish(roomId, agent.roomAgentId, 'offline', 'host_unavailable')
      return
    }
    const currentIdentityKey = this.identityKey(identity)
    const blockedRoom = this.blockedRooms.get(roomId)
    if (blockedRoom && blockedRoom.identityKey === currentIdentityKey) {
      for (const agent of room.agents) this.publish(roomId, agent.roomAgentId, 'offline', blockedRoom.reason)
      return
    }
    if (blockedRoom) this.blockedRooms.delete(roomId)

    try {
      const remoteHostUserId = await this.deps.api.getRoomHostUserId(roomId, { signal: controller.signal })
      if (!this.trustedContextIsCurrent(roomId, room, identity, epoch, controller)) {
        if (!this.current(roomId, epoch, controller)) return
        for (const agent of room.agents) this.publish(roomId, agent.roomAgentId, 'preparing', 'identity_or_config_changed')
        return
      }
      if (remoteHostUserId !== identity.hostUserId) {
        for (const agent of room.agents) this.publish(roomId, agent.roomAgentId, 'offline', 'not_room_host')
        return
      }
      const status = await this.deps.api.getRoomRealtimeStatus(roomId, { signal: controller.signal })
      if (!this.trustedContextIsCurrent(roomId, room, identity, epoch, controller)) {
        if (!this.current(roomId, epoch, controller)) return
        for (const agent of room.agents) this.publish(roomId, agent.roomAgentId, 'preparing', 'identity_or_config_changed')
        return
      }
      if (!status.snapshotReady || !status.ready || status.capabilityState === 'preparing') {
        for (const agent of room.agents) this.publish(roomId, agent.roomAgentId, 'preparing', 'snapshot_pending')
        this.scheduleRetry(roomId)
        return
      }
      if (status.mode === 'legacy' || status.capabilityState === 'legacy') {
        // 旧 Gateway 的在线状态仍由协调器既有 lease 流程唯一负责。
        this.retryAttempts.delete(roomId)
        return
      }
      if (status.mode !== 'modern' || status.capabilityState !== 'ready' || status.socketGeneration <= 0
        || !status.selectedCapabilities.includes('agent-ready-v1')) {
        for (const agent of room.agents) this.publish(roomId, agent.roomAgentId, 'preparing', 'capability_unverified')
        this.scheduleRetry(roomId)
        return
      }

      let retry = false
      for (const agent of room.agents) {
        if (!this.trustedContextIsCurrent(roomId, room, identity, epoch, controller)) return
        const currentAgent = this.deps.store.read(roomId)?.agents.find((candidate) => candidate.roomAgentId === agent.roomAgentId)
        if (!this.sameAgentConfig(currentAgent, agent)) {
          this.publish(roomId, agent.roomAgentId, 'preparing', 'configuration_changed')
          retry = true
          continue
        }
        const agentKey = this.key(roomId, agent.roomAgentId)
        const managementPending = this.hasPendingManagement(roomId, agent.roomAgentId, identity)
        if (managementPending) {
          try {
            const confirmed = await this.confirmManagementUnready(roomId, agent.roomAgentId, status.socketGeneration, room, identity, epoch, controller)
            if (!this.current(roomId, epoch, controller)) return
            if (!confirmed) {
              this.publish(roomId, agent.roomAgentId, 'preparing', 'management_pending')
              retry = true
              continue
            }
            this.publish(roomId, agent.roomAgentId, 'offline', 'management_pending')
          } catch {
            if (!this.trustedContextIsCurrent(roomId, room, identity, epoch, controller)) return
            this.publish(roomId, agent.roomAgentId, 'preparing', 'management_pending')
            retry = true
          }
          continue
        }
        const blockedAgent = this.blockedAgents.get(agentKey)
        if (blockedAgent && blockedAgent.identityKey === currentIdentityKey) {
          this.publish(roomId, agent.roomAgentId, 'offline', blockedAgent.reason)
          continue
        }
        if (blockedAgent) this.blockedAgents.delete(agentKey)
        let runtime: { available: boolean; reason?: string; permanent?: boolean } | undefined
        if (agent.archivedAt === undefined) {
          try { runtime = await this.deps.checkAgent(agent, room) }
          catch (error) { runtime = { available: false, reason: error instanceof Error ? error.message : 'runtime_unavailable' } }
        }
        if (!this.trustedContextIsCurrent(roomId, room, identity, epoch, controller)) return
        if (this.hasPendingManagement(roomId, agent.roomAgentId, identity)) {
          try {
            const confirmed = await this.confirmManagementUnready(roomId, agent.roomAgentId, status.socketGeneration, room, identity, epoch, controller)
            if (!this.current(roomId, epoch, controller)) return
            this.publish(roomId, agent.roomAgentId, confirmed ? 'offline' : 'preparing', 'management_pending')
            if (!confirmed) retry = true
          } catch {
            if (!this.current(roomId, epoch, controller)) return
            this.publish(roomId, agent.roomAgentId, 'preparing', 'management_pending')
            retry = true
          }
          continue
        }
        const checkedAgent = this.deps.store.read(roomId)?.agents.find((candidate) => candidate.roomAgentId === agent.roomAgentId)
        if (!this.sameAgentConfig(checkedAgent, agent)) {
          this.publish(roomId, agent.roomAgentId, 'preparing', 'configuration_changed')
          retry = true
          continue
        }
        const command = agent.archivedAt === undefined && runtime?.available ? 'ready' : 'unready'
        try {
          const receipt = command === 'ready'
            ? await this.deps.api.readyAgent(roomId, agent.roomAgentId, { signal: controller.signal })
            : await this.deps.api.unreadyAgent(roomId, agent.roomAgentId, { signal: controller.signal })
          if (!this.trustedContextIsCurrent(roomId, room, identity, epoch, controller)) return
          if (this.hasPendingManagement(roomId, agent.roomAgentId, identity)) {
            try {
              const confirmed = command === 'unready'
                ? isConfirmedReadyReceipt(receipt, roomId, agent.roomAgentId, status.socketGeneration) && receipt.command === 'agent.unready'
                : await this.confirmManagementUnready(roomId, agent.roomAgentId, status.socketGeneration, room, identity, epoch, controller)
              if (!this.current(roomId, epoch, controller)) return
              this.publish(roomId, agent.roomAgentId, confirmed ? 'offline' : 'preparing', 'management_pending')
              if (!confirmed) retry = true
            } catch {
              if (!this.current(roomId, epoch, controller)) return
              this.publish(roomId, agent.roomAgentId, 'preparing', 'management_pending')
              retry = true
            }
            continue
          }
          if (!isConfirmedReadyReceipt(receipt, roomId, agent.roomAgentId, status.socketGeneration)
            || receipt.command !== `agent.${command}`) {
            this.publish(roomId, agent.roomAgentId, 'preparing', 'ready_ack_unconfirmed')
            retry = true
            continue
          }
          if (!this.trustedContextIsCurrent(roomId, room, identity, epoch, controller)) return
          const after = await this.deps.api.getRoomRealtimeStatus(roomId, { signal: controller.signal })
          if (!this.trustedContextIsCurrent(roomId, room, identity, epoch, controller)) return
          if (this.hasPendingManagement(roomId, agent.roomAgentId, identity)) {
            try {
              const confirmed = await this.confirmManagementUnready(roomId, agent.roomAgentId, after.socketGeneration, room, identity, epoch, controller)
              if (!this.current(roomId, epoch, controller)) return
              this.publish(roomId, agent.roomAgentId, confirmed ? 'offline' : 'preparing', 'management_pending')
              if (!confirmed) retry = true
            } catch {
              if (!this.current(roomId, epoch, controller)) return
              this.publish(roomId, agent.roomAgentId, 'preparing', 'management_pending')
              retry = true
            }
            continue
          }
          if (!after.ready || after.mode !== 'modern' || after.capabilityState !== 'ready'
            || after.socketGeneration !== status.socketGeneration || !after.snapshotReady
            || !after.selectedCapabilities.includes('agent-ready-v1')) {
            this.publish(roomId, agent.roomAgentId, 'preparing', 'connection_changed')
            retry = true
            continue
          }
          if (command === 'ready') this.publish(roomId, agent.roomAgentId, 'online')
          else if (agent.archivedAt !== undefined) this.publish(roomId, agent.roomAgentId, 'offline', 'archived')
          else if (runtime && !runtime.available) this.publish(roomId, agent.roomAgentId, 'configuration_error', runtime.reason ?? 'runtime_unavailable')
        } catch (error) {
          if (!this.trustedContextIsCurrent(roomId, room, identity, epoch, controller)) return
          const permanent = error instanceof ChatRoomReadinessError && error.outcome === 'Rejected'
          const reason = error instanceof ChatRoomReadinessError ? error.code ?? 'ready_unknown' : 'ready_unknown'
          this.publish(roomId, agent.roomAgentId, permanent ? 'offline' : 'preparing', reason)
          if (permanent) this.blockedAgents.set(agentKey, {
            identityKey: currentIdentityKey, reason, code: reason,
            authenticationRequired: error instanceof ChatRoomReadinessError && error.httpStatus === 401,
          })
          if (!permanent) retry = true
        }
      }
      if (retry) this.scheduleRetry(roomId)
      else this.retryAttempts.delete(roomId)
    } catch (error) {
      if (!this.trustedContextIsCurrent(roomId, room, identity, epoch, controller)) return
      const permanent = error instanceof ChatRoomReadinessError && error.outcome === 'Rejected'
      const reason = error instanceof ChatRoomReadinessError ? error.code ?? 'gateway_unavailable' : 'gateway_unavailable'
      for (const agent of room.agents) this.publish(roomId, agent.roomAgentId, permanent ? 'offline' : 'preparing', reason)
      if (permanent) this.blockedRooms.set(roomId, {
        identityKey: currentIdentityKey, reason, code: reason,
        authenticationRequired: error instanceof ChatRoomReadinessError && error.httpStatus === 401,
      })
      this.scheduleRetry(roomId, permanent)
    }
  }

  invalidateConnection(): void {
    if (this.disposed) return
    this.connectionEpoch++
    for (const controller of this.operations.values()) controller.abort()
    this.operations.clear()
    const roomIds = new Set(this.inFlight.keys())
    for (const state of this.states.values()) roomIds.add(state.roomId)
    this.inFlight.clear()
    for (const timer of this.retryTimers.values()) clearTimeout(timer)
    this.retryTimers.clear()
    this.retryAttempts.clear()
    for (const roomId of roomIds) {
      const room = this.deps.store.read(roomId)
      for (const agent of room?.agents ?? []) {
        if (agent.archivedAt !== undefined) continue
        const identityKey = room ? this.identityKey({ hostUserId: room.hostUserId, deviceId: room.deviceId }) : ''
        if (this.blockedRooms.get(roomId)?.identityKey === identityKey
          || this.blockedAgents.get(this.key(roomId, agent.roomAgentId))?.identityKey === identityKey) continue
        this.publish(roomId, agent.roomAgentId, 'preparing', 'connection_changed')
      }
    }
  }

  configurationChanged(roomId: string): Promise<void> {
    const operation = this.operations.get(roomId)
    operation?.abort()
    this.operations.delete(roomId)
    this.inFlight.delete(roomId)
    const timer = this.retryTimers.get(roomId)
    if (timer) clearTimeout(timer)
    this.retryTimers.delete(roomId)
    this.retryAttempts.delete(roomId)
    return this.reconcileRoomAgents(roomId)
  }

  authorizeRecovery(roomId: string, roomAgentId: string): Promise<void> {
    if (this.disposed) return Promise.resolve()
    this.blockedRooms.delete(roomId)
    this.blockedAgents.delete(this.key(roomId, roomAgentId))
    return this.configurationChanged(roomId)
  }

  authenticationRefreshed(): void {
    for (const [roomId, blocked] of this.blockedRooms) if (blocked.authenticationRequired) this.blockedRooms.delete(roomId)
    for (const [key, blocked] of this.blockedAgents) if (blocked.authenticationRequired) this.blockedAgents.delete(key)
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.connectionEpoch++
    for (const controller of this.operations.values()) controller.abort()
    this.operations.clear()
    for (const timer of this.retryTimers.values()) clearTimeout(timer)
    this.retryTimers.clear()
    this.inFlight.clear()
    this.blockedRooms.clear()
    this.blockedAgents.clear()
    this.stateListeners.clear()
  }
}
