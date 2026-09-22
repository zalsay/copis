import { atom } from 'jotai'
import type { ChatRoomAttachment, ChatRoomConnectionStatus, ChatRoomEventEnvelope, ChatRoomInvocation, ChatRoomMessage, ChatRoomSummary, ChatRoomTransferState } from '@copis/shared'

export type ChatRoomMessageState = Map<string, ChatRoomMessage[]>
export type ChatRoomCursorState = Map<string, number>
export type ChatRoomInvocationState = Map<string, Map<string, ChatRoomInvocation>>
export type ChatRoomDraftState = Map<string, string>
export type ChatRoomMentionState = Map<string, string[]>
export type ChatRoomUnreadState = Map<string, number>
export type ChatRoomTransferStateMap = Map<string, ChatRoomTransferState>

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

export const chatRoomActiveRoomIdAtom = atom<string | undefined>(undefined)
export const chatRoomApplyEventAtom = atom(null, (get, set, event: ChatRoomEventEnvelope) => {
  const roomId = event.roomId; if (!roomId) return
  const payload = (typeof event.payload === 'object' && event.payload !== null ? event.payload : {}) as Record<string, unknown>
  if (event.seq !== undefined) set(chatRoomCursorsAtom, (current) => new Map(current).set(roomId, Math.max(current.get(roomId) ?? 0, event.seq!)))
  if (event.type === 'message.created') {
    const message = payload as unknown as ChatRoomMessage
    set(chatRoomMessagesAtom, (current) => { const next = new Map(current); next.set(roomId, [...(current.get(roomId) ?? []), message]); return next })
    if (get(chatRoomActiveRoomIdAtom) !== roomId) set(chatRoomUnreadCountsAtom, (current) => new Map(current).set(roomId, (current.get(roomId) ?? 0) + 1))
  } else if (event.type === 'agent.delta' || event.type === 'agent.completed' || event.type === 'agent.failed') {
    const invocationId = typeof payload.invocationId === 'string' ? payload.invocationId : undefined; if (!invocationId) return
    set(chatRoomInvocationsAtom, (current) => { const next = new Map(current); const room = new Map(current.get(roomId) ?? []); const old = room.get(invocationId); const status = event.type === 'agent.delta' ? 'running' : event.type === 'agent.completed' ? 'completed' : 'failed'; room.set(invocationId, { ...(old ?? {}), invocationId, roomId, traceId: typeof payload.traceId === 'string' ? payload.traceId : old?.traceId ?? '', targetAgentId: typeof payload.targetAgentId === 'string' ? payload.targetAgentId : old?.targetAgentId ?? '', triggerMessageId: typeof payload.triggerMessageId === 'string' ? payload.triggerMessageId : old?.triggerMessageId ?? '', depth: typeof payload.depth === 'number' ? payload.depth : old?.depth ?? 0, status, ...(typeof payload.delta === 'string' ? { delta: `${old?.delta ?? ''}${payload.delta}` } : {}), ...(typeof payload.failureCode === 'string' ? { failureCode: payload.failureCode } : {}) }); next.set(roomId, room); return next })
  }
})
export const chatRoomSetDraftAtom = atom(null, (_get, set, input: { roomId: string; value: string }) => set(chatRoomDraftsAtom, (current) => new Map(current).set(input.roomId, input.value)))
export const chatRoomSetMentionsAtom = atom(null, (_get, set, input: { roomId: string; agentIds: string[] }) => set(chatRoomMentionAgentIdsAtom, (current) => new Map(current).set(input.roomId, [...input.agentIds])))
export const chatRoomSetTransferAtom = atom(null, (_get, set, state: ChatRoomTransferState) => set(chatRoomTransfersAtom, (current) => new Map(current).set(state.transferId, state)))
export const chatRoomMarkReadAtom = atom(null, (_get, set, roomId: string) => { set(chatRoomUnreadCountsAtom, (current) => new Map(current).set(roomId, 0)) })
export const chatRoomRetrySendAtom = atom(null, (_get, _set, _input: { roomId: string; clientMessageId: string }) => { /* 重试由 API 调用方复用同一个 clientMessageId；这里不建立离线队列。 */ })
