import { describe, expect, test } from 'bun:test'
import {
  closeTab,
  getPersistableTabState,
  openChromeDesktopTab,
  openTab,
  resolveRenderedTabId,
} from './tab-atoms'
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

  test('Given Agent 已打开 When 打开 Chrome 预览 Then 在同一主 Tab 栏追加并激活 Chrome Tab', () => {
    const agent: TabItem = { id: 'agent-1', type: 'agent', sessionId: 'agent-1', title: 'Agent' }
    const result = openChromeDesktopTab([agent], {
      sessionId: 'agent-1',
      controlId: 'control-1',
      title: 'Chrome：Example Domain',
    })

    expect(result).toEqual({
      tabs: [
        agent,
        {
          id: '__chrome-desktop-preview__:control-1',
          type: 'chrome-desktop',
          sessionId: 'agent-1',
          title: 'Chrome：Example Domain',
          controlId: 'control-1',
        },
      ],
      activeTabId: '__chrome-desktop-preview__:control-1',
    })
  })

  test('Given Chrome 预览已打开 When 重复点击小预览 Then 复用原 Tab 不重复采集', () => {
    const first = openChromeDesktopTab(
      [{ id: 'agent-1', type: 'agent', sessionId: 'agent-1', title: 'Agent' }],
      { sessionId: 'agent-1', controlId: 'control-1', title: 'Chrome：Example Domain' },
    )
    const second = openChromeDesktopTab(first.tabs, {
      sessionId: 'agent-1',
      controlId: 'control-1',
      title: 'Chrome：Example Domain（更新）',
    })

    expect(second.tabs).toBe(first.tabs)
    expect(second.activeTabId).toBe(first.activeTabId)
  })

  test('Given Chrome 预览 Tab When 生成持久化状态 Then 仅持久化所属 Agent Tab', () => {
    const result = openChromeDesktopTab(
      [{ id: 'agent-1', type: 'agent', sessionId: 'agent-1', title: 'Agent' }],
      { sessionId: 'agent-1', controlId: 'control-1', title: 'Chrome：Example Domain' },
    )

    expect(getPersistableTabState(result.tabs, result.activeTabId)).toEqual({
      tabs: [{ id: 'agent-1', type: 'agent', sessionId: 'agent-1', title: 'Agent' }],
      activeTabId: 'agent-1',
    })
  })

  test('Given Chrome 预览 Tab 已激活 When 关闭 Tab Then 只关闭预览并回到 Agent', () => {
    const result = openChromeDesktopTab(
      [{ id: 'agent-1', type: 'agent', sessionId: 'agent-1', title: 'Agent' }],
      { sessionId: 'agent-1', controlId: 'control-1', title: 'Chrome：Example Domain' },
    )

    expect(closeTab(result.tabs, result.activeTabId, result.activeTabId)).toEqual({
      tabs: [{ id: 'agent-1', type: 'agent', sessionId: 'agent-1', title: 'Agent' }],
      activeTabId: 'agent-1',
    })
  })

  test('Given Agent 及 Chrome 预览 Tab When 关闭 Agent Then 一并移除所属预览入口', () => {
    const result = openChromeDesktopTab(
      [{ id: 'agent-1', type: 'agent', sessionId: 'agent-1', title: 'Agent' }],
      { sessionId: 'agent-1', controlId: 'control-1', title: 'Chrome：Example Domain' },
    )

    expect(closeTab(result.tabs, result.activeTabId, 'agent-1')).toEqual({
      tabs: [],
      activeTabId: null,
    })
  })
})
