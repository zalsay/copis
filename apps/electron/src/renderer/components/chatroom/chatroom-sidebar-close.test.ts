import { describe, expect, test } from 'bun:test'
import type { TabItem } from '@/atoms/tab-atoms'
import { closeSidebarChatRoom, getChatRoomCloseAction } from './chatroom-sidebar-close'

const tabs: TabItem[] = [
  { id: 'chatroom:room-1', type: 'chatroom', roomId: 'room-1', title: '协作室' },
  { id: 'agent-1', type: 'agent', sessionId: 'agent-1', title: 'Agent' },
]

describe('聊天室侧栏关闭行为', () => {
  test('服务端主理人 ID 决定永久删除，不能依赖默认 member 展示角色', () => {
    expect(getChatRoomCloseAction({ roomId: 'room-1', hostUserId: '7' }, '7')).toBe('delete')
    expect(getChatRoomCloseAction({ roomId: 'room-1', hostUserId: '7' }, '8')).toBe('leave')
    expect(getChatRoomCloseAction({ roomId: '', hostUserId: '7' }, '7')).toBe('local')
  })

  test('主理人删除成功后才清理侧栏和当前聊天室标签', async () => {
    const calls: string[] = []
    await closeSidebarChatRoom({
      room: { roomId: 'room-1', hostUserId: '7' }, currentUserId: '7',
      getCurrentUserId: () => '7', isRoomCurrent: () => true,
      api: { deleteRoom: async (id) => { calls.push(`delete:${id}`) }, leaveRoom: async () => { calls.push('leave') } },
      getTabs: () => tabs, getActiveTabId: () => 'chatroom:room-1',
      removeRoom: (id) => calls.push(`remove:${id}`),
      setTabs: (next) => calls.push(`tabs:${next.map((tab) => tab.id).join(',')}`),
      setActiveTabId: (id) => calls.push(`active:${id}`),
    })
    expect(calls).toEqual(['delete:room-1', 'remove:room-1', 'tabs:agent-1', 'active:agent-1'])
  })

  test('加入成员退出成功后移除本地入口，失败时保留入口和标签', async () => {
    const calls: string[] = []
    const input = {
      room: { roomId: 'room-1', hostUserId: '7' }, currentUserId: '8', getTabs: () => tabs, getActiveTabId: () => 'chatroom:room-1',
      getCurrentUserId: () => '8', isRoomCurrent: () => true,
      api: { deleteRoom: async () => { calls.push('delete') }, leaveRoom: async (id: string) => { calls.push(`leave:${id}`) } },
      removeRoom: (id: string) => calls.push(`remove:${id}`),
      setTabs: (next: TabItem[]) => calls.push(`tabs:${next.length}`),
      setActiveTabId: (id: string | null) => calls.push(`active:${id}`),
    }
    await closeSidebarChatRoom(input)
    expect(calls).toEqual(['leave:room-1', 'remove:room-1', 'tabs:1', 'active:agent-1'])
    calls.length = 0
    await expect(closeSidebarChatRoom({ ...input, api: { ...input.api, leaveRoom: async () => { throw new Error('退出失败') } } })).rejects.toThrow('退出失败')
    expect(calls).toEqual([])
  })

  test('远端请求期间切换标签，不回退用户刚打开的其他标签', async () => {
    let finishDelete!: () => void
    const pendingDelete = new Promise<void>((resolve) => { finishDelete = resolve })
    let latestTabs: TabItem[] = tabs
    let latestActive: string | null = 'chatroom:room-1'
    const closing = closeSidebarChatRoom({
      room: { roomId: 'room-1', hostUserId: '7' }, currentUserId: '7',
      getCurrentUserId: () => '7', isRoomCurrent: () => true,
      api: { deleteRoom: async () => pendingDelete, leaveRoom: async () => undefined },
      getTabs: () => latestTabs, getActiveTabId: () => latestActive,
      removeRoom: () => undefined,
      setTabs: (next) => { latestTabs = next },
      setActiveTabId: (id) => { latestActive = id },
    })
    latestTabs = [...tabs, { id: 'agent-2', type: 'agent', sessionId: 'agent-2', title: '新标签' }]
    latestActive = 'agent-2'
    finishDelete()
    await closing
    expect(latestTabs.map((tab) => tab.id)).toEqual(['agent-1', 'agent-2'])
    expect(latestActive).toBe('agent-2')
  })

  test('确认框属于旧账号时，不在新账号下发送永久删除', async () => {
    const calls: string[] = []
    await expect(closeSidebarChatRoom({
      room: { roomId: 'room-1', hostUserId: '7' }, currentUserId: '7',
      getCurrentUserId: () => '8', isRoomCurrent: () => true,
      api: { deleteRoom: async () => { calls.push('delete') }, leaveRoom: async () => { calls.push('leave') } },
      getTabs: () => tabs, getActiveTabId: () => 'chatroom:room-1',
      removeRoom: () => calls.push('remove'), setTabs: () => calls.push('tabs'), setActiveTabId: () => calls.push('active'),
    })).rejects.toThrow('账号')
    expect(calls).toEqual([])
  })

  test('远端请求期间切换账号或移除房间，不清理新账号的本地状态', async () => {
    let finishDelete!: () => void
    const pendingDelete = new Promise<void>((resolve) => { finishDelete = resolve })
    let currentUserId = '7'
    const calls: string[] = []
    const closing = closeSidebarChatRoom({
      room: { roomId: 'room-1', hostUserId: '7' }, currentUserId: '7',
      getCurrentUserId: () => currentUserId, isRoomCurrent: () => true,
      api: { deleteRoom: async () => { calls.push('delete'); await pendingDelete }, leaveRoom: async () => { calls.push('leave') } },
      getTabs: () => tabs, getActiveTabId: () => 'chatroom:room-1',
      removeRoom: () => calls.push('remove'), setTabs: () => calls.push('tabs'), setActiveTabId: () => calls.push('active'),
    })
    currentUserId = '8'
    finishDelete()
    await closing
    expect(calls).toEqual(['delete'])
  })

  test('远端请求期间房间从当前列表消失，不清理后来打开的同名标签', async () => {
    let finishLeave!: () => void
    const pendingLeave = new Promise<void>((resolve) => { finishLeave = resolve })
    let roomCurrent = true
    const calls: string[] = []
    const closing = closeSidebarChatRoom({
      room: { roomId: 'room-1', hostUserId: '7' }, currentUserId: '8',
      getCurrentUserId: () => '8', isRoomCurrent: () => roomCurrent,
      api: { deleteRoom: async () => { calls.push('delete') }, leaveRoom: async () => { calls.push('leave'); await pendingLeave } },
      getTabs: () => tabs, getActiveTabId: () => 'chatroom:room-1',
      removeRoom: () => calls.push('remove'), setTabs: () => calls.push('tabs'), setActiveTabId: () => calls.push('active'),
    })
    roomCurrent = false
    finishLeave()
    await closing
    expect(calls).toEqual(['leave'])
  })

  test('历史空 ID 只清理本地标签，不调用远端删除或退出', async () => {
    const calls: string[] = []
    await closeSidebarChatRoom({
      room: { roomId: '' }, currentUserId: '7',
      getCurrentUserId: () => '7', isRoomCurrent: () => true,
      api: { deleteRoom: async () => { calls.push('delete') }, leaveRoom: async () => { calls.push('leave') } },
      getTabs: () => [{ id: 'chatroom:', type: 'chatroom', roomId: '', title: '旧入口' }], getActiveTabId: () => 'chatroom:',
      removeRoom: () => calls.push('remove'), setTabs: (next) => calls.push(`tabs:${next.length}`),
      setActiveTabId: (id) => calls.push(`active:${id}`),
    })
    expect(calls).toEqual(['remove', 'tabs:0', 'active:null'])
  })
})
