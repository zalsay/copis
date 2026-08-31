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
  dialog: { showMessageBox: mock(async () => ({ response: 0 })) },
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

const {
  acquireWebTabPagePort,
  createWorkflowWebTab,
  disposeWebTabs,
  promoteWorkflowWebTab,
  setWebTabHostWindow,
} = await import('./web-tab-manager')

describe('Workflow 网页页签提升与 Lease 生命周期', () => {
  afterEach(() => {
    disposeWebTabs()
    bridgeStarts.mockClear()
    bridgeDisposes.mockClear()
  })

  test('Given workflow-owned view When 提升为公开页签 Then 默认保持 0 lease 且不启动 bridge，仅在 acquire 后启动 bridge并在 release 时 dispose', () => {
    setWebTabHostWindow(new FakeHostWindow() as never)
    const workflowTab = createWorkflowWebTab({ url: 'https://workflow.example' })

    expect(bridgeStarts).not.toHaveBeenCalled()
    promoteWorkflowWebTab(workflowTab.id)
    expect(bridgeStarts).not.toHaveBeenCalled()

    const port = acquireWebTabPagePort(workflowTab.id, 'agent')
    expect(bridgeStarts).toHaveBeenCalledTimes(1)

    port.release()
    expect(bridgeDisposes).toHaveBeenCalledTimes(1)
  })
})
