import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { parseHTML } from 'linkedom'
import * as React from 'react'
import { Simulate } from 'react-dom/test-utils'
import { createRoot, type Root } from 'react-dom/client'
import { Provider, createStore } from 'jotai'

const act = (React as typeof React & { act: typeof import('react-dom/test-utils').act }).act
globalThis.fetch = mock(async () => new Response(JSON.stringify({ roomId: 'room-1', name: '测试聊天室' }))) as unknown as typeof fetch
let ChatroomCreateDialog: typeof import('./ChatroomCreateDialog')['ChatroomCreateDialog']
let ChatroomAgentProvisionDialog: typeof import('./ChatroomAgentProvisionDialog')['ChatroomAgentProvisionDialog']
let ChatroomMembersPanel: typeof import('./ChatroomMembersPanel')['ChatroomMembersPanel']
const { agentWorkspacesAtom, agentChannelIdAtom } = await import('@/atoms/agent-atoms')
const { chatRoomLocalRoomsAtom, chatRoomRoomsAtom, chatRoomProvisionPlansAtom } = await import('@/atoms/chatroom-atoms')
const { workingAuthLifecycleEpochAtom, workingAuthStateAtom } = await import('@/atoms/working-atoms')
const { chatRoomApi } = await import('@/lib/chatroom-api')

let root: Root | null = null
let renderedStore: ReturnType<typeof createStore>
let domWindow: ReturnType<typeof parseHTML>['window']
let releaseProvision!: () => void
let provisionStarted: Promise<void>

function installDom(): void {
  const parsed = parseHTML('<html><body><div id="root"></div></body></html>')
  domWindow = parsed.window
  Object.assign(domWindow, { getComputedStyle: () => ({ getPropertyValue: () => '', overflowY: 'visible' }), MutationObserver: class { observe(): void {} disconnect(): void {} }, requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(callback, 0) })
  Object.defineProperty(domWindow.document, 'dispatchEvent', { configurable: true, value: () => true })
  Object.defineProperty(domWindow, 'dispatchEvent', { configurable: true, value: () => true })
  Object.defineProperty(domWindow.Element.prototype, 'dispatchEvent', { configurable: true, value: () => true })
  Object.assign(globalThis, { window: domWindow, document: domWindow.document, navigator: domWindow.navigator, Event: domWindow.Event, KeyboardEvent: domWindow.Event, HTMLInputElement: domWindow.HTMLInputElement, MutationObserver: domWindow.MutationObserver, NodeFilter: { SHOW_ELEMENT: 1 }, IS_REACT_ACT_ENVIRONMENT: true })
  provisionStarted = new Promise<void>((resolve) => {
    const waitForStart = (): void => resolve()
    releaseProvision = waitForStart
  })
  Object.assign(domWindow, { electronAPI: { chatrooms: { provisionAgent: mock(async () => { await provisionStarted }) } } })
  globalThis.fetch = mock(async () => new Response(JSON.stringify({ roomId: 'room-1', name: '测试聊天室' }))) as unknown as typeof fetch
}

async function renderCreateDialog(withChannel = true): Promise<void> {
  if (!ChatroomCreateDialog) ({ ChatroomCreateDialog } = await import('./ChatroomCreateDialog'))
  const store = createStore()
  renderedStore = store
  store.set(agentWorkspacesAtom, [
    { id: 'workspace-1', name: 'Agent 1', slug: 'agent-1', createdAt: 1, updatedAt: 1 },
    { id: 'workspace-2', name: 'Agent 2', slug: 'agent-2', createdAt: 1, updatedAt: 1 },
    { id: 'workspace-3', name: 'Agent 3', slug: 'agent-3', createdAt: 1, updatedAt: 1 },
  ])
  if (withChannel) store.set(agentChannelIdAtom, 'channel-1')
  root = createRoot(document.getElementById('root')!)
  await act(async () => {
    root!.render(<Provider store={store}><ChatroomCreateDialog open onOpenChange={() => undefined} /></Provider>)
    await new Promise((resolve) => setTimeout(resolve, 25))
  })
}

beforeEach(() => installDom())
afterEach(async () => {
  if (root) {
    await act(async () => root!.unmount())
    root = null
  }
})

