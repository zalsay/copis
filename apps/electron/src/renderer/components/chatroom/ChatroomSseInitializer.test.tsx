import { describe, expect, mock, test } from 'bun:test'
import * as React from 'react'
import { parseHTML } from 'linkedom'
import { createRoot } from 'react-dom/client'
import { createStore, Provider } from 'jotai'
import { ChatRoomApiError, chatRoomApi } from '../../lib/chatroom-api'
import { chatRoomApplyEventAtom, chatRoomConnectionStatusAtom, chatRoomDataRevisionsAtom, chatRoomDeletedRoomIdsAtom, chatRoomDeltaFramesAtom, chatRoomDetailsAtom, chatRoomInvocationsAtom, chatRoomLocalRoomRevisionsAtom, chatRoomLocalRoomsAtom, chatRoomMessagesAtom, chatRoomPermissionRequestsAtom, chatRoomRejoinRoomAtom, chatRoomRemoveRoomAtom, chatRoomRoomsAtom, chatRoomTransfersAtom, chatRoomUnreadCountsAtom } from '../../atoms/chatroom-atoms'
import { workingAuthStateAtom } from '../../atoms/working-atoms'
import { ChatroomSseInitializer, getChatRoomAccountKey, shouldSubscribeChatRoomRooms } from './ChatroomSseInitializer'

function captureTestGlobals(): Array<[string, PropertyDescriptor | undefined]> {
  return ['window', 'document', 'fetch', 'IS_REACT_ACT_ENVIRONMENT'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)])
}

function restoreTestGlobals(descriptors: Array<[string, PropertyDescriptor | undefined]>): void {
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor)
    else Reflect.deleteProperty(globalThis, key)
  }
}

function createIsolatedSseFetch() {
  const requests: string[] = []
  const sseSignals: AbortSignal[] = []
  const activeReaders = new Set<() => void>()
  const streamControllers = new Set<ReadableStreamDefaultController<Uint8Array>>()
  let sseConnectionCount = 0
  const unmockedFetchFallback = mock((_input: RequestInfo | URL, _init?: RequestInit): never => {
    throw new Error('聊天室测试捕获到未配置 mock 的 fetch')
  })
  const fetch = mock(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    requests.push(url)
    if (url.includes('/api/chatrooms/v2/events?roomIds=')) {
      sseConnectionCount += 1
      const signal = init?.signal ?? undefined
      let closeReader = (): void => undefined
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          streamControllers.add(controller)
          let open = true
          const close = (): void => {
            if (!open) return
            open = false
            activeReaders.delete(close)
            streamControllers.delete(controller)
            try { controller.close() } catch { /* 测试清理时 reader 可能已结束。 */ }
          }
          closeReader = close
          activeReaders.add(close)
          controller.enqueue(new TextEncoder().encode('data: {"type":"local.status","code":"realtime_connected"}\n\n'))
          if (signal) {
            sseSignals.push(signal)
            if (signal.aborted) close()
            else signal.addEventListener('abort', close, { once: true })
          }
        },
        cancel() { closeReader() },
      })
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
    }
    if (url.includes('/api/chatrooms/v2/rooms/') && url.includes('/invocations/terminal?')) {
      return Response.json({ invocations: [], nextCursor: null })
    }
    if (url.includes('/api/chatrooms/v2/rooms/') && url.includes('/events?afterSeq=')) {
      return Response.json({ events: [] })
    }
    return unmockedFetchFallback(input, init)
  })
  return {
    fetch,
    requests,
    sseSignals,
    unmockedFetchFallback,
    emit: (event: unknown) => { const frame = `data: ${JSON.stringify(event)}\n\n`; for (const controller of streamControllers) controller.enqueue(new TextEncoder().encode(frame)) },
    closeStreams: () => { for (const close of [...activeReaders]) close() },
    getSseConnectionCount: () => sseConnectionCount,
    getActiveReaderCount: () => activeReaders.size,
  }
}

