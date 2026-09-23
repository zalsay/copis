import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { parseHTML } from 'linkedom'
import * as React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Simulate } from 'react-dom/test-utils'
import { Provider, createStore } from 'jotai'
import type { ChatRoomPermissionRequest, ChatRoomSummary } from '@copis/shared'
import { chatRoomDetailsAtom, chatRoomPermissionRequestsAtom, chatRoomRoomsAtom } from '@/atoms/chatroom-atoms'
import { ChatroomPermissionBanner } from './ChatroomSseInitializer'

const act = (React as typeof React & { act: typeof import('react-dom/test-utils').act }).act
let root: Root | null = null

function room(role: ChatRoomSummary['role']): ChatRoomSummary {
  return { roomId: 'room-1', name: '测试聊天室', role, status: 'active', memberCount: 1, unreadCount: 0, connectionStatus: 'connected' }
}

const request: ChatRoomPermissionRequest = {
  roomId: 'room-1', roomAgentId: 'agent-1', invocationId: 'invocation-1', traceId: 'trace-1',
  originalSender: { type: 'user', id: 'user-1', displayName: '用户' }, invocationChain: [], requestId: 'permission-1',
  toolName: 'Bash', summary: '执行敏感命令', createdAt: Date.now(), expiresAt: Date.now() + 60_000,
}

beforeEach(() => {
  const parsed = parseHTML('<html><body><div id="root"></div></body></html>')
  Object.assign(globalThis, { window: parsed.window, document: parsed.window.document, navigator: parsed.window.navigator, IS_REACT_ACT_ENVIRONMENT: true })
  Object.assign(parsed.window, { setTimeout, clearTimeout, setInterval, clearInterval, electronAPI: { chatrooms: { respondPermission: mock(async () => undefined) } } })
})

afterEach(async () => {
  if (root) await act(async () => { root?.unmount() })
  root = null
})

async function renderBanner(store: ReturnType<typeof createStore>): Promise<void> {
  root = createRoot(document.getElementById('root')!)
  await act(async () => { root?.render(<Provider store={store}><ChatroomPermissionBanner /></Provider>) })
}

describe('聊天室主理人全局权限审批', () => {
  test('当前显示其他 Tab 时，主理人仍可看到并响应请求', async () => {
    const store = createStore()
    store.set(chatRoomRoomsAtom, [room('host')])
    store.set(chatRoomPermissionRequestsAtom, new Map([[request.requestId, request]]))
    await renderBanner(store)
    expect(document.body.textContent).toContain('执行敏感命令')
    const approve = document.querySelector('button:last-of-type') as HTMLButtonElement
    await act(async () => { Simulate.click(approve); await new Promise((resolve) => setTimeout(resolve, 0)); await Promise.resolve() })
    expect(window.electronAPI.chatrooms.respondPermission).toHaveBeenCalledWith({ requestId: 'permission-1', behavior: 'allow' })
    expect(store.get(chatRoomPermissionRequestsAtom).size).toBe(0)
  })

  test('房间详情尚未返回时暂存请求，详情确认成员后不可审批', async () => {
    const store = createStore()
    store.set(chatRoomRoomsAtom, [])
    store.set(chatRoomPermissionRequestsAtom, new Map([[request.requestId, request]]))
    await renderBanner(store)
    expect(document.querySelector('[data-testid="chatroom-permission-banner"]')).toBeNull()
    await act(async () => { store.set(chatRoomRoomsAtom, [room('member')]); await Promise.resolve() })
    expect(document.querySelector('[data-testid="chatroom-permission-banner"]')).toBeNull()
    expect(store.get(chatRoomPermissionRequestsAtom).size).toBe(1)
  })
})
