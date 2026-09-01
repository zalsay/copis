import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, mock, test } from 'bun:test'

class FakeDebugger extends EventEmitter {
  attached = false
  destroyed = false
  readonly sendCommand = mock(async (_method: string, _params?: Record<string, unknown>) => undefined)

  isAttached(): boolean { return this.attached }
  attach(): void { this.attached = true }
  detach(): void {
    this.attached = false
    this.emit('detach', {}, 'target_closed')
  }
}

interface FakeSession {
  fetch: ReturnType<typeof mock>
  clearStorageData: ReturnType<typeof mock>
}

const sessionsByPartition = new Map<string, FakeSession>()

function getSessionForPartition(partition: string | undefined): FakeSession {
  const key = partition ?? 'default'
  const existing = sessionsByPartition.get(key)
  if (existing) return existing

  const session = {
    fetch: mock(async () => ({ ok: false, headers: new Headers(), arrayBuffer: async () => new ArrayBuffer(0) })),
    clearStorageData: mock(async () => undefined),
  }
  sessionsByPartition.set(key, session)
  return session
}

class FakeWebContents extends EventEmitter {
  readonly debugger = new FakeDebugger()
  readonly session: FakeSession
  readonly id: number
  private static nextId = 1
  private url = 'about:blank'
  private title = ''
  private destroyed = false
  windowOpenHandler: ((details: Electron.HandlerDetails) => Electron.WindowOpenHandlerResponse) | undefined
  readonly send = mock((_channel: string, _value: unknown) => undefined)

  constructor(session = getSessionForPartition(undefined)) {
    super()
    this.id = FakeWebContents.nextId++
    this.session = session
  }

  getURL(): string { return this.url }
  getTitle(): string { return this.title }
  canGoBack(): boolean { return false }
  canGoForward(): boolean { return false }
  isDestroyed(): boolean { return this.destroyed }
  setWindowOpenHandler(handler: (details: Electron.HandlerDetails) => Electron.WindowOpenHandlerResponse): void {
    this.windowOpenHandler = handler
  }
  loadURL(url: string): Promise<void> {
    this.url = url
    return Promise.resolve()
  }
  close(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.debugger.destroyed = true
    this.emit('destroyed')
  }
}

class FakeWebContentsView {
  readonly webContents: FakeWebContents

  constructor(options: { webPreferences?: { partition?: string } } = {}) {
    this.webContents = new FakeWebContents(getSessionForPartition(options.webPreferences?.partition))
  }

  setVisible(): void {}
  setBounds(): void {}
}

let createdBrowserWindows: FakeBrowserWindow[] = []
let persistedSession: { tabs: Array<{ url: string }>; activeTabIndex: number | null } = {
  tabs: [],
  activeTabIndex: null,
}
const savePersistedWebTabs = mock((_session: typeof persistedSession) => undefined)
const openExternalMock = mock(async (_url: string) => undefined)

class FakeBrowserWindow extends EventEmitter {
  readonly webContents: FakeWebContents
  readonly contentView = {
    views: [] as FakeWebContentsView[],
    addChildView: (view: FakeWebContentsView) => { this.contentView.views.push(view) },
    removeChildView: (view: FakeWebContentsView) => {
      const index = this.contentView.views.indexOf(view)
      if (index >= 0) this.contentView.views.splice(index, 1)
    },
  }
  destroyed = false
  focused = false
  visible = false
  readonly options: Record<string, unknown>

  constructor(options: Record<string, unknown> = {}) {
    super()
    this.options = options
    const webPreferences = options.webPreferences as { session?: FakeSession } | undefined
    this.webContents = new FakeWebContents(webPreferences?.session)
    createdBrowserWindows.push(this)
  }

  isDestroyed(): boolean { return this.destroyed }
  show(): void { this.visible = true }
  focus(): void { this.focused = true }
  close(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.webContents.close()
    this.emit('closed')
  }
  destroy(): void { this.close() }
}

mock.module('electron', () => ({
  app: { isPackaged: false },
  BrowserWindow: FakeBrowserWindow,
  WebContentsView: FakeWebContentsView,
  dialog: { showMessageBox: mock(async () => ({ response: 0 })) },
  shell: { openExternal: openExternalMock },
}))

mock.module('./web-tab-session-service', () => ({
  getPersistedWebTabs: () => persistedSession,
  savePersistedWebTabs,
}))

const manager = await import('./web-tab-manager')

