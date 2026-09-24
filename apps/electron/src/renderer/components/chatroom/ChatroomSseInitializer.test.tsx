import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { parseHTML } from 'linkedom'
import { createRoot } from 'react-dom/client'
import { createStore, Provider } from 'jotai'
import { chatRoomApi } from '../../lib/chatroom-api'
import { chatRoomConnectionStatusAtom, chatRoomRoomsAtom } from '../../atoms/chatroom-atoms'
import { workingAuthStateAtom } from '../../atoms/working-atoms'
import { ChatroomSseInitializer, getChatRoomAccountKey, shouldSubscribeChatRoomRooms } from './ChatroomSseInitializer'

describe('聊天室全局实时初始化账户边界', () => {
  test('主窗口初始化从实时连接帧更新已登录房间的状态', async () => {
    const original = { window: globalThis.window, document: globalThis.document, fetch: globalThis.fetch, listRooms: chatRoomApi.listRooms }
    const dom = parseHTML('<html><body><div id="root"></div></body></html>')
    Object.assign(dom.window, { electronAPI: { chatrooms: { onPermissionRequested: () => () => undefined } } })
    Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true })
    const room = { roomId: 'r1', name: '协作室', role: 'member' as const, hostUserId: '7', status: 'active' as const, memberCount: 1, unreadCount: 0, connectionStatus: 'offline' as const }
    chatRoomApi.listRooms = async () => [room]
    globalThis.fetch = (async (url: RequestInfo | URL) => String(url).includes('roomIds=')
      ? new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('data: {"type":"local.status","code":"realtime_connected"}\n\n')) } }), { headers: { 'content-type': 'text/event-stream' } })
      : Response.json({ invocations: [], nextCursor: null })) as typeof fetch
    const store = createStore()
    store.set(workingAuthStateAtom, { authenticated: true, user: { id: 7 }, backendUrl: 'http://test' })
    const root = createRoot(dom.window.document.getElementById('root')!)
    const act = (React as typeof React & { act: typeof import('react-dom/test-utils').act }).act
    try {
      await act(async () => { root.render(<Provider store={store}><React.StrictMode><ChatroomSseInitializer /></React.StrictMode></Provider>); await new Promise((resolve) => setTimeout(resolve, 20)) })
      expect(store.get(chatRoomRoomsAtom).map((item) => item.roomId)).toEqual(['r1'])
      expect(store.get(chatRoomConnectionStatusAtom).get('r1')).toBe('connected')
    } finally {
      await act(async () => root.unmount())
      chatRoomApi.listRooms = original.listRooms
      Object.assign(globalThis, { window: original.window, document: original.document, fetch: original.fetch })
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
})
