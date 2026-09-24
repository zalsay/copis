import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { deleteChatRoomAndClose, getChatRoomAvatarInitial, getChatRoomHostRole, getChatRoomIdentityLabel, getChatRoomInvocationTargetLabel, getChatRoomMemberCount, getChatRoomMessageClassName, hasDurableChatRoomReply, loadChatRoomViewData } from './ChatroomView'
import { chatRoomApi, createChatRoomApi, ChatRoomApiError } from '@/lib/chatroom-api'
import type { TabItem } from '@/atoms/tab-atoms'
import type { ChatRoomAgent, ChatRoomInvocation, ChatRoomMember, ChatRoomMessage } from '@copis/shared'
import * as React from 'react'
import { parseHTML } from 'linkedom'
import { createRoot } from 'react-dom/client'
import { Provider, createStore } from 'jotai'
import { chatRoomDetailsAtom, chatRoomRejoinRoomAtom, chatRoomRemoveRoomAtom, chatRoomRoomsAtom } from '@/atoms/chatroom-atoms'
import { ChatroomView } from './ChatroomView'
import { renderToStaticMarkup } from 'react-dom/server'
import { chatRoomConnectionStatusAtom, chatRoomInvocationsAtom, chatRoomSendStatesAtom } from '@/atoms/chatroom-atoms'
import { chatRoomApplyEventAtom } from '@/atoms/chatroom-atoms'
import { ChatroomAgentActivity, getPendingChatRoomInvocations } from './ChatroomAgentActivity'

const source = readFileSync(new URL('./ChatroomView.tsx', import.meta.url), 'utf8')

test('本地唤起超时转成终态，不在重连时重新成为 pending，迟到真实调用替换本地提示', async () => {
  const prior = { window: globalThis.window, document: globalThis.document }
  const dom = parseHTML('<html><body><div id="root"></div></body></html>')
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true })
  const store = createStore()
  const pending: ChatRoomInvocation = { invocationId: 'pending:c1:a1', roomId: 'r1', targetAgentId: 'a1', triggerMessageId: 'm1', traceId: '', depth: 0, status: 'created', startedAt: Date.now() - 61_000 }
  const send = { roomId: 'r1', clientMessageId: 'c1', messageId: 'm1', status: 'sent' as const, content: '@A', mentionAgentIds: ['a1'], attachmentIds: [], startedAt: pending.startedAt }
  store.set(chatRoomSendStatesAtom, new Map([['c1', send]]))
  const root = createRoot(document.getElementById('root')!)
  const act = (React as typeof React & { act: typeof import('react-dom/test-utils').act }).act
  try {
    await act(async () => { root.render(<Provider store={store}><ChatroomAgentActivity invocation={pending} connectionStatus="reconnecting" /></Provider>); await new Promise((resolve) => setTimeout(resolve, 10)) })
    const terminal = store.get(chatRoomInvocationsAtom).get('r1')?.get(pending.invocationId)
    expect(terminal).toMatchObject({ status: 'rejected', failureCode: 'invocation_unconfirmed' })
    expect(getPendingChatRoomInvocations('r1', [send], [], [terminal!])).toEqual([])
    store.set(chatRoomConnectionStatusAtom, new Map([['r1', 'connected']]))
    // edu-api 的真实 accepted 仅包含 invocationId；缺身份时不猜测归属或重复显示卡片。
    store.set(chatRoomApplyEventAtom, { type: 'agent.accepted', roomId: 'r1', payload: { invocationId: 'real-i1' } })
    expect(renderToStaticMarkup(<Provider store={store}><ChatroomView roomId="r1" /></Provider>)).not.toContain('正在思考')
    // HTTP 响应的 created 元数据晚到，必须补全身份但保留 accepted 阶段。
    store.set(chatRoomApplyEventAtom, { type: 'agent.invocation', roomId: 'r1', payload: { invocationId: 'real-i1', targetAgentId: 'a1', triggerMessageId: 'm1', clientMessageId: 'c1' } })
    expect(store.get(chatRoomInvocationsAtom).get('r1')?.has(pending.invocationId)).toBe(false)
    expect(store.get(chatRoomInvocationsAtom).get('r1')?.get('real-i1')?.status).toBe('accepted')
    const html = renderToStaticMarkup(<Provider store={store}><ChatroomView roomId="r1" /></Provider>)
    expect(html.match(/正在思考/g)).toHaveLength(1)
    expect(html).not.toContain('未收到 Agent 调用确认')
  } finally { await act(async () => root.unmount()); Object.assign(globalThis, prior) }
})

