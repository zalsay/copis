import { describe, expect, test } from 'bun:test'
import { getPersistableTabState, openTab } from './tab-atoms'
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

  test('Given 查看使用教程 When 打开教程 Tab Then 教程入口不写入会话持久化状态', () => {
    const tutorialTab = {
      id: '__tutorial__',
      type: 'tutorial',
      sessionId: '__tutorial__',
      title: 'Copis 使用教程',
    } as unknown as TabItem

    const result = openTab(
      [{ id: 'old', type: 'agent', sessionId: 'old', title: '旧会话' }],
      tutorialTab,
    )

    expect(result).toEqual({ tabs: [tutorialTab], activeTabId: tutorialTab.id })
    expect(getPersistableTabState(result.tabs, result.activeTabId)).toEqual({
      tabs: [],
      activeTabId: null,
    })
  })
})
