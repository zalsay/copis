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
import { httpApiPortArgument, httpApiWebTokenArgument } from './http-api-web-token'
import { moveWebTab } from './web-tab-order'
import { createWebTabWindowOpenHandler, installNativeWebPopupWindow } from './web-tab-native-popup'
import { createWebTabJavascriptDialogBridge } from './web-tab-javascript-dialog'
import type { WebTabJavascriptDialogBridge } from './web-tab-javascript-dialog'
import type {
  CreateWebTabInput,
  NavigateWebTabInput,
  OpenWebBookmarksWindowInput,
  ReorderWebTabInput,
  ResizeWebBookmarksWindowInput,
  UpdateWebTabBoundsInput,
  WebTabBounds,
  WebTabState,
  WebTabsSnapshot,
} from '@copis/shared'

interface WebTabRecord {
  state: WebTabState
  view: WebContentsView
  bounds: WebTabBounds
  isIncognito: boolean
  hasOpenedAddress: boolean
  workflowOwned?: boolean
  workflowVisible?: boolean
  mainFrameLoadError?: string
  faviconRequestId: number
  partition: string
  javascriptDialogBridge?: WebTabJavascriptDialogBridge
  cdpDetachListeners: Set<(reason: string) => void>
  cdpDetachHandler?: (event: Electron.Event, reason: string) => void
}

interface BookmarksWindowState {
  anchorBounds: WebTabBounds
  width: number
  height: number
}

const DEFAULT_URL = 'about:blank'
const DEFAULT_TITLE = '新标签页'
const SEARCH_URL = 'https://www.google.com/search?q='
const MAX_WEB_TAB_FAVICON_BYTES = 512 * 1024
const FAVICON_ACCEPT_HEADER = 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8'

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

interface WebTabFaviconResponse {
  ok: boolean
  headers: { get(name: string): string | null }
  arrayBuffer(): Promise<ArrayBuffer>
}

type WebTabFaviconFetch = (url: string, init: RequestInit) => Promise<WebTabFaviconResponse>

function normalizeDataImageUrl(value: string): string | null {
  const normalized = value.trim()
  const separatorIndex = normalized.indexOf(',')
  if (separatorIndex <= 5) return null

  const metadata = normalized.slice(5, separatorIndex)
  const [mimeType, ...parameters] = metadata.split(';')
  const normalizedMimeType = mimeType?.trim()
  if (!normalizedMimeType || !/^image\/[a-z0-9.+-]+$/i.test(normalizedMimeType)) return null

  const payload = normalized.slice(separatorIndex + 1)
  try {
    const byteLength = parameters.some((parameter) => parameter.trim().toLowerCase() === 'base64')
      ? Buffer.from(payload, 'base64').byteLength
      : Buffer.byteLength(decodeURIComponent(payload))
    return byteLength > 0 && byteLength <= MAX_WEB_TAB_FAVICON_BYTES ? normalized : null
  } catch {
    return null
  }
}

function getImageMimeType(contentType: string | null): string | null {
  const mimeType = contentType?.split(';', 1)[0]?.trim().toLowerCase()
  return mimeType && /^image\/[a-z0-9.+-]+$/.test(mimeType) ? mimeType : null
}

/**
 * 使用网页自身的 Session 读取 favicon，避免渲染进程跨会话请求时丢失 Cookie 或 Referer。
 */
