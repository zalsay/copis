import type { ChatRoomAgent, ChatRoomAgentLocalView, ChatRoomAttachment, ChatRoomCreateInput, ChatRoomEventEnvelope, ChatRoomJoinInput, ChatRoomMember, ChatRoomMessage, ChatRoomSendMessageInput, ChatRoomSummary } from '@copis/shared'
import { normalizeChatRoomShareCode } from '@copis/shared'
import { RENDERER_HTTP_API_BASE_URL } from './http-api-base-url'
import { withHttpApiWebToken } from './http-api-web-token'

export class ChatRoomApiError extends Error {
  readonly status: number
  readonly code: string
  constructor(message: string, status: number, code = 'chatroom_request_failed') {
    super(message); this.name = 'ChatRoomApiError'; this.status = status; this.code = code
  }
}
export class ChatRoomProvisionError extends Error {
  readonly room: ChatRoomSummary
  readonly agentName: string
  readonly succeededCount: number
  readonly totalCount: number
  constructor(room: ChatRoomSummary, agentName: string, cause: unknown, succeededCount: number, totalCount: number) { super(`聊天室已创建，但 Agent「${agentName}」配置失败：${cause instanceof Error ? cause.message : '未知错误'}`); this.name = 'ChatRoomProvisionError'; this.room = room; this.agentName = agentName; this.succeededCount = succeededCount; this.totalCount = totalCount }
}

export interface ChatRoomProvisionProgress {
  completed: number
  total: number
  agentName: string
}