describe('聊天室创建加入契约', () => {
  test('A→B→A期间返回的创建响应不按相同accountKey复活旧房间或配置计划', async () => {
    if (!ChatroomCreateDialog) ({ ChatroomCreateDialog } = await import('./ChatroomCreateDialog'))
    const store = createStore()
    store.set(agentWorkspacesAtom, [{ id: 'workspace-1', name: 'Agent 1', slug: 'agent-1', createdAt: 1, updatedAt: 1 }])
    store.set(agentChannelIdAtom, 'channel-1')
    const accountA = { authenticated: true, user: { id: 'account-a' }, backendUrl: 'http://test' }
    store.set(workingAuthStateAtom, accountA)
    let resolveCreate!: (room: { roomId: string; name: string; role: 'host'; status: 'active'; memberCount: number; unreadCount: number; connectionStatus: 'offline' }) => void
    const originalCreateRoom = chatRoomApi.createRoom
    const createRoom = mock(async () => new Promise<Parameters<typeof resolveCreate>[0]>((resolve) => { resolveCreate = resolve }))
    chatRoomApi.createRoom = createRoom
    const provisionAgent = mock(async () => undefined)
    Object.assign(domWindow, { electronAPI: { chatrooms: { provisionAgent } } })
    root = createRoot(document.getElementById('root')!)
    await act(async () => { root!.render(<Provider store={store}><ChatroomCreateDialog open onOpenChange={() => undefined} /></Provider>); await new Promise((resolve) => setTimeout(resolve, 25)) })
    const inputs = [...document.querySelectorAll('input')] as HTMLInputElement[]
    await act(async () => {
      Simulate.change(inputs.find((input) => input.getAttribute('aria-label') === '聊天室名称')!, { target: { value: 'ABA 房间' } as unknown as EventTarget })
      Simulate.change(inputs.find((input) => input.getAttribute('aria-label') === '分享码')!, { target: { value: 'AB12' } as unknown as EventTarget })
      Simulate.change(inputs.find((input) => input.type === 'checkbox')!, { target: { checked: true } as unknown as EventTarget })
    })
    await act(async () => { Simulate.submit(document.querySelector('form')!); await Promise.resolve() })
    expect(createRoom).toHaveBeenCalledTimes(1)
    await act(async () => {
      store.set(workingAuthStateAtom, { authenticated: true, user: { id: 'account-b' }, backendUrl: 'http://test' })
      store.set(workingAuthStateAtom, accountA)
      await Promise.resolve()
    })
    try {
      await act(async () => { resolveCreate({ roomId: 'room-account-a', name: 'ABA 房间', role: 'host', status: 'active', memberCount: 1, unreadCount: 0, connectionStatus: 'offline' }); await new Promise((resolve) => setTimeout(resolve, 0)) })
      expect(store.get(chatRoomRoomsAtom)).toEqual([])
      expect(store.get(chatRoomProvisionPlansAtom).has('room-account-a')).toBe(false)
      expect(provisionAgent).not.toHaveBeenCalled()
    } finally { chatRoomApi.createRoom = originalCreateRoom }
  })
  test('同账号key重新认证后旧provision回执不能推进或清除旧生命周期计划', async () => {
    if (!ChatroomCreateDialog) ({ ChatroomCreateDialog } = await import('./ChatroomCreateDialog'))
    const store = createStore()
    store.set(agentWorkspacesAtom, [{ id: 'workspace-1', name: 'Agent 1', slug: 'agent-1', createdAt: 1, updatedAt: 1 }])
    store.set(agentChannelIdAtom, 'channel-1')
    const accountA = { authenticated: true, user: { id: 'account-a' }, backendUrl: 'http://test' }
    store.set(workingAuthStateAtom, accountA)
    let rejectProvision!: (error: Error) => void
    const provisionAgent = mock(async () => new Promise<void>((_resolve, reject) => { rejectProvision = reject }))
    const room = { roomId: 'room-lifecycle-a', name: 'Lifecycle A', role: 'host' as const, status: 'active' as const, memberCount: 1, unreadCount: 0, connectionStatus: 'offline' as const }
    const originalCreateRoom = chatRoomApi.createRoom
    chatRoomApi.createRoom = mock(async () => room)
    Object.assign(domWindow, { electronAPI: { chatrooms: { provisionAgent } } })
    const onOpenChange = mock(() => undefined)
    root = createRoot(document.getElementById('root')!)
    await act(async () => { root!.render(<Provider store={store}><ChatroomCreateDialog open onOpenChange={onOpenChange} /></Provider>); await new Promise((resolve) => setTimeout(resolve, 0)) })
    const inputs = [...document.querySelectorAll('input')] as HTMLInputElement[]
    await act(async () => {
      Simulate.change(inputs.find((input) => input.getAttribute('aria-label') === '聊天室名称')!, { target: { value: 'Lifecycle A' } as unknown as EventTarget })
      Simulate.change(inputs.find((input) => input.getAttribute('aria-label') === '分享码')!, { target: { value: 'AB12' } as unknown as EventTarget })
      Simulate.change(inputs.find((input) => input.type === 'checkbox')!, { target: { checked: true } as unknown as EventTarget })
    })
    try {
      await act(async () => { Simulate.submit(document.querySelector('form')!); await Promise.resolve() })
      expect(provisionAgent).toHaveBeenCalledTimes(1)
      const planBeforeReauth = store.get(chatRoomProvisionPlansAtom).get(room.roomId)!
      const epochBeforeReauth = store.get(workingAuthLifecycleEpochAtom)
      await act(async () => {
        store.set(workingAuthStateAtom, { authenticated: true, user: { id: 'account-b' }, backendUrl: 'http://test' })
        store.set(workingAuthStateAtom, accountA)
        await Promise.resolve()
      })
      await act(async () => { rejectProvision(new Error('旧生命周期失败')); await new Promise((resolve) => setTimeout(resolve, 0)) })
      expect(store.get(chatRoomProvisionPlansAtom).has(room.roomId)).toBe(false)
      expect(document.body.textContent).not.toContain('旧生命周期失败')
      expect(onOpenChange).not.toHaveBeenCalled()
      expect(planBeforeReauth.authEpoch).toBe(epochBeforeReauth)
      expect(store.get(workingAuthLifecycleEpochAtom)).toBe(epochBeforeReauth + 2)
    } finally {
      if (rejectProvision) { await act(async () => { rejectProvision(new Error('清理')); await new Promise((resolve) => setTimeout(resolve, 0)) }) }
      if (root) { await act(async () => root!.unmount()); root = null }
      chatRoomApi.createRoom = originalCreateRoom
    }
  })
  test('创建请求跨账号返回时不把旧账号房间或 Agent 计划写回新账号状态', async () => {
    if (!ChatroomCreateDialog) ({ ChatroomCreateDialog } = await import('./ChatroomCreateDialog'))
    const store = createStore()
    store.set(agentWorkspacesAtom, [{ id: 'workspace-1', name: 'Agent 1', slug: 'agent-1', createdAt: 1, updatedAt: 1 }])
    store.set(agentChannelIdAtom, 'channel-1')
    store.set(workingAuthStateAtom, { authenticated: true, user: { id: 'account-a' }, backendUrl: 'http://test' })
    let resolveCreate!: (room: { roomId: string; name: string; role: 'host'; status: 'active'; memberCount: number; unreadCount: number; connectionStatus: 'offline' }) => void
    const originalCreateRoom = chatRoomApi.createRoom
    const createRoom = mock(async () => new Promise<Parameters<typeof resolveCreate>[0]>((resolve) => { resolveCreate = resolve }))
    chatRoomApi.createRoom = createRoom
    const provisionAgent = mock(async () => undefined)
    Object.assign(domWindow, { electronAPI: { chatrooms: { provisionAgent } } })
    root = createRoot(document.getElementById('root')!)
    await act(async () => { root!.render(<Provider store={store}><ChatroomCreateDialog open onOpenChange={() => undefined} /></Provider>); await new Promise((resolve) => setTimeout(resolve, 25)) })
    const inputs = [...document.querySelectorAll('input')] as HTMLInputElement[]
    await act(async () => {
      Simulate.change(inputs.find((input) => input.getAttribute('aria-label') === '聊天室名称')!, { target: { value: '旧账号房间' } as unknown as EventTarget })
      Simulate.change(inputs.find((input) => input.getAttribute('aria-label') === '分享码')!, { target: { value: 'AB12' } as unknown as EventTarget })
      Simulate.change(inputs.find((input) => input.type === 'checkbox')!, { target: { checked: true } as unknown as EventTarget })
    })
    await act(async () => { Simulate.submit(document.querySelector('form')!); await Promise.resolve() })
    expect(createRoom).toHaveBeenCalledTimes(1)
    await act(async () => { store.set(workingAuthStateAtom, { authenticated: true, user: { id: 'account-b' }, backendUrl: 'http://test' }); await Promise.resolve() })
    try {
      await act(async () => { resolveCreate({ roomId: 'room-account-a', name: '旧账号房间', role: 'host', status: 'active', memberCount: 1, unreadCount: 0, connectionStatus: 'offline' }); await new Promise((resolve) => setTimeout(resolve, 0)) })
      expect(store.get(chatRoomRoomsAtom)).toEqual([])
      expect(store.get(chatRoomProvisionPlansAtom).size).toBe(0)
      expect(provisionAgent).not.toHaveBeenCalled()
    } finally { chatRoomApi.createRoom = originalCreateRoom }
  })
  test('创建失败重开后展示并继续使用冻结的 Agent 名称与共享选项', async () => {
    await renderCreateDialog()
    const store = renderedStore
    const provisionAgent = mock(async (_input: unknown): Promise<void> => undefined)
    provisionAgent.mockRejectedValueOnce(new Error('暂时失败'))
    Object.assign(domWindow, { electronAPI: { chatrooms: { provisionAgent } } })
    const inputs = [...document.querySelectorAll('input')] as HTMLInputElement[]
    await act(async () => {
      Simulate.change(inputs.find((input) => input.getAttribute('aria-label') === '聊天室名称')!, { target: { value: '快照房间' } as unknown as EventTarget })
      Simulate.change(inputs.find((input) => input.getAttribute('aria-label') === '分享码')!, { target: { value: 'AB12' } as unknown as EventTarget })
      const checks = inputs.filter((input) => input.type === 'checkbox')
      Simulate.change(checks[0]!, { target: { checked: true } as unknown as EventTarget })
    })
    await act(async () => {
      const memoryToggle = [...document.querySelectorAll('label')].find((label) => label.textContent?.includes('共享记忆'))?.querySelector('input')
      Simulate.change(memoryToggle!, { target: { checked: true } as unknown as EventTarget })
    })
    await act(async () => { Simulate.submit(document.querySelector('form')!); await new Promise((resolve) => setTimeout(resolve, 0)) })
    expect(document.body.textContent).toContain('暂时失败')
    await act(async () => {
      store.set(agentWorkspacesAtom, [{ id: 'workspace-1', name: '变更后的名称', slug: 'agent-1', createdAt: 1, updatedAt: 2 }])
      store.set(agentChannelIdAtom, 'channel-2')
      root!.unmount()
      root = createRoot(document.getElementById('root')!)
      root!.render(<Provider store={store}><ChatroomCreateDialog open onOpenChange={() => undefined} /></Provider>)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(document.body.textContent).toContain('Agent 1')
    expect(document.body.textContent).not.toContain('变更后的名称')
    const reopenedChecks = [...document.querySelectorAll('input[type="checkbox"]')] as HTMLInputElement[]
    expect(reopenedChecks.filter((input) => input.checked)).toHaveLength(2)
    await act(async () => { Simulate.submit(document.querySelector('form')!); await new Promise((resolve) => setTimeout(resolve, 0)) })
    expect(provisionAgent.mock.calls.map(([input]) => input)).toEqual([
      expect.objectContaining({ displayName: 'Agent 1', channelId: 'channel-1', memorySharingEnabled: true }),
      expect.objectContaining({ displayName: 'Agent 1', channelId: 'channel-1', memorySharingEnabled: true }),
    ])
  })
  test('Agent 补配响应跨账号完成时不恢复旧计划或触发旧房间刷新', async () => {
    if (!ChatroomAgentProvisionDialog) ({ ChatroomAgentProvisionDialog } = await import('./ChatroomAgentProvisionDialog'))
    const store = createStore()
    store.set(agentWorkspacesAtom, [{ id: 'workspace-1', name: 'Agent 1', slug: 'agent-1', createdAt: 1, updatedAt: 1 }])
    store.set(agentChannelIdAtom, 'channel-1')
    store.set(workingAuthStateAtom, { authenticated: true, user: { id: 'account-a' }, backendUrl: 'http://test' })
    let resolveProvision!: () => void
    const provisionAgent = mock(async () => new Promise<void>((resolve) => { resolveProvision = resolve }))
    Object.assign(domWindow, { electronAPI: { chatrooms: { provisionAgent } } })
    const room = { roomId: 'room-account-a', name: '旧账号房间', role: 'host' as const, status: 'active' as const, memberCount: 1, unreadCount: 0, connectionStatus: 'offline' as const }
    const onProvisioned = mock(() => undefined)
    const onOpenChange = mock(() => undefined)
    root = createRoot(document.getElementById('root')!)
    await act(async () => { root!.render(<Provider store={store}><ChatroomAgentProvisionDialog open room={room} agents={[]} onOpenChange={onOpenChange} onProvisioned={onProvisioned} /></Provider>); await new Promise((resolve) => setTimeout(resolve, 0)) })
    await act(async () => { Simulate.change(document.querySelector('input[type="checkbox"]')!, { target: { checked: true } as unknown as EventTarget }) })
    await act(async () => { Simulate.submit(document.querySelector('form')!); await Promise.resolve() })
    expect(provisionAgent).toHaveBeenCalledTimes(1)
    await act(async () => { store.set(workingAuthStateAtom, { authenticated: true, user: { id: 'account-b' }, backendUrl: 'http://test' }); await Promise.resolve() })
    await act(async () => { resolveProvision(); await new Promise((resolve) => setTimeout(resolve, 0)) })
    expect(store.get(chatRoomProvisionPlansAtom).has(room.roomId)).toBe(false)
    expect(onProvisioned).not.toHaveBeenCalled()
  })
  test('补配回执对应旧房间时不得关闭或刷新同身份的新房间对话框', async () => {
    if (!ChatroomAgentProvisionDialog) ({ ChatroomAgentProvisionDialog } = await import('./ChatroomAgentProvisionDialog'))
    const store = createStore()
    store.set(agentWorkspacesAtom, [{ id: 'workspace-1', name: 'Agent 1', slug: 'agent-1', createdAt: 1, updatedAt: 1 }])
    store.set(agentChannelIdAtom, 'channel-1')
    store.set(workingAuthStateAtom, { authenticated: true, user: { id: 'account-a' }, backendUrl: 'http://test' })
    const pending: Array<() => void> = []
    const provisionAgent = mock(async () => new Promise<void>((resolve) => { pending.push(resolve) }))
    Object.assign(domWindow, { electronAPI: { chatrooms: { provisionAgent } } })
    const roomA = { roomId: 'room-a', name: '房间 A', role: 'host' as const, status: 'active' as const, memberCount: 1, unreadCount: 0, connectionStatus: 'offline' as const }
    const roomB = { ...roomA, roomId: 'room-b', name: '房间 B' }
    const onProvisionedA = mock(() => undefined)
    const onOpenChangeA = mock(() => undefined)
    const onProvisionedB = mock(() => undefined)
    const onOpenChangeB = mock(() => undefined)
    root = createRoot(document.getElementById('root')!)
    const renderRoom = (room: typeof roomA, onOpenChange: () => void, onProvisioned: () => void) => root!.render(<Provider store={store}><ChatroomAgentProvisionDialog open room={room} agents={[]} onOpenChange={onOpenChange} onProvisioned={onProvisioned} /></Provider>)
    await act(async () => { renderRoom(roomA, onOpenChangeA, onProvisionedA); await new Promise((resolve) => setTimeout(resolve, 0)) })
    await act(async () => { Simulate.change(document.querySelector('input[type="checkbox"]')!, { target: { checked: true } as unknown as EventTarget }) })
    await act(async () => { Simulate.submit(document.querySelector('form')!); await Promise.resolve() })
    expect(provisionAgent).toHaveBeenCalledTimes(1)
    await act(async () => { renderRoom(roomB, onOpenChangeB, onProvisionedB); await new Promise((resolve) => setTimeout(resolve, 0)) })
    await act(async () => { Simulate.change(document.querySelector('input[type="checkbox"]')!, { target: { checked: true } as unknown as EventTarget }) })
    await act(async () => { Simulate.submit(document.querySelector('form')!); await Promise.resolve() })
    expect(provisionAgent).toHaveBeenCalledTimes(2)
    await act(async () => { pending[0]!(); await new Promise((resolve) => setTimeout(resolve, 0)) })
    expect(onOpenChangeA).not.toHaveBeenCalled()
    expect(onProvisionedA).not.toHaveBeenCalled()
    expect([...document.querySelectorAll('button')].find((button) => button.type === 'submit')!.disabled).toBe(true)
    await act(async () => { pending[1]!(); await new Promise((resolve) => setTimeout(resolve, 0)) })
    expect(onOpenChangeB).toHaveBeenCalledWith(false)
    expect(onProvisionedB).toHaveBeenCalledTimes(1)
    expect(store.get(chatRoomProvisionPlansAtom).has(roomB.roomId)).toBe(false)
  })
  test('创建配置组件卸载后仍记录在途 Agent 成功，续办不重复提交', async () => {
    await renderCreateDialog()
    const store = renderedStore
    const calls: string[] = []
    let resolveSecond!: () => void
    let markSecondStarted!: () => void
    const secondStarted = new Promise<void>((resolve) => { markSecondStarted = resolve })
    const provisionAgent = mock(async (input: { displayName: string }) => {
      calls.push(input.displayName)
      if (input.displayName === 'Agent 2') { markSecondStarted(); await new Promise<void>((resolve) => { resolveSecond = resolve }) }
    })
    Object.assign(domWindow, { electronAPI: { chatrooms: { provisionAgent } } })
    const inputs = [...document.querySelectorAll('input')] as HTMLInputElement[]
    await act(async () => {
      Simulate.change(inputs.find((input) => input.getAttribute('aria-label') === '聊天室名称')!, { target: { value: '卸载续办房间' } as unknown as EventTarget })
      Simulate.change(inputs.find((input) => input.getAttribute('aria-label') === '分享码')!, { target: { value: 'AB12' } as unknown as EventTarget })
      const checks = inputs.filter((input) => input.type === 'checkbox')
      Simulate.change(checks[0]!, { target: { checked: true } as unknown as EventTarget })
      Simulate.change(checks[1]!, { target: { checked: true } as unknown as EventTarget })
    })
    try {
      await act(async () => { Simulate.submit(document.querySelector('form')!); await secondStarted })
      expect(store.get(chatRoomProvisionPlansAtom).get('room-1')?.completed).toBe(1)
      await act(async () => { root!.unmount(); root = null })
      const closeAfterBackgroundSuccess = mock(() => undefined)
      root = createRoot(document.getElementById('root')!)
      await act(async () => { root!.render(<Provider store={store}><ChatroomCreateDialog open onOpenChange={closeAfterBackgroundSuccess} /></Provider>); await new Promise((resolve) => setTimeout(resolve, 0)) })
      expect(document.body.textContent).toContain('正在确认 Agent「Agent 2」的配置结果')
      expect([...document.querySelectorAll('button')].find((button) => button.type === 'submit')!.disabled).toBe(true)
      expect(calls).toEqual(['Agent 1', 'Agent 2'])
      await act(async () => { resolveSecond(); await new Promise((resolve) => setTimeout(resolve, 0)) })
      expect(store.get(chatRoomProvisionPlansAtom).has('room-1')).toBe(false)
      expect(calls).toEqual(['Agent 1', 'Agent 2'])
      expect(closeAfterBackgroundSuccess).toHaveBeenCalledWith(false)
    } finally {
      if (root) { await act(async () => root!.unmount()); root = null }
    }
  })
  test('Agent 补配组件卸载后仍结算在途成功并清理计划', async () => {
    if (!ChatroomAgentProvisionDialog) ({ ChatroomAgentProvisionDialog } = await import('./ChatroomAgentProvisionDialog'))
    const store = createStore()
    store.set(agentWorkspacesAtom, [
      { id: 'workspace-1', name: 'Agent 1', slug: 'agent-1', createdAt: 1, updatedAt: 1 },
      { id: 'workspace-2', name: 'Agent 2', slug: 'agent-2', createdAt: 1, updatedAt: 1 },
    ])
    store.set(agentChannelIdAtom, 'channel-1')
    store.set(workingAuthStateAtom, { authenticated: true, user: { id: 'account-a' }, backendUrl: 'http://test' })
    const calls: string[] = []
    let resolveSecond!: () => void
    let markSecondStarted!: () => void
    const secondStarted = new Promise<void>((resolve) => { markSecondStarted = resolve })
    const provisionAgent = mock(async (input: { displayName: string }) => {
      calls.push(input.displayName)
      if (input.displayName === 'Agent 2') { markSecondStarted(); await new Promise<void>((resolve) => { resolveSecond = resolve }) }
    })
    Object.assign(domWindow, { electronAPI: { chatrooms: { provisionAgent } } })
    const room = { roomId: 'room-provision-unmount', name: '补配房间', role: 'host' as const, status: 'active' as const, memberCount: 1, unreadCount: 0, connectionStatus: 'offline' as const }
    const onProvisioned = mock(() => undefined)
    root = createRoot(document.getElementById('root')!)
    await act(async () => { root!.render(<Provider store={store}><ChatroomAgentProvisionDialog open room={room} agents={[]} onOpenChange={() => undefined} onProvisioned={onProvisioned} /></Provider>); await new Promise((resolve) => setTimeout(resolve, 0)) })
    const checks = [...document.querySelectorAll('input[type="checkbox"]')] as HTMLInputElement[]
    await act(async () => {
      Simulate.change(checks[0]!, { target: { checked: true } as unknown as EventTarget })
      Simulate.change(checks[1]!, { target: { checked: true } as unknown as EventTarget })
    })
    try {
      await act(async () => { Simulate.submit(document.querySelector('form')!); await secondStarted })
      expect(store.get(chatRoomProvisionPlansAtom).get(room.roomId)?.completed).toBe(1)
      await act(async () => { root!.unmount(); root = null })
      await act(async () => { resolveSecond(); await new Promise((resolve) => setTimeout(resolve, 0)) })
      expect(store.get(chatRoomProvisionPlansAtom).has(room.roomId)).toBe(false)
      expect(calls).toEqual(['Agent 1', 'Agent 2'])
      expect(onProvisioned).not.toHaveBeenCalled()
    } finally {
      if (root) { await act(async () => root!.unmount()); root = null }
    }
  })
  test('成员面板切房后旧房间回执不能解除新房间操作的busy', async () => {
    if (!ChatroomMembersPanel) ({ ChatroomMembersPanel } = await import('./ChatroomMembersPanel'))
    const store = createStore()
    const localAgent = (id: string) => ({ roomAgentId: id, displayName: id, sourceWorkspaceId: `workspace-${id}`, channelId: 'channel-1', contextMessageCount: 50, memorySharingEnabled: false, skillSharingEnabled: false, archived: false })
    store.set(chatRoomLocalRoomsAtom, new Map([
      ['room-a', { roomId: 'room-a', updatedAt: 1, agents: [localAgent('agent-a')] }],
      ['room-b', { roomId: 'room-b', updatedAt: 1, agents: [localAgent('agent-b')] }],
    ]))
    const pending = new Map<string, (value: ReturnType<typeof localAgent>) => void>()
    const updateAgent = mock(async (input: { roomAgentId: string }) => new Promise<ReturnType<typeof localAgent>>((resolve) => { pending.set(input.roomAgentId, resolve) }))
    Object.assign(domWindow, { electronAPI: { chatrooms: { updateAgent } } })
    const changedA = mock(() => undefined)
    const changedB = mock(() => undefined)
    const memberAgent = (agentId: string) => ({ agentId, displayName: agentId, status: 'offline', memoryShared: false, skillsShared: false } as never)
    root = createRoot(document.getElementById('root')!)
    const renderRoom = (roomId: string, agentId: string, onChanged: () => void) => root!.render(<Provider store={store}><ChatroomMembersPanel roomId={roomId} role="host" members={[]} agents={[memberAgent(agentId)]} onChanged={onChanged} /></Provider>)
    const memoryToggle = (): HTMLInputElement => [...document.querySelectorAll('label')].find((label) => label.textContent?.includes('记忆'))!.querySelector('input')!
    await act(async () => { renderRoom('room-a', 'agent-a', changedA) })
    await act(async () => { Simulate.change(memoryToggle(), { target: { checked: true } as unknown as EventTarget }) })
    expect(updateAgent).toHaveBeenCalledTimes(1)
    await act(async () => { renderRoom('room-b', 'agent-b', changedB) })
    expect(memoryToggle().disabled).toBe(false)
    await act(async () => { Simulate.change(memoryToggle(), { target: { checked: true } as unknown as EventTarget }) })
    expect(updateAgent).toHaveBeenCalledTimes(2)
    await act(async () => { pending.get('agent-a')!(localAgent('agent-a')); await Promise.resolve() })
    expect(changedA).not.toHaveBeenCalled()
    expect(memoryToggle().disabled).toBe(true)
    await act(async () => { pending.get('agent-b')!(localAgent('agent-b')); await new Promise((resolve) => setTimeout(resolve, 0)) })
    expect(changedB).toHaveBeenCalledTimes(1)
  })
  test('成员共享操作在账号切换后隔离旧失败且不清除新操作busy', async () => {
    if (!ChatroomMembersPanel) ({ ChatroomMembersPanel } = await import('./ChatroomMembersPanel'))
    const store = createStore()
    store.set(workingAuthStateAtom, { authenticated: true, user: { id: 'account-a' }, backendUrl: 'http://test' })
    store.set(chatRoomLocalRoomsAtom, new Map([['room-1', { roomId: 'room-1', updatedAt: 1, agents: [{ roomAgentId: 'agent-1', displayName: 'Agent', sourceWorkspaceId: 'workspace-1', channelId: 'channel-1', contextMessageCount: 50, memorySharingEnabled: false, skillSharingEnabled: false, archived: false }] }]]))
    const pending: Array<{ resolve: (value: { roomAgentId: string; displayName: string; sourceWorkspaceId: string; channelId: string; contextMessageCount: number; memorySharingEnabled: boolean; skillSharingEnabled: boolean; archived: boolean }) => void; reject: (error: Error) => void }> = []
    const updateAgent = mock(async () => new Promise<{ roomAgentId: string; displayName: string; sourceWorkspaceId: string; channelId: string; contextMessageCount: number; memorySharingEnabled: boolean; skillSharingEnabled: boolean; archived: boolean }>((resolve, reject) => { pending.push({ resolve, reject }) }))
    Object.assign(domWindow, { electronAPI: { chatrooms: { updateAgent } } })
    const changedA = mock(() => undefined)
    const changedB = mock(() => undefined)
    const agent = { agentId: 'agent-1', displayName: 'Agent', status: 'offline', memoryShared: false, skillsShared: false } as never
    root = createRoot(document.getElementById('root')!)
    const render = (callback: () => void) => root!.render(<Provider store={store}><ChatroomMembersPanel roomId="room-1" role="host" members={[]} agents={[agent]} onChanged={callback} /></Provider>)
    const memoryToggle = (): HTMLInputElement => [...document.querySelectorAll('label')].find((label) => label.textContent?.includes('记忆'))!.querySelector('input')!
    const updated = { roomAgentId: 'agent-1', displayName: 'Agent', sourceWorkspaceId: 'workspace-1', channelId: 'channel-1', contextMessageCount: 50, memorySharingEnabled: true, skillSharingEnabled: false, archived: false }
    await act(async () => { render(changedA) })
    await act(async () => { Simulate.change(memoryToggle(), { target: { checked: true } as unknown as EventTarget }) })
    await act(async () => { store.set(workingAuthStateAtom, { authenticated: true, user: { id: 'account-b' }, backendUrl: 'http://test' }); render(changedB); await Promise.resolve() })
    try {
      expect(memoryToggle().disabled).toBe(false)
      await act(async () => { Simulate.change(memoryToggle(), { target: { checked: true } as unknown as EventTarget }) })
      expect(updateAgent).toHaveBeenCalledTimes(2)
      await act(async () => { pending[0]!.reject(new Error('旧账号失败')); await Promise.resolve() })
      expect(document.body.textContent).not.toContain('旧账号失败')
      expect(memoryToggle().disabled).toBe(true)
      await act(async () => { pending[1]!.resolve(updated); await new Promise((resolve) => setTimeout(resolve, 0)) })
      expect(changedA).not.toHaveBeenCalled()
      expect(changedB).toHaveBeenCalledTimes(1)
    } finally {
      for (const operation of pending) operation.resolve(updated)
    }
  })
  test('共享开关显示并切换经 Main 确认的本机值，而不是远端快照值', async () => {
    if (!ChatroomMembersPanel) ({ ChatroomMembersPanel } = await import('./ChatroomMembersPanel'))
    const store = createStore()
    store.set(chatRoomLocalRoomsAtom, new Map([['room-1', { roomId: 'room-1', updatedAt: 1, agents: [{ roomAgentId: 'agent-1', displayName: 'Agent', sourceWorkspaceId: 'workspace-1', channelId: 'channel-1', contextMessageCount: 50, memorySharingEnabled: false, skillSharingEnabled: false, archived: false }] }]]))
    const updateAgent = mock(async (_input: unknown) => ({ roomAgentId: 'agent-1', displayName: 'Agent', sourceWorkspaceId: 'workspace-1', channelId: 'channel-1', contextMessageCount: 50, memorySharingEnabled: true, skillSharingEnabled: false, archived: false }))
    Object.assign(domWindow, { electronAPI: { chatrooms: { updateAgent } } })
    root = createRoot(document.getElementById('root')!)
    await act(async () => { root!.render(<Provider store={store}><ChatroomMembersPanel roomId="room-1" role="host" members={[]} agents={[{ agentId: 'agent-1', displayName: 'Agent', status: 'offline', memoryShared: true, skillsShared: false } as never]} /></Provider>) })
    const memoryToggle = document.querySelector('input[type="checkbox"]') as HTMLInputElement
    expect(memoryToggle.checked).toBe(false)
    await act(async () => { Simulate.change(memoryToggle, { target: { checked: true } as unknown as EventTarget }); await new Promise((resolve) => setTimeout(resolve, 0)) })
    expect(updateAgent.mock.calls[0]?.[0]).toMatchObject({ roomId: 'room-1', roomAgentId: 'agent-1', memorySharingEnabled: true })
  })
  test('移除 Agent 失败时保留列表项、显示错误并恢复可重试按钮', async () => {
    if (!ChatroomMembersPanel) ({ ChatroomMembersPanel } = await import('./ChatroomMembersPanel'))
    const store = createStore()
    const removeAgent = mock(async (): Promise<void> => { throw new Error('本机配置暂不可用') })
    Object.assign(domWindow, { electronAPI: { chatrooms: { removeAgent } } })
    const onChanged = mock(() => undefined)
    root = createRoot(document.getElementById('root')!)
    await act(async () => { root!.render(<Provider store={store}><ChatroomMembersPanel roomId="room-1" role="host" members={[]} agents={[{ agentId: 'agent-1', displayName: 'Agent', status: 'offline', memoryShared: false, skillsShared: false } as never]} onChanged={onChanged} /></Provider>) })
    await act(async () => { Simulate.click([...document.querySelectorAll('button')].find((button) => button.textContent === '移除')!); await new Promise((resolve) => setTimeout(resolve, 0)) })
    expect(document.body.textContent).toContain('Agent 移除失败，可重试：本机配置暂不可用')
    expect(document.body.textContent).toContain('@Agent')
    expect((document.querySelector('button') as HTMLButtonElement).disabled).toBe(false)
    expect(onChanged).not.toHaveBeenCalled()
    removeAgent.mockImplementation(async () => undefined)
    await act(async () => { Simulate.click([...document.querySelectorAll('button')].find((button) => button.textContent === '重试移除')!); await new Promise((resolve) => setTimeout(resolve, 0)) })
    expect(onChanged).toHaveBeenCalledTimes(1)
  })
  test('已选择 Agent 但没有渠道时，不先创建远端房间', async () => {
    await renderCreateDialog(false)
    const inputs = [...document.querySelectorAll('input')] as HTMLInputElement[]
    await act(async () => {
      Simulate.change(inputs.find((input) => input.getAttribute('aria-label') === '聊天室名称')!, { target: { value: '协作室' } as unknown as EventTarget })
      Simulate.change(inputs.find((input) => input.getAttribute('aria-label') === '分享码')!, { target: { value: 'AB12' } as unknown as EventTarget })
      Simulate.change(inputs.find((input) => input.type === 'checkbox')!, { target: { checked: true } as unknown as EventTarget })
    })
    await act(async () => { Simulate.submit(document.querySelector('form')!); await Promise.resolve() })
    expect(document.body.textContent).toContain('请先配置 Agent 渠道')
  })
  test('已存在房间能单独补配 Agent，不重新创建房间', async () => {
    if (!ChatroomAgentProvisionDialog) ({ ChatroomAgentProvisionDialog } = await import('./ChatroomAgentProvisionDialog'))
    const store = createStore()
    store.set(agentWorkspacesAtom, [{ id: 'workspace-1', name: 'Grok', slug: 'grok', createdAt: 1, updatedAt: 1 }])
    store.set(agentChannelIdAtom, 'channel-1')
    const provision = mock(async (_input: unknown) => undefined)
    Object.assign(domWindow, { electronAPI: { chatrooms: { provisionAgent: provision } } })
    const room = { roomId: 'room-existing', name: '已有房间', role: 'host' as const, status: 'active' as const, memberCount: 1, unreadCount: 0, connectionStatus: 'offline' as const }
    const onProvisioned = mock(() => undefined)
    root = createRoot(document.getElementById('root')!)
    await act(async () => { root!.render(<Provider store={store}><ChatroomAgentProvisionDialog open room={room} agents={[]} onOpenChange={() => undefined} onProvisioned={onProvisioned} /></Provider>) })
    const checkbox = document.querySelector('input[type="checkbox"]') as HTMLInputElement
    await act(async () => { Simulate.change(checkbox, { target: { checked: true } as unknown as EventTarget }) })
    await act(async () => { Simulate.submit(document.querySelector('form')!); await new Promise((resolve) => setTimeout(resolve, 0)) })
    expect(provision.mock.calls[0]?.[0]).toMatchObject({ roomId: 'room-existing', displayName: 'Grok' })
    expect(onProvisioned).toHaveBeenCalledTimes(1)
    expect((globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls).toHaveLength(0)
  })
  test('加入规范化大小写并校验四位分享码', () => {
    const source = readFileSync(new URL('./ChatroomJoinDialog.tsx', import.meta.url), 'utf8')
    expect(source).toContain("toUpperCase()")
    expect(source).toContain('/^[A-Z0-9]{4}$/')
    expect(source).toContain('openChatRoomTab')
  })
  test('创建最多配置三个 Agent，且创建后逐个 provision', () => {
    const source = readFileSync(new URL('./ChatroomCreateDialog.tsx', import.meta.url), 'utf8')
    expect(source).toContain('selected.length >= 3')
    expect(source).toContain('createRoom')
    expect(source).toContain('onProvisionProgress')
    expect(source).toContain('succeededCount')
    expect(source).toContain('createdRoomId !== null')
  })

  test('首个 Agent provision 挂起时显示明确等待对象', async () => {
    await renderCreateDialog()
    const inputs = [...document.querySelectorAll('input')] as HTMLInputElement[]
    await act(async () => {
      Simulate.change(inputs.find((input) => input.getAttribute('aria-label') === '聊天室名称')!, { target: { value: '测试聊天室' } as unknown as EventTarget })
      Simulate.change(inputs.find((input) => input.getAttribute('aria-label') === '分享码')!, { target: { value: 'AB12' } as unknown as EventTarget })
      for (const input of inputs.filter((input) => input.type === 'checkbox')) Simulate.change(input, { target: { checked: true } as unknown as EventTarget })
    })
    await act(async () => {
      Simulate.submit(document.querySelector('form')!)
      await Promise.resolve()
    })
    expect(document.body.textContent).toContain('正在确认 Agent「Agent 1」的配置结果')
    await act(async () => {
      releaseProvision()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  })

  test('首个 Agent provision 失败时仍显示 0/3 并保留创建错误', async () => {
    await renderCreateDialog()
    const inputs = [...document.querySelectorAll('input')] as HTMLInputElement[]
    await act(async () => {
      Simulate.change(inputs.find((input) => input.getAttribute('aria-label') === '聊天室名称')!, { target: { value: '测试聊天室' } as unknown as EventTarget })
      Simulate.change(inputs.find((input) => input.getAttribute('aria-label') === '分享码')!, { target: { value: 'AB12' } as unknown as EventTarget })
      for (const input of inputs.filter((input) => input.type === 'checkbox')) Simulate.change(input, { target: { checked: true } as unknown as EventTarget })
    })
    const provision = (domWindow as typeof domWindow & { electronAPI: { chatrooms: { provisionAgent: ReturnType<typeof mock> } } }).electronAPI.chatrooms.provisionAgent
    provision.mockRejectedValueOnce(new Error('配置不可用'))
    await act(async () => {
      Simulate.submit(document.querySelector('form')!)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(document.body.textContent).toContain('Agent 配置 0/3')
    expect(document.body.textContent).toContain('配置不可用')
    expect(document.body.textContent).toContain('继续配置')
    const requestCountBeforeRetry = (globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls.length
    await act(async () => {
      root!.render(<Provider store={renderedStore}><ChatroomCreateDialog open={false} onOpenChange={() => undefined} /></Provider>)
    })
    await act(async () => {
      root!.render(<Provider store={renderedStore}><ChatroomCreateDialog open onOpenChange={() => undefined} /></Provider>)
    })
    expect(document.body.textContent).toContain('继续配置')
    await act(async () => {
      Simulate.submit(document.querySelector('form')!)
      await Promise.resolve()
    })
    expect((globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls.length).toBe(requestCountBeforeRetry)
    await act(async () => { releaseProvision(); await new Promise((resolve) => setTimeout(resolve, 0)) })
    expect(provision.mock.calls.length).toBe(4)
  })
})
