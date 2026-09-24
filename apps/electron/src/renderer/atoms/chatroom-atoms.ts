import { atom } from 'jotai'
import type { ChatRoomAgent, ChatRoomAttachment, ChatRoomConnectionStatus, ChatRoomEventEnvelope, ChatRoomInvocation, ChatRoomMessage, ChatRoomPermissionRequest, ChatRoomSummary, ChatRoomTransferState } from '@copis/shared'
import { normalizeChatRoomMessage, type ChatRoomSendResult } from '../lib/chatroom-api'

export type ChatRoomMessageState = Map<string, ChatRoomMessage[]>
export type ChatRoomCursorState = Map<string, number>
export type ChatRoomInvocationState = Map<string, Map<string, ChatRoomInvocation>>
export type ChatRoomDraftState = Map<string, string>
export type ChatRoomMentionState = Map<string, string[]>
export type ChatRoomUnreadState = Map<string, number>
export type ChatRoomTransferStateMap = Map<string, ChatRoomTransferState>
export type ChatRoomSendState = { roomId: string; clientMessageId: string; status: 'sending' | 'sent' | 'failed'; content: string; mentionAgentIds: string[]; attachmentIds: string[]; error?: string; startedAt?: number; messageId?: string }

export const chatRoomRoomsAtom = atom<ChatRoomSummary[]>([])
export const chatRoomDetailsAtom = atom<Record<string, unknown>>( {})
export const chatRoomMessagesAtom = atom<ChatRoomMessageState>(new Map())
export const chatRoomCursorsAtom = atom<ChatRoomCursorState>(new Map())
export const chatRoomConnectionStatusAtom = atom<Map<string, ChatRoomConnectionStatus>>(new Map())
export const chatRoomInvocationsAtom = atom<ChatRoomInvocationState>(new Map())
export const chatRoomTransfersAtom = atom<ChatRoomTransferStateMap>(new Map())
export const chatRoomDraftsAtom = atom<ChatRoomDraftState>(new Map())
export const chatRoomMentionAgentIdsAtom = atom<ChatRoomMentionState>(new Map())
export const chatRoomUnreadCountsAtom = atom<ChatRoomUnreadState>(new Map())
export const chatRoomSendStatesAtom = atom<Map<string, ChatRoomSendState>>(new Map())
/** 已删除房间的本地墓碑，阻止迟到的 HTTP/SSE 结果重新写回状态。 */
export const chatRoomDeletedRoomIdsAtom = atom<Set<string>>(new Set<string>())
export const chatRoomPermissionRequestsAtom = atom<Map<string, ChatRoomPermissionRequest>>(new Map())

/** 超时只记录本地未确认结果，不改变服务端调用；迟到的真实结果仍有优先权。 */
export const chatRoomExpirePendingInvocationAtom = atom(null, (get, set, pending: ChatRoomInvocation) => {
  if (!pending.invocationId.startsWith('pending:') || pending.status !== 'created' || get(chatRoomDeletedRoomIdsAtom).has(pending.roomId)) return
  const sends = [...get(chatRoomSendStatesAtom).values()]
  if (!sends.some((send) => send.roomId === pending.roomId && send.status !== 'failed' && send.mentionAgentIds.some((id) => `pending:${send.clientMessageId}:${id}` === pending.invocationId))) return
  const room = new Map(get(chatRoomInvocationsAtom).get(pending.roomId) ?? [])
  if (room.has(pending.invocationId) || (pending.triggerMessageId && [...room.values()].some((item) => item.targetAgentId === pending.targetAgentId && item.triggerMessageId === pending.triggerMessageId))) return
  room.set(pending.invocationId, { ...pending, status: 'rejected', failureCode: 'invocation_unconfirmed' })
  set(chatRoomInvocationsAtom, (current) => new Map(current).set(pending.roomId, room))
})

function clearLocalInvocationTimeout(room: Map<string, ChatRoomInvocation>, agentId: string, messageId: string, clientMessageId?: string): void {
  for (const [id, item] of room) {
    if (id.startsWith('pending:') && item.failureCode === 'invocation_unconfirmed' && item.targetAgentId === agentId
      && ((messageId && item.triggerMessageId === messageId) || (clientMessageId && id === `pending:${clientMessageId}:${agentId}`))) room.delete(id)
  }
}

