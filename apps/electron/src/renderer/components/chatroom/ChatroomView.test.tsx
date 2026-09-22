import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { deleteChatRoomAndClose, getHostChatRoomPermission } from './ChatroomView'
import type { TabItem } from '@/atoms/tab-atoms'

const source = readFileSync(new URL('./ChatroomView.tsx', import.meta.url), 'utf8')

describe('聊天室房间视图契约', () => {
  test('房间按 roomId 加载消息并使用成员面板', () => {
    expect(source).toContain('getMessages(roomId')
    expect(source).toContain('<ChatroomMembersPanel')
    expect(source).toContain('<ChatroomComposer')
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

  test('权限请求在详情尚未加载时保留，成员视图不可操作', () => {
    const request = { requestId: 'p1', roomId: 'r1', roomAgentId: 'a1', invocationId: 'i1', traceId: 't1', originalSender: { type: 'user' as const, id: 'u1', displayName: '用户' }, invocationChain: [], toolName: 'Bash', summary: '执行命令', createdAt: 1, expiresAt: 2 }
    expect(getHostChatRoomPermission(undefined, [request], 'r1')).toBeUndefined()
    expect(getHostChatRoomPermission({ role: 'member' }, [request], 'r1')).toBeUndefined()
    expect(getHostChatRoomPermission({ role: 'host' }, [request], 'r1')).toEqual(request)
  })
})
