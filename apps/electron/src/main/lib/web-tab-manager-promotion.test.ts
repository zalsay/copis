import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, mock, test } from 'bun:test'

class FakeDebugger extends EventEmitter {
  attached = false
  readonly sendCommand = mock(async () => undefined)

  isAttached(): boolean { return this.attached }
  attach(): void { this.attached = true }
  detach(): void { this.attached = false; this.emit('detach', {}, 'target_closed') }
}

class FakeWebContents extends EventEmitter {
  readonly debugger = new FakeDebugger()
  readonly session = { fetch: mock(async () => ({ ok: false, headers: new Headers(), arrayBuffer: async () => new ArrayBuffer(0) })) }
  readonly id = 1
  private url = 'about:blank'
  private title = ''
  private destroyed = false

  getURL(): string { return this.url }
  getTitle(): string { return this.title }
  canGoBack(): boolean { return false }
  canGoForward(): boolean { return false }
  isDestroyed(): boolean { return this.destroyed }
  setWindowOpenHandler(): void {}
  loadURL(url: string): Promise<void> { this.url = url; return Promise.resolve() }
  close(): void { this.destroyed = true; this.emit('destroyed') }
}

class FakeWebContentsView {
  readonly webContents = new FakeWebContents()
  setVisible(): void {}
  setBounds(): void {}
}

class FakeHostWindow extends EventEmitter {
  readonly contentView = {
    addChildView: mock(() => undefined),
    removeChildView: mock(() => undefined),
  }
  readonly webContents = { send: mock(() => undefined), getURL: () => 'http://renderer.test/' }
  isDestroyed(): boolean { return false }
}

const bridgeStarts = mock(() => Promise.resolve())
const bridgeDisposes = mock(() => undefined)

mock.module('electron', () => ({
  app: { isPackaged: false },
  BrowserWindow: FakeHostWindow,
  WebContentsView: FakeWebContentsView,
  shell: { openExternal: mock(async () => undefined) },
}))

mock.module('./web-tab-javascript-dialog', () => ({
  createWebTabJavascriptDialogBridge: mock(() => ({
    start: bridgeStarts,
    dispose: bridgeDisposes,
  })),
}))

mock.module('./web-tab-session-service', () => ({
  getPersistedWebTabs: () => ({ tabs: [], activeTabIndex: null }),
  savePersistedWebTabs: mock(() => undefined),
}))

mock.module('./web-tab-native-popup', () => ({
  createWebTabWindowOpenHandler: () => () => ({ action: 'deny' }),
  installNativeWebPopupWindow: () => undefined,
}))

const { createWorkflowWebTab, disposeWebTabs, promoteWorkflowWebTab, setWebTabHostWindow } = await import('./web-tab-manager')

describe('Workflow 网页页签提升后的 JavaScript dialog bridge', () => {
  afterEach(() => {
    disposeWebTabs()
    bridgeStarts.mockClear()
    bridgeDisposes.mockClear()
  })

  test('Given workflow-owned view When 提升为公开页签 Then 仅启动一次 dialog bridge', () => {
    setWebTabHostWindow(new FakeHostWindow() as never)
    const workflowTab = createWorkflowWebTab({ url: 'https://workflow.example' })

    expect(bridgeStarts).not.toHaveBeenCalled()
    promoteWorkflowWebTab(workflowTab.id)

    expect(bridgeStarts).toHaveBeenCalledTimes(1)
  })
})