function messageKey(message: ChatRoomMessage): string {
  if (message.messageId) return `id:${message.messageId}`
  if (message.seq > 0) return `seq:${message.seq}`
  if (message.clientMessageId) return `client:${message.clientMessageId}`
  return `anonymous:${message.createdAt}:${message.senderId}:${message.content}`
}

/** 合并历史与实时消息。历史请求可能晚于 SSE 返回，不能覆盖已经到达的实时消息。 */
export function mergeChatRoomMessages(current: ChatRoomMessage[], incoming: ChatRoomMessage[]): ChatRoomMessage[] {
  const merged = new Map<string, ChatRoomMessage>()
  const put = (message: ChatRoomMessage) => {
    const key = [...merged.entries()].find(([, existing]) =>
      (message.messageId && existing.messageId === message.messageId) ||
      (message.seq > 0 && existing.seq > 0 && existing.seq === message.seq))?.[0] ?? messageKey(message)
    const previous = merged.get(key)
    // 后到的消息只补全已有字段，避免历史响应覆盖实时响应携带的较新内容。
    merged.set(key, previous ? {
      ...previous,
      ...message,
      messageId: message.messageId || previous.messageId,
      roomId: message.roomId || previous.roomId,
      senderId: message.senderId || previous.senderId,
      content: message.content || previous.content,
      createdAt: message.createdAt || previous.createdAt,
    } : message)
  }
  current.forEach(put)
  incoming.forEach(put)
  return [...merged.values()].sort((a, b) => {
    if (a.seq !== b.seq && (a.seq > 0 || b.seq > 0)) return a.seq - b.seq
    return a.createdAt.localeCompare(b.createdAt) || messageKey(a).localeCompare(messageKey(b))
  })
}

export const chatRoomHydrateMessagesAtom = atom(null, (_get, set, input: { roomId: string; messages: ChatRoomMessage[]; cursor?: number }) => {
  set(chatRoomMessagesAtom, (current) => {
    const next = new Map(current)
    // 以历史作为基线、当前状态作为后到数据，确保加载期间收到的 SSE 内容优先。
    next.set(input.roomId, mergeChatRoomMessages(input.messages, current.get(input.roomId) ?? []))
    return next
  })
  const historicalCursor = input.messages.reduce((max, message) => Math.max(max, message.seq), 0)
  if (input.cursor !== undefined || historicalCursor > 0) set(chatRoomCursorsAtom, (current) => new Map(current).set(input.roomId, Math.max(current.get(input.roomId) ?? 0, input.cursor ?? 0, historicalCursor)))
})

