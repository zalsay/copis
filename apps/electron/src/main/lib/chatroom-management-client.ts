import { canonicalizeChatRoomAgentDisplayName } from '@copis/shared'
import { getHttpApiInternalToken, HTTP_API_HOST, HTTP_API_PORT } from './http-api-server'
import { ChatRoomReadinessError, type ChatRoomReadinessStatus } from './chatroom-readiness-coordinator'
import type { ChatRoomManagementMode } from './chatroom-management-journal'

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
const COMPONENT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export interface ChatRoomManagementReceipt {
  version: 1
  operationId: string
  roomId: string
  roomAgentId: string
  ownerUserId: number
  action: 'register' | 'remove' | 'update-sharing'
  status: 'registered' | 'removed' | 'updated'
  displayName: string
  memoryShared: boolean
  skillsShared: boolean
}

export interface ChatRoomLegacyRemovalConfirmation {
  mode: 'legacy'
  outcome: 'confirmed'
  roomId: string
  roomAgentId: string
}

export type ChatRoomManagementOperationStatus =
  | { mode: 'legacy' }
  | { mode: 'v1'; receipt?: ChatRoomManagementReceipt }

export class ChatRoomManagementError extends Error {
  constructor(message: string, readonly httpStatus: number, readonly code: string) {
    super(message)
    this.name = 'ChatRoomManagementError'
  }
}

function component(value: string): string {
  if (!COMPONENT.test(value)) throw new Error('聊天室 ID 不正确')
  return encodeURIComponent(value)
}

