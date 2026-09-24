import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { parseHTML } from 'linkedom'
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { Simulate } from 'react-dom/test-utils'
import { Provider } from 'jotai'
import { createStore } from 'jotai/vanilla'
import type { ChatRoomPermissionRequest, ChatRoomTransferState } from '@copis/shared'
import { chatRoomDraftsAtom, chatRoomMentionAgentIdsAtom, chatRoomPermissionRequestsAtom } from '@/atoms/chatroom-atoms'
import { chatRoomApi } from '@/lib/chatroom-api'
import { ChatroomComposer, filterChatRoomMentionCandidates, formatChatRoomAgentStatus, getChatRoomKeyboardCandidates, getChatRoomMentionQuery, reconstructChatRoomMentionTokens, removeChatRoomMentionToken, removeChatRoomMentionTrigger, replaceChatRoomMentionTrigger, reconcileChatRoomMentionTokens, subscribeChatRoomTransferProgress } from './ChatroomComposer'
import type { ChatRoomAgent } from '@copis/shared'

const source = readFileSync(new URL('./ChatroomComposer.tsx', import.meta.url), 'utf8')

function installComposerDom(): ReturnType<typeof parseHTML>['window'] {
  const parsed = parseHTML('<html><body><div id="root"></div></body></html>')
  const domWindow = parsed.window
  Object.assign(domWindow, { setTimeout, clearTimeout, setInterval, clearInterval, IS_REACT_ACT_ENVIRONMENT: true })
  Object.assign(globalThis, {
    window: domWindow,
    document: domWindow.document,
    navigator: domWindow.navigator,
    Event: domWindow.Event,
    KeyboardEvent: domWindow.Event,
    HTMLInputElement: domWindow.HTMLInputElement,
    HTMLTextAreaElement: domWindow.HTMLTextAreaElement,
    Element: domWindow.Element,
    Node: domWindow.Node,
    HTMLElement: domWindow.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  })
  return domWindow
}

function changeComposerTextarea(_domWindow: ReturnType<typeof parseHTML>['window'], textarea: HTMLTextAreaElement, value: string, caret: number): void {
  textarea.value = value
  Object.defineProperty(textarea, 'selectionStart', { configurable: true, value: caret })
  Simulate.change(textarea)
}

afterEach(() => {
  const root = typeof document === 'undefined' ? null : document.getElementById('root')
  if (root) root.replaceChildren()
})

