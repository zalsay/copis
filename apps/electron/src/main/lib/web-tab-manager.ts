/**
 * 内嵌 Chromium 网页页签管理器。
 *
 * WebContentsView 由主进程持有，渲染进程只负责页签状态、工具栏和视图尺寸同步。
 * 每个网页创建时自动 attach Chrome DevTools Protocol，供后续自动化能力复用。
 */

import { BrowserWindow, shell, WebContentsView } from 'electron'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { WEB_IPC_CHANNELS } from '@copis/shared'
import { getPersistedWebTabs, savePersistedWebTabs } from './web-tab-session-service'
import type {
  CreateWebTabInput,
  NavigateWebTabInput,
  OpenWebBookmarksWindowInput,
  ResizeWebBookmarksWindowInput,
  SendWebTabCdpCommandInput,
  UpdateWebTabBoundsInput,
  WebTabBounds,
  WebTabState,
  WebTabsSnapshot,
} from '@copis/shared'

interface WebTabRecord {
  state: WebTabState
  view: WebContentsView
  bounds: WebTabBounds
}

interface BookmarksWindowState {
  anchorBounds: WebTabBounds
  width: number
  height: number
}

const DEFAULT_URL = 'about:blank'
const DEFAULT_TITLE = '新标签页'
const SEARCH_URL = 'https://www.google.com/search?q='

let hostWindow: BrowserWindow | null = null
let activeTabId: string | null = null
let isRestoringPersistedTabs = false
let isDisposingWebTabs = false
let bookmarksWindow: BrowserWindow | null = null
let bookmarksWindowState: BookmarksWindowState | null = null
const records = new Map<string, WebTabRecord>()

function isHostAvailable(): boolean {
  return hostWindow !== null && !hostWindow.isDestroyed()
}

function getFallbackTitle(url: string): string {
  if (url === DEFAULT_URL) return DEFAULT_TITLE

  try {
    return new URL(url).hostname || '网页'
  } catch {
    return '网页'
  }
}

function selectFaviconUrl(favicons: string[]): string | null {
  for (const favicon of favicons) {
    const normalized = favicon.trim()
    if (/^https?:\/\//i.test(normalized) || /^data:image\//i.test(normalized)) {
      return normalized
    }
  }
  return null
}

function isAllowedWebUrl(url: string): boolean {
  return /^https?:\/\//i.test(url) || url === DEFAULT_URL
}

/** 将地址栏输入转换成可导航的 HTTP(S) 地址。 */
export function normalizeWebTabUrl(input: string): string {
  const value = input.trim()
  if (!value) return DEFAULT_URL
  if (value === DEFAULT_URL) return value

  if (/^https?:\/\//i.test(value)) {
    const parsed = new URL(value)
    if (!isAllowedWebUrl(parsed.toString())) {
      throw new Error('仅支持 HTTP 或 HTTPS 网页')
    }
    return parsed.toString()
  }

  if (/^about:/i.test(value)) {
    if (value.toLowerCase() === DEFAULT_URL) return DEFAULT_URL
    throw new Error('仅支持 about:blank')
  }

  if (/^[a-z][a-z\d+.-]*:/i.test(value)) {
    throw new Error('仅支持 HTTP 或 HTTPS 网页')
  }

  if (/\s/.test(value)) {
    return `${SEARCH_URL}${encodeURIComponent(value)}`
  }

  if (/^(localhost|127(?:\.\d{1,3}){3})(:\d+)?(?:\/.*)?$/i.test(value)) {
    return `http://${value}`
  }

  return `https://${value}`
}

function getSnapshot(): WebTabsSnapshot {
  return {
    tabs: Array.from(records.values(), (record) => ({ ...record.state })),
    activeTabId,
  }
}

function persistTabs(): void {
  if (isRestoringPersistedTabs || isDisposingWebTabs) return

  const snapshot = getSnapshot()
  const activeTabIndex = snapshot.activeTabId === null
    ? null
    : snapshot.tabs.findIndex((tab) => tab.id === snapshot.activeTabId)
  try {
    savePersistedWebTabs({
      tabs: snapshot.tabs.map((tab) => ({ url: tab.url })),
      activeTabIndex: activeTabIndex !== null && activeTabIndex >= 0 ? activeTabIndex : null,
    })
  } catch (error) {
    console.error('[网页页签] 更新恢复状态失败:', error)
  }
}