export async function resolveWebTabFaviconDataUrl(
  favicons: string[],
  fetchFavicon: WebTabFaviconFetch,
  pageUrl: string,
): Promise<string | null> {
  for (const favicon of favicons) {
    const normalized = favicon.trim()
    const dataImageUrl = normalizeDataImageUrl(normalized)
    if (dataImageUrl) return dataImageUrl
    if (!/^https?:\/\//i.test(normalized)) continue

    try {
      const response = await fetchFavicon(normalized, {
        redirect: 'follow',
        referrer: isHttpWebUrl(pageUrl) ? pageUrl : undefined,
        credentials: 'include',
        headers: { Accept: FAVICON_ACCEPT_HEADER },
      })
      if (!response.ok) continue

      const mimeType = getImageMimeType(response.headers.get('content-type'))
      if (!mimeType) continue

      const declaredSize = Number(response.headers.get('content-length'))
      if (Number.isFinite(declaredSize) && declaredSize > MAX_WEB_TAB_FAVICON_BYTES) continue

      const icon = Buffer.from(await response.arrayBuffer())
      if (icon.byteLength === 0 || icon.byteLength > MAX_WEB_TAB_FAVICON_BYTES) continue
      return `data:${mimeType};base64,${icon.toString('base64')}`
    } catch {
      // 单个候选图标失败后继续尝试页面提供的其他候选。
    }
  }
  return null
}

/**
 * 主框架加载生命周期事件对 favicon 的纯状态转换，便于单元测试。
 *
 * 事件顺序约束：
 * 1. 刷新或同页面加载时，Chromium 通常不重复派发 page-favicon-updated，loading-started 不应清空已有图标；
 * 2. 导航已加载页签时，Chromium 可能在 did-navigate 之前或之后触发 page-favicon-updated，各阶段均应保留有效图标；
 * 3. 页面加载失败或异常崩溃时，由错误处理例程负责显式清空图标。
 */
export type WebTabFaviconLifecycleEvent =
  | { type: 'loading-started' }
  | { type: 'favicon-updated'; favicons: string[] }
  | { type: 'navigation-committed' }

export function resolveWebTabFaviconUrl(
  previous: string | null,
  event: WebTabFaviconLifecycleEvent,
): string | null {
  switch (event.type) {
    case 'loading-started':
      return previous
    case 'favicon-updated':
      return selectFaviconUrl(event.favicons)
    case 'navigation-committed':
      return previous
  }
}

function isAllowedWebUrl(url: string): boolean {
  return /^https?:\/\//i.test(url) || url === DEFAULT_URL
}

function isHttpWebUrl(url: string): boolean {
  return /^https?:\/\//i.test(url)
}

function canActivateIncognito(record: WebTabRecord): boolean {
  return !record.workflowOwned
    && !record.isIncognito
    && !record.hasOpenedAddress
    && record.state.url === DEFAULT_URL
}

function getPublicState(record: WebTabRecord): WebTabState {
  return {
    ...record.state,
    isIncognito: record.isIncognito,
    canActivateIncognito: canActivateIncognito(record),
  }
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
    tabs: Array.from(records.values())
      .filter((record) => !record.workflowOwned)
      .map((record) => getPublicState(record)),
    activeTabId,
  }
}

