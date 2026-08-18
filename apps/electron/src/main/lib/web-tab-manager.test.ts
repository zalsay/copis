import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, mock, test } from 'bun:test'

const persistedSessions: Array<{ tabs: Array<{ url: string }>; activeTabIndex: number | null }> = []
const createdViews: FakeWebContentsView[] = []

class FakeDebugger extends EventEmitter {
  attached = false

  isAttached(): boolean {
    return this.attached
  }

  attach(): void {
    this.attached = true
  }

  detach(): void {
    this.attached = false
    this.emit('detach', {}, 'target_closed')
  }

  sendCommand(): Promise<unknown> {
    return Promise.resolve({})
  }
}

class FakeSession {
  clearStorageDataCalls = 0

  clearStorageData(): Promise<void> {
    this.clearStorageDataCalls += 1
    return Promise.resolve()
  }
}

class FakeWebContents extends EventEmitter {
  url = 'about:blank'
  title = ''
  destroyed = false
  closed = false
  readonly debugger = new FakeDebugger()
  readonly session = new FakeSession()
  readonly id = Math.floor(Math.random() * 100000)
  private windowOpenHandler: ((details: { url: string }) => { action: string }) | undefined

  getURL(): string {
    return this.url
  }

  getTitle(): string {
    return this.title
  }

  canGoBack(): boolean {
    return false
  }

  canGoForward(): boolean {
    return false
  }

  getOrCreateDevToolsTargetId(): string {
    return `target-${this.id}`
  }

  setWindowOpenHandler(handler: (details: { url: string }) => { action: string }): void {
    this.windowOpenHandler = handler
  }

  loadURL(url: string): Promise<void> {
    this.url = url
    this.emit('did-start-loading')
    this.emit('did-navigate', {}, url)
    this.emit('did-stop-loading')
    return Promise.resolve()
  }

  close(): void {
    this.closed = true
    this.destroyed = true
    this.emit('destroyed')
  }

  isDestroyed(): boolean {
    return this.destroyed
  }
}

class FakeWebContentsView {
  readonly webContents = new FakeWebContents()
  partition: string | undefined
  bounds = { x: 0, y: 0, width: 0, height: 0 }
  visible = false

  constructor(options: { webPreferences?: { partition?: string } } = {}) {
    this.partition = options.webPreferences?.partition
    createdViews.push(this)
  }

  setVisible(visible: boolean): void {
    this.visible = visible
  }

  setBounds(bounds: { x: number; y: number; width: number; height: number }): void {
    this.bounds = { ...bounds }
  }
}

class FakeHostWindow {
  readonly contentView = {
    addChildView: mock(() => undefined),
    removeChildView: mock(() => undefined),
  }
  readonly webContents = { send: mock(() => undefined), getURL: () => 'http://renderer.test/' }

  isDestroyed(): boolean {
    return false
  }
}

// 提供可观测的 Electron stub，覆盖页签创建、导航、关闭、session 和 CDP 生命周期。
mock.module('electron', () => ({
  app: { isPackaged: false, getPath: () => '/tmp/copis-web-tab-test' },
  BrowserWindow: FakeHostWindow,
  shell: {},
  WebContentsView: FakeWebContentsView,
}))

mock.module('./web-tab-session-service', () => ({
  getPersistedWebTabs: () => ({ tabs: [], activeTabIndex: null }),
  savePersistedWebTabs: (session: { tabs: Array<{ url: string }>; activeTabIndex: number | null }) => {
    persistedSessions.push(session)
  },
}))

const {
  activateWebTabIncognito,
  createWebTab,
  closeWebTab,
  disposeWebTabs,
  getWebTabState,
  listWebTabs,
  resolveWebTabFaviconUrl,
  setWebTabHostWindow,
  subscribeWebTabLifecycle,
  updateWebTabBounds,
  navigateWebTab,
} = await import('./web-tab-manager')

function setupHost(): FakeHostWindow {
  const host = new FakeHostWindow()
  setWebTabHostWindow(host as never)
  persistedSessions.length = 0
  createdViews.length = 0
  return host
}

afterEach(() => {
  disposeWebTabs()
  persistedSessions.length = 0
})

describe('网页页签 favicon 生命周期', () => {
  test('Given 收藏夹导航时 page-favicon-updated 先于 did-navigate 触发 When 导航提交 Then 不清空已更新的 favicon', () => {
    let favicon: string | null = resolveWebTabFaviconUrl(null, { type: 'loading-started' })
    favicon = resolveWebTabFaviconUrl(favicon, { type: 'favicon-updated', favicons: ['https://example.com/favicon.ico'] })
    favicon = resolveWebTabFaviconUrl(favicon, { type: 'navigation-committed' })
    expect(favicon).toBe('https://example.com/favicon.ico')
  })

  test('Given 页签已有 favicon When 开始下一次导航 Then 清空旧 favicon', () => {
    const favicon = resolveWebTabFaviconUrl('https://old.example.com/favicon.ico', { type: 'loading-started' })
    expect(favicon).toBeNull()
  })

  test('Given 常规时序 favicon-updated 晚于 did-navigate When 图标到达 Then 设置新 favicon', () => {
    let favicon: string | null = resolveWebTabFaviconUrl(null, { type: 'loading-started' })
    favicon = resolveWebTabFaviconUrl(favicon, { type: 'navigation-committed' })
    favicon = resolveWebTabFaviconUrl(favicon, { type: 'favicon-updated', favicons: ['data:image/png;base64,AAAA'] })
    expect(favicon).toBe('data:image/png;base64,AAAA')
  })

  test('Given 页面没有 favicon When 导航提交 Then favicon 保持为空', () => {
    const favicon = resolveWebTabFaviconUrl(null, { type: 'navigation-committed' })
    expect(favicon).toBeNull()
  })
})

