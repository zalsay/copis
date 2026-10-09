import { useEffect, useRef, useState, type ReactElement } from 'react'
import { useAtomValue, useSetAtom, useStore } from 'jotai'
import { chatRoomApplyEventAtom, chatRoomApplyInvocationMetadataAtom, chatRoomApplyLocalRoomConfigAtom, chatRoomClearPermissionRequestAtom, chatRoomClearStaleProvisionPlansAtom, chatRoomConnectionStatusAtom, chatRoomDeletedRoomIdsAtom, chatRoomInvocationsAtom, chatRoomLifecycleGenerationsAtom, chatRoomLocalRoomRevisionsAtom, chatRoomPermissionRequestsAtom, chatRoomResetStateAtom, chatRoomRoomsAtom, chatRoomDetailsAtom } from '../../atoms/chatroom-atoms'
import { ChatRoomSseClient } from '../../lib/chatroom-sse'
import { chatRoomApi } from '../../lib/chatroom-api'
import { workingAuthLifecycleEpochAtom, workingAuthStateAtom } from '../../atoms/working-atoms'
import type { WorkingAuthState } from '@copis/shared'
import type { ChatRoomPermissionRequest, ChatRoomSummary } from '@copis/shared'

export function getChatRoomAccountKey(state: WorkingAuthState | null): string {
  if (!state?.authenticated) return 'anonymous'
  const accountId = state.user?.id ?? state.user?.userId
  return accountId === undefined || accountId === null ? 'authenticated' : `authenticated:${String(accountId)}`
}

export function shouldSubscribeChatRoomRooms(accountKey: string, subscribedAccountKey: string | undefined): boolean {
  return accountKey !== 'anonymous' && subscribedAccountKey === accountKey
}

type ChatRoomDetail = { room?: Pick<ChatRoomSummary, 'role'> }

export function getHostPermissionRequests(
  rooms: ChatRoomSummary[],
  details: Record<string, unknown>,
  requests: Iterable<ChatRoomPermissionRequest>,
  now = Date.now(),
): ChatRoomPermissionRequest[] {
  const hostRoomIds = new Set(rooms.filter((room) => room.role === 'host').map((room) => room.roomId))
  for (const [roomId, value] of Object.entries(details)) {
    const role = (value as ChatRoomDetail | undefined)?.room?.role
    if (role === 'host') hostRoomIds.add(roomId)
    if (role === 'member') hostRoomIds.delete(roomId)
  }
  return [...requests].filter((request) => hostRoomIds.has(request.roomId) && request.expiresAt > now)
}

/** 主窗口级权限审批入口；房间 Tab 切换或详情尚未加载时仍保留审批能力。 */
export function ChatroomPermissionBanner(): ReactElement | null {
  const rooms = useAtomValue(chatRoomRoomsAtom)
  const details = useAtomValue(chatRoomDetailsAtom)
  const requests = useAtomValue(chatRoomPermissionRequestsAtom)
  const clearRequest = useSetAtom(chatRoomClearPermissionRequestAtom)
  const [now, setNow] = useState(() => Date.now())
  const [busyRequestId, setBusyRequestId] = useState<string>()
  const [error, setError] = useState('')
  const mountedRef = useRef(true)
  useEffect(() => () => { mountedRef.current = false }, [])
  useEffect(() => {
    const nextExpiry = [...requests.values()].map((request) => request.expiresAt).filter((expiresAt) => expiresAt > now).sort((a, b) => a - b)[0]
    if (nextExpiry === undefined) return undefined
    const timer = window.setTimeout(() => { if (mountedRef.current) setNow(Date.now()) }, Math.max(0, nextExpiry - Date.now()))
    return () => window.clearTimeout(timer)
  }, [now, requests])
  const pending = getHostPermissionRequests(rooms, details, requests.values(), now)
  if (pending.length === 0) return null
  const respond = async (request: ChatRoomPermissionRequest, behavior: 'allow' | 'deny'): Promise<void> => {
    if (!mountedRef.current) return
    setBusyRequestId(request.requestId)
    setError('')
    try {
      await window.electronAPI.chatrooms.respondPermission({ requestId: request.requestId, behavior })
      clearRequest(request.requestId)
    } catch (responseError) {
      if (mountedRef.current) setError(responseError instanceof Error ? responseError.message : '权限响应失败')
    } finally {
      if (mountedRef.current) setBusyRequestId(undefined)
    }
  }
  return <div className="fixed bottom-4 right-4 z-50 flex max-w-[min(32rem,calc(100vw-2rem))] flex-col gap-2" data-testid="chatroom-permission-banner">
    {pending.map((request) => <div key={request.requestId} role="alert" className="rounded-xl bg-amber-500/95 px-4 py-3 text-xs text-black shadow-xl">
      <div className="font-semibold">聊天室敏感操作待审批</div>
      <div className="mt-1 break-words">{request.toolName} · {request.summary}</div>
      <div className="mt-2 flex justify-end gap-2">
        <button type="button" disabled={busyRequestId === request.requestId} className="rounded-md bg-black/10 px-2 py-1 underline" onClick={() => void respond(request, 'deny')}>拒绝</button>
        <button type="button" disabled={busyRequestId === request.requestId} className="rounded-md bg-black px-2 py-1 text-white" onClick={() => void respond(request, 'allow')}>批准</button>
      </div>
    </div>)}
    {error && <div role="alert" className="rounded-lg bg-destructive px-3 py-2 text-xs text-destructive-foreground">{error}</div>}
  </div>
}