function restorePersistedWebTabs(): void {
  const session = getPersistedWebTabs()
  if (session.tabs.length === 0) return

  const restoredTabIds: string[] = []
  activeTabId = null
  isRestoringPersistedTabs = true
  try {
    for (const tab of session.tabs) {
      const existingIds = new Set(records.keys())
      try {
        createWebTab({ url: tab.url, activate: false })
        const restoredId = Array.from(records.keys()).find((id) => !existingIds.has(id))
        if (restoredId) restoredTabIds.push(restoredId)
      } catch (error) {
        console.warn(`[网页页签] 恢复地址失败: ${tab.url}`, error)
      }
    }
  } finally {
    isRestoringPersistedTabs = false
  }

  if (session.activeTabIndex === null) {
    activeTabId = null
  } else {
    activeTabId = restoredTabIds[session.activeTabIndex] ?? restoredTabIds[0] ?? null
  }
  applyActiveView()
  persistTabs()
  console.log(`[网页页签] 已恢复 ${restoredTabIds.length} 个网页页签`)
}

function emitSnapshot(): void {
  if (!isHostAvailable()) return
  hostWindow!.webContents.send(WEB_IPC_CHANNELS.STATE_CHANGED, getSnapshot())
}

function refreshState(record: WebTabRecord | undefined, updates?: Partial<WebTabState>): void {
  const contents = record?.view?.webContents
  if (!record || !contents || contents.isDestroyed()) return

  record.state = {
    ...record.state,
    url: contents.getURL() || record.state.url,
    title: contents.getTitle() || record.state.title,
    canGoBack: contents.canGoBack(),
    canGoForward: contents.canGoForward(),
    ...updates,
  }
  persistTabs()
  emitSnapshot()
}

function applyActiveView(): void {
  for (const record of records.values()) {
    const isActive = record.state.id === activeTabId
    const hasBounds = record.bounds.width > 0 && record.bounds.height > 0

    if (isActive && hasBounds) {
      record.view.setBounds(record.bounds)
      record.view.setVisible(true)
    } else {
      record.view.setVisible(false)
    }
  }
}

function attachCdp(record: WebTabRecord): void {
  const cdp = record.view.webContents.debugger

  try {
    if (!cdp.isAttached()) {
      cdp.attach('1.3')
    }
    const attached = cdp.isAttached()
    record.state = { ...record.state, cdpAttached: attached }

    if (attached) {
      void cdp.sendCommand('Page.enable').catch((error: unknown) => {
        console.warn('[网页页签] 初始化 CDP Page 域失败:', error)
      })
      void cdp.sendCommand('Runtime.enable').catch((error: unknown) => {
        console.warn('[网页页签] 初始化 CDP Runtime 域失败:', error)
      })
    }
  } catch (error) {
    console.warn('[网页页签] 自动连接 CDP 失败:', error)
  }
}

