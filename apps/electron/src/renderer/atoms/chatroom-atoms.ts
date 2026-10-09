import { atom } from 'jotai'
import type { ChatRoomAgent, ChatRoomAgentLocalView, ChatRoomAttachment, ChatRoomConnectionStatus, ChatRoomEventEnvelope, ChatRoomInvocation, ChatRoomInvocationMetadata, ChatRoomLocalRoomView, ChatRoomMember, ChatRoomMessage, ChatRoomPermissionRequest, ChatRoomSummary, ChatRoomTransferState, ProvisionChatRoomAgentInput } from '@copis/shared'
import { normalizeChatRoomAgent, normalizeChatRoomMember, normalizeChatRoomMessage, normalizeChatRoomSummary, type ChatRoomSendResult } from '../lib/chatroom-api'
import { applyChatRoomDeltaFrame, clearChatRoomDeltaFrames, createChatRoomDeltaFrameState, type ChatRoomDeltaFrameState } from '../lib/chatroom-delta-frames'

export type ChatRoomMessageState = Map<string, ChatRoomMessage[]>
export type ChatRoomCursorState = Map<string, number>
export type ChatRoomInvocationPreviewPause = 'frame_conflict' | 'frame_capacity'
export type ChatRoomRendererInvocation = ChatRoomInvocation & { previewPaused?: ChatRoomInvocationPreviewPause }
export type ChatRoomInvocationState = Map<string, Map<string, ChatRoomRendererInvocation>>
export type ChatRoomDraftState = Map<string, string>
export type ChatRoomMentionState = Map<string, string[]>
export type ChatRoomUnreadState = Map<string, number>
export type ChatRoomTransferStateMap = Map<string, ChatRoomTransferState>
export type ChatRoomSendState = { roomId: string; clientMessageId: string; status: 'sending' | 'sent' | 'failed'; content: string; mentionAgentIds: string[]; attachmentIds: string[]; error?: string; startedAt?: number; messageId?: string }
export interface ChatRoomProvisionPlan {
  room: ChatRoomSummary
  agents: Array<Omit<ProvisionChatRoomAgentInput, 'roomId'>>
  completed: number
  accountKey: string
  authEpoch: number
  operationId: string
  attemptId: string
  inFlightIndex?: number
  inFlightAgentName?: string
  error?: string
}
export type ChatRoomProvisionProgressPayload =
  | { phase: 'started'; index: number; agentName: string }
  | { phase: 'progress'; completed: number }
  | { phase: 'failed'; completed: number; error: string }
  | { phase: 'finished' }
export type ChatRoomProvisionProgressUpdate = { roomId: string; accountKey: string; authEpoch: number; operationId: string; attemptId: string } & ChatRoomProvisionProgressPayload