/** 主窗口级聊天室实时订阅；ChatroomView 卸载不会关闭此连接。 */
export function ChatroomSseInitializer(): ReactElement {
  const rooms = useAtomValue(chatRoomRoomsAtom)
  const authState = useAtomValue(workingAuthStateAtom)
  const authEpoch = useAtomValue(workingAuthLifecycleEpochAtom)
  const resetState = useSetAtom(chatRoomResetStateAtom)
  const store = useStore()
  const clientRef = useRef<ChatRoomSseClient>()
  const loadRequestRef = useRef(0)
  const previousAccountKeyRef = useRef<string>()
  const previousAuthEpochRef = useRef<number>()
  const subscribedAccountKeyRef = useRef<string>()
  const deletedRoomIds = useAtomValue(chatRoomDeletedRoomIdsAtom)
  const metadataLookupsRef = useRef(new Map<string, { roomId: string; controller: AbortController }>())
  const currentSocketGenerationRef = useRef(0)
  const accountKey = getChatRoomAccountKey(authState)
  useEffect(() => {
    const requestId = ++loadRequestRef.current
    const accountChanged = previousAccountKeyRef.current !== accountKey
    const authLifecycleChanged = previousAuthEpochRef.current !== authEpoch
    previousAccountKeyRef.current = accountKey
    previousAuthEpochRef.current = authEpoch
    if (accountChanged || authLifecycleChanged) subscribedAccountKeyRef.current = undefined
    const client = new ChatRoomSseClient()
    currentSocketGenerationRef.current = 0
    clientRef.current = client
    const offEvent = client.onEvent((event, socketGeneration) => {
      if (socketGeneration !== currentSocketGenerationRef.current || getChatRoomAccountKey(store.get(workingAuthStateAtom)) !== accountKey || store.get(workingAuthLifecycleEpochAtom) !== authEpoch) return
      store.set(chatRoomApplyEventAtom, event)
      const payload = typeof event.payload === 'object' && event.payload !== null ? event.payload as Record<string, unknown> : {}
      const invocationId = typeof payload.invocationId === 'string' ? payload.invocationId : undefined
      if (event.type !== 'agent.accepted' || !event.roomId || !invocationId || (typeof payload.targetAgentId === 'string' && typeof payload.triggerMessageId === 'string')) return
      const lookupKey = `${accountKey}:${authEpoch}:${event.roomId}:${invocationId}`
      if (metadataLookupsRef.current.has(lookupKey) || metadataLookupsRef.current.size >= 128) return
      const roomGeneration = store.get(chatRoomLifecycleGenerationsAtom).get(event.roomId) ?? 0
      const controller = new AbortController()
      metadataLookupsRef.current.set(lookupKey, { roomId: event.roomId, controller })
      void chatRoomApi.getInvocationMetadata(event.roomId, invocationId, { signal: controller.signal }).then((metadata) => {
        if (requestId !== loadRequestRef.current || socketGeneration !== currentSocketGenerationRef.current || getChatRoomAccountKey(store.get(workingAuthStateAtom)) !== accountKey || store.get(workingAuthLifecycleEpochAtom) !== authEpoch
          || (store.get(chatRoomLifecycleGenerationsAtom).get(event.roomId!) ?? 0) !== roomGeneration
          || store.get(chatRoomDeletedRoomIdsAtom).has(event.roomId!)) return
        if (metadata.roomId !== event.roomId || metadata.invocationId !== invocationId
          || (typeof payload.targetAgentId === 'string' && payload.targetAgentId !== metadata.targetAgentId)
          || (typeof payload.triggerMessageId === 'string' && payload.triggerMessageId !== metadata.triggerMessageId)) return
        const previous = store.get(chatRoomInvocationsAtom).get(event.roomId!)?.get(invocationId)
        if ((previous?.targetAgentId && previous.targetAgentId !== metadata.targetAgentId)
          || (previous?.triggerMessageId && previous.triggerMessageId !== metadata.triggerMessageId)) return
        store.set(chatRoomApplyInvocationMetadataAtom, metadata)
      }).catch(() => undefined).finally(() => {
        if (metadataLookupsRef.current.get(lookupKey)?.controller === controller) metadataLookupsRef.current.delete(lookupKey)
      })
    })
    const offStatus = client.onStatus((status, socketGeneration) => {
      if (socketGeneration < currentSocketGenerationRef.current) return
      currentSocketGenerationRef.current = socketGeneration
      for (const room of store.get(chatRoomRoomsAtom)) store.set(chatRoomConnectionStatusAtom, (current) => new Map(current).set(room.roomId, status))
    })
    if (accountChanged || authLifecycleChanged || accountKey === 'anonymous') {
      resetState()
    }
    if (accountKey !== 'anonymous') {
      void chatRoomApi.listRooms().then((nextRooms) => {
        if (requestId !== loadRequestRef.current || getChatRoomAccountKey(store.get(workingAuthStateAtom)) !== accountKey || store.get(workingAuthLifecycleEpochAtom) !== authEpoch) return
        store.set(chatRoomRoomsAtom, nextRooms)
        client.setRooms(nextRooms.map((room) => room.roomId))
        subscribedAccountKeyRef.current = accountKey
      }).catch(() => {
        if (requestId === loadRequestRef.current && getChatRoomAccountKey(store.get(workingAuthStateAtom)) === accountKey && store.get(workingAuthLifecycleEpochAtom) === authEpoch) client.close()
      })
    }
    return () => {
      offEvent(); offStatus(); client.close()
      for (const lookup of metadataLookupsRef.current.values()) lookup.controller.abort()
      metadataLookupsRef.current.clear()
    }
  }, [accountKey, authEpoch, resetState, store])
  useEffect(() => {
    for (const [key, lookup] of metadataLookupsRef.current) {
      if (!deletedRoomIds.has(lookup.roomId)) continue
      lookup.controller.abort()
      metadataLookupsRef.current.delete(key)
    }
  }, [deletedRoomIds])
  useEffect(() => { store.set(chatRoomClearStaleProvisionPlansAtom, authEpoch) }, [authEpoch, store])
  useEffect(() => {
    return window.electronAPI.chatrooms.onPermissionRequested((request) => {
      const currentAuth = store.get(workingAuthStateAtom)
      if (!currentAuth?.authenticated) return
      store.set(chatRoomPermissionRequestsAtom, (current) => new Map(current).set(request.requestId, request))
    })
  }, [store])
  useEffect(() => {
    if (accountKey === 'anonymous') return undefined
    let active = true
    const applyEvent = (room: Parameters<typeof chatRoomApplyLocalRoomConfigAtom.write>[2]['room']): void => {
      if (active && getChatRoomAccountKey(store.get(workingAuthStateAtom)) === accountKey && store.get(workingAuthLifecycleEpochAtom) === authEpoch) store.set(chatRoomApplyLocalRoomConfigAtom, { room })
    }
    const unsubscribe = window.electronAPI.chatrooms.onLocalConfigChanged(applyEvent)
    const revisionsAtStart = new Map(store.get(chatRoomLocalRoomRevisionsAtom))
    void window.electronAPI.chatrooms.listLocalRooms().then((rooms) => {
      if (active && getChatRoomAccountKey(store.get(workingAuthStateAtom)) === accountKey && store.get(workingAuthLifecycleEpochAtom) === authEpoch) {
        rooms.forEach((room) => store.set(chatRoomApplyLocalRoomConfigAtom, { room, expectedRevision: revisionsAtStart.get(room.roomId) ?? 0 }))
      }
    }).catch((error) => {
      if (active) console.warn('[聊天室] 加载本机 Agent 配置失败：', error)
    })
    return () => { active = false; unsubscribe() }
  }, [accountKey, authEpoch, store])
  useEffect(() => {
    if (!shouldSubscribeChatRoomRooms(accountKey, subscribedAccountKeyRef.current)) {
      if (accountKey !== 'anonymous') subscribedAccountKeyRef.current = accountKey
      return
    }
    clientRef.current?.setRooms(store.get(chatRoomRoomsAtom).map((room) => room.roomId))
  }, [accountKey, rooms, store])
  return <ChatroomPermissionBanner />
}