describe('聊天室房间视图契约', () => {
  test('多个 Agent 被唤起时分别显示等待和思考，失败后停止动效并显示原因', () => {
    const store = createStore()
    store.set(chatRoomConnectionStatusAtom, new Map([['r1', 'connected']]))
    store.set(chatRoomSendStatesAtom, new Map([['c1', { roomId: 'r1', clientMessageId: 'c1', status: 'sent', messageId: 'm1', content: '@A @B', mentionAgentIds: ['a1', 'a2'], attachmentIds: [], startedAt: Date.now() }]]))
    const render = () => renderToStaticMarkup(<Provider store={store}><ChatroomView roomId="r1" /></Provider>)
    expect(render().match(/正在唤起/g)).toHaveLength(2)
    const invocation: ChatRoomInvocation = { invocationId: 'i1', roomId: 'r1', targetAgentId: 'a1', triggerMessageId: 'm1', traceId: 't1', depth: 0, status: 'accepted', startedAt: Date.now() }
    store.set(chatRoomInvocationsAtom, new Map([['r1', new Map([['i1', invocation]])]]))
    expect(render()).toContain('正在思考')
    expect(render().match(/正在唤起/g)).toHaveLength(1)
    expect(render()).toContain('agent-thinking-marquee')
    store.set(chatRoomInvocationsAtom, new Map([['r1', new Map([['i1', { ...invocation, status: 'failed', failureCode: 'lease_expired' }]])]]))
    expect(render()).not.toContain('正在思考')
    expect(render()).toContain('租约已过期')
    store.set(chatRoomConnectionStatusAtom, new Map([['r1', 'reconnecting']]))
    expect(render()).not.toContain('agent-thinking-marquee')
    expect(render()).toContain('连接中断')
  })

  test('没有收到调用确认时停止无限唤起动画，不假报正在思考', () => {
    const store = createStore()
    store.set(chatRoomConnectionStatusAtom, new Map([['r1', 'connected']]))
    store.set(chatRoomSendStatesAtom, new Map([['c1', { roomId: 'r1', clientMessageId: 'c1', status: 'sent', messageId: 'm1', content: '@A', mentionAgentIds: ['a1'], attachmentIds: [], startedAt: Date.now() - 61_000 }]]))
    const html = renderToStaticMarkup(<Provider store={store}><ChatroomView roomId="r1" /></Provider>)
    expect(html).toContain('未收到 Agent 调用确认')
    expect(html).not.toContain('agent-thinking-marquee')
  })
  test('服务端房间摘要缺少成员数字时，详情加载后显示真实成员数量', () => {
    const summary = { memberCount: 0 }
    expect(getChatRoomMemberCount(summary, undefined)).toBe(0)
    expect(getChatRoomMemberCount(summary, { members: [{ userId: '7', displayName: '主理人', role: 'host', presence: 'online' }] })).toBe(1)
  })
  test('服务端默认 member 展示角色不遮蔽真实主理人的补配入口', () => {
    const room = { roomId: 'room-1', hostUserId: '7', role: 'member' as const }
    expect(getChatRoomHostRole(room, '7')).toBe('host')
    expect(getChatRoomHostRole(room, '8')).toBe('member')
    expect(getChatRoomHostRole(room, undefined)).toBe('member')
  })
  test('附件列表路由尚未实现时仍加载真实房间详情和历史消息', async () => {
    const roomId = 'room-real'
    const api = createChatRoomApi({ baseUrl: 'http://test', fetchImpl: async (url) => {
      const path = new URL(String(url)).pathname
      if (path.endsWith('/attachments')) return new Response(JSON.stringify({ code: 'chatroom_route_not_found', error: '聊天室路由不存在' }), { status: 404 })
      if (path.endsWith('/messages')) return new Response(JSON.stringify({ data: [{ messageId: 'm1', roomId, seq: 1, senderType: 'user', senderUserId: 7, content: '你好', mentionAgentIds: [], attachmentIds: [], clientMessageId: 'c1', depth: 0, createdAt: 'now' }] }))
      return new Response(JSON.stringify({ data: { room: { roomId, name: '协作室', status: 'active' }, members: [], agents: [] } }))
    } })
    const result = await loadChatRoomViewData(roomId, api)
    expect(result.detail.room.roomId).toBe(roomId)
    expect(result.history.messages[0]?.content).toBe('你好')
    expect(result.attachments).toEqual([])
  })

  test('旧空房间标签不会发起任何详情、消息或附件请求', async () => {
    let requests = 0
    const api = createChatRoomApi({ fetchImpl: async () => { requests++; return new Response('{}') } })
    await expect(loadChatRoomViewData('', api)).rejects.toBeInstanceOf(ChatRoomApiError)
    expect(requests).toBe(0)
  })

  test('房间按 roomId 加载消息并使用成员面板', () => {
    expect(source).toContain('getMessages(roomId')
    expect(source).toContain('hydrateMessages({ roomId, messages: history.messages, cursor: history.cursor })')
    expect(source).toContain('<ChatroomMembersPanel')
    expect(source).toContain('<ChatroomComposer')
  })

  test('打开房间时右侧成员面板默认关闭且中间聊天区隐藏滚动条', () => {
    expect(source).toContain('const [showMembers, setShowMembers] = React.useState(false)')
    expect(source).toContain('overflow-y-auto scrollbar-none')
  })

  test('调用卡片展示实时 delta、真实触发来源和停止继续唤起原因', () => {
    expect(source).toContain('invocation.delta')
    expect(source).toContain('triggerMessageId')
    const store = createStore()
    store.set(chatRoomInvocationsAtom, new Map([['r1', new Map([['i1', { invocationId: 'i1', roomId: 'r1', targetAgentId: 'a1', triggerMessageId: 'm1', traceId: 't1', depth: 2, status: 'rejected', failureCode: 'invocation_depth_exceeded' }]])]]))
    expect(renderToStaticMarkup(<Provider store={store}><ChatroomView roomId="r1" /></Provider>)).toContain('已停止继续唤起')
    expect(source).toContain('hasDurableChatRoomReply')
    expect(source).toContain("invocation.status === 'running' || !hasDurableChatRoomReply(messages, invocation)")
  })

  test('同一 trace 的两个 Agent 只隐藏各自已落库的 delta', () => {
    const base: ChatRoomMessage = { messageId: 'm', roomId: 'r1', seq: 1, senderType: 'agent', senderId: 'agent-a', content: '答复', mentionAgentIds: [], attachmentIds: [], clientMessageId: 'c', traceId: 'trace-1', depth: 1, createdAt: 'now' }
    const invocation = (targetAgentId: string): Pick<ChatRoomInvocation, 'traceId' | 'targetAgentId'> => ({ traceId: 'trace-1', targetAgentId })
    expect(hasDurableChatRoomReply([{ ...base, senderId: 'agent-a' }], invocation('agent-a'))).toBe(true)
    expect(hasDurableChatRoomReply([{ ...base, senderId: 'agent-a' }], invocation('agent-b'))).toBe(false)
  })

  test('按真实身份显示多个用户和 Agent，未知身份安全回退', () => {
    const members: ChatRoomMember[] = [{ userId: 'u-current', displayName: '当前用户', role: 'host', presence: 'online' }, { userId: 'u-other', displayName: '另一位成员', role: 'member', presence: 'online' }]
    const agents: ChatRoomAgent[] = [{ agentId: 'agent-a', displayName: '分析 Agent', status: 'online', busy: false, memoryShared: false, skillsShared: false }, { agentId: 'agent-b', displayName: '执行 Agent', status: 'online', busy: false, memoryShared: false, skillsShared: false }]
    expect(getChatRoomIdentityLabel({ senderType: 'user', senderId: 'u-current' }, 'u-current', members, agents)).toBe('我')
    expect(getChatRoomIdentityLabel({ senderType: 'user', senderId: 'u-other' }, 'u-current', members, agents)).toBe('另一位成员')
    expect(getChatRoomIdentityLabel({ senderType: 'agent', senderId: 'agent-a' }, 'u-current', members, agents)).toBe('分析 Agent')
    expect(getChatRoomIdentityLabel({ senderType: 'agent', senderId: 'agent-b' }, 'u-current', members, agents)).toBe('执行 Agent')
    expect(getChatRoomIdentityLabel({ senderType: 'agent', senderId: 'unknown-agent' }, 'u-current', members, agents)).toBe('unknown-agent')
    expect(getChatRoomInvocationTargetLabel('agent-b', agents)).toBe('执行 Agent')
    expect(getChatRoomInvocationTargetLabel('unknown-agent', agents)).toBe('unknown-agent')
  })

  test('仅当前用户消息右对齐并对齐深浅主题，其他用户左对齐且与 Agent 区分', () => {
    expect(getChatRoomMessageClassName({ senderType: 'user', senderId: 'u-current' }, 'u-current')).toBe('ml-auto bg-primary/10 text-foreground border border-primary/15')
    expect(getChatRoomMessageClassName({ senderType: 'user', senderId: 'u-other' }, 'u-current')).toBe('mr-auto bg-muted/80 text-foreground border border-border/50 dark:bg-muted/50 dark:border-border/40')
    expect(getChatRoomMessageClassName({ senderType: 'agent', senderId: 'agent-a' }, 'u-current')).toBe('mr-auto bg-card text-card-foreground border border-border/60 shadow-xs dark:bg-muted/30 dark:border-border/40')
    expect(getChatRoomMessageClassName({ senderType: 'agent', senderId: 'agent-b' }, 'u-current')).toBe('mr-auto bg-card text-card-foreground border border-border/60 shadow-xs dark:bg-muted/30 dark:border-border/40')
    expect(source).toContain("message.senderType === 'user' && currentUserId === message.senderId")
    expect(source).toContain("'ml-auto bg-primary/10 text-foreground border border-primary/15'")
    expect(source).toContain("'mr-auto bg-card text-card-foreground border border-border/60 shadow-xs dark:bg-muted/30 dark:border-border/40'")
    expect(source).toContain("'mr-auto bg-muted/80 text-foreground border border-border/50 dark:bg-muted/50 dark:border-border/40'")
    expect(source).toContain('getChatRoomMessageClassName(message, currentUserId)')
    expect(source).toContain("isSelf ? 'justify-end' : isSystem ? 'justify-center' : 'justify-start'")
    expect(source).toContain("w-fit max-w-[80%]")
  })

  test('首字母 Avatar 提取逻辑规范化中英文与特殊前缀', () => {
    expect(getChatRoomAvatarInitial('我')).toBe('我')
    expect(getChatRoomAvatarInitial('分析 Agent')).toBe('分')
    expect(getChatRoomAvatarInitial('执行 Agent')).toBe('执')
    expect(getChatRoomAvatarInitial('Agent')).toBe('A')
    expect(getChatRoomAvatarInitial('bob')).toBe('B')
    expect(getChatRoomAvatarInitial('@Alice')).toBe('A')
    expect(getChatRoomAvatarInitial('')).toBe('?')
  })

  test('“我”显示在右侧外侧 Avatar，左侧 Agent/其他用户显示首字母外侧 Avatar', () => {
    expect(source).toContain('getChatRoomAvatarInitial(senderLabel)')
    expect(source).toContain('aria-label="我"')
    expect(source).toContain('isAgent')
    expect(source).toContain('bg-[var(--ui-primary)] text-white')
    expect(source).toContain("backgroundColor: 'var(--ui-primary)'")
  })

  test('删除成功后清理房间并关闭对应 Tab', async () => {
    const calls: string[] = []
    const tabs: TabItem[] = [
      { id: 'agent-1', type: 'agent', sessionId: 'agent-1', title: 'Agent' },
      { id: 'chatroom:r1', type: 'chatroom', roomId: 'r1', title: '房间' },
    ]
    let nextTabs = tabs
    let nextActive: string | null = 'chatroom:r1'
    await deleteChatRoomAndClose({ roomId: 'r1', deleteRoom: async () => { calls.push('delete') }, removeRoom: (roomId) => calls.push(`remove:${roomId}`), tabs, activeTabId: nextActive, setTabs: (value) => { nextTabs = value }, setActiveTabId: (value) => { nextActive = value } })
    expect(calls).toEqual(['delete', 'remove:r1'])
    expect(nextTabs.map((tab) => tab.id)).toEqual(['agent-1'])
    expect(nextActive).toBe('agent-1')
  })

  test('删除失败时不清理房间或 Tab', async () => {
    const calls: string[] = []
    const tabs: TabItem[] = [{ id: 'chatroom:r1', type: 'chatroom', roomId: 'r1', title: '房间' }]
    await expect(deleteChatRoomAndClose({ roomId: 'r1', deleteRoom: async () => { throw new Error('网络失败') }, removeRoom: (roomId) => calls.push(roomId), tabs, activeTabId: 'chatroom:r1', setTabs: () => calls.push('tabs'), setActiveTabId: () => calls.push('active') })).rejects.toThrow('网络失败')
    expect(calls).toEqual([])
  })

})