describe('网页页签 manager window.open 组合回归', () => {
  afterEach(() => {
    manager.disposeWebTabs()
    persistedSession = { tabs: [], activeTabIndex: null }
    savePersistedWebTabs.mockClear()
    openExternalMock.mockClear()
    sessionsByPartition.clear()
    createdBrowserWindows = []
  })

  test('普通页签 window.open HTTP(S) 时创建并激活默认页签，且不启用 CDP、不构造原生 popup', () => {
    const host = new FakeBrowserWindow()
    manager.setWebTabHostWindow(host as never)
    const before = manager.createWebTab({ url: 'https://owner.example' })
    const owner = host.contentView.views[0]!.webContents
    const response = owner.windowOpenHandler?.({ url: 'https://popup.example' } as never)

    expect(response).toEqual({ action: 'deny' })

    const after = manager.listWebTabs()
    const opened = after.tabs.find((tab) => tab.url === 'https://popup.example/')
    expect(after.tabs).toHaveLength(before.tabs.length + 1)
    expect(opened).toBeDefined()
    expect(after.activeTabId).toBe(opened!.id)
    expect(host.contentView.views).toHaveLength(2)
    expect(host.contentView.views[1]!.webContents.session).toBe(owner.session)
    expect(host.contentView.views[1]!.webContents.debugger.sendCommand).not.toHaveBeenCalled()
    expect(createdBrowserWindows).toHaveLength(1)
    expect(savePersistedWebTabs).toHaveBeenCalledTimes(2)
  })

  test('新建、恢复和无痕页签 window.open HTTP(S) 时都创建默认页签', () => {
    const host = new FakeBrowserWindow()
    manager.setWebTabHostWindow(host as never)
    manager.createWebTab({ url: 'https://created.example' })
    const createdContents = host.contentView.views[0]!.webContents
    expect(createdContents.windowOpenHandler?.({ url: 'https://created-popup.example' } as never)).toEqual({ action: 'deny' })
    expect(host.contentView.views.at(-1)!.webContents.session).toBe(createdContents.session)

    manager.disposeWebTabs()
    persistedSession = { tabs: [{ url: 'https://restored.example' }], activeTabIndex: 0 }
    const restoredHost = new FakeBrowserWindow()
    manager.setWebTabHostWindow(restoredHost as never)
    const restoredContents = restoredHost.contentView.views[0]!.webContents
    expect(restoredContents.windowOpenHandler?.({ url: 'https://restored-popup.example' } as never)).toEqual({ action: 'deny' })
    expect(restoredHost.contentView.views.at(-1)!.webContents.session).toBe(restoredContents.session)

    const blank = manager.createWebTab({ activate: false })
    const blankId = blank.tabs.find((tab) => tab.url === 'about:blank')!.id
    manager.activateWebTabIncognito(blankId)
    const incognitoContents = restoredHost.contentView.views.at(-1)!.webContents
    expect(incognitoContents.windowOpenHandler?.({ url: 'https://incognito-popup.example' } as never)).toEqual({ action: 'deny' })
    const openedFromIncognito = restoredHost.contentView.views.at(-1)!.webContents
    expect(openedFromIncognito.session).toBe(restoredContents.session)
    expect(incognitoContents.session).not.toBe(restoredContents.session)
  })

  test('Google OAuth window.open（仅 accounts.google.com）沿用系统外部打开且不新增 Manager 页签', () => {
    const host = new FakeBrowserWindow()
    manager.setWebTabHostWindow(host as never)
    const before = manager.createWebTab({ url: 'https://owner.example' })
    const owner = host.contentView.views[0]!.webContents
    const oauthUrl = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=copis&redirect_uri=http%3A%2F%2Flocalhost%2Fcallback'

    const response = owner.windowOpenHandler?.({ url: oauthUrl } as never)

    expect(response).toEqual({ action: 'deny' })
    expect(openExternalMock).toHaveBeenCalledWith(oauthUrl)
    expect(manager.listWebTabs().tabs).toHaveLength(before.tabs.length)
    expect(createdBrowserWindows).toHaveLength(1)
  })

  test('非 accounts.google.com 域名（如 accounts.google.com.evil.example）window.open 视为普通 HTTP(S) 创建新页签', () => {
    const host = new FakeBrowserWindow()
    manager.setWebTabHostWindow(host as never)
    const before = manager.createWebTab({ url: 'https://owner.example' })
    const owner = host.contentView.views[0]!.webContents
    const evilUrl = 'https://accounts.google.com.evil.example/o/oauth2/v2/auth'

    const response = owner.windowOpenHandler?.({ url: evilUrl } as never)

    expect(response).toEqual({ action: 'deny' })
    expect(openExternalMock).not.toHaveBeenCalled()
    const after = manager.listWebTabs()
    expect(after.tabs).toHaveLength(before.tabs.length + 1)
    expect(after.tabs.some((tab) => tab.url.startsWith('https://accounts.google.com.evil.example'))).toBe(true)
  })

  test('非 HTTP(S) URL window.open 沿用外部打开策略且不新增 Manager 页签', () => {
    const host = new FakeBrowserWindow()
    manager.setWebTabHostWindow(host as never)
    const before = manager.createWebTab({ url: 'https://owner.example' })
    const owner = host.contentView.views[0]!.webContents
    const mailtoUrl = 'mailto:owner@example.com'

    const response = owner.windowOpenHandler?.({ url: mailtoUrl } as never)

    expect(response).toEqual({ action: 'deny' })
    expect(openExternalMock).toHaveBeenCalledWith(mailtoUrl)
    expect(manager.listWebTabs().tabs).toHaveLength(before.tabs.length)
    expect(createdBrowserWindows).toHaveLength(1)
  })

  test('workflow-owned 页签 window.open HTTP(S) 时创建 workflow-owned 页签并通知订阅者，不影响公开快照与 activeTabId', () => {
    const host = new FakeBrowserWindow()
    manager.setWebTabHostWindow(host as never)
    const regularSnapshot = manager.createWebTab({ url: 'https://regular.example' })
    const initialActiveTabId = regularSnapshot.activeTabId
    const workflowTab = manager.createWorkflowWebTab({ url: 'https://workflow-parent.example', partition: 'persist:copis-workflow-test' })
    const openedWorkflowTabs: Array<{ id: string; url: string }> = []
    const unsubscribe = manager.subscribeWorkflowWebTabOpened(workflowTab.id, (tab) => {
      openedWorkflowTabs.push(tab as { id: string; url: string })
    })

    const workflowView = host.contentView.views.find((v) => v.webContents.getURL().startsWith('https://workflow-parent.example'))!
    const response = workflowView.webContents.windowOpenHandler?.({ url: 'https://workflow-popup.example' } as never)

    expect(response).toEqual({ action: 'deny' })
    expect(openedWorkflowTabs).toHaveLength(1)
    expect(openedWorkflowTabs[0]?.url).toBe('https://workflow-popup.example/')

    const childWorkflowView = host.contentView.views.find((v) => v.webContents.getURL().startsWith('https://workflow-popup.example'))!
    expect(childWorkflowView.webContents.session).toBe(workflowView.webContents.session)
    expect(childWorkflowView.webContents.debugger.sendCommand).not.toHaveBeenCalled()
    expect(manager.listWebTabs().tabs).toHaveLength(1)
    expect(manager.listWebTabs().activeTabId).toBe(initialActiveTabId)
    expect(createdBrowserWindows).toHaveLength(1)

    unsubscribe()
  })

  test('普通页签默认不启动 bridge；获得 Agent lease 后启动 bridge，release/close 后 bridge dispose 且 detach 后不发命令', async () => {
    const host = new FakeBrowserWindow()
    manager.setWebTabHostWindow(host as never)
    const snapshot = manager.createWebTab({ url: 'https://dialog-owner.example' })
    const contents = host.contentView.views[0]!.webContents
    await new Promise((resolve) => setTimeout(resolve, 0))

    // 普通页签 0 lease 时不启用 Page
    expect(contents.debugger.sendCommand.mock.calls.some(([method]) => method === 'Page.enable')).toBe(false)

    // acquire Agent lease 后 bridge 启动并启用 Page
    const port = manager.acquireWebTabPagePort(snapshot.tabs[0]!.id, 'agent')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(contents.debugger.sendCommand.mock.calls.some(([method]) => method === 'Page.enable')).toBe(true)
    const commandCountBeforeClose = contents.debugger.sendCommand.mock.calls.length

    port.release()
    manager.closeWebTab(snapshot.tabs[0]!.id)
    contents.debugger.emit('detach', {}, 'late detach')
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(contents.debugger.sendCommand.mock.calls.length).toBe(commandCountBeforeClose)
  })
})