describe('网页页签无痕生命周期', () => {
  test('Given 新建空白页签 When 激活无痕模式 Then 保留 tabId 并切换到唯一非持久 partition', () => {
    setupHost()
    const initial = createWebTab({ url: 'about:blank' })
    const tabId = initial.tabs[0]!.id
    updateWebTabBounds({ tabId, bounds: { x: 1, y: 2, width: 300, height: 200 } })
    const lifecycleTypes: string[] = []
    const unsubscribe = subscribeWebTabLifecycle((event) => lifecycleTypes.push(event.type))

    const recreated = activateWebTabIncognito(tabId)
    const tab = recreated.tabs[0]!

    expect(tab.id).toBe(tabId)
    expect(tab.url).toBe('about:blank')
    expect(tab.isIncognito).toBe(true)
    expect(tab.canActivateIncognito).toBe(false)
    expect(recreated.activeTabId).toBe(tabId)
    unsubscribe()
    expect(lifecycleTypes).toContain('recreated')
    expect(createdViews).toHaveLength(2)
    expect(createdViews[0]?.partition).toBe('persist:copis-web')
    expect(createdViews[1]?.partition).toMatch(/^copis-incognito-/)
    expect(createdViews[1]?.partition).not.toContain('persist:')
    expect(createdViews[0]?.webContents.closed).toBe(true)
    expect(createdViews[1]?.bounds).toEqual({ x: 1, y: 2, width: 300, height: 200 })
  })

  test('Given 页签已经访问 HTTP(S) When 激活无痕模式 Then 保持原页签并拒绝转换', () => {
    setupHost()
    const initial = createWebTab({ url: 'https://example.com' })
    const tabId = initial.tabs[0]!.id
    const before = getWebTabState(tabId)

    expect(before?.isIncognito).toBe(false)
    expect(before?.canActivateIncognito).toBe(false)
    expect(() => activateWebTabIncognito(tabId)).toThrow()
    expect(getWebTabState(tabId)).toEqual(before)
  })

  test('Given 页签访问地址后回到 about:blank When 激活无痕模式 Then 仍拒绝转换', () => {
    setupHost()
    const initial = createWebTab({ url: 'about:blank' })
    const tabId = initial.tabs[0]!.id
    navigateWebTab({ tabId, url: 'https://example.com' })
    navigateWebTab({ tabId, url: 'about:blank' })

    const tab = getWebTabState(tabId)
    expect(tab?.url).toBe('about:blank')
    expect(tab?.canActivateIncognito).toBe(false)
    expect(() => activateWebTabIncognito(tabId)).toThrow()
    expect(getWebTabState(tabId)?.isIncognito).toBe(false)
  })

  test('Given 两个无痕页签 When 创建 Then partition 不相同且都不是 persist partition', () => {
    setupHost()
    const first = createWebTab({ incognito: true })
    const second = createWebTab({ incognito: true })

    expect(first.tabs[0]?.isIncognito).toBe(true)
    expect(second.tabs[1]?.isIncognito).toBe(true)
    expect(first.tabs[0]?.url).toBe('about:blank')
    expect(second.tabs[1]?.url).toBe('about:blank')
    expect(first.tabs[0]?.id).not.toBe(second.tabs[1]?.id)
    expect(createdViews[0]?.partition).toMatch(/^copis-incognito-/)
    expect(createdViews[1]?.partition).toMatch(/^copis-incognito-/)
    expect(createdViews[0]?.partition).not.toBe(createdViews[1]?.partition)
  })

  test('Given 无痕页签 When 保存网页会话 Then 恢复快照不包含无痕页签', () => {
    setupHost()
    createWebTab({ url: 'https://normal.example', activate: false })
    const incognito = createWebTab({ incognito: true })
    expect(incognito.tabs).toHaveLength(2)

    const latest = persistedSessions.at(-1)
    expect(latest?.tabs).toEqual([{ url: 'https://normal.example/' }])
    expect(latest?.activeTabIndex).toBeNull()
  })

  test('Given 无痕页签 When 显式关闭 Then 清理临时 Session 后关闭 view', () => {
    setupHost()
    const snapshot = createWebTab({ incognito: true })
    const tabId = snapshot.tabs[0]!.id
    const view = createdViews[0]!

    closeWebTab(tabId)

    expect(view.webContents.session.clearStorageDataCalls).toBe(1)
    expect(view.webContents.closed).toBe(true)
  })

  test('Given 无痕页签 When dispose Then 清理临时 Session 后释放 view', () => {
    setupHost()
    createWebTab({ incognito: true })
    const view = createdViews[0]!

    disposeWebTabs()

    expect(view.webContents.session.clearStorageDataCalls).toBe(1)
    expect(view.webContents.closed).toBe(true)
  })
})
