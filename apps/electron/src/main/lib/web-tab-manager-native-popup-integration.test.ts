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

class FakeWebContents extends EventEmitter {
  readonly debugger = new FakeDebugger()
  readonly session = {
    fetch: mock(async () => ({ ok: false, headers: new Headers(), arrayBuffer: async () => new ArrayBuffer(0) })),
    clearStorageData: mock(async () => undefined),
  }
  readonly id: number
  private static nextId = 1
  private url = 'about:blank'
  private title = ''
  private destroyed = false
  windowOpenHandler: ((details: Electron.HandlerDetails) => Electron.WindowOpenHandlerResponse) | undefined
  readonly send = mock((_channel: string, _value: unknown) => undefined)

  constructor() {
    super()
    this.id = FakeWebContents.nextId++
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
  readonly webContents = new FakeWebContents()
  setVisible(): void {}
  setBounds(): void {}
}

class FakeBrowserWindow extends EventEmitter {
  readonly webContents = new FakeWebContents()
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

let persistedSession: { tabs: Array<{ url: string }>; activeTabIndex: number | null } = {
  tabs: [],
  activeTabIndex: null,
}
const savePersistedWebTabs = mock((_session: typeof persistedSession) => undefined)

mock.module('electron', () => ({
  app: { isPackaged: false },
  BrowserWindow: FakeBrowserWindow,
  WebContentsView: FakeWebContentsView,
  dialog: { showMessageBox: mock(async () => ({ response: 0 })) },
  shell: { openExternal: mock(async () => undefined) },
}))

mock.module('./web-tab-session-service', () => ({
  getPersistedWebTabs: () => persistedSession,
  savePersistedWebTabs,
}))

const manager = await import('./web-tab-manager')

describe('网页页签 manager 原生子窗口组合回归', () => {
  afterEach(() => {
    manager.disposeWebTabs()
    persistedSession = { tabs: [], activeTabIndex: null }
    savePersistedWebTabs.mockClear()
  })

  test('普通页签 window.open 创建原生子窗口时不改变快照或恢复持久化', () => {
    const host = new FakeBrowserWindow()
    manager.setWebTabHostWindow(host as never)
    const before = manager.createWebTab({ url: 'https://owner.example' })
    const owner = host.contentView.views[0]!.webContents
    const response = owner.windowOpenHandler?.({ url: 'https://popup.example' } as never)
    const popup = new FakeBrowserWindow(response?.overrideBrowserWindowOptions as Record<string, unknown>)

    expect(response).toMatchObject({
      action: 'allow',
      overrideBrowserWindowOptions: { parent: host, show: false, modal: false },
    })
    owner.emit('did-create-window', popup, { url: 'https://popup.example' })

    expect(manager.listWebTabs()).toEqual(before)
    expect(savePersistedWebTabs).toHaveBeenCalledTimes(1)
    expect(popup.webContents.windowOpenHandler?.({ url: 'https://nested.example' } as never)).toMatchObject({ action: 'allow' })
    expect(popup.options.parent).toBe(host)

    manager.closeWebTab(before.tabs[0]!.id)
    expect(popup.destroyed).toBe(true)
  })

  test('新建、恢复和无痕替换路径都安装同一原生子窗口策略', () => {
    const host = new FakeBrowserWindow()
    manager.setWebTabHostWindow(host as never)
    manager.createWebTab({ url: 'https://created.example' })
    const createdContents = host.contentView.views[0]!.webContents
    expect(createdContents.windowOpenHandler?.({ url: 'https://created-popup.example' } as never)).toMatchObject({ action: 'allow' })

    manager.disposeWebTabs()
    persistedSession = { tabs: [{ url: 'https://restored.example' }], activeTabIndex: 0 }
    const restoredHost = new FakeBrowserWindow()
    manager.setWebTabHostWindow(restoredHost as never)
    const restoredContents = restoredHost.contentView.views[0]!.webContents
    expect(restoredContents.windowOpenHandler?.({ url: 'https://restored-popup.example' } as never)).toMatchObject({ action: 'allow' })

    const blank = manager.createWebTab({ activate: false })
    const blankId = blank.tabs.find((tab) => tab.url === 'about:blank')!.id
    manager.activateWebTabIncognito(blankId)
    const incognitoContents = restoredHost.contentView.views.at(-1)!.webContents
    expect(incognitoContents.windowOpenHandler?.({ url: 'https://incognito-popup.example' } as never)).toMatchObject({ action: 'allow' })
  })

  test('关闭普通页签后 bridge dispose，之后 CDP detach 不会重连或发命令', async () => {
    const host = new FakeBrowserWindow()
    manager.setWebTabHostWindow(host as never)
    const snapshot = manager.createWebTab({ url: 'https://dialog-owner.example' })
    const contents = host.contentView.views[0]!.webContents
    await new Promise((resolve) => setTimeout(resolve, 0))
    const commandCountBeforeClose = contents.debugger.sendCommand.mock.calls.length

    manager.closeWebTab(snapshot.tabs[0]!.id)
    contents.debugger.emit('detach', {}, 'late detach')
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(contents.debugger.sendCommand.mock.calls.length).toBe(commandCountBeforeClose)
    expect(contents.debugger.sendCommand.mock.calls.some(([method]) => method === 'Page.enable')).toBe(true)
  })
})