export const chatRoomActiveRoomIdAtom = atom<string | undefined>(undefined)
export const chatRoomResetStateAtom = atom(null, (_get, set) => {
  set(chatRoomRoomsAtom, [])
  set(chatRoomDetailsAtom, {})
  set(chatRoomMessagesAtom, new Map())
  set(chatRoomCursorsAtom, new Map())
  set(chatRoomConnectionStatusAtom, new Map())
  set(chatRoomInvocationsAtom, new Map())
  set(chatRoomTransfersAtom, new Map())
  set(chatRoomDraftsAtom, new Map())
  set(chatRoomMentionAgentIdsAtom, new Map())
  set(chatRoomUnreadCountsAtom, new Map())
  set(chatRoomSendStatesAtom, new Map())
  set(chatRoomDeletedRoomIdsAtom, new Set())
  set(chatRoomPermissionRequestsAtom, new Map())
  set(chatRoomActiveRoomIdAtom, undefined)
})
export const chatRoomRemoveRoomAtom = atom(null, (get, set, roomId: string) => {
  const removeKey = <T>(current: Map<string, T>): Map<string, T> => { const next = new Map(current); next.delete(roomId); return next }
  set(chatRoomRoomsAtom, (current) => current.filter((room) => room.roomId !== roomId))
  set(chatRoomDetailsAtom, (current) => { const next = { ...current }; delete next[roomId]; return next })
  set(chatRoomMessagesAtom, removeKey)
  set(chatRoomCursorsAtom, removeKey)
  set(chatRoomConnectionStatusAtom, removeKey)
  set(chatRoomUnreadCountsAtom, removeKey)
  set(chatRoomDraftsAtom, removeKey)
  set(chatRoomMentionAgentIdsAtom, removeKey)
  set(chatRoomInvocationsAtom, removeKey)
  set(chatRoomTransfersAtom, (current) => new Map([...current].filter(([, state]) => state.roomId !== roomId)))
  set(chatRoomSendStatesAtom, (current) => new Map([...current].filter(([, state]) => state.roomId !== roomId)))
  set(chatRoomPermissionRequestsAtom, (current) => new Map([...current].filter(([, request]) => request.roomId !== roomId)))
  set(chatRoomDeletedRoomIdsAtom, (current: Set<string>) => new Set(current).add(roomId))
  if (get(chatRoomActiveRoomIdAtom) === roomId) set(chatRoomActiveRoomIdAtom, undefined)
})
export const chatRoomRejoinRoomAtom = atom(null, (_get, set, room: ChatRoomSummary) => {
  set(chatRoomDeletedRoomIdsAtom, (current) => { const next = new Set(current); next.delete(room.roomId); return next })
  set(chatRoomRoomsAtom, (current) => [...current.filter((item) => item.roomId !== room.roomId), room])
})
export const chatRoomClearPermissionRequestAtom = atom(null, (get, set, requestId: string) => { const next = new Map(get(chatRoomPermissionRequestsAtom)); next.delete(requestId); set(chatRoomPermissionRequestsAtom, next) })
export const chatRoomApplyEventAtom = atom(null, (get, set, event: ChatRoomEventEnvelope) => {
  const roomId = event.roomId; if (!roomId) return
  if (get(chatRoomDeletedRoomIdsAtom).has(roomId)) return
  if (event.type === 'local.status' && (event.code === 'room_not_found' || event.code === 'not_member')) {
    set(chatRoomRemoveRoomAtom, roomId)
    return
  }
  const payload = (typeof event.payload === 'object' && event.payload !== null ? event.payload : {}) as Record<string, unknown>
  const presence = event.type === 'agent.presence_changed' ? payload.status : event.type === 'agent.offline' ? 'offline' : event.type === 'agent.busy' ? 'busy' : event.type === 'agent.disabled' ? 'disabled' : undefined
  if (typeof presence === 'string' && ['online', 'offline', 'busy', 'disabled'].includes(presence)) {
    const agentId = payload.roomAgentId ?? payload.agentId
    set(chatRoomDetailsAtom, (current) => {
      const detail = current[roomId] as { agents?: ChatRoomAgent[] } | undefined
      if (!Array.isArray(detail?.agents)) return current
      return { ...current, [roomId]: { ...detail, agents: detail.agents.map((agent) => agent.agentId === agentId ? { ...agent, status: presence as ChatRoomAgent['status'], busy: presence === 'busy' } : agent) } }
    })
  }
  if (event.seq !== undefined) set(chatRoomCursorsAtom, (current) => new Map(current).set(roomId, Math.max(current.get(roomId) ?? 0, event.seq!)))
  if (event.type === 'message.created') {
    const message = normalizeChatRoomMessage(payload, { roomId, seq: event.seq })
    if (message.senderType === 'agent' && message.parentMessageId) {
      set(chatRoomInvocationsAtom, (current) => {
        const room = new Map(current.get(roomId) ?? [])
        clearLocalInvocationTimeout(room, message.senderId, message.parentMessageId!)
        for (const [id, invocation] of room) {
          if (invocation.targetAgentId === message.senderId && invocation.triggerMessageId === message.parentMessageId && ['created', 'accepted', 'running'].includes(invocation.status)) room.set(id, { ...invocation, status: 'completed' })
        }
        return new Map(current).set(roomId, room)
      })
    }
    let added = false
    set(chatRoomMessagesAtom, (current) => {
      const existing = current.get(roomId) ?? []
      const merged = mergeChatRoomMessages(existing, [message])
      added = merged.length > existing.length
      const next = new Map(current); next.set(roomId, merged); return next
    })
    if (added && get(chatRoomActiveRoomIdAtom) !== roomId) set(chatRoomUnreadCountsAtom, (current) => new Map(current).set(roomId, (current.get(roomId) ?? 0) + 1))
  } else if (['agent.offline', 'agent.busy', 'agent.disabled', 'invocation.limit_reached'].includes(event.type)) {
    const targetAgentId = typeof payload.agentId === 'string' ? payload.agentId : undefined
    const triggerMessageId = typeof payload.messageId === 'string' ? payload.messageId : undefined
    // presence 离线广播没有触发消息，不能虚构一次调用失败。
    if (!targetAgentId || !triggerMessageId) return
    const invocationId = `result:${triggerMessageId}:${targetAgentId}`
    set(chatRoomInvocationsAtom, (current) => {
      const room = new Map(current.get(roomId) ?? [])
      clearLocalInvocationTimeout(room, targetAgentId, triggerMessageId, typeof payload.clientMessageId === 'string' ? payload.clientMessageId : undefined)
      room.set(invocationId, { invocationId, roomId, targetAgentId, triggerMessageId, traceId: '', depth: 0, status: 'rejected', failureCode: typeof payload.failureCode === 'string' ? payload.failureCode : typeof payload.reason === 'string' ? payload.reason : event.type.replace('.', '_') })
      return new Map(current).set(roomId, room)
    })
  } else if (['agent.invocation', 'agent.accepted', 'agent.delta', 'agent.completed', 'agent.failed'].includes(event.type)) {
    const invocationId = typeof payload.invocationId === 'string' ? payload.invocationId : undefined
    if (!invocationId) return
    set(chatRoomInvocationsAtom, (current) => {
      const next = new Map(current)
      const room = new Map(current.get(roomId) ?? [])
      const old = room.get(invocationId)
      clearLocalInvocationTimeout(room, typeof payload.targetAgentId === 'string' ? payload.targetAgentId : old?.targetAgentId ?? '', typeof payload.triggerMessageId === 'string' ? payload.triggerMessageId : old?.triggerMessageId ?? '', typeof payload.clientMessageId === 'string' ? payload.clientMessageId : undefined)
      const oldIsTerminal = old?.status === 'completed' || old?.status === 'failed' || old?.status === 'rejected'
      const incomingStatus = event.type === 'agent.invocation' ? 'created' : event.type === 'agent.accepted' ? 'accepted' : event.type === 'agent.delta' ? 'running' : event.type === 'agent.completed' ? 'completed' : 'failed'
      if (oldIsTerminal && ['completed', 'failed'].includes(incomingStatus) && incomingStatus !== old.status) return current
      const olderPhase = (old?.status === 'running' && ['created', 'accepted'].includes(incomingStatus)) || (old?.status === 'accepted' && incomingStatus === 'created')
      const status = oldIsTerminal || olderPhase ? old!.status : incomingStatus
      room.set(invocationId, {
        ...(old ?? {}),
        invocationId,
        roomId,
        traceId: typeof payload.traceId === 'string' ? payload.traceId : old?.traceId ?? '',
        targetAgentId: typeof payload.targetAgentId === 'string' ? payload.targetAgentId : old?.targetAgentId ?? '',
        triggerMessageId: typeof payload.triggerMessageId === 'string' ? payload.triggerMessageId : old?.triggerMessageId ?? '',
        depth: typeof payload.depth === 'number' ? payload.depth : old?.depth ?? 0,
        status,
        startedAt: old?.startedAt ?? Date.now(),
        ...(event.type === 'agent.delta' && !oldIsTerminal && typeof payload.delta === 'string' ? { delta: `${old?.delta ?? ''}${payload.delta}` } : {}),
        ...(!oldIsTerminal && typeof payload.failureCode === 'string' ? { failureCode: payload.failureCode } : {}),
        ...(typeof payload.message === 'string' ? { errorMessage: payload.message } : {}),
      })
      next.set(roomId, room)
      return next
    })
  }
})
export const chatRoomSetDraftAtom = atom(null, (_get, set, input: { roomId: string; value: string }) => set(chatRoomDraftsAtom, (current) => new Map(current).set(input.roomId, input.value)))
export const chatRoomSetMentionsAtom = atom(null, (_get, set, input: { roomId: string; agentIds: string[] }) => set(chatRoomMentionAgentIdsAtom, (current) => new Map(current).set(input.roomId, [...input.agentIds])))
export const chatRoomSetTransferAtom = atom(null, (_get, set, state: ChatRoomTransferState) => set(chatRoomTransfersAtom, (current) => new Map(current).set(state.transferId, state)))
export const chatRoomConsumeTransfersAtom = atom(null, (_get, set, attachmentIds: string[]) => set(chatRoomTransfersAtom, (current) => { const next = new Map(current); for (const [transferId, state] of next) if (state.attachmentId && attachmentIds.includes(state.attachmentId)) next.delete(transferId); return next }))
export const chatRoomMarkReadAtom = atom(null, (_get, set, roomId: string) => { set(chatRoomUnreadCountsAtom, (current) => new Map(current).set(roomId, 0)) })
type ChatRoomSendInput = { api: { sendMessage(value: { roomId: string; content: string; mentionAgentIds: string[]; attachmentIds: string[]; clientMessageId: string }): Promise<ChatRoomSendResult> }; roomId: string; content: string; mentionAgentIds: string[]; attachmentIds: string[]; clientMessageId: string }