export interface ChatRoomCreateOptions {
  onProvisionProgress?: (progress: ChatRoomProvisionProgress) => void
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
type RecordValue = Record<string, unknown>
const record = (value: unknown): RecordValue => (typeof value === 'object' && value !== null && !Array.isArray(value) ? value as RecordValue : {})
const text = (v: unknown, fallback = ''): string => typeof v === 'string' ? v : fallback
const bool = (v: unknown): boolean => v === true
const num = (v: unknown, fallback = 0): number => typeof v === 'number' && Number.isFinite(v) ? v : fallback
const array = (v: unknown): unknown[] => Array.isArray(v) ? v : []
const pick = (o: RecordValue, ...keys: string[]): unknown => keys.map((key) => o[key]).find((v) => v !== undefined)

function normalizeSummary(value: unknown): ChatRoomSummary {
  const o = record(value)
  return { roomId: text(pick(o, 'roomId', 'room_id', 'id')), name: text(o.name), role: o.role === 'host' ? 'host' : 'member', status: ['active', 'archived', 'deleting', 'deleted'].includes(text(o.status)) ? o.status as ChatRoomSummary['status'] : 'active', ...(typeof pick(o, 'shareCode', 'share_code') === 'string' ? { shareCode: text(pick(o, 'shareCode', 'share_code')) } : {}), memberCount: num(pick(o, 'memberCount', 'member_count')), unreadCount: num(pick(o, 'unreadCount', 'unread_count')), connectionStatus: ['connecting', 'connected', 'reconnecting', 'offline', 'auth_expired'].includes(text(pick(o, 'connectionStatus', 'connection_status'))) ? pick(o, 'connectionStatus', 'connection_status') as ChatRoomSummary['connectionStatus'] : 'offline' }
}
function normalizeMember(value: unknown): ChatRoomMember { const o = record(value); return { userId: text(pick(o, 'userId', 'user_id', 'id')), displayName: text(pick(o, 'displayName', 'display_name', 'name')), ...(typeof o.avatar === 'string' ? { avatar: o.avatar } : {}), role: o.role === 'host' ? 'host' : 'member', presence: ['online', 'busy', 'offline', 'disabled'].includes(text(o.presence)) ? o.presence as ChatRoomMember['presence'] : 'offline' } }
function normalizeAgent(value: unknown): ChatRoomAgent { const o = record(value); return { agentId: text(pick(o, 'agentId', 'agent_id', 'id')), displayName: text(pick(o, 'displayName', 'display_name', 'name')), ...(typeof o.avatar === 'string' ? { avatar: o.avatar } : {}), status: ['online', 'busy', 'offline', 'disabled'].includes(text(o.status)) ? o.status as ChatRoomAgent['status'] : 'offline', busy: bool(o.busy), memoryShared: bool(pick(o, 'memoryShared', 'memory_shared')), skillsShared: bool(pick(o, 'skillsShared', 'skills_shared')) } }
export function normalizeChatRoomMessage(value: unknown, defaults: { roomId?: string; seq?: number } = {}): ChatRoomMessage {
  const o = record(record(value).message ?? value)
  const sender = record(o.sender)
  const rawSenderType = pick(sender, 'type', 'senderType', 'sender_type') ?? pick(o, 'senderType', 'sender_type')
  const senderType = ['user', 'agent', 'system'].includes(text(rawSenderType)) ? rawSenderType as ChatRoomMessage['senderType'] : 'system'
  const rawCreatedAt = pick(o, 'createdAt', 'created_at')
  return {
    messageId: text(pick(o, 'messageId', 'message_id', 'id')),
    roomId: text(pick(o, 'roomId', 'room_id')) || defaults.roomId || '',
    seq: num(o.seq, defaults.seq ?? 0),
    senderType,
    senderId: text(pick(sender, 'id', 'senderId', 'sender_id')) || text(pick(o, 'senderId', 'sender_id')),
    content: text(pick(o, 'text', 'content')),
    mentionAgentIds: array(pick(o, 'mentionedAgentIds', 'mentionAgentIds', 'mentioned_agent_ids', 'mention_agent_ids')).filter((v): v is string => typeof v === 'string'),
    attachmentIds: array(pick(o, 'attachmentIds', 'attachment_ids')).filter((v): v is string => typeof v === 'string'),
    clientMessageId: text(pick(o, 'clientMessageId', 'client_message_id')),
    ...(typeof pick(o, 'traceId', 'trace_id') === 'string' ? { traceId: text(pick(o, 'traceId', 'trace_id')) } : {}),
    ...(typeof pick(o, 'parentMessageId', 'parent_message_id') === 'string' ? { parentMessageId: text(pick(o, 'parentMessageId', 'parent_message_id')) } : {}),
    depth: num(o.depth),
    createdAt: typeof rawCreatedAt === 'number' || typeof rawCreatedAt === 'string' ? String(rawCreatedAt) : '',
  }
}
function normalizeAttachment(value: unknown): ChatRoomAttachment { const o = record(value); const status = ['pending', 'ready', 'attached', 'deleted'].includes(text(o.status)) ? text(o.status) as ChatRoomAttachment['status'] : 'pending'; return { attachmentId: text(pick(o, 'attachmentId', 'attachment_id', 'id')), roomId: text(pick(o, 'roomId', 'room_id')), originalName: text(pick(o, 'originalName', 'original_name', 'fileName')), mimeType: text(pick(o, 'mimeType', 'mime_type')), sizeBytes: num(pick(o, 'sizeBytes', 'size_bytes')), status, ...(typeof pick(o, 'messageId', 'message_id') === 'string' ? { messageId: text(pick(o, 'messageId', 'message_id')) } : {}) } }
export interface ChatRoomApi {
  listRooms(): Promise<ChatRoomSummary[]>
  getRoom(roomId: string): Promise<{ room: ChatRoomSummary; members: ChatRoomMember[]; agents: ChatRoomAgent[] }>
  createRoom(input: ChatRoomCreateInput, selectedAgents?: Array<Pick<ChatRoomAgentLocalView, 'sourceWorkspaceId' | 'displayName' | 'channelId' | 'modelId' | 'contextMessageCount' | 'memorySharingEnabled' | 'skillSharingEnabled'>>, options?: ChatRoomCreateOptions): Promise<ChatRoomSummary>
  joinRoom(input: ChatRoomJoinInput): Promise<ChatRoomSummary>
  getMessages(roomId: string, options?: { beforeSeq?: number; limit?: number }): Promise<{ messages: ChatRoomMessage[]; cursor?: number }>
  sendMessage(input: Omit<ChatRoomSendMessageInput, 'clientMessageId'> & { clientMessageId?: string }): Promise<ChatRoomMessage>
  markRead(roomId: string, seq: number): Promise<void>
  listAgents(roomId: string): Promise<ChatRoomAgent[]>
  listAttachments(roomId: string): Promise<ChatRoomAttachment[]>
  archiveRoom(roomId: string): Promise<void>
  restoreRoom(roomId: string): Promise<void>
  deleteRoom(roomId: string): Promise<void>
  removeMember(roomId: string, memberId: string): Promise<void>
}

export function createChatRoomApi(options: { fetchImpl?: FetchLike; baseUrl?: string } = {}): ChatRoomApi {
  const fetchImpl = options.fetchImpl ?? fetch
  const base = options.baseUrl ?? RENDERER_HTTP_API_BASE_URL
  async function request<T>(path: string, init: RequestInit = {}, map: (v: unknown) => T): Promise<T> {
    const response = await fetchImpl(`${base}${path}`, withHttpApiWebToken({ ...init, headers: { Accept: 'application/json', ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers } }))
    const raw = await response.text(); let payload: unknown
    try { payload = raw ? JSON.parse(raw) : undefined } catch { payload = undefined }
    if (!response.ok) { const o = record(payload); throw new ChatRoomApiError(text(o.message, `聊天室请求失败（${response.status}）`), response.status, text(o.code, `http_${response.status}`)) }
    return map(payload)
  }
  const json = (value: unknown): string => JSON.stringify(value)
  return {
    listRooms: () => request('/api/chatrooms/v2/rooms', {}, (v) => array(record(v).rooms ?? v).map(normalizeSummary)),
    getRoom: (roomId) => request(`/api/chatrooms/v2/rooms/${encodeURIComponent(roomId)}`, {}, (v) => { const o = record(v); return { room: normalizeSummary(o.room ?? v), members: array(o.members).map(normalizeMember), agents: array(o.agents).map(normalizeAgent) } }),
    createRoom: async (input, selectedAgents = [], options = {}) => { const shareCode = normalizeChatRoomShareCode(input.shareCode); if (!shareCode) throw new ChatRoomApiError('分享码必须是4位字母或数字', 400, 'invalid_share_code'); const room = await request('/api/chatrooms/v2/rooms', { method: 'POST', body: json({ name: input.name, shareCode }) }, (v) => normalizeSummary(record(v).room ?? v)); const provision = (globalThis as typeof globalThis & { window?: Window }).window?.electronAPI?.chatrooms?.provisionAgent; const agents = selectedAgents.slice(0, 3); if (provision && agents.length > 0) { options.onProvisionProgress?.({ completed: 0, total: agents.length, agentName: '' }); let succeededCount = 0; for (const agent of agents) { try { await provision({ roomId: room.roomId, sourceWorkspaceId: agent.sourceWorkspaceId, displayName: agent.displayName, channelId: agent.channelId, ...(agent.modelId === undefined ? {} : { modelId: agent.modelId }), contextMessageCount: agent.contextMessageCount, memorySharingEnabled: agent.memorySharingEnabled, skillSharingEnabled: agent.skillSharingEnabled }); succeededCount += 1; options.onProvisionProgress?.({ completed: succeededCount, total: agents.length, agentName: agent.displayName }) } catch (error) { throw new ChatRoomProvisionError(room, agent.displayName, error, succeededCount, agents.length) } } } return room },
    joinRoom: (input) => { const shareCode = normalizeChatRoomShareCode(input.shareCode); if (!shareCode) return Promise.reject(new ChatRoomApiError('分享码必须是4位字母或数字', 400, 'invalid_share_code')); return request('/api/chatrooms/v2/join', { method: 'POST', body: json({ shareCode }) }, (v) => normalizeSummary(record(v).room ?? v)) },
    getMessages: (roomId, options = {}) => { const qs = new URLSearchParams(); if (options.beforeSeq !== undefined) qs.set('beforeSeq', String(options.beforeSeq)); if (options.limit !== undefined) qs.set('limit', String(options.limit)); return request(`/api/chatrooms/v2/rooms/${encodeURIComponent(roomId)}/messages${qs.size ? `?${qs}` : ''}`, {}, (v) => { const o = record(v); return { messages: array(o.messages ?? o.data ?? v).map((message) => normalizeChatRoomMessage(message, { roomId })), ...(typeof o.cursor === 'number' ? { cursor: o.cursor } : {}) } }) },
    sendMessage: (input) => request(`/api/chatrooms/v2/rooms/${encodeURIComponent(input.roomId)}/messages`, { method: 'POST', body: json({ content: input.content, mentionAgentIds: input.mentionAgentIds, attachmentIds: input.attachmentIds, clientMessageId: input.clientMessageId ?? crypto.randomUUID() }) }, (v) => normalizeChatRoomMessage(record(v).message ?? record(v).data ?? v, { roomId: input.roomId })),
    markRead: (roomId, seq) => request(`/api/chatrooms/v2/rooms/${encodeURIComponent(roomId)}/read`, { method: 'PATCH', body: json({ seq }) }, () => undefined),
    listAgents: (roomId) => request(`/api/chatrooms/v2/rooms/${encodeURIComponent(roomId)}/agents`, {}, (v) => array(record(v).agents ?? v).map(normalizeAgent)),
    listAttachments: (roomId) => request(`/api/chatrooms/v2/rooms/${encodeURIComponent(roomId)}/attachments`, {}, (v) => array(record(v).attachments ?? v).map(normalizeAttachment)),
    archiveRoom: (roomId) => request(`/api/chatrooms/v2/rooms/${encodeURIComponent(roomId)}/archive`, { method: 'POST' }, () => undefined),
    restoreRoom: (roomId) => request(`/api/chatrooms/v2/rooms/${encodeURIComponent(roomId)}/restore`, { method: 'POST' }, () => undefined),
    deleteRoom: (roomId) => request(`/api/chatrooms/v2/rooms/${encodeURIComponent(roomId)}`, { method: 'DELETE' }, () => undefined),
    removeMember: (roomId, memberId) => request(`/api/chatrooms/v2/rooms/${encodeURIComponent(roomId)}/members/${encodeURIComponent(memberId)}`, { method: 'DELETE' }, () => undefined),
  }
}

export const chatRoomApi = createChatRoomApi()
export type { ChatRoomEventEnvelope }