function installWebContentsHandlers(record: WebTabRecord): void {
  const contents = record.view.webContents

  contents.on('did-start-loading', () => {
    refreshState(record, { isLoading: true, faviconUrl: null })
  })

  contents.on('did-stop-loading', () => {
    refreshState(record, { isLoading: false })
  })

  contents.on('page-favicon-updated', (_event, favicons) => {
    refreshState(record, { faviconUrl: selectFaviconUrl(favicons) })
  })

  contents.on('did-navigate', (_event, url) => {
    refreshState(record, { url, isLoading: false, title: getFallbackTitle(url), faviconUrl: null })
  })

  contents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
    if (isMainFrame) refreshState(record, { url })
  })

  contents.on('page-title-updated', (event, title) => {
    event.preventDefault()
    refreshState(record, { title: title || getFallbackTitle(record.state.url) })
  })

  contents.on('did-fail-load', (_event, _errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame) return
    refreshState(record, {
      url: validatedURL || record.state.url,
      title: errorDescription || '网页加载失败',
      isLoading: false,
      faviconUrl: null,
    })
  })

  contents.on('render-process-gone', () => {
    refreshState(record, { title: '网页进程已退出', isLoading: false, faviconUrl: null })
  })

  contents.on('destroyed', () => {
    if (records.get(record.state.id) !== record) return
    records.delete(record.state.id)
    if (activeTabId === record.state.id) activeTabId = null
    persistTabs()
    emitSnapshot()
  })

  contents.on('will-navigate', (event, url) => {
    if (isAllowedWebUrl(url)) return
    event.preventDefault()
    void shell.openExternal(url).catch((error: unknown) => {
      console.warn('[网页页签] 打开外部协议失败:', error)
    })
  })

  contents.setWindowOpenHandler(({ url }) => {
    if (isAllowedWebUrl(url)) {
      try {
        createWebTab({ url, activate: true })
      } catch (error) {
        console.error('[网页页签] 创建 window.open 页签失败:', error)
      }
    } else if (url) {
      void shell.openExternal(url).catch((error: unknown) => {
        console.warn('[网页页签] 打开外部协议失败:', error)
      })
    }
    return { action: 'deny' }
  })

  contents.debugger.on('detach', () => {
    if (records.get(record.state.id) !== record) return
    record.state = { ...record.state, cdpAttached: false }
    emitSnapshot()
  })
}

/** 设置承载 WebContentsView 的主窗口。 */
export function setWebTabHostWindow(window: BrowserWindow): void {
  hostWindow = window
  for (const record of records.values()) {
    hostWindow.contentView.addChildView(record.view)
  }
  if (records.size === 0) restorePersistedWebTabs()
  applyActiveView()
}

const DEFAULT_BOOKMARKS_WINDOW_WIDTH = 384
const DEFAULT_BOOKMARKS_WINDOW_HEIGHT = 480

function positionBookmarksWindow(): void {
  if (!bookmarksWindow || bookmarksWindow.isDestroyed() || !bookmarksWindowState || !isHostAvailable()) return

  const hostBounds = hostWindow!.getContentBounds()
  const { anchorBounds, width, height } = bookmarksWindowState
  const anchorX = hostBounds.x + anchorBounds.x
  const anchorY = hostBounds.y + anchorBounds.y + anchorBounds.height
  const maxX = hostBounds.x + Math.max(0, hostBounds.width - width)
  const x = Math.max(hostBounds.x, Math.min(anchorX, maxX))
  const contentBottom = hostBounds.y + hostBounds.height
  const y = anchorY + height <= contentBottom
    ? anchorY
    : Math.max(hostBounds.y, anchorY - height)

  bookmarksWindow.setContentBounds({ x: Math.round(x), y: Math.round(y), width, height })
}

