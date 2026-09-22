import { atom } from 'jotai'
import type { ChatRoomAttachment, ChatRoomConnectionStatus, ChatRoomEventEnvelope, ChatRoomInvocation, ChatRoomMessage, ChatRoomSummary, ChatRoomTransferState } from '@copis/shared'
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
  set(chatRoomDeletedRoomIdsAtom, (current: Set<string>) => new Set(current).add(roomId))
  if (get(chatRoomActiveRoomIdAtom) === roomId) set(chatRoomActiveRoomIdAtom, undefined)
})
export const chatRoomApplyEventAtom = atom(null, (get, set, event: ChatRoomEventEnvelope) => {
  const roomId = event.roomId; if (!roomId) return
  if (get(chatRoomDeletedRoomIdsAtom).has(roomId)) return
  const payload = (typeof event.payload === 'object' && event.payload !== null ? event.payload : {}) as Record<string, unknown>
  if (event.seq !== undefined) set(chatRoomCursorsAtom, (current) => new Map(current).set(roomId, Math.max(current.get(roomId) ?? 0, event.seq!)))
  if (event.type === 'message.created') {
    const message = normalizeChatRoomMessage(payload, { roomId, seq: event.seq })
    set(chatRoomMessagesAtom, (current) => { const next = new Map(current); next.set(roomId, [...(current.get(roomId) ?? []), message]); return next })
    if (get(chatRoomActiveRoomIdAtom) !== roomId) set(chatRoomUnreadCountsAtom, (current) => new Map(current).set(roomId, (current.get(roomId) ?? 0) + 1))
  } else if (event.type === 'agent.delta' || event.type === 'agent.completed' || event.type === 'agent.failed') {
    const invocationId = typeof payload.invocationId === 'string' ? payload.invocationId : undefined; if (!invocationId) return
    set(chatRoomInvocationsAtom, (current) => { const next = new Map(current); const room = new Map(current.get(roomId) ?? []); const old = room.get(invocationId); const status = event.type === 'agent.delta' ? 'running' : event.type === 'agent.completed' ? 'completed' : 'failed'; room.set(invocationId, { ...(old ?? {}), invocationId, roomId, traceId: typeof payload.traceId === 'string' ? payload.traceId : old?.traceId ?? '', targetAgentId: typeof payload.targetAgentId === 'string' ? payload.targetAgentId : old?.targetAgentId ?? '', triggerMessageId: typeof payload.triggerMessageId === 'string' ? payload.triggerMessageId : old?.triggerMessageId ?? '', depth: typeof payload.depth === 'number' ? payload.depth : old?.depth ?? 0, status, ...(event.type === 'agent.delta' && typeof payload.delta === 'string' ? { delta: `${old?.delta ?? ''}${payload.delta}` } : {}), ...(event.type !== 'agent.delta' ? { delta: undefined } : {}), ...(typeof payload.failureCode === 'string' ? { failureCode: payload.failureCode } : {}) }); next.set(roomId, room); return next })
  }
})
export const chatRoomSetDraftAtom = atom(null, (_get, set, input: { roomId: string; value: string }) => set(chatRoomDraftsAtom, (current) => new Map(current).set(input.roomId, input.value)))
export const chatRoomSetMentionsAtom = atom(null, (_get, set, input: { roomId: string; agentIds: string[] }) => set(chatRoomMentionAgentIdsAtom, (current) => new Map(current).set(input.roomId, [...input.agentIds])))
export const chatRoomSetTransferAtom = atom(null, (_get, set, state: ChatRoomTransferState) => set(chatRoomTransfersAtom, (current) => new Map(current).set(state.transferId, state)))
export const chatRoomConsumeTransfersAtom = atom(null, (_get, set, attachmentIds: string[]) => set(chatRoomTransfersAtom, (current) => { const next = new Map(current); for (const [transferId, state] of next) if (state.attachmentId && attachmentIds.includes(state.attachmentId)) next.delete(transferId); return next }))
export const chatRoomMarkReadAtom = atom(null, (_get, set, roomId: string) => { set(chatRoomUnreadCountsAtom, (current) => new Map(current).set(roomId, 0)) })
export const chatRoomSendMessageAtom = atom(null, async (_get, set, input: { api: { sendMessage(value: { roomId: string; content: string; mentionAgentIds: string[]; attachmentIds: string[]; clientMessageId: string }): Promise<ChatRoomMessage> }; roomId: string; content: string; mentionAgentIds: string[]; attachmentIds: string[]; clientMessageId?: string }) => { const clientMessageId = input.clientMessageId ?? crypto.randomUUID(); const snapshot = { roomId: input.roomId, clientMessageId, content: input.content, mentionAgentIds: [...input.mentionAgentIds], attachmentIds: [...input.attachmentIds] }; set(chatRoomSendStatesAtom, (current) => new Map(current).set(clientMessageId, { ...snapshot, status: 'sending' })); try { const result = await input.api.sendMessage({ ...snapshot }); set(chatRoomSendStatesAtom, (current) => new Map(current).set(clientMessageId, { ...snapshot, status: 'sent' })); return result } catch (error) { set(chatRoomSendStatesAtom, (current) => new Map(current).set(clientMessageId, { ...snapshot, status: 'failed', error: error instanceof Error ? error.message : '发送失败' })); throw error } })
export const chatRoomRetrySendAtom = atom(null, async (_get, set, input: { api: { sendMessage(value: { roomId: string; content: string; mentionAgentIds: string[]; attachmentIds: string[]; clientMessageId: string }): Promise<ChatRoomMessage> }; roomId: string; content: string; mentionAgentIds: string[]; attachmentIds: string[]; clientMessageId: string }) => { const snapshot = { roomId: input.roomId, clientMessageId: input.clientMessageId, content: input.content, mentionAgentIds: [...input.mentionAgentIds], attachmentIds: [...input.attachmentIds] }; set(chatRoomSendStatesAtom, (current) => new Map(current).set(input.clientMessageId, { ...snapshot, status: 'sending' })); try { const result = await input.api.sendMessage({ ...snapshot }); set(chatRoomSendStatesAtom, (current) => new Map(current).set(input.clientMessageId, { ...snapshot, status: 'sent' })); return result } catch (error) { set(chatRoomSendStatesAtom, (current) => new Map(current).set(input.clientMessageId, { ...snapshot, status: 'failed', error: error instanceof Error ? error.message : '发送失败' })); throw error } })