function persistTabs(): void {
  if (isRestoringPersistedTabs || isDisposingWebTabs) return

  const snapshot = getSnapshot()
  const tabs = snapshot.tabs.filter((tab) => !tab.isIncognito)
  const activeTabIndex = snapshot.activeTabId === null
    ? null
    : tabs.findIndex((tab) => tab.id === snapshot.activeTabId)
  try {
    savePersistedWebTabs({
      tabs: tabs.map((tab) => ({ url: tab.url })),
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
  if (record.workflowOwned) {
    if (record.workflowVisible) applyActiveView()
    return
  }
  persistTabs()
  emitSnapshot()
}

function applyActiveView(): void {
  for (const record of records.values()) {
    if (record.workflowOwned) {
      const hasBounds = record.bounds.width > 0 && record.bounds.height > 0
      record.view.setVisible(Boolean(record.workflowVisible && hasBounds))
      if (record.workflowVisible && hasBounds) record.view.setBounds(record.bounds)
      continue
    }
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
  if (record.cdpDetachHandler) {
    cdp.removeListener('detach', record.cdpDetachHandler)
    record.cdpDetachHandler = undefined
  }

  const detachHandler = (_event: Electron.Event, reason: string): void => {
    for (const listener of record.cdpDetachListeners) listener(reason)
  }
  cdp.on('detach', detachHandler)
  record.cdpDetachHandler = detachHandler
  try {
    if (!cdp.isAttached()) cdp.attach('1.3')
  } catch (error) {
    console.warn('[网页页签] 自动连接 CDP 失败:', error)
  }
}

function detachCdp(record: WebTabRecord): void {
  const cdp = record.view.webContents.debugger
  if (record.cdpDetachHandler) {
    cdp.removeListener('detach', record.cdpDetachHandler)
    record.cdpDetachHandler = undefined
  }
  if (cdp.isAttached()) {
    try {
      cdp.detach()
    } catch {
      // 忽略已销毁视图的断开异常
    }
  }
}

function disposeJavascriptDialogBridge(record: WebTabRecord): void {
  const bridge = record.javascriptDialogBridge
  record.javascriptDialogBridge = undefined
  bridge?.dispose()
}

function startJavascriptDialogBridge(record: WebTabRecord): void {
  if (record.workflowOwned || record.javascriptDialogBridge) return
  const cdp = record.view.webContents.debugger
  const subscribe = (listener: (method: string, params: Record<string, unknown>) => void): (() => void) => {
    const handler = (_event: Electron.Event, method: string, params: Record<string, unknown>): void => listener(method, params)
    cdp.on('message', handler)
    return () => cdp.removeListener('message', handler)
  }
  const subscribeDetach = (listener: (reason: string) => void): (() => void) => {
    const handler = (_event: Electron.Event, reason: string): void => listener(reason)
    cdp.on('detach', handler)
    return () => cdp.removeListener('detach', handler)
  }
  const bridge = createWebTabJavascriptDialogBridge({
    hostWindow,
    debugger: cdp,
    attach: () => attachCdp(record),
    sendCommand: (method, params) => cdp.sendCommand(method, params),
    subscribe,
    subscribeDetach,
    isDestroyed: () => record.view.webContents.isDestroyed(),
  })
  record.javascriptDialogBridge = bridge
  void bridge.start().catch((error: unknown) => {
    console.warn('[网页对话框] 启动 CDP bridge 失败:', error)
  })
}

function installWebContentsHandlers(record: WebTabRecord): void {
  const contents = record.view.webContents

  contents.on('did-start-loading', () => {
    record.mainFrameLoadError = undefined
    record.faviconRequestId += 1
    refreshState(record, {
      isLoading: true,
      faviconUrl: resolveWebTabFaviconUrl(record.state.faviconUrl, { type: 'loading-started' }),
    })
  })

  contents.on('did-stop-loading', () => {
    refreshState(record, { isLoading: false })
  })

  contents.on('page-favicon-updated', (_event, favicons) => {
    const requestId = ++record.faviconRequestId
    const pageUrl = contents.getURL() || record.state.url
    void resolveWebTabFaviconDataUrl(
      favicons,
      (url, init) => contents.session.fetch(url, init),
      pageUrl,
    ).then((faviconUrl) => {
      if (
        records.get(record.state.id) !== record
        || record.view.webContents !== contents
        || contents.isDestroyed()
        || record.faviconRequestId !== requestId
      ) {
        return
      }
      refreshState(record, { faviconUrl })
    })
  })

  contents.on('did-navigate', (_event, url) => {
    if (isHttpWebUrl(url)) record.hasOpenedAddress = true
    refreshState(record, {
      url,
      isLoading: false,
      title: getFallbackTitle(url),
      faviconUrl: resolveWebTabFaviconUrl(record.state.faviconUrl, { type: 'navigation-committed' }),
    })
    emitWebTabLifecycle({ type: 'navigated', tabId: record.state.id, workflowOwned: record.workflowOwned, url, snapshot: getSnapshot() })
  })

  contents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
    if (isMainFrame) {
      if (isHttpWebUrl(url)) record.hasOpenedAddress = true
      refreshState(record, { url })
      emitWebTabLifecycle({ type: 'navigated', tabId: record.state.id, workflowOwned: record.workflowOwned, url, snapshot: getSnapshot() })
    }
  })

  contents.on('page-title-updated', (event, title) => {
    event.preventDefault()
    refreshState(record, { title: title || getFallbackTitle(record.state.url) })
  })

  contents.on('did-fail-load', (_event, _errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame) return
    record.mainFrameLoadError = errorDescription || '网页加载失败'
    record.faviconRequestId += 1
    refreshState(record, {
      url: validatedURL || record.state.url,
      title: errorDescription || '网页加载失败',
      isLoading: false,
      faviconUrl: null,
    })
  })

  contents.on('render-process-gone', () => {
    record.faviconRequestId += 1
    refreshState(record, { title: '网页进程已退出', isLoading: false, faviconUrl: null })
  })

  contents.on('destroyed', () => {
    if (records.get(record.state.id) !== record || record.view.webContents !== contents) return
    disposeJavascriptDialogBridge(record)
    records.delete(record.state.id)
    if (!record.workflowOwned && activeTabId === record.state.id) activeTabId = null
    if (!record.workflowOwned) {
      persistTabs()
      emitSnapshot()
    } else if (record.workflowVisible) {
      applyActiveView()
    }
    emitWebTabLifecycle({ type: 'closed', tabId: record.state.id, workflowOwned: record.workflowOwned, snapshot: getSnapshot() })
  })

  contents.on('will-navigate', (event, url) => {
    if (isAllowedWebUrl(url)) return
    event.preventDefault()
    void shell.openExternal(url).catch((error: unknown) => {
      console.warn('[网页页签] 打开外部协议失败:', error)
    })
  })

  const nativePopupContext = {
    getHostWindow: () => hostWindow,
    openExternal: (url: string) => shell.openExternal(url),
    logExternalFailure: (error: unknown) => {
      console.warn('[网页页签] 打开外部协议失败:', error)
    },
  }
  contents.setWindowOpenHandler(createWebTabWindowOpenHandler(nativePopupContext, contents))
  contents.on('did-create-window', (window) => {
    installNativeWebPopupWindow({
      ...nativePopupContext,
      window,
      opener: contents,
    })
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
      additionalArguments: [httpApiWebTokenArgument(), httpApiPortArgument()],
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

function clearIncognitoSession(record: WebTabRecord): void {
  if (!record.isIncognito) return
  let clearStorageData: Promise<void> | void
  try {
    clearStorageData = record.view.webContents.session.clearStorageData()
  } catch (error) {
    console.warn('[网页页签] 清理无痕 Session 失败:', error)
    return
  }
  void Promise.resolve(clearStorageData).catch((error: unknown) => {
    console.warn('[网页页签] 清理无痕 Session 失败:', error)
  })
}

/** 保存当前网页页签，供应用退出前调用。 */
export function saveWebTabsSession(): void {
  persistTabs()
}

/** 释放所有网页页签及原生视图。 */
export function disposeWebTabs(): void {
  isDisposingWebTabs = true
  closeWebBookmarksWindow()
  const currentHost = hostWindow
  hostWindow = null
  activeTabId = null

  try {
    for (const record of records.values()) {
      clearIncognitoSession(record)
      disposeJavascriptDialogBridge(record)
      try {
        if (currentHost && !currentHost.isDestroyed()) {
          currentHost.contentView.removeChildView(record.view)
        }
      } catch {
        // 窗口销毁过程中移除子视图可能已经由 Electron 自动完成。
      }

      try {
        const cdp = record.view.webContents.debugger
        if (record.cdpDetachHandler) cdp.removeListener('detach', record.cdpDetachHandler)
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

export interface WebTabLifecycleEvent {
  type: 'created' | 'activated' | 'closed' | 'navigated' | 'recreated'
  tabId: string
  openerTabId?: string
  workflowOwned?: boolean
  url?: string
  snapshot: WebTabsSnapshot
}

const webTabLifecycleListeners = new Set<(event: WebTabLifecycleEvent) => void>()

export function subscribeWebTabLifecycle(listener: (event: WebTabLifecycleEvent) => void): () => void {
  webTabLifecycleListeners.add(listener)
  return () => webTabLifecycleListeners.delete(listener)
}

function emitWebTabLifecycle(event: WebTabLifecycleEvent): void {
  for (const listener of webTabLifecycleListeners) listener(event)
}

/** 获取当前网页页签快照。 */
export function listWebTabs(): WebTabsSnapshot {
  return getSnapshot()
}

function normalizeWebTabPartition(partition: string | undefined): string {
  if (partition === 'persist:copis-web') return partition
  const prefix = 'persist:copis-workflow-'
  if (partition?.startsWith(prefix) && /^[a-zA-Z0-9_-]+$/.test(partition.slice(prefix.length))) return partition
  return 'persist:copis-web'
}

function createWebTabView(partition: string): WebContentsView {
  return new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: true,
      partition,
    },
  })
}

/** 创建网页 WebContentsView；Workflow-owned 视图不进入用户页签和持久化会话。 */
function createWebTabInternal(input: CreateWebTabInput, workflowOwned: boolean, openerTabId?: string): WebTabRecord {
  if (!isHostAvailable()) throw new Error('主窗口尚未准备好')

  const url = normalizeWebTabUrl(input.url ?? DEFAULT_URL)
  const isIncognito = input.incognito === true
  const partition = isIncognito
    ? `copis-incognito-${randomUUID()}`
    : normalizeWebTabPartition(input.partition)
  const view = createWebTabView(partition)
  const id = `web-${randomUUID()}`
  const showWorkflowForE2E = workflowOwned && process.env.COPIS_BROWSER_WORKFLOW_E2E_VISIBLE === '1'
  const record: WebTabRecord = {
    state: {
      id,
      title: getFallbackTitle(url),
      url,
      faviconUrl: null,
      isLoading: url !== DEFAULT_URL,
      canGoBack: false,
      canGoForward: false,
      isIncognito,
      canActivateIncognito: false,
    },
    view,
    bounds: { x: 0, y: 0, width: 0, height: 0 },
    isIncognito,
    hasOpenedAddress: isHttpWebUrl(url),
    workflowOwned,
    workflowVisible: showWorkflowForE2E,
    faviconRequestId: 0,
    partition,
    cdpDetachListeners: new Set(),
  }

  record.state.canActivateIncognito = canActivateIncognito(record)

  records.set(id, record)
  if (showWorkflowForE2E && activeTabId) {
    const activeRecord = records.get(activeTabId)
    if (activeRecord) record.bounds = { ...activeRecord.bounds }
  }
  try {
    hostWindow!.contentView.addChildView(view)
    view.setVisible(false)
    installWebContentsHandlers(record)
    startJavascriptDialogBridge(record)
  } catch (error) {
    disposeJavascriptDialogBridge(record)
    records.delete(id)
    try {
      hostWindow!.contentView.removeChildView(view)
    } catch {
      // 创建回滚时视图可能尚未挂载。
    }
    try {
      const cdp = view.webContents.debugger
      if (cdp.isAttached()) cdp.detach()
    } catch {
      // 创建回滚时忽略已退出视图的 CDP 清理错误。
    }
    if (!view.webContents.isDestroyed()) view.webContents.close({ waitForBeforeUnload: false })
    throw error
  }

  if (!workflowOwned && input.activate !== false) activeTabId = id
  persistTabs()
  applyActiveView()
  if (!workflowOwned) emitSnapshot()
  emitWebTabLifecycle({ type: 'created', tabId: id, openerTabId, workflowOwned, snapshot: getSnapshot() })
  if (!workflowOwned && input.activate !== false) emitWebTabLifecycle({ type: 'activated', tabId: id, snapshot: getSnapshot() })

  if (url !== DEFAULT_URL) {
    void view.webContents.loadURL(url).catch((error: unknown) => {
      record.mainFrameLoadError = error instanceof Error ? error.message : '网页加载失败'
      console.warn('[网页页签] 初始导航失败:', error)
      refreshState(record, { isLoading: false, title: '网页加载失败' })
    })
  }

  return record
}

/** 创建并默认激活一个新的 Chromium 网页页签。 */
export function createWebTab(input: CreateWebTabInput = {}): WebTabsSnapshot {
  createWebTabInternal(input, false)
  return getSnapshot()
}

/** 创建仅供固定 Workflow 使用的隔离网页视图，不出现在用户页签或恢复文件中。 */
export function createWorkflowWebTab(input: CreateWebTabInput = {}): WebTabState {
  const record = createWebTabInternal({ ...input, activate: false }, true)
  return getPublicState(record)
}

/** 关闭 Workflow-owned 网页视图并释放 CDP。 */
export function closeWorkflowWebTab(tabId: string): void {
  const record = records.get(tabId)
  if (!record || !record.workflowOwned) return
  records.delete(tabId)
  clearIncognitoSession(record)
  disposeJavascriptDialogBridge(record)
  try {
    hostWindow?.contentView.removeChildView(record.view)
  } catch {
    // 主窗口正在销毁时，Electron 会自动移除子视图。
  }
  try {
    const cdp = record.view.webContents.debugger
    if (record.cdpDetachHandler) cdp.removeListener('detach', record.cdpDetachHandler)
    if (cdp.isAttached()) cdp.detach()
  } catch {
    // 清理阶段忽略已退出网页进程的错误。
  }
  if (!record.view.webContents.isDestroyed()) record.view.webContents.close({ waitForBeforeUnload: false })
  applyActiveView()
}

/** 将失败的 Workflow 专用页面提升为普通网页页签，供当前 Agent 重新观察和操作。 */
export function promoteWorkflowWebTab(tabId: string): WebTabState {
  const record = records.get(tabId)
  if (!record?.workflowOwned) throw new Error('Workflow 失败页面不存在或不能接管')
  const activeRecord = activeTabId ? records.get(activeTabId) : undefined
  if (activeRecord && !activeRecord.workflowOwned) record.bounds = { ...activeRecord.bounds }
  record.workflowOwned = false
  record.workflowVisible = false
  startJavascriptDialogBridge(record)
  activeTabId = tabId
  persistTabs()
  applyActiveView()
  emitSnapshot()
  emitWebTabLifecycle({ type: 'activated', tabId, snapshot: getSnapshot() })
  return getPublicState(record)
}

export function activateWebTab(tabId: string | null): WebTabsSnapshot {
  if (tabId !== null && !records.has(tabId)) {
    throw new Error('网页页签不存在')
  }
  activeTabId = tabId
  persistTabs()
  applyActiveView()
  emitSnapshot()
  if (tabId) emitWebTabLifecycle({ type: 'activated', tabId, snapshot: getSnapshot() })
  return getSnapshot()
}

/** 按公开页签顺序移动网页 Tab，并在拖动结束后激活它。 */
export function reorderWebTab(input: ReorderWebTabInput): WebTabsSnapshot {
  const record = records.get(input.tabId)
  if (!record || record.workflowOwned) throw new Error('网页页签不存在')

  const publicRecords = Array.from(records.values()).filter((item) => !item.workflowOwned)
  const fromIndex = publicRecords.findIndex((item) => item.state.id === input.tabId)
  if (!Number.isInteger(input.targetIndex) || input.targetIndex < 0 || input.targetIndex >= publicRecords.length) {
    throw new Error('网页页签目标位置无效')
  }

  const reorderedRecords = moveWebTab(publicRecords, fromIndex, input.targetIndex)
  const workflowRecords = Array.from(records.values()).filter((item) => item.workflowOwned)
  records.clear()
  for (const nextRecord of reorderedRecords) records.set(nextRecord.state.id, nextRecord)
  for (const workflowRecord of workflowRecords) records.set(workflowRecord.state.id, workflowRecord)

  activeTabId = input.tabId
  persistTabs()
  applyActiveView()
  emitSnapshot()
  emitWebTabLifecycle({ type: 'activated', tabId: input.tabId, snapshot: getSnapshot() })
  return getSnapshot()
}

/** 将尚未访问地址的普通空白页签切换为独立无痕 Session。 */
export function activateWebTabIncognito(tabId: string): WebTabsSnapshot {
  const record = records.get(tabId)
  if (!record) throw new Error('网页页签不存在')
  if (!canActivateIncognito(record)) throw new Error('当前网页页签不能切换为无痕模式')

  const previousView = record.view
  const partition = `copis-incognito-${randomUUID()}`
  const nextView = createWebTabView(partition)
  const nextRecord: WebTabRecord = {
    ...record,
    state: {
      ...record.state,
      isIncognito: true,
      canActivateIncognito: false,
    },
    view: nextView,
    isIncognito: true,
    partition,
    javascriptDialogBridge: undefined,
    cdpDetachHandler: undefined,
  }

  try {
    hostWindow!.contentView.addChildView(nextView)
    nextView.setVisible(false)
    installWebContentsHandlers(nextRecord)
    startJavascriptDialogBridge(nextRecord)
    if (previousView.webContents.debugger.isAttached()) {
      attachCdp(nextRecord)
    }
  } catch (error) {
    clearIncognitoSession(nextRecord)
    disposeJavascriptDialogBridge(nextRecord)
    try {
      hostWindow!.contentView.removeChildView(nextView)
    } catch {
      // 新视图未完整挂载时忽略移除错误。
    }
    try {
      const cdp = nextView.webContents.debugger
      if (cdp.isAttached()) cdp.detach()
    } catch {
      // 新视图初始化失败时忽略 CDP 清理错误。
    }
    if (!nextView.webContents.isDestroyed()) nextView.webContents.close({ waitForBeforeUnload: false })
    throw error
  }

  records.set(tabId, nextRecord)
  try {
    hostWindow!.contentView.removeChildView(previousView)
  } catch {
    // 主窗口正在销毁时，Electron 会自动移除旧视图。
  }
  try {
    const cdp = previousView.webContents.debugger
    if (record.cdpDetachHandler) cdp.removeListener('detach', record.cdpDetachHandler)
    if (cdp.isAttached()) cdp.detach()
  } catch {
    // 旧网页进程可能已经退出，忽略替换阶段清理错误。
  }
  disposeJavascriptDialogBridge(record)
  if (!previousView.webContents.isDestroyed()) previousView.webContents.close({ waitForBeforeUnload: false })

  persistTabs()
  applyActiveView()
  emitSnapshot()
  emitWebTabLifecycle({ type: 'recreated', tabId, snapshot: getSnapshot() })
  return getSnapshot()
}

/** 关闭网页页签，并按浏览器习惯切换到相邻页签。 */
export function closeWebTab(tabId: string): WebTabsSnapshot {
  const record = records.get(tabId)
  if (!record) return getSnapshot()

  const tabIds = Array.from(records.values())
    .filter((item) => !item.workflowOwned)
    .map((item) => item.state.id)
  const tabIndex = tabIds.indexOf(tabId)
  const wasActive = activeTabId === tabId
  records.delete(tabId)

  if (wasActive) {
    activeTabId = tabIds[tabIndex - 1] ?? tabIds[tabIndex + 1] ?? null
  }

  clearIncognitoSession(record)
  disposeJavascriptDialogBridge(record)

  try {
    hostWindow?.contentView.removeChildView(record.view)
  } catch {
    // 主窗口正在销毁时，Electron 会自动移除子视图。
  }

  try {
    const cdp = record.view.webContents.debugger
    if (record.cdpDetachHandler) cdp.removeListener('detach', record.cdpDetachHandler)
    if (cdp.isAttached()) cdp.detach()
  } catch {
    // 清理阶段忽略已退出网页进程的错误。
  }

  if (!record.view.webContents.isDestroyed()) record.view.webContents.close({ waitForBeforeUnload: false })
  persistTabs()
  applyActiveView()
  emitSnapshot()
  emitWebTabLifecycle({ type: 'closed', tabId, snapshot: getSnapshot() })
  return getSnapshot()
}

/** 导航到地址栏输入的网页。 */
export function navigateWebTab(input: NavigateWebTabInput): WebTabsSnapshot {
  const record = records.get(input.tabId)
  if (!record) throw new Error('网页页签不存在')

  const url = normalizeWebTabUrl(input.url)
  if (isHttpWebUrl(url)) record.hasOpenedAddress = true
  record.mainFrameLoadError = undefined
  record.faviconRequestId += 1
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
    record.mainFrameLoadError = error instanceof Error ? error.message : '网页加载失败'
    console.warn('[网页页签] 导航失败:', error)
    refreshState(record, { isLoading: false, title: '网页加载失败' })
  })
  return getSnapshot()
}

/** 等待当前页签最近一次主框架导航完成，Workflow 不直接操作未完成或失败的页面。 */
export async function waitForWebTabLoad(tabId: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
  const record = records.get(tabId)
  if (!record) throw new Error('网页页签不存在')
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error('Browser Workflow 已取消')
    const current = records.get(tabId)
    if (!current) throw new Error('网页页签不存在')
    if (current.mainFrameLoadError) throw new Error(`网页加载失败: ${current.mainFrameLoadError}`)
    if (!current.state.isLoading) {
      // did-stop-loading 可能先于 loadURL rejection 到达，留出一个 macrotask 让失败标记落盘。
      await new Promise((resolve) => setTimeout(resolve, 100))
      const settled = records.get(tabId)
      if (!settled) throw new Error('网页页签不存在')
      if (settled.mainFrameLoadError) throw new Error(`网页加载失败: ${settled.mainFrameLoadError}`)
      if (!settled.state.isLoading) return
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('等待网页加载超时')
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
  if (record.workflowOwned) {
    if (record.workflowVisible) applyActiveView()
    return
  }
  for (const workflowRecord of records.values()) {
    if (workflowRecord.workflowOwned && workflowRecord.workflowVisible) {
      workflowRecord.bounds = { ...record.bounds }
    }
  }
  applyActiveView()
}

/** 让 Workflow-owned 页面临时显示在当前用户网页区域，供人工检查点操作。 */
export function setWorkflowWebTabVisible(tabId: string, visible: boolean): void {
  const record = records.get(tabId)
  if (!record?.workflowOwned) return
  record.workflowVisible = visible
  if (visible) {
    const activeRecord = activeTabId ? records.get(activeTabId) : undefined
    if (activeRecord && !activeRecord.workflowOwned) record.bounds = { ...activeRecord.bounds }
  }
  applyActiveView()
}

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

interface WebTabCdpCommandInput {
  tabId: string
  method: string
  params?: Record<string, unknown>
}

export type WebTabCdpEventListener = (method: string, params: Record<string, unknown>) => void

export type WebTabCdpDetachListener = (reason: string) => void

/** 订阅主进程内部 CDP 会话断开事件；不通过 IPC 暴露。 */
export function subscribeWebTabCdpDetach(tabId: string, listener: WebTabCdpDetachListener): () => void {
  const record = records.get(tabId)
  if (!record) return () => undefined
  record.cdpDetachListeners.add(listener)
  return () => record.cdpDetachListeners.delete(listener)
}

/** 获取主进程持有的网页页签状态，供 Workflow 服务绑定页面。 */
export function getWebTabLoadError(tabId: string): string | undefined {
  return records.get(tabId)?.mainFrameLoadError
}

export function getWebTabState(tabId: string): WebTabState | undefined {
  const record = records.get(tabId)
  return record ? getPublicState(record) : undefined
}

/** 获取指定 WebContentsView 的 CDP target ID，供主进程生成的 Workflow 脚本精确选页。 */
export async function getWebTabCdpTargetId(tabId: string): Promise<string> {
  const record = records.get(tabId)
  if (!record) throw new Error('网页页签不存在')
  const targetId = record.view.webContents.getOrCreateDevToolsTargetId()
  if (typeof targetId !== 'string' || !targetId.trim()) {
    throw new Error('网页 CDP target ID 不可用')
  }
  return targetId
}

/** 订阅指定网页页签的 CDP 事件；监听器只在主进程内部使用。 */
export function subscribeWebTabCdpEvents(tabId: string, listener: WebTabCdpEventListener): () => void {
  const record = records.get(tabId)
  if (!record) throw new Error('网页页签不存在')
  const handler = (_event: Electron.Event, method: string, params: Record<string, unknown>): void => {
    listener(method, params)
  }
  record.view.webContents.debugger.on('message', handler)
  return () => {
    record.view.webContents.debugger.removeListener('message', handler)
  }
}

/** 仅供真实 Electron E2E 触发 CDP detach；生产 IPC 不暴露该能力。 */
export function detachWebTabCdpForTest(tabId: string): void {
  if (process.env.COPIS_BROWSER_WORKFLOW_E2E !== '1') throw new Error('E2E CDP 操作未启用')
  const record = records.get(tabId)
  if (!record) throw new Error('网页页签不存在')
  const cdp = record.view.webContents.debugger
  if (cdp.isAttached()) cdp.detach()
  else for (const listener of record.cdpDetachListeners) listener('E2E 模拟 CDP 断开')
}

/** 向主进程内部的网页 CDP 会话发送命令，禁止通过 Renderer/HTTP 暴露。 */
export async function sendWebTabCdpCommandInternal(input: WebTabCdpCommandInput): Promise<unknown> {
  const record = records.get(input.tabId)
  if (!record) throw new Error('网页页签不存在')

  const cdp = record.view.webContents.debugger
  if (!cdp.isAttached()) attachCdp(record)
  if (!cdp.isAttached()) throw new Error('网页 CDP 未连接')
  return cdp.sendCommand(input.method, input.params)
}

/** 确保指定网页页签挂载 CDP，供 AI 浏览器抽屉绑定或 Agent 交互时按需调用。 */
export function ensureWebTabCdpAttached(tabId: string): void {
  const record = records.get(tabId)
  if (!record) throw new Error('网页页签不存在')
  attachCdp(record)
}

/** 断开指定网页页签的 CDP 挂载并释放资源。 */
export function detachWebTabCdp(tabId: string): void {
  const record = records.get(tabId)
  if (!record) return
  detachCdp(record)
}

/** 查询指定网页页签当前是否处于 CDP 挂载状态。 */
export function isWebTabCdpAttached(tabId: string): boolean {
  const record = records.get(tabId)
  return record ? record.view.webContents.debugger.isAttached() : false
}

