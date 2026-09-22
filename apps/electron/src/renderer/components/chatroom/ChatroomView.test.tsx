import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { deleteChatRoomAndClose, getChatRoomIdentityLabel, getChatRoomInvocationTargetLabel, getChatRoomMessageClassName, hasDurableChatRoomReply } from './ChatroomView'
import type { TabItem } from '@/atoms/tab-atoms'
import type { ChatRoomAgent, ChatRoomInvocation, ChatRoomMember, ChatRoomMessage } from '@copis/shared'

const source = readFileSync(new URL('./ChatroomView.tsx', import.meta.url), 'utf8')

describe('聊天室房间视图契约', () => {
  test('房间按 roomId 加载消息并使用成员面板', () => {
    expect(source).toContain('getMessages(roomId')
    expect(source).toContain('hydrateMessages({ roomId, messages: history.messages, cursor: history.cursor })')
    expect(source).toContain('<ChatroomMembersPanel')
    expect(source).toContain('<ChatroomComposer')
  })

  test('调用卡片展示实时 delta、真实触发来源和停止继续唤起原因', () => {
    expect(source).toContain('invocation.delta')
    expect(source).toContain('triggerMessageId')
    expect(source).toContain('已停止继续唤起')
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

  test('仅当前用户消息右对齐并使用主色，其他用户左对齐且与 Agent 区分', () => {
    expect(getChatRoomMessageClassName({ senderType: 'user', senderId: 'u-current' }, 'u-current')).toBe('ml-auto bg-primary text-primary-foreground')
    expect(getChatRoomMessageClassName({ senderType: 'user', senderId: 'u-other' }, 'u-current')).toBe('mr-auto bg-muted/70 text-foreground')
    expect(getChatRoomMessageClassName({ senderType: 'agent', senderId: 'agent-a' }, 'u-current')).toBe('mr-auto bg-muted')
    expect(getChatRoomMessageClassName({ senderType: 'agent', senderId: 'agent-b' }, 'u-current')).toBe('mr-auto bg-muted')
    expect(source).toContain("message.senderType === 'user' && currentUserId === message.senderId")
    expect(source).toContain("'ml-auto bg-primary text-primary-foreground'")
    expect(source).toContain("'bg-muted'")
    expect(source).toContain("'mr-auto bg-muted/70'")
    expect(source).toContain('getChatRoomMessageClassName(message, currentUserId)')
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
