import type { DshGroupChatMessage } from '@copis/shared'

export interface SharedRoom {
  id: string
  name: string
  role: 'host' | 'member' | null
  shareCode?: string
  nextSeq?: number
  active: boolean
}
function obj(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('共享群响应格式不正确')
  return raw as Record<string, unknown>
}
function text(v: unknown): string {
  if (typeof v !== 'string' || !v) throw new Error('共享群响应缺少必要字段')
  return v
}
export function readSharedRoom(raw: unknown, account: string): SharedRoom {
  const r = obj(raw)
  const hostId = r.hostUserId
  const role = typeof hostId !== 'number' || !Number.isSafeInteger(hostId) || hostId <= 0 || !account
    ? null : String(hostId) === account ? 'host' : 'member'
  return {
    id: text(r.roomId),
    name: text(r.name),
    role,
    ...(Number.isSafeInteger(r.nextSeq) && Number(r.nextSeq) > 0 ? {nextSeq:Number(r.nextSeq)} : {}),
    active: r.status === 'active',
    shareCode:
      role === 'host' && r.shareCodeEnabled === true ? text(r.shareCode) : undefined,
  }
}
export interface HostAgent {
  id: string
  name: string
  state: string
  queuedCount: number | null
  callable: boolean
}
export function readHostAgents(raw: unknown, roomId: string): HostAgent[] {
  const detail = obj(raw),
    room = obj(detail.room)
  if (room.roomId !== roomId || room.hostUserId == null) throw new Error('房间信息不匹配')
  const states: Record<string, string> = {
    online: '空闲',
    busy: '思考中',
    offline: '离线',
    disabled: '已暂停',
    preparing: '准备中',
    configuration_error: '配置异常',
  }
  return (Array.isArray(detail.agents) ? detail.agents : [])
    .map(obj)
    .filter(
      (a) =>
        a.ownerUserId != null &&
        String(a.ownerUserId) === String(room.hostUserId) &&
        a.roomId === roomId,
    )
    .map((a) => {
      const count = room.roomKind === 'dsh_shared' && Number.isSafeInteger(a.queuedCount) && Number(a.queuedCount) >= 0
        ? Number(a.queuedCount) : null
      const available = a.availability === 'online' || a.availability === 'busy'
      const state = states[String(a.availability)]
      return { id: text(a.roomAgentId), name: text(a.displayName),
        state: available && count === null ? '待确认' : typeof state === 'string' ? state : '未知',
        queuedCount: count, callable: available && count !== null }
    })
}
export function newShareCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  return Array.from(
    crypto.getRandomValues(new Uint8Array(4)),
    (b) => alphabet[b % alphabet.length],
  ).join('')
}
export function readSharedMessage(raw: unknown, roomId: string): DshGroupChatMessage {
  const m = obj(raw)
  if (m.roomId !== roomId || !Number.isSafeInteger(m.seq) || Number(m.seq) <= 0)
    throw new Error('共享群消息与房间不匹配')
  const who = m.senderType === 'user' && m.senderUserId != null ? String(m.senderUserId) : null
  return {
    id: text(m.messageId),
    groupId: roomId,
    seq: Number(m.seq),
    kind: m.senderType === 'user' ? 'user' : m.senderType === 'agent' ? 'agent' : 'system',
    text: typeof m.content === 'string' ? m.content : '',
    authorUserId: who,
    authorName: who ? `用户 ${who}` : null,
    agentId: typeof m.senderAgentId === 'string' ? m.senderAgentId : null,
    agentName: null,
    attachmentIds: Array.isArray(m.attachmentIds) ? m.attachmentIds.filter((id): id is string => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(id)) : [],
    mentions: [],
    createdAt: text(m.createdAt),
  }
}
export function readSharedEvents(raw: unknown, roomId: string, after: number) {
  if (!Array.isArray(raw)) throw new Error('群事件列表格式不正确')
  let cursor = after
  const messages: DshGroupChatMessage[] = []
  for (const item of raw) {
    const e = obj(item)
    if (e.roomId !== roomId || !Number.isSafeInteger(e.seq) || Number(e.seq) <= cursor)
      throw new Error('群事件序号异常')
    cursor = Number(e.seq)
    if (e.eventType === 'message.created')
      messages.push(
        readSharedMessage(
          { ...obj(e.payload), createdAt: e.createdAt ?? obj(e.payload).createdAt },
          roomId,
        ),
      )
  }
  return { cursor, messages, more: raw.length === 100 }
}
export function mergeSharedMessages(before: DshGroupChatMessage[], next: DshGroupChatMessage[]) {
  return Array.from(new Map([...before, ...next].map((m) => [m.id, m])).values()).sort(
    (a, b) => a.seq - b.seq,
  )
}