function object(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function invalidPublicAgentRoster(): ChatRoomManagementError {
  return new ChatRoomManagementError('聊天室公开 Agent 名单不可用', 502, 'invalid_public_agent_roster')
}

export interface ChatRoomPublicAgentRoster {
  roomId: string
  hostUserId: string
  agents: Array<{ roomAgentId: string; displayName: string }>
}

function managementErrorCode(value: unknown, status: number): string {
  const envelope = object(value)
  const nested = object(envelope.error)
  return typeof envelope.code === 'string' ? envelope.code
    : typeof nested.code === 'string' ? nested.code
      : `http_${status}`
}

function parseManagementReceipt(value: unknown, expected: {
  operationId: string; roomId: string; hostUserId: string; action: ChatRoomManagementReceipt['action']; roomAgentId?: string
  displayName?: string; memoryShared?: boolean; skillsShared?: boolean
}): ChatRoomManagementReceipt {
  const envelope = object(value)
  const receipt = object(envelope.data)
  const fields = ['version', 'operationId', 'roomId', 'roomAgentId', 'ownerUserId', 'action', 'status', 'displayName', 'memoryShared', 'skillsShared']
  const status = expected.action === 'register' ? 'registered' : expected.action === 'remove' ? 'removed' : 'updated'
  if (Object.keys(envelope).length !== 1 || Object.keys(envelope)[0] !== 'data'
    || Object.keys(receipt).length !== fields.length || fields.some((field) => !Object.prototype.hasOwnProperty.call(receipt, field))
    || receipt.version !== 1 || receipt.operationId !== expected.operationId || receipt.roomId !== expected.roomId
    || String(receipt.ownerUserId) !== expected.hostUserId || !Number.isSafeInteger(receipt.ownerUserId)
    || receipt.action !== expected.action || receipt.status !== status
    || typeof receipt.roomAgentId !== 'string' || !COMPONENT.test(receipt.roomAgentId)
    || (expected.roomAgentId !== undefined && receipt.roomAgentId !== expected.roomAgentId)
    || typeof receipt.displayName !== 'string' || !receipt.displayName.trim()
    || (expected.displayName !== undefined && receipt.displayName !== expected.displayName)
    || typeof receipt.memoryShared !== 'boolean' || typeof receipt.skillsShared !== 'boolean') {
    throw new ChatRoomManagementError('聊天室管理回执与操作身份不匹配', 502, 'invalid_management_receipt')
  }
  if ((expected.memoryShared !== undefined && receipt.memoryShared !== expected.memoryShared)
    || (expected.skillsShared !== undefined && receipt.skillsShared !== expected.skillsShared)) {
    throw new ChatRoomManagementError('聊天室管理回执配置与操作不匹配', 502, 'invalid_management_receipt')
  }
  return receipt as unknown as ChatRoomManagementReceipt
}

export class ChatRoomManagementClient {
  private readonly baseUrl: string
  private readonly getToken: () => string | null | undefined
  private readonly fetchImpl: FetchLike

  constructor(options: { baseUrl?: string; getToken?: () => string | null | undefined; fetchImpl?: FetchLike } = {}) {
    const url = new URL(options.baseUrl ?? `http://${HTTP_API_HOST}:${HTTP_API_PORT}`)
    if (url.protocol !== 'http:' || url.hostname !== HTTP_API_HOST || url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
      throw new Error('Rust HTTP API 必须使用 loopback 地址')
    }
    this.baseUrl = url.origin
    this.getToken = options.getToken ?? getHttpApiInternalToken
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  private async request(path: string, method: 'GET' | 'POST' | 'DELETE', body?: object, signal?: AbortSignal, readinessRequest = false): Promise<unknown> {
    const token = this.getToken()
    if (!token?.trim()) {
      if (readinessRequest) throw new ChatRoomReadinessError('Rust HTTP API 尚未启动', 'Unknown', 'http_api_unavailable')
      throw new Error('Rust HTTP API 尚未启动')
    }
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: { Accept: 'application/json', 'X-Copis-Internal-Token': token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(signal ? { signal } : {}),
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    if (!response.ok) {
      if (readinessRequest) {
        const envelope = object(await response.json().catch(() => ({})))
        const detail = object(envelope.error)
        const code = typeof envelope.code === 'string' ? envelope.code
          : typeof detail.code === 'string' ? detail.code
            : `http_${response.status}`
        const outcome = response.status === 404 || response.status >= 500 ? 'Unknown' : 'Rejected'
        throw new ChatRoomReadinessError(`聊天室管理请求未确认（${response.status}）`, outcome, code, response.status)
      }
      throw new Error(`聊天室管理请求失败（${response.status}）`)
    }
    if (method === 'DELETE') return undefined
    const envelope = object(await response.json())
    return 'data' in envelope ? envelope.data : envelope
  }

  private async managementRequest(path: string, method: 'GET' | 'POST', body?: object): Promise<unknown> {
    const token = this.getToken()
    if (!token?.trim()) throw new ChatRoomManagementError('Rust HTTP API 尚未启动', 503, 'http_api_unavailable')
    let response: Response
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: { Accept: 'application/json', 'X-Copis-Internal-Token': token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      })
    } catch {
      throw new ChatRoomManagementError('聊天室管理请求网络结果未知', 0, 'network_error')
    }
    const raw: unknown = await response.json().catch(() => ({}))
    if (!response.ok) throw new ChatRoomManagementError(`聊天室管理请求未确认（${response.status}）`, response.status, managementErrorCode(raw, response.status))
    return raw
  }

  async probeAgentManagementVersion(): Promise<boolean> {
    const path = '/api/internal/chatrooms/agent-management/capabilities'
    const token = this.getToken()
    if (!token?.trim()) throw new ChatRoomManagementError('Rust HTTP API 尚未启动', 503, 'http_api_unavailable')
    let response: Response
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, { method: 'GET', headers: { Accept: 'application/json', 'X-Copis-Internal-Token': token } })
    } catch {
      throw new ChatRoomManagementError('聊天室管理能力查询网络结果未知', 0, 'network_error')
    }
    const raw: unknown = await response.json().catch(() => ({}))
    if (response.status === 404) return false
    if (!response.ok) throw new ChatRoomManagementError(`聊天室管理能力查询失败（${response.status}）`, response.status, managementErrorCode(raw, response.status))
    const envelope = object(raw)
    const data = object(envelope.data)
    if (Object.keys(envelope).length !== 1 || Object.keys(envelope)[0] !== 'data'
      || Object.keys(data).length !== 1 || data.version !== 1) {
      throw new ChatRoomManagementError('聊天室管理能力响应不正确', 502, 'invalid_management_capabilities')
    }
    return true
  }

  private async managementStatus(input: { roomId: string; operationId: string; deviceId: string; hostUserId: string; displayName?: string; memoryShared?: boolean; skillsShared?: boolean }, action: ChatRoomManagementReceipt['action'], roomAgentId?: string): Promise<ChatRoomManagementReceipt | undefined> {
    const path = `/api/internal/chatrooms/rooms/${component(input.roomId)}/agent-management/operations/status`
    let value: unknown
    try {
      value = await this.managementRequest(path, 'POST', { operationId: input.operationId, deviceId: input.deviceId })
    } catch (error) {
      if (error instanceof ChatRoomManagementError && error.httpStatus === 404 && error.code === 'management_operation_not_found') return undefined
      throw error
    }
    return parseManagementReceipt(value, {
      operationId: input.operationId, roomId: input.roomId, hostUserId: input.hostUserId, action,
      ...(roomAgentId ? { roomAgentId } : {}), ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
      ...(input.memoryShared !== undefined ? { memoryShared: input.memoryShared } : {}),
      ...(input.skillsShared !== undefined ? { skillsShared: input.skillsShared } : {}),
    })
  }

  async getRoomHostUserId(roomId: string, options?: { signal?: AbortSignal }): Promise<string> {
    const value = object(await this.request(`/api/chatrooms/v2/rooms/${component(roomId)}`, 'GET', undefined, options?.signal, true))
    const room = object(value.room)
    if (room.roomId !== roomId || room.status !== 'active' || (typeof room.hostUserId !== 'number' && typeof room.hostUserId !== 'string')) {
      throw new Error('聊天室主理人信息不可用')
    }
    return String(room.hostUserId)
  }

  async getRoomAgentRoster(roomId: string, options?: { signal?: AbortSignal }): Promise<ChatRoomPublicAgentRoster> {
    const value = await this.request(`/api/chatrooms/v2/rooms/${component(roomId)}`, 'GET', undefined, options?.signal, true)
    if (!isPlainRecord(value) || !isPlainRecord(value.room)) throw invalidPublicAgentRoster()
    const room = value.room
    if (room.roomId !== roomId || room.status !== 'active'
      || (typeof room.hostUserId !== 'number' && typeof room.hostUserId !== 'string')) {
      throw invalidPublicAgentRoster()
    }
    if (!Array.isArray(value.agents) || value.agents.length > 3) throw invalidPublicAgentRoster()

    const seenAgentIds = new Set<string>()
    const agents: ChatRoomPublicAgentRoster['agents'] = []
    for (const candidate of value.agents) {
      if (!isPlainRecord(candidate)) throw invalidPublicAgentRoster()
      const roomAgentId = candidate.roomAgentId
      const displayName = canonicalizeChatRoomAgentDisplayName(candidate.displayName)
      if (typeof roomAgentId !== 'string' || !COMPONENT.test(roomAgentId)
        || candidate.roomId !== roomId
        || displayName === undefined
        || !['online', 'busy', 'offline', 'disabled'].includes(String(candidate.status))
        || seenAgentIds.has(roomAgentId)) {
        throw invalidPublicAgentRoster()
      }
      seenAgentIds.add(roomAgentId)
      if (candidate.status !== 'disabled') agents.push({ roomAgentId, displayName })
    }

    return { roomId, hostUserId: String(room.hostUserId), agents }
  }

  async getRoomRealtimeStatus(roomId: string, options?: { signal?: AbortSignal }): Promise<ChatRoomReadinessStatus> {
    const value = object(await this.request(`/api/internal/chatrooms/rooms/${component(roomId)}/status`, 'GET', undefined, options?.signal, true))
    if (typeof value.ready !== 'boolean' || !Number.isSafeInteger(value.epoch) || (value.epoch as number) < 0) {
      throw new Error('聊天室网关状态响应不正确')
    }
    const hasCapabilitySnapshot = ['capabilityState', 'mode', 'socketGeneration', 'snapshotReady', 'selectedCapabilities']
      .some((key) => Object.prototype.hasOwnProperty.call(value, key))
    if (!hasCapabilitySnapshot) {
      // 旧 Gateway 只提供兼容字段；缺少协商快照只能走 legacy lease，绝不能猜测现代能力。
      return { ready: value.ready, epoch: value.epoch as number, capabilityState: 'legacy', mode: 'legacy', socketGeneration: 0, snapshotReady: value.ready, selectedCapabilities: [] }
    }
    if (!['preparing', 'ready', 'legacy'].includes(String(value.capabilityState))
      || !['modern', 'legacy'].includes(String(value.mode))
      || !Number.isSafeInteger(value.socketGeneration) || (value.socketGeneration as number) < 0
      || typeof value.snapshotReady !== 'boolean' || !Array.isArray(value.selectedCapabilities)
      || value.selectedCapabilities.some((capability) => !['agent-ready-v1', 'invocation-ack-v1', 'agent-delta-frame-id-v1'].includes(String(capability)))) {
      throw new Error('聊天室网关状态响应不正确')
    }
    return {
      ready: value.ready,
      epoch: value.epoch as number,
      capabilityState: value.capabilityState as ChatRoomReadinessStatus['capabilityState'],
      mode: value.mode as ChatRoomReadinessStatus['mode'],
      socketGeneration: value.socketGeneration as number,
      snapshotReady: value.snapshotReady,
      selectedCapabilities: [...new Set(value.selectedCapabilities as string[])],
    }
  }

  private async setAgentReadiness(roomId: string, roomAgentId: string, action: 'ready' | 'unready', options?: { signal?: AbortSignal }): Promise<unknown> {
    const path = `/api/internal/chatrooms/rooms/${component(roomId)}/agents/${component(roomAgentId)}/${action}`
    const token = this.getToken()
    if (!token?.trim()) throw new ChatRoomReadinessError('Rust HTTP API 尚未启动', 'Unknown', 'http_api_unavailable')
    let response: Response
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-Copis-Internal-Token': token },
        body: '{}', ...(options?.signal ? { signal: options.signal } : {}),
      })
    } catch (error) {
      if (options?.signal?.aborted) throw error
      throw new ChatRoomReadinessError('聊天室 ready 请求网络失败', 'Unknown', 'network_error')
    }
    const raw: unknown = await response.json().catch(() => ({}))
    const envelope = object(raw)
    const value = object('data' in envelope ? envelope.data : envelope)
    if (!response.ok) {
      const bodyError = object(envelope.error)
      const code = typeof envelope.code === 'string' ? envelope.code
        : typeof bodyError.code === 'string' ? bodyError.code
          : `http_${response.status}`
      const outcome = response.status === 401 || response.status === 403 || (response.status < 500 && response.status !== 404) ? 'Rejected' : 'Unknown'
      throw new ChatRoomReadinessError('聊天室 ready 请求未确认', outcome, code, response.status)
    }
    const command = `agent.${action}`
    const keys = ['outcome', 'mode', 'source', 'roomId', 'roomAgentId', 'command', 'requestId', 'generation']
    if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.prototype.hasOwnProperty.call(value, key))
      || value.outcome !== 'confirmed' || value.mode !== 'agent-ready-v1' || value.source !== 'private-ack'
      || value.roomId !== roomId || value.roomAgentId !== roomAgentId || value.command !== command
      || typeof value.requestId !== 'string' || !value.requestId || !Number.isSafeInteger(value.generation) || (value.generation as number) <= 0) {
      throw new ChatRoomReadinessError('聊天室 ready ACK 格式或上下文不匹配', 'Unknown', 'invalid_ready_receipt')
    }
    return value
  }

  async readyAgent(roomId: string, roomAgentId: string, options?: { signal?: AbortSignal }): Promise<unknown> {
    return this.setAgentReadiness(roomId, roomAgentId, 'ready', options)
  }

  async unreadyAgent(roomId: string, roomAgentId: string, options?: { signal?: AbortSignal }): Promise<unknown> {
    return this.setAgentReadiness(roomId, roomAgentId, 'unready', options)
  }

  async registerAgent(input: { roomId: string; displayName: string; deviceId: string; hostUserId: string; operationId?: string; memoryShared?: boolean; skillsShared?: boolean }): Promise<string | ChatRoomManagementReceipt> {
    if (input.operationId !== undefined) {
      if (!UUID_V4.test(input.operationId) || !UUID_V4.test(input.deviceId)
        || (input.memoryShared !== undefined && typeof input.memoryShared !== 'boolean')
        || (input.skillsShared !== undefined && typeof input.skillsShared !== 'boolean')) throw new Error('聊天室管理操作 ID、设备 ID 或共享设置不正确')
      const memoryShared = input.memoryShared ?? false
      const skillsShared = input.skillsShared ?? false
      const command = { action: 'register', operationId: input.operationId, deviceId: input.deviceId, displayName: input.displayName, memoryShared, skillsShared }
      const value = await this.managementRequest(`/api/internal/chatrooms/rooms/${component(input.roomId)}/agent-management/operations`, 'POST', command)
      return parseManagementReceipt(value, { operationId: input.operationId, roomId: input.roomId, hostUserId: input.hostUserId, action: 'register', displayName: input.displayName, memoryShared, skillsShared })
    }
    const value = object(await this.request(`/api/chatrooms/v2/rooms/${component(input.roomId)}/agents`, 'POST', {
      displayName: input.displayName, deviceId: input.deviceId,
    }))
    const agent = object(value.agent)
    if (agent.roomId !== input.roomId || String(agent.ownerUserId) !== input.hostUserId || !COMPONENT.test(String(agent.roomAgentId ?? ''))) {
      throw new Error('服务端 Agent ID 或身份不正确')
    }
    return agent.roomAgentId as string
  }

  async unregisterAgent(roomId: string, agentId: string, management?: { operationId: string; deviceId: string; hostUserId: string; mode: ChatRoomManagementMode }): Promise<void | ChatRoomManagementReceipt | ChatRoomLegacyRemovalConfirmation> {
    if (management) {
      if (!UUID_V4.test(management.operationId) || !UUID_V4.test(management.deviceId)) throw new Error('聊天室管理操作 ID 或设备 ID 不正确')
      if (management.mode === 'legacy') {
        try {
          await this.request(`/api/chatrooms/v2/rooms/${component(roomId)}/agents/${component(agentId)}`, 'DELETE')
          return { mode: 'legacy', outcome: 'confirmed', roomId, roomAgentId: agentId }
        } catch (error) {
          throw new ChatRoomManagementError('旧版聊天室 Agent 删除结果未知；journal 已保留，请勿重复删除', 0, 'legacy_remove_unknown')
        }
      }
      const status = await this.managementStatus({ roomId, ...management }, 'remove', agentId)
      if (status) return status
      const value = await this.managementRequest(`/api/internal/chatrooms/rooms/${component(roomId)}/agent-management/operations`, 'POST', {
        action: 'remove', operationId: management.operationId, deviceId: management.deviceId, roomAgentId: agentId,
      })
      return parseManagementReceipt(value, { operationId: management.operationId, roomId, hostUserId: management.hostUserId, action: 'remove', roomAgentId: agentId })
    }
    await this.request(`/api/chatrooms/v2/rooms/${component(roomId)}/agents/${component(agentId)}`, 'DELETE')
  }

  async updateAgentSharing(input: {
    roomId: string; roomAgentId: string; operationId: string; deviceId: string; hostUserId: string
    mode: 'v1'; memoryShared: boolean; skillsShared: boolean
  }): Promise<ChatRoomManagementReceipt> {
    if (!UUID_V4.test(input.operationId) || !UUID_V4.test(input.deviceId)
      || typeof input.memoryShared !== 'boolean' || typeof input.skillsShared !== 'boolean') {
      throw new Error('聊天室管理操作 ID、设备 ID 或共享设置不正确')
    }
    const statusInput = { ...input }
    const status = await this.managementStatus(statusInput, 'update-sharing', input.roomAgentId)
    if (status) return status
    const value = await this.managementRequest(`/api/internal/chatrooms/rooms/${component(input.roomId)}/agent-management/operations`, 'POST', {
      action: 'update-sharing', operationId: input.operationId, deviceId: input.deviceId,
      roomAgentId: input.roomAgentId, memoryShared: input.memoryShared, skillsShared: input.skillsShared,
    })
    return parseManagementReceipt(value, {
      operationId: input.operationId, roomId: input.roomId, hostUserId: input.hostUserId,
      action: 'update-sharing', roomAgentId: input.roomAgentId,
      memoryShared: input.memoryShared, skillsShared: input.skillsShared,
    })
  }

  async renewAgentLease(roomId: string, agentId: string, deviceId: string): Promise<void> {
    const value = object(await this.request(`/api/chatrooms/v2/rooms/${component(roomId)}/agents/${component(agentId)}/lease`, 'POST', { deviceId }))
    if (value.roomAgentId !== agentId || value.status !== 'online') throw new Error('Agent 租约响应不正确')
  }

  async lookupManagementOperation(input: { roomId: string; displayName: string; deviceId: string; hostUserId: string; operationId: string; memoryShared?: boolean; skillsShared?: boolean; mode?: ChatRoomManagementMode }): Promise<ChatRoomManagementOperationStatus> {
    if (!UUID_V4.test(input.operationId) || !UUID_V4.test(input.deviceId)) throw new Error('聊天室管理操作 ID 或设备 ID 不正确')
    if (input.mode === 'legacy') return { mode: 'legacy' }
    if (input.mode !== undefined && input.mode !== 'v1') throw new Error('聊天室管理协议模式不正确')
    if (input.mode === undefined && !await this.probeAgentManagementVersion()) return { mode: 'legacy' }
    const receipt = await this.managementStatus({ ...input, memoryShared: input.memoryShared ?? false, skillsShared: input.skillsShared ?? false }, 'register')
    return { mode: 'v1', ...(receipt ? { receipt } : {}) }
  }
}
