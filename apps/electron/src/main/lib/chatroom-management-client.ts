import { getHttpApiInternalToken, HTTP_API_HOST, HTTP_API_PORT } from './http-api-server'

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
const COMPONENT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

function component(value: string): string {
  if (!COMPONENT.test(value)) throw new Error('聊天室 ID 不正确')
  return encodeURIComponent(value)
}

function object(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
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

  private async request(path: string, method: 'GET' | 'POST' | 'DELETE', body?: object): Promise<unknown> {
    const token = this.getToken()
    if (!token?.trim()) throw new Error('Rust HTTP API 尚未启动')
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: { Accept: 'application/json', 'X-Copis-Internal-Token': token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    if (!response.ok) throw new Error(`聊天室管理请求失败（${response.status}）`)
    if (method === 'DELETE') return undefined
    const envelope = object(await response.json())
    return 'data' in envelope ? envelope.data : envelope
  }

  async getRoomHostUserId(roomId: string): Promise<string> {
    const value = object(await this.request(`/api/chatrooms/v2/rooms/${component(roomId)}`, 'GET'))
    const room = object(value.room)
    if (room.roomId !== roomId || room.status !== 'active' || (typeof room.hostUserId !== 'number' && typeof room.hostUserId !== 'string')) {
      throw new Error('聊天室主理人信息不可用')
    }
    return String(room.hostUserId)
  }

  async getRoomRealtimeStatus(roomId: string): Promise<{ ready: boolean; epoch: number }> {
    const value = object(await this.request(`/api/internal/chatrooms/rooms/${component(roomId)}/status`, 'GET'))
    if (typeof value.ready !== 'boolean' || !Number.isSafeInteger(value.epoch) || (value.epoch as number) < 0) throw new Error('聊天室网关状态响应不正确')
    return { ready: value.ready, epoch: value.epoch as number }
  }

  async registerAgent(input: { roomId: string; displayName: string; deviceId: string; hostUserId: string }): Promise<string> {
    const value = object(await this.request(`/api/chatrooms/v2/rooms/${component(input.roomId)}/agents`, 'POST', {
      displayName: input.displayName, deviceId: input.deviceId,
    }))
    const agent = object(value.agent)
    if (agent.roomId !== input.roomId || String(agent.ownerUserId) !== input.hostUserId || !COMPONENT.test(String(agent.roomAgentId ?? ''))) {
      throw new Error('服务端 Agent ID 或身份不正确')
    }
    return agent.roomAgentId as string
  }

  async unregisterAgent(roomId: string, agentId: string): Promise<void> {
    await this.request(`/api/chatrooms/v2/rooms/${component(roomId)}/agents/${component(agentId)}`, 'DELETE')
  }

  async renewAgentLease(roomId: string, agentId: string, deviceId: string): Promise<void> {
    const value = object(await this.request(`/api/chatrooms/v2/rooms/${component(roomId)}/agents/${component(agentId)}/lease`, 'POST', { deviceId }))
    if (value.roomAgentId !== agentId || value.status !== 'online') throw new Error('Agent 租约响应不正确')
  }

  async findRegisteredAgent(input: { roomId: string; displayName: string; deviceId: string; hostUserId: string }): Promise<{ agentId: string; leaseVerified: boolean } | undefined> {
    const detail = object(await this.request(`/api/chatrooms/v2/rooms/${component(input.roomId)}`, 'GET'))
    const room = object(detail.room)
    if (room.roomId !== input.roomId || room.status !== 'active' || String(room.hostUserId) !== input.hostUserId || !Array.isArray(detail.agents)) {
      throw new Error('聊天室 Agent 归属无法验证')
    }
    const matches = detail.agents.map(object).filter((agent) => agent.roomId === input.roomId
      && String(agent.ownerUserId) === input.hostUserId
      && typeof agent.displayName === 'string'
      && agent.displayName.toLowerCase() === input.displayName.trim().toLowerCase())
    if (matches.length === 0) return undefined
    const agentId = matches[0]?.roomAgentId
    if (matches.length !== 1 || typeof agentId !== 'string' || !COMPONENT.test(agentId)) throw new Error('聊天室 Agent 归属无法验证')
    // 服务端不向客户端暴露 deviceIdHash；续租成功才证明这是当前设备注册的 Agent。
    try {
      await this.renewAgentLease(input.roomId, agentId, input.deviceId)
      return { agentId, leaseVerified: true }
    } catch {
      return { agentId, leaseVerified: false }
    }
  }
}
