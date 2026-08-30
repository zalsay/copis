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
  fetchCalls: Array<{ url: string; init: RequestInit }> = []
  fetchImpl: ((url: string, init: RequestInit) => Promise<FakeFaviconResponse>) | undefined

  clearStorageData(): Promise<void> {
    this.clearStorageDataCalls += 1
    return Promise.resolve()
  }

  fetch(url: string, init: RequestInit): Promise<FakeFaviconResponse> {
    this.fetchCalls.push({ url, init })
    return this.fetchImpl?.(url, init) ?? Promise.reject(new Error('未配置 favicon 响应'))
  }
}

interface FakeFaviconResponse {
  ok: boolean
  headers: Headers
  arrayBuffer(): Promise<ArrayBuffer>
}

function createFaviconResponse(
  body: Uint8Array,
  options: { ok?: boolean; contentType?: string; contentLength?: number } = {},
): FakeFaviconResponse {
  const headers = new Headers()
  if (options.contentType) headers.set('content-type', options.contentType)
  if (options.contentLength !== undefined) headers.set('content-length', String(options.contentLength))
  return {
    ok: options.ok ?? true,
    headers,
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer,
  }
}

function waitForAsyncTasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
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

  reload(): void {
    this.emit('did-start-loading')
    this.emit('did-stop-loading')
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
  createWorkflowWebTab,
  closeWebTab,
  detachWebTabCdp,
  disposeWebTabs,
  ensureWebTabCdpAttached,
  getWebTabState,
  isWebTabCdpAttached,
  listWebTabs,
  reorderWebTab,
  resolveWebTabFaviconDataUrl,
  resolveWebTabFaviconUrl,
  reloadWebTab,
  sendWebTabCdpCommandInternal,
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

  test('Given 页签已有 favicon When 开始加载/刷新 Then 保留已有 favicon 不被清空', () => {
    const favicon = resolveWebTabFaviconUrl('https://old.example.com/favicon.ico', { type: 'loading-started' })
    expect(favicon).toBe('https://old.example.com/favicon.ico')
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

describe('网页页签 favicon 解析', () => {
  test('Given 第一个远程候选不可用且第二个是图片 When 解析 favicon Then 继续尝试并返回 data URL', async () => {
    const requestedUrls: string[] = []

    const favicon = await resolveWebTabFaviconDataUrl(
      ['https://first.example/favicon.ico', 'https://second.example/favicon.png'],
      async (url) => {
        requestedUrls.push(url)
        return url.includes('first')
          ? createFaviconResponse(new Uint8Array(), { ok: false })
          : createFaviconResponse(new Uint8Array([0, 1, 2]), { contentType: 'image/png' })
      },
      'https://page.example/article',
    )

    expect(requestedUrls).toEqual(['https://first.example/favicon.ico', 'https://second.example/favicon.png'])
    expect(favicon).toBe('data:image/png;base64,AAEC')
  })

  test('Given 候选响应不是图片 When 后续候选是图片 Then 跳过非图片响应', async () => {
    const favicon = await resolveWebTabFaviconDataUrl(
      ['https://page.example/not-an-icon', 'https://page.example/favicon.svg'],
      async (url) => url.endsWith('.svg')
        ? createFaviconResponse(new Uint8Array([3]), { contentType: 'image/svg+xml' })
        : createFaviconResponse(new Uint8Array([1]), { contentType: 'text/html' }),
      'https://page.example',
    )

    expect(favicon).toBe('data:image/svg+xml;base64,Aw==')
  })

  test('Given 候选图片超过大小上限 When 解析 favicon Then 忽略该响应', async () => {
    const favicon = await resolveWebTabFaviconDataUrl(
      ['https://page.example/oversized.png'],
      async () => createFaviconResponse(new Uint8Array([1]), {
        contentType: 'image/png',
        contentLength: 512 * 1024 + 1,
      }),
      'https://page.example',
    )

    expect(favicon).toBeNull()
  })

  test('Given 页面直接提供 data 图片 When 解析 favicon Then 保留原始 data URL', async () => {
    const favicon = await resolveWebTabFaviconDataUrl(
      ['data:image/png;base64,AAAA'],
      async () => {
        throw new Error('data URL 不应发起网络请求')
      },
      'https://page.example',
    )

    expect(favicon).toBe('data:image/png;base64,AAAA')
  })

  test('Given 网页页签提供远程 favicon When page-favicon-updated 触发 Then 使用该页签 Session 并写入 data URL', async () => {
    setupHost()
    const initial = createWebTab({ url: 'https://page.example' })
    const tabId = initial.tabs[0]!.id
    const view = createdViews[0]!
    view.webContents.session.fetchImpl = async () => createFaviconResponse(
      new Uint8Array([4, 5]),
      { contentType: 'image/png' },
    )

    view.webContents.emit('page-favicon-updated', {}, ['https://cdn.example/favicon.png'])
    await waitForAsyncTasks()

    expect(view.webContents.session.fetchCalls).toEqual([
      expect.objectContaining({
        url: 'https://cdn.example/favicon.png',
        init: expect.objectContaining({ credentials: 'include', referrer: 'https://page.example/' }),
      }),
    ])
    expect(getWebTabState(tabId)?.faviconUrl).toBe('data:image/png;base64,BAU=')
  })

  test('Given 旧页面图标仍在异步读取 When 导航到新页面 Then 不写回旧 favicon', async () => {
    setupHost()
    const initial = createWebTab({ url: 'https://old.example' })
    const tabId = initial.tabs[0]!.id
    const view = createdViews[0]!
    let resolveResponse: ((response: FakeFaviconResponse) => void) | undefined
    view.webContents.session.fetchImpl = () => new Promise((resolve) => {
      resolveResponse = resolve
    })

    view.webContents.emit('page-favicon-updated', {}, ['https://old.example/favicon.png'])
    await Promise.resolve()
    navigateWebTab({ tabId, url: 'https://new.example' })
    resolveResponse?.(createFaviconResponse(new Uint8Array([9]), { contentType: 'image/png' }))
    await Promise.resolve()
    await Promise.resolve()

    expect(getWebTabState(tabId)?.faviconUrl).toBeNull()
  })

  test('Given 网页页签已有 favicon When 触发刷新 reloadWebTab 且 Chromium 不重复派发 page-favicon-updated Then 保持原有 favicon 不被重置为默认图标', async () => {
    setupHost()
    const initial = createWebTab({ url: 'https://page.example' })
    const tabId = initial.tabs[0]!.id
    const view = createdViews[0]!
    view.webContents.session.fetchImpl = async () => createFaviconResponse(
      new Uint8Array([4, 5]),
      { contentType: 'image/png' },
    )

    view.webContents.emit('page-favicon-updated', {}, ['https://cdn.example/favicon.png'])
    await waitForAsyncTasks()
    expect(getWebTabState(tabId)?.faviconUrl).toBe('data:image/png;base64,BAU=')

    // 触发刷新 reload
    reloadWebTab(tabId)
    await waitForAsyncTasks()

    // 刷新完成后，即使没有再次触发 page-favicon-updated，favicon 依然被完整保留
    expect(getWebTabState(tabId)?.faviconUrl).toBe('data:image/png;base64,BAU=')
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

describe('网页页签拖动排序', () => {
  test('Given A、B、C When 将 A 移到末位 Then 顺序和激活状态都更新', () => {
    setupHost()
    const first = createWebTab({ url: 'https://a.example', activate: false })
    const second = createWebTab({ url: 'https://b.example', activate: false })
    const third = createWebTab({ url: 'https://c.example', activate: false })

    const result = reorderWebTab({ tabId: first.tabs[0]!.id, targetIndex: 2 })

    expect(result.tabs.map((tab) => tab.url)).toEqual([
      'https://b.example/',
      'https://c.example/',
      'https://a.example/',
    ])
    expect(result.activeTabId).toBe(first.tabs[0]!.id)
    expect(persistedSessions.at(-1)).toEqual({
      tabs: [
        { url: 'https://b.example/' },
        { url: 'https://c.example/' },
        { url: 'https://a.example/' },
      ],
      activeTabIndex: 2,
    })
    expect(second.tabs[1]!.id).toBe(result.tabs[0]!.id)
    expect(third.tabs[2]!.id).toBe(result.tabs[1]!.id)
  })

  test('Given公开页签和 workflow-owned 页签 When重排公开页签 Then workflow 页签不参与目标索引', () => {
    setupHost()
    const first = createWebTab({ url: 'https://a.example', activate: false })
    const workflow = createWorkflowWebTab({ url: 'https://workflow.example' })
    const second = createWebTab({ url: 'https://b.example', activate: false })

    const result = reorderWebTab({ tabId: second.tabs[1]!.id, targetIndex: 0 })

    expect(result.tabs.map((tab) => tab.id)).toEqual([second.tabs[1]!.id, first.tabs[0]!.id])
    expect(result.tabs.some((tab) => tab.id === workflow.id)).toBe(false)
  })

  test('Given不存在的页签或无效目标索引 When重排 Then拒绝请求且不改变顺序', () => {
    setupHost()
    const first = createWebTab({ url: 'https://a.example', activate: false })
    createWebTab({ url: 'https://b.example', activate: false })
    const before = listWebTabs()

    expect(() => reorderWebTab({ tabId: 'missing-tab', targetIndex: 0 })).toThrow('网页页签不存在')
    expect(() => reorderWebTab({ tabId: first.tabs[0]!.id, targetIndex: 2 })).toThrow('网页页签目标位置无效')
    expect(listWebTabs()).toEqual(before)
  })
})

describe('网页页签 CDP 按需生命周期', () => {
  test('Given 新建普通页签 When 初始创建 Then 默认不挂载 CDP', () => {
    setupHost()
    const snapshot = createWebTab({ url: 'https://example.com' })
    expect(isWebTabCdpAttached(snapshot.activeTabId!)).toBe(false)
  })

  test('Given 未挂载 CDP 的页签 When 显式调用 ensureWebTabCdpAttached Then 挂载 CDP', () => {
    setupHost()
    const snapshot = createWebTab({ url: 'https://example.com' })
    expect(isWebTabCdpAttached(snapshot.activeTabId!)).toBe(false)

    ensureWebTabCdpAttached(snapshot.activeTabId!)
    expect(isWebTabCdpAttached(snapshot.activeTabId!)).toBe(true)
  })

  test('Given 已挂载 CDP 的页签 When 显式调用 detachWebTabCdp Then 释放 CDP', () => {
    setupHost()
    const snapshot = createWebTab({ url: 'https://example.com' })
    ensureWebTabCdpAttached(snapshot.activeTabId!)
    expect(isWebTabCdpAttached(snapshot.activeTabId!)).toBe(true)

    detachWebTabCdp(snapshot.activeTabId!)
    expect(isWebTabCdpAttached(snapshot.activeTabId!)).toBe(false)
  })

  test('Given 未挂载 CDP 的页签 When 执行内部 CDP 指令 Then 自动懒加载挂载 CDP', async () => {
    setupHost()
    const snapshot = createWebTab({ url: 'https://example.com' })
    expect(isWebTabCdpAttached(snapshot.activeTabId!)).toBe(false)

    await sendWebTabCdpCommandInternal({ tabId: snapshot.activeTabId!, method: 'Runtime.enable' })
    expect(isWebTabCdpAttached(snapshot.activeTabId!)).toBe(true)
  })
})