/** 打开原生收藏夹浮层，确保它显示在 WebContentsView 之上。 */
export function openWebBookmarksWindow(input: OpenWebBookmarksWindowInput): void {
  if (!isHostAvailable()) return
  const { bounds } = input
  if (![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)) return

  const nextState: BookmarksWindowState = {
    anchorBounds: {
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.max(0, Math.round(bounds.width)),
      height: Math.max(0, Math.round(bounds.height)),
    },
    width: bookmarksWindowState?.width ?? DEFAULT_BOOKMARKS_WINDOW_WIDTH,
    height: bookmarksWindowState?.height ?? DEFAULT_BOOKMARKS_WINDOW_HEIGHT,
  }

  if (bookmarksWindow && !bookmarksWindow.isDestroyed()) {
    bookmarksWindowState = nextState
    positionBookmarksWindow()
    bookmarksWindow.show()
    bookmarksWindow.focus()
    return
  }

  const rendererUrl = hostWindow!.webContents.getURL()
  if (!rendererUrl) return

  const window = new BrowserWindow({
    parent: hostWindow!,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    hasShadow: true,
    useContentSize: true,
    width: nextState.width,
    height: nextState.height,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  bookmarksWindow = window
  bookmarksWindowState = nextState

  const reposition = (): void => positionBookmarksWindow()
  hostWindow!.on('resize', reposition)
  hostWindow!.on('move', reposition)
  window.on('closed', () => {
    hostWindow?.removeListener('resize', reposition)
    hostWindow?.removeListener('move', reposition)
    if (bookmarksWindow === window) {
      bookmarksWindow = null
      bookmarksWindowState = null
    }
  })
  window.on('blur', () => {
    setTimeout(() => {
      if (!window.isDestroyed() && !window.isFocused()) closeWebBookmarksWindow()
    }, 0)
  })

  positionBookmarksWindow()
  window.once('ready-to-show', () => {
    if (window.isDestroyed()) return
    positionBookmarksWindow()
    window.show()
    window.focus()
  })
  void window.loadURL((() => {
    try {
      const url = new URL(rendererUrl)
      url.searchParams.set('window', 'web-bookmarks')
      return url.toString()
    } catch {
      return rendererUrl
    }
  })()).catch((error: unknown) => {
    console.error('[网页收藏夹] 浮层窗口加载失败:', error)
    closeWebBookmarksWindow()
  })
}

/** 调整原生收藏夹浮层尺寸，避免透明窗口拦截窗口外的网页点击。 */
export function resizeWebBookmarksWindow(input: ResizeWebBookmarksWindowInput): void {
  if (!bookmarksWindow || bookmarksWindow.isDestroyed() || !bookmarksWindowState) return
  if (![input.width, input.height].every(Number.isFinite)) return

  bookmarksWindowState = {
    ...bookmarksWindowState,
    width: Math.min(640, Math.max(320, Math.ceil(input.width))),
    height: Math.min(760, Math.max(180, Math.ceil(input.height))),
  }
  positionBookmarksWindow()
}

/** 关闭原生收藏夹浮层。 */
export function closeWebBookmarksWindow(): void {
  const window = bookmarksWindow
  bookmarksWindow = null
  bookmarksWindowState = null
  if (window && !window.isDestroyed()) window.close()
}

/** 保存当前网页页签，供应用退出前调用。 */
export function saveWebTabsSession(): void {
  persistTabs()
}

/** 释放所有网页页签及原生视图。 */
export function disposeWebTabs(): void {
  closeWebBookmarksWindow()
  const currentHost = hostWindow
  hostWindow = null
  activeTabId = null

  try {
    for (const record of records.values()) {
      try {
        if (currentHost && !currentHost.isDestroyed()) {
          currentHost.contentView.removeChildView(record.view)
        }
      } catch {
        // 窗口销毁过程中移除子视图可能已经由 Electron 自动完成。
      }

      try {
        const cdp = record.view.webContents.debugger
        if (cdp.isAttached()) cdp.detach()
      } catch {
        // 网页进程可能已经退出，忽略清理阶段错误。
      }

      if (!record.view.webContents.isDestroyed()) {
        record.view.webContents.close({ waitForBeforeUnload: false })
      }
    }
  } finally {
    records.clear()
    isDisposingWebTabs = false
  }
}

/** 获取当前网页页签快照。 */
export function listWebTabs(): WebTabsSnapshot {
  return getSnapshot()
}

/** 创建并默认激活一个新的 Chromium 网页页签。 */
export function createWebTab(input: CreateWebTabInput = {}): WebTabsSnapshot {
  if (!isHostAvailable()) throw new Error('主窗口尚未准备好')

  const url = normalizeWebTabUrl(input.url ?? DEFAULT_URL)
  const view = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: true,
      partition: 'persist:copis-web',
    },
  })
  const id = `web-${randomUUID()}`
  const record: WebTabRecord = {
    state: {
      id,
      title: getFallbackTitle(url),
      url,
      isLoading: url !== DEFAULT_URL,
      faviconUrl: null,
      canGoBack: false,
      canGoForward: false,
      cdpAttached: false,
    },
    view,
    bounds: { x: 0, y: 0, width: 0, height: 0 },
  }

  records.set(id, record)
  hostWindow!.contentView.addChildView(view)
  view.setVisible(false)
  installWebContentsHandlers(record)
  attachCdp(record)

  if (input.activate !== false) activeTabId = id
  persistTabs()
  applyActiveView()
  emitSnapshot()

  if (url !== DEFAULT_URL) {
    void view.webContents.loadURL(url).catch((error: unknown) => {
      console.warn('[网页页签] 初始导航失败:', error)
      refreshState(record, { isLoading: false, title: '网页加载失败' })
    })
  }

  return getSnapshot()
}

