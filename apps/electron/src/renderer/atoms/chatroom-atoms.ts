import { atom } from 'jotai'
import type { ChatRoomAttachment, ChatRoomConnectionStatus, ChatRoomEventEnvelope, ChatRoomInvocation, ChatRoomMessage, ChatRoomPermissionRequest, ChatRoomSummary, ChatRoomTransferState } from '@copis/shared'
import { normalizeChatRoomMessage } from '../lib/chatroom-api'

export type ChatRoomMessageState = Map<string, ChatRoomMessage[]>
export type ChatRoomCursorState = Map<string, number>
export type ChatRoomInvocationState = Map<string, Map<string, ChatRoomInvocation>>
export type ChatRoomDraftState = Map<string, string>
export type ChatRoomMentionState = Map<string, string[]>
export type ChatRoomUnreadState = Map<string, number>
export type ChatRoomTransferStateMap = Map<string, ChatRoomTransferState>
export type ChatRoomSendState = { roomId: string; clientMessageId: string; status: 'sending' | 'sent' | 'failed'; content: string; mentionAgentIds: string[]; attachmentIds: string[]; error?: string }

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
  if (input.cursor !== undefined) set(chatRoomCursorsAtom, (current) => new Map(current).set(input.roomId, Math.max(current.get(input.roomId) ?? 0, input.cursor!)))
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
export const chatRoomClearPermissionRequestAtom = atom(null, (get, set, requestId: string) => { const next = new Map(get(chatRoomPermissionRequestsAtom)); next.delete(requestId); set(chatRoomPermissionRequestsAtom, next) })
export const chatRoomApplyEventAtom = atom(null, (get, set, event: ChatRoomEventEnvelope) => {
  const roomId = event.roomId; if (!roomId) return
  if (get(chatRoomDeletedRoomIdsAtom).has(roomId)) return
  const payload = (typeof event.payload === 'object' && event.payload !== null ? event.payload : {}) as Record<string, unknown>
  if (event.seq !== undefined) set(chatRoomCursorsAtom, (current) => new Map(current).set(roomId, Math.max(current.get(roomId) ?? 0, event.seq!)))
  if (event.type === 'message.created') {
    const message = normalizeChatRoomMessage(payload, { roomId, seq: event.seq })
    let added = false
    set(chatRoomMessagesAtom, (current) => {
      const existing = current.get(roomId) ?? []
      const merged = mergeChatRoomMessages(existing, [message])
      added = merged.length > existing.length
      const next = new Map(current); next.set(roomId, merged); return next
    })
    if (added && get(chatRoomActiveRoomIdAtom) !== roomId) set(chatRoomUnreadCountsAtom, (current) => new Map(current).set(roomId, (current.get(roomId) ?? 0) + 1))
  } else if (event.type === 'agent.delta' || event.type === 'agent.completed' || event.type === 'agent.failed') {
    const invocationId = typeof payload.invocationId === 'string' ? payload.invocationId : undefined; if (!invocationId) return
    set(chatRoomInvocationsAtom, (current) => { const next = new Map(current); const room = new Map(current.get(roomId) ?? []); const old = room.get(invocationId); const status = event.type === 'agent.delta' ? 'running' : event.type === 'agent.completed' ? 'completed' : 'failed'; room.set(invocationId, { ...(old ?? {}), invocationId, roomId, traceId: typeof payload.traceId === 'string' ? payload.traceId : old?.traceId ?? '', targetAgentId: typeof payload.targetAgentId === 'string' ? payload.targetAgentId : old?.targetAgentId ?? '', triggerMessageId: typeof payload.triggerMessageId === 'string' ? payload.triggerMessageId : old?.triggerMessageId ?? '', depth: typeof payload.depth === 'number' ? payload.depth : old?.depth ?? 0, status, ...(event.type === 'agent.delta' && typeof payload.delta === 'string' ? { delta: `${old?.delta ?? ''}${payload.delta}` } : {}), ...(typeof payload.failureCode === 'string' ? { failureCode: payload.failureCode } : {}) }); next.set(roomId, room); return next })
  }
})
export const chatRoomSetDraftAtom = atom(null, (_get, set, input: { roomId: string; value: string }) => set(chatRoomDraftsAtom, (current) => new Map(current).set(input.roomId, input.value)))
export const chatRoomSetMentionsAtom = atom(null, (_get, set, input: { roomId: string; agentIds: string[] }) => set(chatRoomMentionAgentIdsAtom, (current) => new Map(current).set(input.roomId, [...input.agentIds])))
export const chatRoomSetTransferAtom = atom(null, (_get, set, state: ChatRoomTransferState) => set(chatRoomTransfersAtom, (current) => new Map(current).set(state.transferId, state)))
export const chatRoomConsumeTransfersAtom = atom(null, (_get, set, attachmentIds: string[]) => set(chatRoomTransfersAtom, (current) => { const next = new Map(current); for (const [transferId, state] of next) if (state.attachmentId && attachmentIds.includes(state.attachmentId)) next.delete(transferId); return next }))
export const chatRoomMarkReadAtom = atom(null, (_get, set, roomId: string) => { set(chatRoomUnreadCountsAtom, (current) => new Map(current).set(roomId, 0)) })
type ChatRoomSendInput = { api: { sendMessage(value: { roomId: string; content: string; mentionAgentIds: string[]; attachmentIds: string[]; clientMessageId: string }): Promise<ChatRoomMessage> }; roomId: string; content: string; mentionAgentIds: string[]; attachmentIds: string[]; clientMessageId: string }

async function sendChatRoomMessage(setSendState: (update: (current: Map<string, ChatRoomSendState>) => Map<string, ChatRoomSendState>) => void, input: ChatRoomSendInput): Promise<ChatRoomMessage> {
  const snapshot = { roomId: input.roomId, clientMessageId: input.clientMessageId, content: input.content, mentionAgentIds: [...input.mentionAgentIds], attachmentIds: [...input.attachmentIds] }
  setSendState((current) => new Map(current).set(input.clientMessageId, { ...snapshot, status: 'sending' }))
  try {
    const result = await input.api.sendMessage({ ...snapshot })
    setSendState((current) => new Map(current).set(input.clientMessageId, { ...snapshot, status: 'sent' }))
    return result
  } catch (error) {
    setSendState((current) => new Map(current).set(input.clientMessageId, { ...snapshot, status: 'failed', error: error instanceof Error ? error.message : '发送失败' }))
    throw error
  }
}

export const chatRoomSendMessageAtom = atom(null, async (_get, set, input: Omit<ChatRoomSendInput, 'clientMessageId'> & { clientMessageId?: string }) => sendChatRoomMessage((update) => set(chatRoomSendStatesAtom, update), { ...input, clientMessageId: input.clientMessageId ?? crypto.randomUUID() }))
export const chatRoomRetrySendAtom = atom(null, async (_get, set, input: ChatRoomSendInput) => sendChatRoomMessage((update) => set(chatRoomSendStatesAtom, update), input))
