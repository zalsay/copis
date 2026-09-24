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
const { agentWorkspacesAtom, agentChannelIdAtom } = await import('@/atoms/agent-atoms')

let root: Root | null = null
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

  test('首个 Agent provision 挂起时显示 0/3', async () => {
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
    expect(document.body.textContent).toContain('Agent 配置 0/3')
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
      Simulate.submit(document.querySelector('form')!)
      await Promise.resolve()
    })
    expect((globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls.length).toBe(requestCountBeforeRetry)
    await act(async () => { releaseProvision(); await new Promise((resolve) => setTimeout(resolve, 0)) })
    expect(provision.mock.calls.length).toBe(4)
  })
})