async function sendChatRoomMessage(getSendState: (id: string) => ChatRoomSendState | undefined, setSendState: (update: (current: Map<string, ChatRoomSendState>) => Map<string, ChatRoomSendState>) => void, applyEvent: (event: ChatRoomEventEnvelope) => void, input: ChatRoomSendInput): Promise<ChatRoomMessage> {
  const snapshot = { roomId: input.roomId, clientMessageId: input.clientMessageId, content: input.content, mentionAgentIds: [...input.mentionAgentIds], attachmentIds: [...input.attachmentIds] }
  const startedAt = Date.now()
  const attempt: ChatRoomSendState = { ...snapshot, startedAt, status: 'sending' }
  setSendState((current) => new Map(current).set(input.clientMessageId, attempt))
  try {
    const result = await input.api.sendMessage({ ...snapshot })
    // 账号重置、房间移除或同 ID 新重试之后，旧请求只能结束，不能重新填回 UI。
    if (getSendState(input.clientMessageId) !== attempt) return result
    for (const invocation of result.invocations ?? []) {
      const type = invocation.status === 'created' ? 'agent.invocation' : invocation.status === 'accepted' || invocation.status === 'running' ? 'agent.accepted' : invocation.status === 'completed' ? 'agent.completed' : 'agent.failed'
      applyEvent({ type, roomId: input.roomId, payload: { ...invocation, clientMessageId: input.clientMessageId } })
    }
    for (const event of result.events ?? []) applyEvent({ ...event, payload: { ...(event.payload as object), clientMessageId: input.clientMessageId } })
    setSendState((current) => new Map(current).set(input.clientMessageId, { ...snapshot, startedAt, messageId: result.messageId, status: 'sent' }))
    return result
  } catch (error) {
    if (getSendState(input.clientMessageId) === attempt) setSendState((current) => new Map(current).set(input.clientMessageId, { ...snapshot, startedAt, status: 'failed', error: error instanceof Error ? error.message : '发送失败' }))
    throw error
  }
}

export const chatRoomSendMessageAtom = atom(null, async (get, set, input: Omit<ChatRoomSendInput, 'clientMessageId'> & { clientMessageId?: string }) => sendChatRoomMessage((id) => get(chatRoomSendStatesAtom).get(id), (update) => set(chatRoomSendStatesAtom, update), (event) => set(chatRoomApplyEventAtom, event), { ...input, clientMessageId: input.clientMessageId ?? crypto.randomUUID() }))
export const chatRoomRetrySendAtom = atom(null, async (get, set, input: ChatRoomSendInput) => sendChatRoomMessage((id) => get(chatRoomSendStatesAtom).get(id), (update) => set(chatRoomSendStatesAtom, update), (event) => set(chatRoomApplyEventAtom, event), input))