test('同一房间 Tab 留在页面时重新加入，必须重新读取详情与真实成员数', async () => {
  const previousWindow = globalThis.window
  const previousDocument = globalThis.document
  const parsed = parseHTML('<html><body><div id="root"></div></body></html>')
  Object.assign(parsed.window, { electronAPI: { chatrooms: { onTransferProgress: () => () => undefined } } })
  Object.assign(globalThis, { window: parsed.window, document: parsed.window.document, IS_REACT_ACT_ENVIRONMENT: true })
  let detailsRequested = 0
  const originalApi = { getRoom: chatRoomApi.getRoom, getMessages: chatRoomApi.getMessages, listAttachments: chatRoomApi.listAttachments }
  const store = createStore()
  const room = { roomId: 'r1', name: '恢复的房间', role: 'member' as const, status: 'active' as const, memberCount: 0, unreadCount: 0, connectionStatus: 'offline' as const }
  chatRoomApi.getRoom = async () => { detailsRequested++; return { room, members: [{ userId: '7', displayName: '主理人', role: 'host', presence: 'online' }], agents: [] } }
  chatRoomApi.getMessages = async () => ({ messages: [] })
  chatRoomApi.listAttachments = async () => []
  store.set(chatRoomRoomsAtom, [room])
  store.set(chatRoomRemoveRoomAtom, room.roomId)
  const root = createRoot(parsed.window.document.getElementById('root')!)
  const act = (React as typeof React & { act: typeof import('react-dom/test-utils').act }).act
  try {
    await act(async () => { root.render(<Provider store={store}><ChatroomView roomId="r1" /></Provider>); await Promise.resolve() })
    expect(parsed.window.document.body.textContent).toContain('聊天室已删除')
    detailsRequested = 0
    await act(async () => { store.set(chatRoomRejoinRoomAtom, room); await new Promise((resolve) => setTimeout(resolve, 0)) })
    expect(detailsRequested).toBeGreaterThan(0)
    expect(store.get(chatRoomDetailsAtom).r1).toBeDefined()
    expect(parsed.window.document.body.textContent).toContain('成员 1')
  } finally {
    await act(async () => root.unmount())
    Object.assign(chatRoomApi, originalApi)
    Object.assign(globalThis, { window: previousWindow, document: previousDocument })
  }
})
