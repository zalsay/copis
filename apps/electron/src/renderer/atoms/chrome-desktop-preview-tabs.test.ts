import { describe, expect, test } from 'bun:test'
import { createStore } from 'jotai'
import {
  openChromeDesktopPreviewTabAtom,
  syncChromeDesktopSessionStateAtom,
} from './chrome-desktop-preview-tabs'
import { activeTabIdAtom, tabsAtom } from './tab-atoms'
import { chromeDesktopSessionStateAtom } from './chrome-desktop-atoms'
import type { ChromeDesktopSessionState } from '@copis/shared'

function pendingState(sessionId = 'agent-1'): ChromeDesktopSessionState {
  return {
    sessionId, controlId: 'control-new', state: 'awaiting_user', mode: 'observe',
    targetWindow: null, shortcut: 'Control+Option+Command+.', createdAt: 0,
  }
}

function previewStore() {
  const store = createStore()
  store.set(tabsAtom, [{ id: 'agent-1', type: 'agent', sessionId: 'agent-1', title: 'Agent' }])
  store.set(openChromeDesktopPreviewTabAtom, { sessionId: 'agent-1', controlId: 'control-old', title: 'Chrome' })
  return store
}

describe('Chrome Desktop 主 Tab', () => {
  test('Given 已授权的 Chrome 控制会话 When 执行打开动作 Then 写入主 Tab 并激活它', () => {
    const store = createStore()
    store.set(tabsAtom, [{ id: 'agent-1', type: 'agent', sessionId: 'agent-1', title: 'Agent' }])

    store.set(openChromeDesktopPreviewTabAtom, {
      sessionId: 'agent-1',
      controlId: 'control-1',
      title: 'Chrome：Example Domain',
    })

    expect(store.get(activeTabIdAtom)).toBe('__chrome-desktop-preview__:control-1')
    expect(store.get(tabsAtom)).toHaveLength(2)
    expect(store.get(tabsAtom)[1]).toMatchObject({
      type: 'chrome-desktop',
      controlId: 'control-1',
    })
  })
})


describe('Chrome Desktop 重新授权入口可见性', () => {
  test('Given 当前正在查看旧 Chrome 预览 Tab When 同会话再次请求授权 Then 回到所属 Agent Tab 展示新授权横幅', () => {
    const store = previewStore()
    const state = pendingState()
    store.set(syncChromeDesktopSessionStateAtom, state)
    expect(store.get(chromeDesktopSessionStateAtom)).toEqual(state)
    expect(store.get(activeTabIdAtom)).toBe('agent-1')
    // 仅切换应用内 Tab，不发起任何系统窗口激活/采集请求。
    expect(store.get(tabsAtom)).toHaveLength(2)
  })

  test('Given 正在查看其他会话 Chrome 预览 When 收到另一会话授权请求 Then 不抢占用户当前 Tab', () => {
    const store = previewStore()
    const activeId = store.get(activeTabIdAtom)
    store.set(syncChromeDesktopSessionStateAtom, pendingState('agent-other'))
    expect(store.get(activeTabIdAtom)).toBe(activeId)
  })

  test('Given 正在查看文件预览 When 请求 Chrome 授权 Then 不切换文件 Tab', () => {
    const store = previewStore()
    store.set(tabsAtom, [...store.get(tabsAtom), { id: 'file-preview', type: 'preview', sessionId: 'agent-1', title: '文件' }])
    store.set(activeTabIdAtom, 'file-preview')
    store.set(syncChromeDesktopSessionStateAtom, pendingState())
    expect(store.get(activeTabIdAtom)).toBe('file-preview')
  })

  test('Given Chrome 正常连接并显示完整预览 When 收到活跃状态广播 Then 不跳回 Agent 页', () => {
    const store = previewStore()
    const activeId = store.get(activeTabIdAtom)
    store.set(syncChromeDesktopSessionStateAtom, { ...pendingState(), state: 'active' })
    expect(store.get(activeTabIdAtom)).toBe(activeId)
  })

  test('Given 所属 Agent Tab 已关闭 When 收到授权状态 Then 不激活不存在的 Tab', () => {
    const store = previewStore()
    store.set(tabsAtom, store.get(tabsAtom).filter(tab => tab.type !== 'agent'))
    const activeId = store.get(activeTabIdAtom)
    store.set(syncChromeDesktopSessionStateAtom, pendingState())
    expect(store.get(activeTabIdAtom)).toBe(activeId)
  })
})
