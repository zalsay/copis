import { describe, expect, test } from 'bun:test'
import { closeChatRoomTab, getPersistableTabState, openChatRoomTab, openTab, resolveRenderedTabId } from './tab-atoms'
import type { TabItem } from './tab-atoms'

describe('会话入口持久化', () => {
  test('Given 历史 Scratch Tab 仍是激活入口 When 生成持久化状态 Then 过滤草稿并恢复真实会话', () => {
    const legacyScratchTab = {
      id: '__scratch-pad__',
      type: 'scratch',
      sessionId: '__scratch-pad__',
      title: '草稿',
    } as unknown as TabItem
    const agentTab: TabItem = {
      id: 'agent-1',
      type: 'agent',
      sessionId: 'agent-1',
      title: '当前会话',
    }

    expect(getPersistableTabState([legacyScratchTab, agentTab], legacyScratchTab.id)).toEqual({
      tabs: [agentTab],
      activeTabId: agentTab.id,
    })
  })

  test('Given 打开一个会话 When 创建入口 Then 只保留当前真实会话', () => {
    const result = openTab(
      [{ id: 'old', type: 'agent', sessionId: 'old', title: '旧会话' }],
      { type: 'agent', sessionId: 'agent-1', title: '新会话' },
    )

    expect(result).toEqual({
      tabs: [{ id: 'agent-1', type: 'agent', sessionId: 'agent-1', title: '新会话' }],
      activeTabId: 'agent-1',
    })
  })

  test('Given deferred 值指向已删除标签 When tabs 已更新 Then 回退到当前激活标签', () => {
    const current: TabItem = { id: 'agent-2', type: 'agent', sessionId: 'agent-2', title: '新会话' }

    expect(resolveRenderedTabId([current], 'agent-2', 'agent-1')).toBe('agent-2')
  })

  test('Given 当前激活标签也不存在 When tabs 已清空 Then 不渲染不存在的标签', () => {
    expect(resolveRenderedTabId([], 'agent-1', 'agent-1')).toBeNull()
  })

  test('Given 查看使用教程 When 打开教程 Tab Then 教程入口不写入会话持久化状态', () => {
    const tutorialTab = {
      id: '__tutorial__',
      type: 'tutorial',
      sessionId: '__tutorial__',
      title: 'Copis 使用教程',
    } as unknown as TabItem

    const result = openTab(
      [{ id: 'old', type: 'agent', sessionId: 'old', title: '旧会话' }],
      tutorialTab as Extract<TabItem, { type: 'tutorial' }>,
    )

    expect(result).toEqual({ tabs: [tutorialTab], activeTabId: tutorialTab.id })
    expect(getPersistableTabState(result.tabs, result.activeTabId)).toEqual({
      tabs: [],
      activeTabId: null,
    })
  })

  test('Given Agent 和项目 Tab 已存在 When 打开聊天室 Then 保留原 Tab 且按 roomId 聚焦复用', () => {
    const agent: TabItem = { id: 'agent-1', type: 'agent', sessionId: 'agent-1', title: 'Agent' }
    const project: TabItem = { id: 'preview-1', type: 'preview', sessionId: 'agent-1', title: '项目' }
    const first = openChatRoomTab([agent, project], { roomId: 'room-1', name: '讨论' })
    expect(first.tabs).toHaveLength(3)
    expect(first.tabs[0]).toEqual(agent)
    expect(first.tabs[1]).toEqual(project)
    expect(first.activeTabId).toBe('chatroom:room-1')
    const second = openChatRoomTab(first.tabs, { roomId: 'room-1', name: '讨论' })
    expect(second.tabs).toBe(first.tabs)
    expect(second.activeTabId).toBe(first.activeTabId)
  })

  test('删除聊天室关闭对应 Tab 并选择相邻 fallback', () => {
    const agent: TabItem = { id: 'agent-1', type: 'agent', sessionId: 'agent-1', title: 'Agent' }
    const first = openChatRoomTab([agent], { roomId: 'room-1', name: '讨论' })
    const tabs = [...first.tabs, { id: 'chatroom:room-2', type: 'chatroom' as const, roomId: 'room-2', title: '另一个' }]
    const result = closeChatRoomTab(tabs, first.activeTabId, 'room-1')
    expect(result.tabs.map((tab) => tab.id)).toEqual(['agent-1', 'chatroom:room-2'])
    expect(result.activeTabId).toBe('chatroom:room-2')
  })
})
