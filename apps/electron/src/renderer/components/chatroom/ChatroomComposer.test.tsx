import { describe, expect, test } from 'bun:test'
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
import { ChatroomComposer, filterChatRoomMentionCandidates, formatChatRoomAgentStatus, getChatRoomKeyboardCandidates, getChatRoomMentionQuery, removeChatRoomMentionToken, replaceChatRoomMentionTrigger, reconcileChatRoomMentionTokens, subscribeChatRoomTransferProgress } from './ChatroomComposer'
import type { ChatRoomAgent } from '@copis/shared'

const source = readFileSync(new URL('./ChatroomComposer.tsx', import.meta.url), 'utf8')

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
    const parsed = parseHTML('<html><body><div id="root"></div></body></html>')
    Object.assign(globalThis, { window: parsed.window, document: parsed.window.document, IS_REACT_ACT_ENVIRONMENT: true })
    const requests: Array<{ body?: unknown }> = []
    const originalSendMessage = chatRoomApi.sendMessage
    chatRoomApi.sendMessage = async (input) => { requests.push({ body: input }); return { messageId: 'm-1', roomId: 'room-1', seq: 1, senderType: 'user', senderId: 'user-1', content: input.content, mentionAgentIds: input.mentionAgentIds, attachmentIds: [], clientMessageId: input.clientMessageId ?? 'c-1', depth: 0, createdAt: '1' } }
    Object.assign(parsed.window, { setTimeout, clearTimeout, setInterval, clearInterval, electronAPI: { chatrooms: { onTransferProgress: () => () => undefined, startUpload: async () => ({ transferId: 't', phase: 'ready' }) } } })
    const store = createStore()
    store.set(chatRoomPermissionRequestsAtom, new Map([['permission-1', { roomId: 'room-1', roomAgentId: 'a-online' } as ChatRoomPermissionRequest]]))
    const act = (React as typeof React & { act: typeof import('react-dom/test-utils').act }).act
    const root = createRoot(document.getElementById('root')!)
    await act(async () => { root.render(<Provider store={store}><ChatroomComposer roomId="room-1" agents={agents} /></Provider>) })
    const textarea = document.querySelector('[aria-label="聊天室消息"]') as HTMLTextAreaElement
    await act(async () => { textarea.value = '@'; Object.defineProperty(textarea, 'selectionStart', { configurable: true, value: 1 }); Simulate.change(textarea) })
    expect(document.querySelector('[role="listbox"]')).not.toBeNull()
    expect([...document.querySelectorAll('[role="option"]')].find((item) => item.textContent?.includes('Alpha'))?.textContent).toContain('待授权')
    const offline = [...document.querySelectorAll('[role="option"]')].find((item) => item.textContent?.includes('Beta')) as HTMLButtonElement
    expect(offline.disabled).toBe(false)
    await act(async () => { offline.click(); await Promise.resolve() })
    expect(store.get(chatRoomMentionAgentIdsAtom).get('room-1')).toEqual(['a-offline'])
    await act(async () => { (document.querySelector('[aria-label="发送消息"]') as HTMLButtonElement).click(); await new Promise((resolve) => setTimeout(resolve, 0)) })
    expect(requests.at(-1)?.body).toMatchObject({ mentionAgentIds: ['a-offline'] })
    await act(async () => { textarea.value = '手写 @Beta'; Object.defineProperty(textarea, 'selectionStart', { configurable: true, value: 9 }); Simulate.change(textarea) })
    expect(store.get(chatRoomMentionAgentIdsAtom).get('room-1')).toEqual([])
    await act(async () => { (document.querySelector('[aria-label="发送消息"]') as HTMLButtonElement).click(); await new Promise((resolve) => setTimeout(resolve, 0)) })
    expect(requests.at(-1)?.body).toMatchObject({ mentionAgentIds: [] })
    chatRoomApi.sendMessage = originalSendMessage
    await act(async () => { root.unmount() })
    expect(store.get(chatRoomMentionAgentIdsAtom).get('room-1')).toEqual([])
  })
})
