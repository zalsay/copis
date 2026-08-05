/**
 * 网页页签恢复状态存储服务。
 *
 * 只保存可重新加载的网页地址和激活页签索引，不持久化 WebContentsView 等原生对象。
 */

import type { PersistedWebTab, PersistedWebTabs } from './web-tab-session-types'
import { readJsonFileSafe, writeJsonFileAtomic } from './safe-file'
import { getWebTabsPath } from './config-paths'

const SESSION_VERSION = 1

interface PersistedWebTabsFile extends PersistedWebTabs {
  version: number
}

function emptySession(): PersistedWebTabs {
  return { tabs: [], activeTabIndex: null }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function normalizeUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const url = value.trim()
  if (url === 'about:blank') return url

  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    return parsed.toString()
  } catch {
    return null
  }
}

function readTabs(value: unknown): PersistedWebTab[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item): PersistedWebTab[] => {
    if (!isRecord(item)) return []
    const url = normalizeUrl(item.url)
    return url ? [{ url }] : []
  })
}

function normalizeActiveTabIndex(value: unknown, tabCount: number): number | null {
  return typeof value === 'number'
    && Number.isInteger(value)
    && value >= 0
    && value < tabCount
    ? value
    : null
}

/** 读取上次退出时保存的网页页签。 */
export function getPersistedWebTabs(): PersistedWebTabs {
  const raw = readJsonFileSafe<unknown>(getWebTabsPath())
  if (!isRecord(raw)) return emptySession()

  const tabs = readTabs(raw.tabs)
  return {
    tabs,
    activeTabIndex: normalizeActiveTabIndex(raw.activeTabIndex, tabs.length),
  }
}

/** 保存网页页签恢复状态。 */
export function savePersistedWebTabs(session: PersistedWebTabs): void {
  const tabs = session.tabs.flatMap((tab): PersistedWebTab[] => {
    const url = normalizeUrl(tab.url)
    return url ? [{ url }] : []
  })
  const data: PersistedWebTabsFile = {
    version: SESSION_VERSION,
    tabs,
    activeTabIndex: normalizeActiveTabIndex(session.activeTabIndex, tabs.length),
  }

  try {
    writeJsonFileAtomic(getWebTabsPath(), data)
  } catch (error) {
    console.error('[网页页签] 保存恢复状态失败:', error)
    throw new Error('保存网页页签恢复状态失败', { cause: error })
  }
}