describe('聊天室输入行为契约', () => {
  const agents: ChatRoomAgent[] = [
    { agentId: 'a-online', displayName: 'Alpha', status: 'online', busy: false, memoryShared: false, skillsShared: false },
    { agentId: 'a-offline', displayName: 'Beta', status: 'offline', busy: false, memoryShared: false, skillsShared: false },
    { agentId: 'a-disabled', displayName: 'Gamma', status: 'disabled', busy: false, memoryShared: false, skillsShared: false },
  ]

  test('只在光标前的 @ 触发词上提供过滤候选，普通 @ 文本不会生成 Agent ID', () => {
    expect(getChatRoomMentionQuery('请看 @Al', 6)).toEqual({ start: 3, query: 'Al' })
    expect(getChatRoomMentionQuery('请看 @Alpha ', 10)).toBeUndefined()
    expect(getChatRoomMentionQuery('email@example.com', 17)).toBeUndefined()
    expect(filterChatRoomMentionCandidates(agents, 'be').map((agent) => agent.agentId)).toEqual(['a-offline'])
  })

  test('离线候选可选择，只有 disabled 候选真正禁用', () => {
    expect(formatChatRoomAgentStatus(agents[1]!)).toBe('离线')
    expect(formatChatRoomAgentStatus({ ...agents[0]!, busy: true })).toBe('忙碌')
    expect(formatChatRoomAgentStatus(agents[0]!, true)).toBe('待授权')
    expect(filterChatRoomMentionCandidates(agents, '').find((agent) => agent.agentId === 'a-offline')).toBeTruthy()
    expect(filterChatRoomMentionCandidates(agents, '').find((agent) => agent.agentId === 'a-disabled')).toBeTruthy()
    expect(getChatRoomKeyboardCandidates(agents, '').map((agent) => agent.agentId)).toEqual(['a-online', 'a-offline'])
  })

  test('候选选择只替换触发词并返回新光标位置', () => {
    expect(replaceChatRoomMentionTrigger('请 @Al继续', 5, 'Alpha')).toEqual({ value: '请 @Alpha 继续', caret: 9 })
    expect(removeChatRoomMentionToken('请 @Alpha 继续', 'Alpha')).toBe('请 继续')
    const tokens = new Map([['a-online', { start: 0, end: 6 }]])
    expect(reconcileChatRoomMentionTokens(tokens, '@Alpha', '手写 Alpha')).toEqual(new Map())
    expect(reconcileChatRoomMentionTokens(new Map([['a-online', { start: 0, end: 6 }], ['a-offline', { start: 7, end: 12 }]]), '@Alpha @Beta ', '@Beta ')).toEqual(new Map([['a-offline', { start: 0, end: 5 }]]))
    expect(removeChatRoomMentionTrigger('请 @Alpha 后续', 8)).toEqual({ value: '请 后续', caret: 2 })
    expect(reconstructChatRoomMentionTokens('@Alpha 后续', ['a-online'], agents)).toEqual(new Map([['a-online', { start: 0, end: 6 }]]))
    expect(reconstructChatRoomMentionTokens('@Alpha @Alpha', ['a-online'], agents)).toEqual(new Map())
  })

  test('消息只提交结构化 Agent ID 和客户端消息 ID', () => {
    expect(source).toContain('mentionAgentIds')
    expect(source).toContain('clientMessageId')
    expect(source).not.toContain('traceId:')
    expect(source).not.toContain('parentMessageId:')
    expect(source).not.toContain('depth:')
  })
  test('手写 @ 文本不产生结构化 Agent ID，离线结果仍由发送状态处理', () => {
    expect(source).toContain('mentionAgentIds')
    expect(source).toContain('消息不会排队')
  })
  test('挂载卸载后 transfer listener 不会累积', () => {
    const listeners = new Set<(state: ChatRoomTransferState) => void>()
    const subscribe = (callback: (state: ChatRoomTransferState) => void): (() => void) => { listeners.add(callback); return () => listeners.delete(callback) }
    const updates: ChatRoomTransferState[] = []
    const firstCleanup = subscribeChatRoomTransferProgress('room-1', (state) => updates.push(state), subscribe)
    firstCleanup()
    subscribeChatRoomTransferProgress('room-1', (state) => updates.push(state), subscribe)
    const state = { transferId: 'transfer-1', roomId: 'room-1', phase: 'ready', progress: 1 } as ChatRoomTransferState
    for (const listener of listeners) listener(state)
    expect(listeners.size).toBe(1)
    expect(updates).toHaveLength(1)
  })

  test('选择离线 Agent 后发送仍提交结构化 ID，手写同名文本不会伪造 ID', async () => {
    const domWindow = installComposerDom()
    const requests: Array<{ body?: unknown }> = []
    const originalSendMessage = chatRoomApi.sendMessage
    chatRoomApi.sendMessage = async (input) => { requests.push({ body: input }); return { messageId: 'm-1', roomId: 'room-1', seq: 1, senderType: 'user', senderId: 'user-1', content: input.content, mentionAgentIds: input.mentionAgentIds, attachmentIds: [], clientMessageId: input.clientMessageId ?? 'c-1', depth: 0, createdAt: '1' } }
    Object.assign(domWindow, { electronAPI: { chatrooms: { onTransferProgress: () => () => undefined, startUpload: async () => ({ transferId: 't', phase: 'ready' }) } } })
    const store = createStore()
    store.set(chatRoomPermissionRequestsAtom, new Map([['permission-1', { roomId: 'room-1', roomAgentId: 'a-online' } as ChatRoomPermissionRequest]]))
    const act = (React as typeof React & { act: typeof import('react-dom/test-utils').act }).act
    const root = createRoot(document.getElementById('root')!)
    await act(async () => { root.render(<Provider store={store}><ChatroomComposer roomId="room-1" agents={agents} /></Provider>) })
    const textarea = document.querySelector('[aria-label="聊天室消息"]') as HTMLTextAreaElement
    await act(async () => { changeComposerTextarea(domWindow, textarea, '@', 1) })
    expect(document.querySelector('[role="listbox"]')).not.toBeNull()
    expect([...document.querySelectorAll('[role="option"]')].find((item) => item.textContent?.includes('Alpha'))?.textContent).toContain('待授权')
    const offline = [...document.querySelectorAll('[role="option"]')].find((item) => item.textContent?.includes('Beta')) as HTMLButtonElement
    expect(offline.disabled).toBe(false)
    await act(async () => { Simulate.click(offline); await Promise.resolve() })
    expect(store.get(chatRoomMentionAgentIdsAtom).get('room-1')).toEqual(['a-offline'])
    await act(async () => { changeComposerTextarea(domWindow, textarea, '@Beta @', 7) })
    const duplicate = [...document.querySelectorAll('[role="option"]')].find((item) => item.textContent?.includes('Beta')) as HTMLButtonElement
    await act(async () => { Simulate.click(duplicate); await Promise.resolve() })
    expect(store.get(chatRoomMentionAgentIdsAtom).get('room-1')).toEqual(['a-offline'])
    expect(store.get(chatRoomDraftsAtom).get('room-1')).toBe('@Beta ')
    await act(async () => { Simulate.click(document.querySelector('[aria-label="发送消息"]')!); await new Promise((resolve) => setTimeout(resolve, 0)) })
    expect(requests.at(-1)?.body).toMatchObject({ mentionAgentIds: ['a-offline'] })
    await act(async () => { changeComposerTextarea(domWindow, textarea, '手写 @Beta', 9) })
    expect(store.get(chatRoomMentionAgentIdsAtom).get('room-1')).toEqual([])
    await act(async () => { Simulate.click(document.querySelector('[aria-label="发送消息"]')!); await new Promise((resolve) => setTimeout(resolve, 0)) })
    expect(requests.at(-1)?.body).toMatchObject({ mentionAgentIds: [] })
    chatRoomApi.sendMessage = originalSendMessage
    await act(async () => { root.unmount() })
    expect(store.get(chatRoomMentionAgentIdsAtom).get('room-1')).toEqual([])
  })

  test('Composer 重挂载后恢复房间内结构化 mention token，并继续提交 Agent ID', async () => {
    const domWindow = installComposerDom()
    Object.assign(domWindow, { electronAPI: { chatrooms: { onTransferProgress: () => () => undefined, startUpload: async () => ({ transferId: 't', phase: 'ready' }) } } })
    const requests: unknown[] = []
    const originalSendMessage = chatRoomApi.sendMessage
    chatRoomApi.sendMessage = async (input) => { requests.push(input); return { messageId: 'm-2', roomId: 'room-1', seq: 2, senderType: 'user', senderId: 'user-1', content: input.content, mentionAgentIds: input.mentionAgentIds, attachmentIds: [], clientMessageId: input.clientMessageId ?? 'c-2', depth: 0, createdAt: '2' } }
    const store = createStore()
    store.set(chatRoomDraftsAtom, new Map([['room-1', '@Beta ']]))
    store.set(chatRoomMentionAgentIdsAtom, new Map([['room-1', ['a-offline']]]))
    const act = (React as typeof React & { act: typeof import('react-dom/test-utils').act }).act
    let root = createRoot(document.getElementById('root')!)
    await act(async () => { root.render(<Provider store={store}><ChatroomComposer roomId="room-1" agents={agents} /></Provider>) })
    await act(async () => { root.unmount() })
    root = createRoot(document.getElementById('root')!)
    await act(async () => { root.render(<Provider store={store}><ChatroomComposer roomId="room-1" agents={agents} /></Provider>) })
    await act(async () => { Simulate.click(document.querySelector('[aria-label="发送消息"]')!); await new Promise((resolve) => setTimeout(resolve, 0)) })
    expect(requests.at(-1)).toMatchObject({ mentionAgentIds: ['a-offline'] })
    chatRoomApi.sendMessage = originalSendMessage
    await act(async () => { root.unmount() })
  })

  test('删除前一个 mention 后，后续 Agent token 偏移仍正确并可提交', async () => {
    const domWindow = installComposerDom()
    Object.assign(domWindow, { electronAPI: { chatrooms: { onTransferProgress: () => () => undefined, startUpload: async () => ({ transferId: 't', phase: 'ready' }) } } })
    const requests: unknown[] = []
    const originalSendMessage = chatRoomApi.sendMessage
    chatRoomApi.sendMessage = async (input) => { requests.push(input); return { messageId: 'm-3', roomId: 'room-1', seq: 3, senderType: 'user', senderId: 'user-1', content: input.content, mentionAgentIds: input.mentionAgentIds, attachmentIds: [], clientMessageId: input.clientMessageId ?? 'c-3', depth: 0, createdAt: '3' } }
    const store = createStore()
    const act = (React as typeof React & { act: typeof import('react-dom/test-utils').act }).act
    const root = createRoot(document.getElementById('root')!)
    await act(async () => { root.render(<Provider store={store}><ChatroomComposer roomId="room-1" agents={agents} /></Provider>) })
    const textarea = document.querySelector('[aria-label="聊天室消息"]') as HTMLTextAreaElement
    await act(async () => { changeComposerTextarea(domWindow, textarea, '@', 1) })
    await act(async () => { Simulate.click([...document.querySelectorAll('[role="option"]')].find((item) => item.textContent?.includes('Alpha'))!); await Promise.resolve() })
    await act(async () => { changeComposerTextarea(domWindow, textarea, '@Alpha @', 8) })
    await act(async () => { Simulate.click([...document.querySelectorAll('[role="option"]')].find((item) => item.textContent?.includes('Beta'))!); await Promise.resolve() })
    expect(store.get(chatRoomMentionAgentIdsAtom).get('room-1')).toEqual(['a-online', 'a-offline'])
    expect(store.get(chatRoomDraftsAtom).get('room-1')).toBe('@Alpha @Beta ')
    await act(async () => { Simulate.click(document.querySelector('[aria-label="移除提及 Alpha"]')!); await Promise.resolve() })
    expect(store.get(chatRoomMentionAgentIdsAtom).get('room-1')).toEqual(['a-offline'])
    await act(async () => { Simulate.click(document.querySelector('[aria-label="发送消息"]')!); await new Promise((resolve) => setTimeout(resolve, 0)) })
    expect(requests.at(-1)).toMatchObject({ mentionAgentIds: ['a-offline'] })
    chatRoomApi.sendMessage = originalSendMessage
    await act(async () => { root.unmount() })
  })

  test('Composer 采用与 Agent 一致的卡片布局、毛玻璃样式、CornerDownLeft 发送按钮与 AI 生成提示文案', async () => {
    installComposerDom()
    const store = createStore()
    const act = (React as typeof React & { act: typeof import('react-dom/test-utils').act }).act
    const root = createRoot(document.getElementById('root')!)
    await act(async () => { root.render(<Provider store={store}><ChatroomComposer roomId="room-1" agents={agents} /></Provider>) })

    const agentModeContainer = document.querySelector('[data-input-mode="agent"]')
    expect(agentModeContainer).not.toBeNull()
    expect(agentModeContainer?.className).toContain('max-w-[760px]')

    const composerCard = document.querySelector('.copis-agent-composer-card')
    expect(composerCard).not.toBeNull()
    expect(composerCard?.className).toContain('rounded-[17px]')
    expect(composerCard?.className).toContain('backdrop-blur-sm')
    expect(composerCard?.className).toContain('shadow-[0_20px_60px_rgba(0,0,0,0.26)]')

    expect(document.body.textContent).toContain('内容由 AI 生成，请核实重要信息')

    const sendButton = document.querySelector('[aria-label="发送消息"]')
    expect(sendButton).not.toBeNull()
    expect(source).toContain('CornerDownLeft')
    expect(source).toContain('inputToolbarButtonClass')
    expect(source).toContain('inputToolbarSendButtonClass')

    await act(async () => { root.unmount() })
  })
})