describe('聊天室全局实时初始化账户边界', () => {
  test('同一账号切换backend时立即清理旧本地状态并拒绝迟到A list及本机配置回执', async () => {
    const priorGlobals = captureTestGlobals()
    const priorListRooms = chatRoomApi.listRooms
    const transport = createIsolatedSseFetch()
    const dom = parseHTML('<html><body><div id="root"></div></body></html>')
    const localListeners: Array<(room: { roomId: string; agents: []; updatedAt: number }) => void> = []
    const localRoomLists: Array<(rooms: Array<{ roomId: string; agents: []; updatedAt: number }>) => void> = []
    Object.assign(dom.window, { electronAPI: { chatrooms: {
      onPermissionRequested: () => () => undefined,
      onLocalConfigChanged: (callback: (room: { roomId: string; agents: []; updatedAt: number }) => void) => { localListeners.push(callback); return () => undefined },
      listLocalRooms: async () => new Promise<Array<{ roomId: string; agents: []; updatedAt: number }>>((resolve) => { localRoomLists.push(resolve) }),
    } } })
    const act = (React as typeof React & { act: typeof import('react-dom/test-utils').act }).act
    const roomLists: Array<(rooms: Array<{ roomId: string; name: string; role: 'member'; hostUserId: string; status: 'active'; memberCount: number; unreadCount: number; connectionStatus: 'offline' }>) => void> = []
    const oldRoom = { roomId: 'room-a', name: 'A房间', role: 'member' as const, hostUserId: 'account-a', status: 'active' as const, memberCount: 1, unreadCount: 0, connectionStatus: 'offline' as const }
    const oldLocalRoom = { roomId: 'room-a', agents: [] as [], updatedAt: 1 }
    const oldMessage = { messageId: 'm-a', roomId: 'room-a', seq: 1, senderType: 'user' as const, senderId: 'account-a', content: 'A消息', mentionAgentIds: [], attachmentIds: [], clientMessageId: 'client-a', depth: 0, createdAt: '2026-09-30T00:00:00.000Z' }
    let root: ReturnType<typeof createRoot> | undefined
    const emptyRoomList: Array<never> = []
    try {
      Object.assign(globalThis, { window: dom.window, document: dom.window.document, fetch: transport.fetch, IS_REACT_ACT_ENVIRONMENT: true })
      chatRoomApi.listRooms = async () => new Promise((resolve) => { roomLists.push(resolve) })
      const store = createStore()
      store.set(workingAuthStateAtom, { authenticated: true, user: { id: 'account-a' }, backendUrl: 'http://backend-a' })
      const mountedRoot = createRoot(dom.window.document.getElementById('root')!)
      root = mountedRoot
      await act(async () => { mountedRoot.render(<Provider store={store}><ChatroomSseInitializer /></Provider>); await new Promise((resolve) => setTimeout(resolve, 0)) })
      expect(roomLists).toHaveLength(1)
      expect(localRoomLists).toHaveLength(1)
      await act(async () => {
        store.set(chatRoomRoomsAtom, [oldRoom])
        store.set(chatRoomDetailsAtom, { 'room-a': { room: oldRoom, members: [], agents: [] } })
        store.set(chatRoomMessagesAtom, new Map([['room-a', [oldMessage]]]))
        store.set(chatRoomLocalRoomsAtom, new Map([['room-a', oldLocalRoom]]))
        store.set(chatRoomLocalRoomRevisionsAtom, new Map([['room-a', 1]]))
        store.set(chatRoomInvocationsAtom, new Map([['room-a', new Map()]]))
        store.set(chatRoomTransfersAtom, new Map([['transfer-a', { transferId: 'transfer-a', roomId: 'room-a', phase: 'uploading', progress: 0 }]]))
        store.set(chatRoomUnreadCountsAtom, new Map([['room-a', 3]]))
      })
      await act(async () => {
        store.set(workingAuthStateAtom, { authenticated: true, user: { id: 'account-a' }, backendUrl: 'http://backend-b' })
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
      expect(roomLists).toHaveLength(2)
      expect(localRoomLists).toHaveLength(2)
      expect(store.get(chatRoomRoomsAtom)).toEqual([])
      expect(store.get(chatRoomDetailsAtom)).toEqual({})
      expect(store.get(chatRoomMessagesAtom).size).toBe(0)
      expect(store.get(chatRoomLocalRoomsAtom).size).toBe(0)
      expect(store.get(chatRoomLocalRoomRevisionsAtom).size).toBe(0)
      expect(store.get(chatRoomInvocationsAtom).size).toBe(0)
      expect(store.get(chatRoomTransfersAtom).size).toBe(0)
      expect(store.get(chatRoomUnreadCountsAtom).size).toBe(0)
      await act(async () => {
        roomLists[0]!([oldRoom])
        localRoomLists[0]!([oldLocalRoom])
        localListeners[0]!(oldLocalRoom)
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
      await act(async () => {
        roomLists[1]!(emptyRoomList)
        localRoomLists[1]!([])
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
      expect(store.get(chatRoomRoomsAtom)).toEqual([])
      expect(store.get(chatRoomDetailsAtom)).toEqual({})
      expect(store.get(chatRoomMessagesAtom).size).toBe(0)
      expect(store.get(chatRoomLocalRoomsAtom).size).toBe(0)
      expect(transport.requests.some((url) => url.includes('/events?roomIds=room-a'))).toBe(true)
      expect(transport.fetch.mock.calls.length).toBeGreaterThan(0)
      expect(transport.unmockedFetchFallback).not.toHaveBeenCalled()
      await act(async () => mountedRoot.unmount())
      root = undefined
      expect(transport.sseSignals.length).toBeGreaterThan(0)
      expect(transport.sseSignals.every((signal) => signal.aborted)).toBe(true)
      expect(transport.getActiveReaderCount()).toBe(0)
    } finally {
      if (root) await act(async () => root!.unmount())
      chatRoomApi.listRooms = priorListRooms
      restoreTestGlobals(priorGlobals)
    }
  })
  test('主窗口初始化从实时连接帧更新已登录房间的状态', async () => {
    const priorGlobals = captureTestGlobals()
    const priorListRooms = chatRoomApi.listRooms
    const transport = createIsolatedSseFetch()
    const dom = parseHTML('<html><body><div id="root"></div></body></html>')
    Object.assign(dom.window, { electronAPI: { chatrooms: { onPermissionRequested: () => () => undefined, onLocalConfigChanged: () => () => undefined, listLocalRooms: async () => [] } } })
    const act = (React as typeof React & { act: typeof import('react-dom/test-utils').act }).act
    const room = { roomId: 'r1', name: '协作室', role: 'member' as const, hostUserId: '7', status: 'active' as const, memberCount: 1, unreadCount: 0, connectionStatus: 'offline' as const }
    let root: ReturnType<typeof createRoot> | undefined
    try {
      Object.assign(globalThis, { window: dom.window, document: dom.window.document, fetch: transport.fetch, IS_REACT_ACT_ENVIRONMENT: true })
      chatRoomApi.listRooms = async () => [room]
      const store = createStore()
      store.set(workingAuthStateAtom, { authenticated: true, user: { id: 7 }, backendUrl: 'http://test' })
      const mountedRoot = createRoot(dom.window.document.getElementById('root')!)
      root = mountedRoot
      await act(async () => { mountedRoot.render(<Provider store={store}><React.StrictMode><ChatroomSseInitializer /></React.StrictMode></Provider>); await new Promise((resolve) => setTimeout(resolve, 20)) })
      expect(store.get(chatRoomRoomsAtom).map((item) => item.roomId)).toEqual(['r1'])
      expect(store.get(chatRoomConnectionStatusAtom).get('r1')).toBe('connected')
      expect(transport.requests.some((url) => url.includes('/events?roomIds=r1'))).toBe(true)
      expect(transport.fetch.mock.calls.length).toBeGreaterThan(0)
      expect(transport.unmockedFetchFallback).not.toHaveBeenCalled()
      const delta = { type: 'agent.delta', roomId: 'r1', payload: { invocationId: 'frame-test', frameId: 'a'.repeat(32), delta: '哈' } }
      await act(async () => { transport.emit(delta); transport.emit(delta); await Promise.resolve() })
      expect(store.get(chatRoomInvocationsAtom).get('r1')?.get('frame-test')?.delta).toBe('哈')
      const priorConnections = transport.getSseConnectionCount()
      transport.closeStreams()
      await act(async () => {
        for (let attempt = 0; attempt < 80 && transport.getSseConnectionCount() <= priorConnections; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 25))
      })
      expect(transport.getSseConnectionCount()).toBeGreaterThan(priorConnections)
      await act(async () => { transport.emit(delta); await Promise.resolve() })
      expect(store.get(chatRoomInvocationsAtom).get('r1')?.get('frame-test')?.delta).toBe('哈')
      await act(async () => mountedRoot.unmount())
      root = undefined
      expect(transport.sseSignals.length).toBeGreaterThan(0)
      expect(transport.sseSignals.at(-1)?.aborted).toBe(true)
      expect(transport.getActiveReaderCount()).toBe(0)
    } finally {
      if (root) await act(async () => root!.unmount())
      chatRoomApi.listRooms = priorListRooms
      restoreTestGlobals(priorGlobals)
    }
  })
  test('running metadata 精确补全身份并保留暂停预览、已见帧及其终态清理', async () => {
    const priorGlobals = captureTestGlobals()
    const priorListRooms = chatRoomApi.listRooms
    const priorMetadata = chatRoomApi.getInvocationMetadata
    const transport = createIsolatedSseFetch()
    const dom = parseHTML('<html><body><div id="root"></div></body></html>')
    Object.assign(dom.window, { electronAPI: { chatrooms: { onPermissionRequested: () => () => undefined, onLocalConfigChanged: () => () => undefined, listLocalRooms: async () => [] } } })
    const act = (React as typeof React & { act: typeof import('react-dom/test-utils').act }).act
    const room = { roomId: 'r1', name: '协作室', role: 'member' as const, status: 'active' as const, memberCount: 2, unreadCount: 0, connectionStatus: 'offline' as const }
    let resolveMetadata!: (value: Awaited<ReturnType<typeof chatRoomApi.getInvocationMetadata>>) => void
    const metadata = new Promise<Awaited<ReturnType<typeof chatRoomApi.getInvocationMetadata>>>((resolve) => { resolveMetadata = resolve })
    let resolveCompletedMetadata!: (value: Awaited<ReturnType<typeof chatRoomApi.getInvocationMetadata>>) => void
    const completedMetadata = new Promise<Awaited<ReturnType<typeof chatRoomApi.getInvocationMetadata>>>((resolve) => { resolveCompletedMetadata = resolve })
    let metadataLookups = 0
    let root: ReturnType<typeof createRoot> | undefined
    try {
      Object.assign(globalThis, { window: dom.window, document: dom.window.document, fetch: transport.fetch, IS_REACT_ACT_ENVIRONMENT: true })
      chatRoomApi.listRooms = async () => [room]
      chatRoomApi.getInvocationMetadata = async () => { metadataLookups += 1; return metadataLookups === 1 ? metadata : completedMetadata }
      const store = createStore()
      store.set(workingAuthStateAtom, { authenticated: true, user: { id: 'account-a' }, backendUrl: 'http://test' })
      const mountedRoot = createRoot(dom.window.document.getElementById('root')!)
      root = mountedRoot
      await act(async () => { mountedRoot.render(<Provider store={store}><ChatroomSseInitializer /></Provider>); await new Promise((resolve) => setTimeout(resolve, 20)) })
      await act(async () => { transport.emit({ type: 'agent.accepted', roomId: 'r1', payload: { invocationId: 'inv-1' } }); await new Promise((resolve) => setTimeout(resolve, 0)) })
      expect(store.get(chatRoomInvocationsAtom).get('r1')?.get('inv-1')).toMatchObject({ status: 'accepted', targetAgentId: '' })
      const delta = { type: 'agent.delta', roomId: 'r1', payload: { invocationId: 'inv-1', frameId: 'a'.repeat(32), delta: '已收到片段' } }
      await act(async () => {
        transport.emit(delta)
        transport.emit({ ...delta, payload: { ...delta.payload, delta: '冲突片段' } })
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
      const beforeMetadata = store.get(chatRoomInvocationsAtom).get('r1')?.get('inv-1')
      expect(beforeMetadata).toMatchObject({ status: 'running', delta: '已收到片段', previewPaused: 'frame_conflict' })
      expect(store.get(chatRoomDeltaFramesAtom).total).toBe(1)
      await act(async () => {
        resolveMetadata({ invocationId: 'inv-1', roomId: 'r1', traceId: 'trace-1', targetAgentId: 'agent-b', triggerMessageId: 'message-1', depth: 1, status: 'running' })
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
      expect(store.get(chatRoomInvocationsAtom).get('r1')?.get('inv-1')).toMatchObject({ status: 'running', targetAgentId: 'agent-b', triggerMessageId: 'message-1', traceId: 'trace-1', startedAt: beforeMetadata?.startedAt, delta: '已收到片段', previewPaused: 'frame_conflict' })
      expect(store.get(chatRoomDeltaFramesAtom).total).toBe(1)
      await act(async () => { transport.emit({ type: 'agent.accepted', roomId: 'r1', payload: { invocationId: 'inv-1' } }); await new Promise((resolve) => setTimeout(resolve, 0)) })
      expect(metadataLookups).toBe(2)
      await act(async () => {
        resolveCompletedMetadata({ invocationId: 'inv-1', roomId: 'r1', traceId: 'trace-1', targetAgentId: 'agent-b', triggerMessageId: 'message-1', depth: 1, status: 'completed' })
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
      expect(store.get(chatRoomInvocationsAtom).get('r1')?.get('inv-1')).toMatchObject({ status: 'completed', delta: '已收到片段', startedAt: beforeMetadata?.startedAt })
      expect(store.get(chatRoomInvocationsAtom).get('r1')?.get('inv-1')?.previewPaused).toBeUndefined()
      expect(store.get(chatRoomDeltaFramesAtom).total).toBe(0)
      expect(transport.unmockedFetchFallback).not.toHaveBeenCalled()
      await act(async () => mountedRoot.unmount())
      root = undefined
    } finally {
      if (root) await act(async () => root!.unmount())
      chatRoomApi.listRooms = priorListRooms
      chatRoomApi.getInvocationMetadata = priorMetadata
      restoreTestGlobals(priorGlobals)
    }
  })
  test('旧账号 metadata HTTP 回执不能给新账号同 ID 房间恢复 invocation', async () => {
    const priorGlobals = captureTestGlobals()
    const priorListRooms = chatRoomApi.listRooms
    const priorMetadata = chatRoomApi.getInvocationMetadata
    const transport = createIsolatedSseFetch()
    const dom = parseHTML('<html><body><div id="root"></div></body></html>')
    Object.assign(dom.window, { electronAPI: { chatrooms: { onPermissionRequested: () => () => undefined, onLocalConfigChanged: () => () => undefined, listLocalRooms: async () => [] } } })
    const act = (React as typeof React & { act: typeof import('react-dom/test-utils').act }).act
    const room = { roomId: 'same-room', name: '协作室', role: 'member' as const, status: 'active' as const, memberCount: 2, unreadCount: 0, connectionStatus: 'offline' as const }
    let resolveMetadata!: (value: Awaited<ReturnType<typeof chatRoomApi.getInvocationMetadata>>) => void
    let acknowledgeLookup!: () => void
    const lookupStarted = new Promise<void>((resolve) => { acknowledgeLookup = resolve })
    let lookupSignal: AbortSignal | undefined
    let root: ReturnType<typeof createRoot> | undefined
    try {
      Object.assign(globalThis, { window: dom.window, document: dom.window.document, fetch: transport.fetch, IS_REACT_ACT_ENVIRONMENT: true })
      chatRoomApi.listRooms = async () => [room]
      chatRoomApi.getInvocationMetadata = async (_roomId, _invocationId, options) => { lookupSignal = options?.signal; acknowledgeLookup(); return new Promise((resolve) => { resolveMetadata = resolve }) }
      const store = createStore()
      store.set(workingAuthStateAtom, { authenticated: true, user: { id: 'account-a' }, backendUrl: 'http://test' })
      const mountedRoot = createRoot(dom.window.document.getElementById('root')!)
      root = mountedRoot
      await act(async () => { mountedRoot.render(<Provider store={store}><ChatroomSseInitializer /></Provider>); await new Promise((resolve) => setTimeout(resolve, 20)) })
      await act(async () => { transport.emit({ type: 'agent.accepted', roomId: 'same-room', payload: { invocationId: 'inv-same' } }); await lookupStarted })
      await act(async () => { store.set(workingAuthStateAtom, { authenticated: true, user: { id: 'account-b' }, backendUrl: 'http://test' }); await new Promise((resolve) => setTimeout(resolve, 20)) })
      expect(lookupSignal?.aborted).toBe(true)
      await act(async () => {
        resolveMetadata({ invocationId: 'inv-same', roomId: 'same-room', traceId: 'trace-a', targetAgentId: 'agent-a', triggerMessageId: 'message-a', depth: 1, status: 'accepted' })
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
      expect(store.get(chatRoomInvocationsAtom).size).toBe(0)
      expect(transport.unmockedFetchFallback).not.toHaveBeenCalled()
      await act(async () => mountedRoot.unmount())
      root = undefined
    } finally {
      if (root) await act(async () => root!.unmount())
      chatRoomApi.listRooms = priorListRooms
      chatRoomApi.getInvocationMetadata = priorMetadata
      restoreTestGlobals(priorGlobals)
    }
  })
  test('同一 roomId 删除并重加入后，旧生命周期 metadata 不恢复 invocation', async () => {
    const priorGlobals = captureTestGlobals()
    const priorListRooms = chatRoomApi.listRooms
    const priorMetadata = chatRoomApi.getInvocationMetadata
    const transport = createIsolatedSseFetch()
    const dom = parseHTML('<html><body><div id="root"></div></body></html>')
    Object.assign(dom.window, { electronAPI: { chatrooms: { onPermissionRequested: () => () => undefined, onLocalConfigChanged: () => () => undefined, listLocalRooms: async () => [] } } })
    const act = (React as typeof React & { act: typeof import('react-dom/test-utils').act }).act
    const room = { roomId: 'r1', name: '协作室', role: 'member' as const, status: 'active' as const, memberCount: 2, unreadCount: 0, connectionStatus: 'offline' as const }
    let resolveMetadata!: (value: Awaited<ReturnType<typeof chatRoomApi.getInvocationMetadata>>) => void
    let acknowledgeLookup!: () => void
    const lookupStarted = new Promise<void>((resolve) => { acknowledgeLookup = resolve })
    let root: ReturnType<typeof createRoot> | undefined
    try {
      Object.assign(globalThis, { window: dom.window, document: dom.window.document, fetch: transport.fetch, IS_REACT_ACT_ENVIRONMENT: true })
      chatRoomApi.listRooms = async () => [room]
      chatRoomApi.getInvocationMetadata = async () => { acknowledgeLookup(); return new Promise((resolve) => { resolveMetadata = resolve }) }
      const store = createStore()
      store.set(workingAuthStateAtom, { authenticated: true, user: { id: 'account-a' }, backendUrl: 'http://test' })
      store.set(chatRoomRoomsAtom, [room])
      const mountedRoot = createRoot(dom.window.document.getElementById('root')!)
      root = mountedRoot
      await act(async () => { mountedRoot.render(<Provider store={store}><ChatroomSseInitializer /></Provider>); await new Promise((resolve) => setTimeout(resolve, 20)) })
      await act(async () => { transport.emit({ type: 'agent.accepted', roomId: 'r1', payload: { invocationId: 'inv-1' } }); await lookupStarted })
      await act(async () => { store.set(chatRoomRemoveRoomAtom, 'r1'); store.set(chatRoomRejoinRoomAtom, room); await Promise.resolve() })
      await act(async () => {
        resolveMetadata({ invocationId: 'inv-1', roomId: 'r1', traceId: 'trace-old', targetAgentId: 'agent-old', triggerMessageId: 'message-old', depth: 1, status: 'accepted' })
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
      expect(store.get(chatRoomInvocationsAtom).has('r1')).toBe(false)
      expect(transport.unmockedFetchFallback).not.toHaveBeenCalled()
      await act(async () => mountedRoot.unmount())
      root = undefined
    } finally {
      if (root) await act(async () => root!.unmount())
      chatRoomApi.listRooms = priorListRooms
      chatRoomApi.getInvocationMetadata = priorMetadata
      restoreTestGlobals(priorGlobals)
    }
  })
  test('未登录与不同账号使用不同的房间订阅边界', () => {
    expect(getChatRoomAccountKey(null)).toBe('anonymous')
    expect(getChatRoomAccountKey({ authenticated: false, user: null, backendUrl: 'http://test' })).toBe('anonymous')
    expect(getChatRoomAccountKey({ authenticated: true, user: { id: 'account-a' }, backendUrl: 'http://test' })).toBe('authenticated:account-a')
    expect(getChatRoomAccountKey({ authenticated: true, user: { id: 'account-b' }, backendUrl: 'http://test' })).not.toBe('authenticated:account-a')
  })
  test('账号切换后的首个 rooms effect 不会把旧账号房间交给新连接', () => {
    expect(shouldSubscribeChatRoomRooms('authenticated:account-b', undefined)).toBe(false)
    expect(shouldSubscribeChatRoomRooms('authenticated:account-b', 'authenticated:account-b')).toBe(true)
    expect(shouldSubscribeChatRoomRooms('anonymous', 'authenticated:account-a')).toBe(false)
  })

  test('Given authenticated pure SSE transport When mixed frames, metadata 404 and disconnect occur Then identity, terminal and full reply remain monotonic', async () => {
    const priorGlobals = captureTestGlobals()
    const priorListRooms = chatRoomApi.listRooms
    const priorMetadata = chatRoomApi.getInvocationMetadata
    const priorMarkRead = chatRoomApi.markRead
    const transport = createIsolatedSseFetch()
    const dom = parseHTML('<html><body><div id="root"></div></body></html>')
    const apiEvents: string[] = []
    const room = { roomId: 'r1', name: 'Transport', role: 'member' as const, status: 'active' as const, memberCount: 2, unreadCount: 0, connectionStatus: 'offline' as const }
    const otherRoom = { ...room, roomId: 'r2', name: 'Keep SSE open' }
    const configAgent = { agentId: 'configured-agent', displayName: 'Broken', status: 'offline' as const, availability: 'configuration_error' as const }
    const preparingAgent = { agentId: 'preparing-agent', displayName: 'Preparing', status: 'online' as const, availability: 'preparing' as const }
    Object.assign(dom.window, { electronAPI: { getHttpApiWebToken: () => 'fixture-web-token', chatrooms: {
      onPermissionRequested: () => () => undefined,
      onLocalConfigChanged: () => () => undefined,
      listLocalRooms: async () => [],
      respondPermission: async () => undefined,
    } } })
    const act = (React as typeof React & { act: typeof import('react-dom/test-utils').act }).act
    let root: ReturnType<typeof createRoot> | undefined
    try {
      // Renderer import graph不包含Main SDK/Provider/Memory/config/tempPaths；IPC、chatRoomApi、markRead和fetch边界均由本测试注入。
      Object.assign(globalThis, { window: dom.window, document: dom.window.document, fetch: transport.fetch, IS_REACT_ACT_ENVIRONMENT: true })
      chatRoomApi.listRooms = async () => [room, otherRoom]
      chatRoomApi.getInvocationMetadata = mock(async () => {
        apiEvents.push('metadata-404')
        throw new ChatRoomApiError('not found', 404, 'not_found')
      })
      chatRoomApi.markRead = mock(async () => { apiEvents.push('markRead') })
      const store = createStore()
      store.set(workingAuthStateAtom, { authenticated: true, user: { id: 'account-a' }, backendUrl: 'http://test' })
      store.set(chatRoomRoomsAtom, [room, otherRoom])
      store.set(chatRoomDetailsAtom, { r1: { room, members: [], agents: [configAgent, preparingAgent] } })
      const mountedRoot = createRoot(dom.window.document.getElementById('root')!)
      root = mountedRoot
      await act(async () => { mountedRoot.render(<Provider store={store}><ChatroomSseInitializer /></Provider>); await new Promise((resolve) => setTimeout(resolve, 30)) })
      expect(transport.getSseConnectionCount()).toBeGreaterThan(0)

      const capFrames = new Map<string, string>()
      for (let index = 0; index < 8192; index++) capFrames.set(index.toString(16).padStart(32, '0'), 'cached')
      store.set(chatRoomDeltaFramesAtom, { frames: new Map([['r1', new Map([['i-cap', capFrames]])]]), total: 8192 })
      const emit = async (event: unknown) => act(async () => { transport.emit(event); await new Promise((resolve) => setTimeout(resolve, 0)) })
      await emit({ type: 'room.snapshot', roomId: 'r1', latestSeq: 0, payload: { room, members: [], agents: [configAgent, preparingAgent] } })
      await emit({ type: 'local.status', code: 'realtime_connected' })
      expect(store.get(chatRoomConnectionStatusAtom).get('r1')).toBe('connected')
      expect((store.get(chatRoomDetailsAtom).r1 as { agents: Array<{ availability?: string }> }).agents.map((agent) => agent.availability)).toEqual(['configuration_error', 'preparing'])

      await emit({ type: 'agent.accepted', roomId: 'r1', payload: { invocationId: 'i-frames' } })
      await emit({ type: 'agent.delta', roomId: 'r1', payload: { invocationId: 'i-frames', delta: 'chunk', frameId: '0123456789abcdef0123456789abcdef' } })
      await emit({ type: 'agent.delta', roomId: 'r1', payload: { invocationId: 'i-frames', delta: 'chunk', frameId: '0123456789abcdef0123456789abcdef' } })
      await emit({ type: 'agent.delta', roomId: 'r1', payload: { invocationId: 'i-frames', delta: 'chunk', frameId: 'fedcba9876543210fedcba9876543210' } })
      await emit({ type: 'agent.delta', roomId: 'r1', payload: { invocationId: 'i-frames', delta: 'chunk' } })
      expect(store.get(chatRoomInvocationsAtom).get('r1')?.get('i-frames')?.delta).toBe('chunkchunkchunk')
      expect(store.get(chatRoomDeltaFramesAtom).total).toBe(8194)

      await emit({ type: 'agent.accepted', roomId: 'r1', payload: { invocationId: 'i-terminal' } })
      await emit({ type: 'agent.completed', roomId: 'r1', payload: { invocationId: 'i-terminal', content: 'terminal' } })
      await emit({ type: 'agent.accepted', roomId: 'r1', payload: { invocationId: 'i-terminal' } })
      expect(store.get(chatRoomInvocationsAtom).get('r1')?.get('i-terminal')?.status).toBe('completed')

      await emit({ type: 'agent.delta', roomId: 'r1', payload: { invocationId: 'i-cap', delta: 'overflow', frameId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } })
      expect(store.get(chatRoomInvocationsAtom).get('r1')?.get('i-cap')?.previewPaused).toBe('frame_capacity')
      await emit({ type: 'agent.completed', roomId: 'r1', payload: { invocationId: 'i-cap', content: 'full final reply' } })
      await emit({ type: 'message.created', roomId: 'r1', seq: 1, payload: {
        messageId: 'reply-cap', sender: { type: 'agent', id: 'agent-cap', displayName: 'Cap' }, text: 'full final reply',
        createdAt: '2026-10-08T12:00:00Z', parentMessageId: 'trigger-cap', depth: 1, clientMessageId: 'reply-cap', mentionAgentIds: [], attachmentIds: [],
      } })
      expect(store.get(chatRoomInvocationsAtom).get('r1')?.get('i-cap')).toMatchObject({ status: 'completed', previewPaused: undefined })
      expect(store.get(chatRoomMessagesAtom).get('r1')?.find((item) => item.messageId === 'reply-cap')?.content).toBe('full final reply')
      const revisionAfterReply = store.get(chatRoomDataRevisionsAtom).get('r1')
      await emit({ type: 'message.created', roomId: 'r1', seq: 1, payload: { messageId: 'stale-reply', text: 'stale' } })
      expect(store.get(chatRoomMessagesAtom).get('r1')?.some((item) => item.messageId === 'stale-reply')).toBe(false)
      expect(store.get(chatRoomDataRevisionsAtom).get('r1')).toBe(revisionAfterReply)
      expect(apiEvents).toContain('metadata-404')
      expect(apiEvents).not.toContain('markRead')

      await act(async () => { transport.closeStreams(); await new Promise((resolve) => setTimeout(resolve, 0)) })
      expect(store.get(chatRoomConnectionStatusAtom).get('r1')).toBe('reconnecting')
      expect(store.get(chatRoomInvocationsAtom).get('r1')?.get('i-frames')?.status).toBe('running')
      expect(store.get(chatRoomInvocationsAtom).get('r1')?.get('i-terminal')?.status).toBe('completed')

      await act(async () => { store.set(chatRoomRemoveRoomAtom, 'r1'); await new Promise((resolve) => setTimeout(resolve, 0)) })
      const deletedRevision = store.get(chatRoomDataRevisionsAtom).get('r1')
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) })
      expect(transport.getSseConnectionCount()).toBeGreaterThan(1)
      await emit({ type: 'agent.failed', roomId: 'r1', payload: { invocationId: 'i-frames', failureCode: 'agent_offline' } })
      expect(store.get(chatRoomDeletedRoomIdsAtom).has('r1')).toBe(true)
      expect(store.get(chatRoomInvocationsAtom).has('r1')).toBe(false)
      expect(store.get(chatRoomMessagesAtom).has('r1')).toBe(false)
      expect(store.get(chatRoomDataRevisionsAtom).get('r1')).toBe(deletedRevision)
      expect(transport.unmockedFetchFallback).not.toHaveBeenCalled()
    } finally {
      if (root) await act(async () => root!.unmount())
      chatRoomApi.listRooms = priorListRooms
      chatRoomApi.getInvocationMetadata = priorMetadata
      chatRoomApi.markRead = priorMarkRead
      transport.closeStreams()
      restoreTestGlobals(priorGlobals)
    }
  })
})
