/**
 * Chrome Desktop 主 Tab 状态。
 *
 * 预览 Tab 只保存当前控制会话的轻量引用，真实 MediaStream 继续由
 * chrome-desktop-atoms 在内存中统一持有，避免点击预览时重复申请采集权限。
 */

import { atom } from 'jotai'
import type { ChromeDesktopSessionState } from '@copis/shared'
import { chromeDesktopSessionStateAtom } from './chrome-desktop-atoms'
import {
  activeTabIdAtom,
  isChromeDesktopTab,
  openChromeDesktopTab,
  tabsAtom,
} from './tab-atoms'

export interface OpenChromeDesktopPreviewInput {
  sessionId: string
  controlId: string
  title: string
}

export const chromeDesktopPreviewTabAtom = atom((get) => {
  return get(tabsAtom).find(isChromeDesktopTab) ?? null
})

/** 在顶部主 Tab 栏打开或聚焦 Chrome Desktop 预览。 */
export const openChromeDesktopPreviewTabAtom = atom(
  null,
  (get, set, input: OpenChromeDesktopPreviewInput) => {
    const result = openChromeDesktopTab(get(tabsAtom), input)
    set(tabsAtom, result.tabs)
    set(activeTabIdAtom, result.activeTabId)
    return result.activeTabId
  },
)

/** 新一轮授权不能藏在旧的完整预览后面，仅切回同会话的 Agent Tab。 */
export const syncChromeDesktopSessionStateAtom = atom(
  null,
  (get, set, state: ChromeDesktopSessionState | null) => {
    set(chromeDesktopSessionStateAtom, state)
    if (state?.state !== 'awaiting_user') return

    const tabs = get(tabsAtom)
    const activeTabId = get(activeTabIdAtom)
    const activeTab = tabs.find(tab => tab.id === activeTabId)
    if (!activeTab || !isChromeDesktopTab(activeTab) || activeTab.sessionId !== state.sessionId) return

    const owner = tabs.find(tab => tab.type === 'agent' && tab.sessionId === state.sessionId)
    if (owner) set(activeTabIdAtom, owner.id)
  },
)