/** 激活网页页签；传 null 返回 Copis 首页。 */
export function activateWebTab(tabId: string | null): WebTabsSnapshot {
  if (tabId !== null && !records.has(tabId)) {
    throw new Error('网页页签不存在')
  }
  activeTabId = tabId
  persistTabs()
  applyActiveView()
  emitSnapshot()
  return getSnapshot()
}

/** 关闭网页页签，并按浏览器习惯切换到相邻页签。 */
export function closeWebTab(tabId: string): WebTabsSnapshot {
  const record = records.get(tabId)
  if (!record) return getSnapshot()

  const tabIds = Array.from(records.keys())
  const tabIndex = tabIds.indexOf(tabId)
  const wasActive = activeTabId === tabId
  records.delete(tabId)

  if (wasActive) {
    activeTabId = tabIds[tabIndex - 1] ?? tabIds[tabIndex + 1] ?? null
  }

  try {
    hostWindow?.contentView.removeChildView(record.view)
  } catch {
    // 主窗口正在销毁时，Electron 会自动移除子视图。
  }

  try {
    const cdp = record.view.webContents.debugger
    if (cdp.isAttached()) cdp.detach()
  } catch {
    // 清理阶段忽略已退出网页进程的错误。
  }

  if (!record.view.webContents.isDestroyed()) record.view.webContents.close({ waitForBeforeUnload: false })
  persistTabs()
  applyActiveView()
  emitSnapshot()
  return getSnapshot()
}

/** 导航到地址栏输入的网页。 */
export function navigateWebTab(input: NavigateWebTabInput): WebTabsSnapshot {
  const record = records.get(input.tabId)
  if (!record) throw new Error('网页页签不存在')

  const url = normalizeWebTabUrl(input.url)
  record.state = {
    ...record.state,
    url,
    title: getFallbackTitle(url),
    isLoading: url !== DEFAULT_URL,
    faviconUrl: null,
    canGoBack: record.view.webContents.canGoBack(),
    canGoForward: record.view.webContents.canGoForward(),
  }
  persistTabs()
  emitSnapshot()

  void record.view.webContents.loadURL(url).catch((error: unknown) => {
    console.warn('[网页页签] 导航失败:', error)
    refreshState(record, { isLoading: false, title: '网页加载失败' })
  })
  return getSnapshot()
}

/** 同步原生网页视图尺寸。 */
export function updateWebTabBounds(input: UpdateWebTabBoundsInput): void {
  const record = records.get(input.tabId)
  if (!record) return

  const { bounds } = input
  if (![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)) return
  record.bounds = {
    x: Math.max(0, Math.round(bounds.x)),
    y: Math.max(0, Math.round(bounds.y)),
    width: Math.max(0, Math.round(bounds.width)),
    height: Math.max(0, Math.round(bounds.height)),
  }
  applyActiveView()
}

/** 后退当前网页。 */
export function goBackWebTab(tabId: string): WebTabsSnapshot {
  const record = records.get(tabId)
  if (!record) throw new Error('网页页签不存在')
  if (record.view.webContents.canGoBack()) record.view.webContents.goBack()
  return getSnapshot()
}

/** 前进当前网页。 */
export function goForwardWebTab(tabId: string): WebTabsSnapshot {
  const record = records.get(tabId)
  if (!record) throw new Error('网页页签不存在')
  if (record.view.webContents.canGoForward()) record.view.webContents.goForward()
  return getSnapshot()
}

/** 刷新当前网页。 */
export function reloadWebTab(tabId: string): WebTabsSnapshot {
  const record = records.get(tabId)
  if (!record) throw new Error('网页页签不存在')
  record.view.webContents.reload()
  return getSnapshot()
}

/** 向自动连接的 CDP 会话发送命令。 */
export async function sendWebTabCdpCommand(input: SendWebTabCdpCommandInput): Promise<unknown> {
  const record = records.get(input.tabId)
  if (!record) throw new Error('网页页签不存在')

  const cdp = record.view.webContents.debugger
  if (!cdp.isAttached()) {
    attachCdp(record)
  }
  if (!cdp.isAttached()) throw new Error('网页 CDP 未连接')
  return cdp.sendCommand(input.method, input.params)
}