export const chatRoomRoomsAtom = atom<ChatRoomSummary[]>([])
export const chatRoomDetailsAtom = atom<Record<string, unknown>>( {})
export const chatRoomMessagesAtom = atom<ChatRoomMessageState>(new Map())
export const chatRoomCursorsAtom = atom<ChatRoomCursorState>(new Map())
/** 已应用的房间状态版本，用于拒绝晚到的 HTTP 详情。 */
export const chatRoomDataRevisionsAtom = atom<Map<string, number>>(new Map())
/** 删除/重新加入时递增，隔离旧 room 生命周期中的异步回执。 */
export const chatRoomLifecycleGenerationsAtom = atom<Map<string, number>>(new Map())
export const chatRoomConnectionStatusAtom = atom<Map<string, ChatRoomConnectionStatus>>(new Map())
export const chatRoomInvocationsAtom = atom<ChatRoomInvocationState>(new Map())
export const chatRoomDeltaFramesAtom = atom<ChatRoomDeltaFrameState>(createChatRoomDeltaFrameState())
export const chatRoomTransfersAtom = atom<ChatRoomTransferStateMap>(new Map())
export const chatRoomDraftsAtom = atom<ChatRoomDraftState>(new Map())
export const chatRoomMentionAgentIdsAtom = atom<ChatRoomMentionState>(new Map())
export const chatRoomUnreadCountsAtom = atom<ChatRoomUnreadState>(new Map())
export const chatRoomSendStatesAtom = atom<Map<string, ChatRoomSendState>>(new Map())
/** 已删除房间的本地墓碑，阻止迟到的 HTTP/SSE 结果重新写回状态。 */
export const chatRoomDeletedRoomIdsAtom = atom<Set<string>>(new Set<string>())
export const chatRoomPermissionRequestsAtom = atom<Map<string, ChatRoomPermissionRequest>>(new Map())
export const chatRoomLocalRoomsAtom = atom<Map<string, ChatRoomLocalRoomView>>(new Map())
export const chatRoomLocalRoomRevisionsAtom = atom<Map<string, number>>(new Map())
export const chatRoomProvisionPlansAtom = atom<Map<string, ChatRoomProvisionPlan>>(new Map())
export const chatRoomApplyLocalRoomConfigAtom = atom(null, (get, set, input: { room: ChatRoomLocalRoomView; expectedRevision?: number }) => {
  const revision = get(chatRoomLocalRoomRevisionsAtom).get(input.room.roomId) ?? 0
  if (input.expectedRevision !== undefined && input.expectedRevision !== revision) return
  set(chatRoomLocalRoomsAtom, (items) => new Map(items).set(input.room.roomId, input.room))
  set(chatRoomLocalRoomRevisionsAtom, (items) => new Map(items).set(input.room.roomId, revision + 1))
})
export const chatRoomSetProvisionPlanAtom = atom(null, (_get, set, plan: ChatRoomProvisionPlan) => set(chatRoomProvisionPlansAtom, (current) => new Map(current).set(plan.room.roomId, plan)))
export const chatRoomClearProvisionPlanAtom = atom(null, (_get, set, roomId: string) => set(chatRoomProvisionPlansAtom, (current) => { const next = new Map(current); next.delete(roomId); return next }))
export const chatRoomClearStaleProvisionPlansAtom = atom(null, (_get, set, authEpoch: number) => set(chatRoomProvisionPlansAtom, (current) => new Map([...current].filter(([, plan]) => plan.authEpoch === authEpoch))))
export const chatRoomApplyProvisionProgressAtom = atom(null, (get, set, update: ChatRoomProvisionProgressUpdate) => {
  const current = get(chatRoomProvisionPlansAtom).get(update.roomId)
  if (!current || current.accountKey !== update.accountKey || current.authEpoch !== update.authEpoch || current.operationId !== update.operationId || current.attemptId !== update.attemptId) return
  if (update.phase === 'finished') {
    if (current.completed < current.agents.length) return
    set(chatRoomClearProvisionPlanAtom, update.roomId)
    return
  }
  const next: ChatRoomProvisionPlan = { ...current }
  if (update.phase === 'started') {
    next.inFlightIndex = update.index
    next.inFlightAgentName = update.agentName
    delete next.error
  } else {
    next.completed = update.completed
    delete next.inFlightIndex
    delete next.inFlightAgentName
    if (update.phase === 'failed') next.error = update.error
    else delete next.error
  }
  set(chatRoomProvisionPlansAtom, (plans) => new Map(plans).set(update.roomId, next))
})
export const chatRoomUpdateLocalAgentAtom = atom(null, (get, set, input: { roomId: string; agent: ChatRoomAgentLocalView; expectedRevision?: number }) => {
  const room = get(chatRoomLocalRoomsAtom).get(input.roomId)
  if (!room) return
  const revision = get(chatRoomLocalRoomRevisionsAtom).get(input.roomId) ?? 0
  if (input.expectedRevision !== undefined && revision !== input.expectedRevision) return
  set(chatRoomLocalRoomsAtom, (current) => new Map(current).set(input.roomId, { ...room, agents: room.agents.map((agent) => agent.roomAgentId === input.agent.roomAgentId ? input.agent : agent) }))
  set(chatRoomLocalRoomRevisionsAtom, (current) => new Map(current).set(input.roomId, revision + 1))
})

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
  set(chatRoomDataRevisionsAtom, new Map())
  set(chatRoomLifecycleGenerationsAtom, new Map())
  set(chatRoomConnectionStatusAtom, new Map())
  set(chatRoomInvocationsAtom, new Map())
  set(chatRoomDeltaFramesAtom, createChatRoomDeltaFrameState())
  set(chatRoomTransfersAtom, new Map())
  set(chatRoomDraftsAtom, new Map())
  set(chatRoomMentionAgentIdsAtom, new Map())
  set(chatRoomUnreadCountsAtom, new Map())
  set(chatRoomSendStatesAtom, new Map())
  set(chatRoomDeletedRoomIdsAtom, new Set())
  set(chatRoomPermissionRequestsAtom, new Map())
  set(chatRoomLocalRoomsAtom, new Map())
  set(chatRoomLocalRoomRevisionsAtom, new Map())
  set(chatRoomProvisionPlansAtom, new Map())
  set(chatRoomActiveRoomIdAtom, undefined)
})
export const chatRoomRemoveRoomAtom = atom(null, (get, set, roomId: string) => {
  const removeKey = <T>(current: Map<string, T>): Map<string, T> => { const next = new Map(current); next.delete(roomId); return next }
  set(chatRoomRoomsAtom, (current) => current.filter((room) => room.roomId !== roomId))
  set(chatRoomDetailsAtom, (current) => { const next = { ...current }; delete next[roomId]; return next })
  set(chatRoomLocalRoomsAtom, (current) => { const next = new Map(current); next.delete(roomId); return next })
  set(chatRoomLocalRoomRevisionsAtom, (current) => { const next = new Map(current); next.delete(roomId); return next })
  set(chatRoomProvisionPlansAtom, (current) => { const next = new Map(current); next.delete(roomId); return next })
  set(chatRoomMessagesAtom, removeKey)
  set(chatRoomCursorsAtom, removeKey)
  set(chatRoomDataRevisionsAtom, (current) => new Map(current).set(roomId, (current.get(roomId) ?? 0) + 1))
  set(chatRoomLifecycleGenerationsAtom, (current) => new Map(current).set(roomId, (current.get(roomId) ?? 0) + 1))
  set(chatRoomConnectionStatusAtom, removeKey)
  set(chatRoomUnreadCountsAtom, removeKey)
  set(chatRoomDraftsAtom, removeKey)
  set(chatRoomMentionAgentIdsAtom, removeKey)
  set(chatRoomInvocationsAtom, removeKey)
  set(chatRoomDeltaFramesAtom, (current) => clearChatRoomDeltaFrames(current, { roomId }))
  set(chatRoomTransfersAtom, (current) => new Map([...current].filter(([, state]) => state.roomId !== roomId)))
  set(chatRoomSendStatesAtom, (current) => new Map([...current].filter(([, state]) => state.roomId !== roomId)))
  set(chatRoomPermissionRequestsAtom, (current) => new Map([...current].filter(([, request]) => request.roomId !== roomId)))
  set(chatRoomDeletedRoomIdsAtom, (current: Set<string>) => new Set(current).add(roomId))
  if (get(chatRoomActiveRoomIdAtom) === roomId) set(chatRoomActiveRoomIdAtom, undefined)
})
export const chatRoomRejoinRoomAtom = atom(null, (_get, set, room: ChatRoomSummary) => {
  set(chatRoomDeletedRoomIdsAtom, (current) => { const next = new Set(current); next.delete(room.roomId); return next })
  set(chatRoomDataRevisionsAtom, (current) => new Map(current).set(room.roomId, (current.get(room.roomId) ?? 0) + 1))
  set(chatRoomLifecycleGenerationsAtom, (current) => new Map(current).set(room.roomId, (current.get(room.roomId) ?? 0) + 1))
  set(chatRoomDeltaFramesAtom, (current) => clearChatRoomDeltaFrames(current, { roomId: room.roomId }))
  set(chatRoomRoomsAtom, (current) => [...current.filter((item) => item.roomId !== room.roomId), room])
})
export const chatRoomApplyRoomDetailAtom = atom(null, (get, set, input: { roomId: string; detail: { room: ChatRoomSummary; members: ChatRoomMember[]; agents: ChatRoomAgent[] }; expectedRevision?: number }) => {
  if (get(chatRoomDeletedRoomIdsAtom).has(input.roomId)) return
  if (input.expectedRevision !== undefined && (get(chatRoomDataRevisionsAtom).get(input.roomId) ?? 0) !== input.expectedRevision) return
  set(chatRoomDetailsAtom, (current) => ({ ...current, [input.roomId]: input.detail }))
})
export const chatRoomClearPermissionRequestAtom = atom(null, (get, set, requestId: string) => { const next = new Map(get(chatRoomPermissionRequestsAtom)); next.delete(requestId); set(chatRoomPermissionRequestsAtom, next) })
/** 公开 metadata 是身份/状态快照，不是 delta；独立合并以免伪造或要求文本帧。 */
export const chatRoomApplyInvocationMetadataAtom = atom(null, (get, set, metadata: ChatRoomInvocationMetadata) => {
  const { roomId, invocationId } = metadata
  if (!roomId || !invocationId || get(chatRoomDeletedRoomIdsAtom).has(roomId)) return
  const current = get(chatRoomInvocationsAtom)
  const currentRoom = current.get(roomId) ?? new Map<string, ChatRoomRendererInvocation>()
  const old = currentRoom.get(invocationId)
  if ((old?.targetAgentId && old.targetAgentId !== metadata.targetAgentId)
    || (old?.triggerMessageId && old.triggerMessageId !== metadata.triggerMessageId)) return

  const terminalStatuses = ['completed', 'failed', 'rejected']
  const oldIsTerminal = old !== undefined && terminalStatuses.includes(old.status)
  const incomingIsTerminal = terminalStatuses.includes(metadata.status)
  if (oldIsTerminal && incomingIsTerminal && metadata.status !== old.status) return

  const olderPhase = (old?.status === 'running' && ['created', 'accepted'].includes(metadata.status))
    || (old?.status === 'accepted' && metadata.status === 'created')
  const status = oldIsTerminal || olderPhase ? old!.status : metadata.status
  const terminal = terminalStatuses.includes(status)
  const room = new Map(currentRoom)
  clearLocalInvocationTimeout(room, metadata.targetAgentId, metadata.triggerMessageId)
  const failureCode = metadata.failureCode ?? old?.failureCode
  room.set(invocationId, {
    ...(old ?? {}),
    invocationId,
    roomId,
    traceId: metadata.traceId || old?.traceId || '',
    targetAgentId: metadata.targetAgentId || old?.targetAgentId || '',
    triggerMessageId: metadata.triggerMessageId || old?.triggerMessageId || '',
    depth: metadata.depth,
    status,
    startedAt: old?.startedAt ?? Date.now(),
    ...(failureCode !== undefined ? { failureCode } : {}),
    ...(terminal ? { previewPaused: undefined } : old?.previewPaused ? { previewPaused: old.previewPaused } : {}),
  })
  set(chatRoomInvocationsAtom, new Map(current).set(roomId, room))
  if (terminal) set(chatRoomDeltaFramesAtom, (frames) => clearChatRoomDeltaFrames(frames, { roomId, invocationId }))
})
export const chatRoomApplyEventAtom = atom(null, (get, set, event: ChatRoomEventEnvelope) => {
  const roomId = event.roomId; if (!roomId) return
  if (get(chatRoomDeletedRoomIdsAtom).has(roomId)) return
  if (event.type === 'local.status' && (event.code === 'room_not_found' || event.code === 'not_member')) {
    set(chatRoomRemoveRoomAtom, roomId)
    return
  }
  const currentCursor = get(chatRoomCursorsAtom).get(roomId) ?? 0
  if (event.type === 'room.snapshot') {
    if (!Number.isSafeInteger(event.latestSeq) || event.latestSeq! < 0) return
    const latestSeq = event.latestSeq!
    if (latestSeq < currentCursor) return
    const payload = (typeof event.payload === 'object' && event.payload !== null ? event.payload : {}) as Record<string, unknown>
    const current = get(chatRoomDetailsAtom)[roomId] as { room?: ChatRoomSummary } | undefined
    const summary = current?.room ?? get(chatRoomRoomsAtom).find((room) => room.roomId === roomId)
    const roomValue = payload.room && typeof payload.room === 'object' ? payload.room as Record<string, unknown> : payload
    const room = normalizeChatRoomSummary({ ...summary, ...roomValue, roomId })
    const detail = {
      room,
      members: Array.isArray(payload.members) ? payload.members.map(normalizeChatRoomMember) : [],
      agents: Array.isArray(payload.agents) ? payload.agents.map(normalizeChatRoomAgent) : [],
    }
    set(chatRoomDetailsAtom, (items) => ({ ...items, [roomId]: detail }))
    set(chatRoomRoomsAtom, (rooms) => rooms.map((item) => item.roomId === roomId ? room : item))
    set(chatRoomCursorsAtom, (items) => new Map(items).set(roomId, Math.max(items.get(roomId) ?? 0, latestSeq)))
    set(chatRoomDataRevisionsAtom, (items) => new Map(items).set(roomId, (items.get(roomId) ?? 0) + 1))
    return
  }
  if (event.seq !== undefined && event.seq <= currentCursor) return
  const payload = (typeof event.payload === 'object' && event.payload !== null ? event.payload : {}) as Record<string, unknown>
  if (event.type === 'room.updated') {
    const current = (get(chatRoomDetailsAtom)[roomId] as { room?: ChatRoomSummary } | undefined)?.room
      ?? get(chatRoomRoomsAtom).find((room) => room.roomId === roomId)
    const roomValue = payload.room && typeof payload.room === 'object' ? payload.room as Record<string, unknown> : payload
    const room = normalizeChatRoomSummary({ ...current, ...roomValue, roomId })
    set(chatRoomRoomsAtom, (rooms) => rooms.map((item) => item.roomId === roomId ? room : item))
    set(chatRoomDetailsAtom, (details) => ({ ...details, [roomId]: { ...((details[roomId] as Record<string, unknown> | undefined) ?? {}), room } }))
  }
  const presence = event.type === 'agent.presence_changed' ? payload.status : event.type === 'agent.offline' ? 'offline' : event.type === 'agent.busy' ? 'busy' : event.type === 'agent.disabled' ? 'disabled' : undefined
  if (event.type === 'agent.updated') {
    const incomingAgent = normalizeChatRoomAgent(payload)
    if (incomingAgent.agentId) set(chatRoomDetailsAtom, (current) => {
      const detail = current[roomId] as { agents?: ChatRoomAgent[] } | undefined
      if (!Array.isArray(detail?.agents)) return current
      const existing = detail.agents.find((agent) => agent.agentId === incomingAgent.agentId)
      const agents = detail.agents.filter((agent) => agent.agentId !== incomingAgent.agentId)
      if (payload.removed !== true) agents.push(normalizeChatRoomAgent({ ...existing, ...payload, agentId: incomingAgent.agentId }))
      return { ...current, [roomId]: { ...detail, agents } }
    })
  } else if (event.type === 'agent.removed') {
    const agentId = typeof payload.agentId === 'string' ? payload.agentId : typeof payload.roomAgentId === 'string' ? payload.roomAgentId : undefined
    if (agentId) set(chatRoomDetailsAtom, (current) => {
      const detail = current[roomId] as { agents?: ChatRoomAgent[] } | undefined
      return Array.isArray(detail?.agents) ? { ...current, [roomId]: { ...detail, agents: detail.agents.filter((agent) => agent.agentId !== agentId) } } : current
    })
  } else if (event.type === 'member.removed') {
    const userId = typeof payload.userId === 'string' ? payload.userId : typeof payload.memberId === 'string' ? payload.memberId : undefined
    if (userId) set(chatRoomDetailsAtom, (current) => {
      const detail = current[roomId] as { members?: ChatRoomMember[] } | undefined
      return Array.isArray(detail?.members) ? { ...current, [roomId]: { ...detail, members: detail.members.filter((member) => member.userId !== userId) } } : current
    })
  } else if (event.type === 'member.presence_changed') {
    const userId = payload.userId ?? payload.memberId
    const nextPresence = payload.presence ?? payload.status
    if (typeof userId === 'string' && ['online', 'busy', 'offline', 'disabled'].includes(String(nextPresence))) set(chatRoomDetailsAtom, (current) => {
      const detail = current[roomId] as { members?: ChatRoomMember[] } | undefined
      return Array.isArray(detail?.members) ? { ...current, [roomId]: { ...detail, members: detail.members.map((member) => member.userId === userId ? { ...member, presence: nextPresence as ChatRoomMember['presence'] } : member) } } : current
    })
  } else if (typeof presence === 'string' && ['online', 'offline', 'busy', 'disabled'].includes(presence)) {
    const agentId = payload.roomAgentId ?? payload.agentId
    set(chatRoomDetailsAtom, (current) => {
      const detail = current[roomId] as { agents?: ChatRoomAgent[] } | undefined
      if (!Array.isArray(detail?.agents)) return current
      return { ...current, [roomId]: { ...detail, agents: detail.agents.map((agent) => {
        if (agent.agentId !== agentId) return agent
        const runtimeStatus = presence === 'online' && (agent.availability === 'busy' || agent.busy) ? 'busy' : presence as ChatRoomAgent['status']
        const availability = event.type === 'agent.busy' ? 'busy' : event.type === 'agent.offline' ? 'offline' : event.type === 'agent.disabled' ? 'disabled' : agent.availability
        return { ...agent, status: runtimeStatus, busy: runtimeStatus === 'busy', ...(availability ? { availability } : {}) }
      }) } }
    })
  }
  if (event.seq !== undefined) set(chatRoomCursorsAtom, (current) => new Map(current).set(roomId, Math.max(current.get(roomId) ?? 0, event.seq!)))
  set(chatRoomDataRevisionsAtom, (current) => new Map(current).set(roomId, (current.get(roomId) ?? 0) + 1))
  if (event.type === 'message.created') {
    const message = normalizeChatRoomMessage(payload, { roomId, seq: event.seq })
    if (message.senderType === 'agent' && message.parentMessageId) {
      const currentFrames = get(chatRoomDeltaFramesAtom)
      let nextFrames = currentFrames
      set(chatRoomInvocationsAtom, (current) => {
        const room = new Map(current.get(roomId) ?? [])
        clearLocalInvocationTimeout(room, message.senderId, message.parentMessageId!)
        for (const [id, invocation] of room) {
          if (invocation.targetAgentId === message.senderId && invocation.triggerMessageId === message.parentMessageId && ['created', 'accepted', 'running'].includes(invocation.status)) {
            room.set(id, { ...invocation, status: 'completed', previewPaused: undefined })
            nextFrames = clearChatRoomDeltaFrames(nextFrames, { roomId, invocationId: id })
          }
        }
        return new Map(current).set(roomId, room)
      })
      if (nextFrames !== currentFrames) set(chatRoomDeltaFramesAtom, nextFrames)
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
    const currentInvocations = get(chatRoomInvocationsAtom)
    const currentRoom = currentInvocations.get(roomId) ?? new Map<string, ChatRoomRendererInvocation>()
    const old = currentRoom.get(invocationId)
    const oldIsTerminal = old?.status === 'completed' || old?.status === 'failed' || old?.status === 'rejected'
    const incomingStatus = event.type === 'agent.invocation' ? 'created' : event.type === 'agent.accepted' ? 'accepted' : event.type === 'agent.delta' ? 'running' : event.type === 'agent.completed' ? 'completed' : 'failed'
    if (event.type === 'agent.delta' && oldIsTerminal) return
    if (oldIsTerminal && ['completed', 'failed'].includes(incomingStatus) && incomingStatus !== old.status) return

    let deltaToAppend: string | undefined
    let previewPaused = old?.previewPaused
    let frameState: ChatRoomDeltaFrameState | undefined
    if (event.type === 'agent.delta') {
      if (old?.previewPaused || typeof payload.delta !== 'string') return
      if (Object.prototype.hasOwnProperty.call(payload, 'frameId')) {
        const applied = applyChatRoomDeltaFrame(get(chatRoomDeltaFramesAtom), {
          roomId,
          invocationId,
          frameId: payload.frameId,
          delta: payload.delta,
        })
        if (applied.decision === 'append') {
          frameState = applied.state
          deltaToAppend = payload.delta
        } else if (applied.decision === 'conflict') previewPaused = 'frame_conflict'
        else if (applied.decision === 'capacity') previewPaused = 'frame_capacity'
        else if (applied.decision === 'invalid') return
        else return
      } else {
        // 旧协议没有帧身份，只能保留线上的到达顺序。
        deltaToAppend = payload.delta
      }
    }

    const room = new Map(currentRoom)
    clearLocalInvocationTimeout(room, typeof payload.targetAgentId === 'string' ? payload.targetAgentId : old?.targetAgentId ?? '', typeof payload.triggerMessageId === 'string' ? payload.triggerMessageId : old?.triggerMessageId ?? '', typeof payload.clientMessageId === 'string' ? payload.clientMessageId : undefined)
    const olderPhase = (old?.status === 'running' && ['created', 'accepted'].includes(incomingStatus)) || (old?.status === 'accepted' && incomingStatus === 'created')
    const preserveStatusForPreviewPause = event.type === 'agent.delta' && previewPaused !== undefined
    const status = oldIsTerminal || olderPhase || preserveStatusForPreviewPause ? old?.status ?? incomingStatus : incomingStatus
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
      ...(deltaToAppend !== undefined ? { delta: `${old?.delta ?? ''}${deltaToAppend}` } : {}),
      ...(event.type === 'agent.completed' || event.type === 'agent.failed' ? { previewPaused: undefined } : previewPaused ? { previewPaused } : {}),
      ...(!oldIsTerminal && typeof payload.failureCode === 'string' ? { failureCode: payload.failureCode } : {}),
      ...(typeof payload.message === 'string' ? { errorMessage: payload.message } : {}),
    })
    set(chatRoomInvocationsAtom, new Map(currentInvocations).set(roomId, room))
    if (frameState) set(chatRoomDeltaFramesAtom, frameState)
    if (event.type === 'agent.completed' || event.type === 'agent.failed') {
      set(chatRoomDeltaFramesAtom, (current) => clearChatRoomDeltaFrames(current, { roomId, invocationId }))
    }
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
