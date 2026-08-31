import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

type Listener = (...args: unknown[]) => void

class FakeWebContents {
  id: number
  private listeners = new Map<string, Listener[]>()

  constructor(id: number) {
    this.id = id
  }

  isDestroyed(): boolean { return false }

  on(event: string, listener: Listener): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener])
    return this
  }

  removeListener(event: string, listener: Listener): this {
    this.listeners.set(event, (this.listeners.get(event) ?? []).filter((item) => item !== listener))
    return this
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args)
  }
}

class FakeBrowserWindow {
  static nextId = 100
  readonly webContents = new FakeWebContents(FakeBrowserWindow.nextId++)
  readonly options: Record<string, unknown>
  readonly loadedUrls: string[] = []
  private listeners = new Map<string, Listener[]>()
  loadURL = mock((url: string) => {
    this.loadedUrls.push(url)
    return Promise.resolve()
  })
  loadFile = mock(() => Promise.resolve())
  show = mock(() => undefined)
  focus = mock(() => undefined)
  close = mock(() => {
    this.emit('closed')
  })

  constructor(options: Record<string, unknown>) {
    this.options = options
  }

  getParentWindow(): FakeBrowserWindow | null {
    return (this.options.parent as FakeBrowserWindow | undefined) ?? null
  }

  isDestroyed(): boolean { return false }

  on(event: string, listener: Listener): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener])
    return this
  }

  once(event: string, listener: Listener): this {
    const wrapped: Listener = (...args) => {
      this.removeListener(event, wrapped)
      listener(...args)
    }
    return this.on(event, wrapped)
  }

  removeListener(event: string, listener: Listener): this {
    this.listeners.set(event, (this.listeners.get(event) ?? []).filter((item) => item !== listener))
    return this
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args)
  }
}

const windows: FakeBrowserWindow[] = []
const hostWindow = new FakeBrowserWindow({})

mock.module('electron', () => ({
  app: { isPackaged: false },
  BrowserWindow: class extends FakeBrowserWindow {
    constructor(options: Record<string, unknown>) {
      super(options)
      windows.push(this)
    }
  },
}))

const manager = await import('./web-tab-javascript-prompt-window')

describe('网页 JavaScript prompt 原生窗口', () => {
  beforeEach(() => {
    windows.splice(0)
  })

  afterEach(() => {
    manager.disposeWebJavascriptPromptWindows()
  })

  test('创建受控窗口并仅允许匹配 webContents 身份的请求读取和确认', async () => {
    const resultPromise = manager.showWebJavascriptPromptWindow({
      hostWindow: hostWindow as never,
      message: '请输入名称',
      defaultPrompt: 'Copis',
    })
    const win = windows[0]!
    const requestId = new URL(win.loadedUrls[0]!).searchParams.get('requestId')!

    expect(win.options).toMatchObject({
      parent: hostWindow,
      modal: true,
      show: false,
      width: 420,
      height: 220,
      resizable: false,
      webPreferences: {
        preload: expect.stringContaining('web-javascript-prompt-preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    })
    expect(new URL(win.loadedUrls[0]!).searchParams.get('window')).toBe('web-javascript-prompt')
    expect(manager.getWebJavascriptPromptRequest(requestId, win.webContents.id)).toMatchObject({
      requestId,
      message: '请输入名称',
      defaultPrompt: 'Copis',
    })
    expect(manager.getWebJavascriptPromptRequest(requestId, win.webContents.id + 1)).toBeNull()
    expect(manager.resolveWebJavascriptPromptRequest({ requestId, accept: true, promptText: '新名称' }, win.webContents.id + 1)).toBe(false)
    expect(manager.resolveWebJavascriptPromptRequest({ requestId, accept: true, promptText: '新名称' }, win.webContents.id)).toBe(true)
    await expect(resultPromise).resolves.toEqual({ accept: true, promptText: '新名称' })
    expect(manager.getWebJavascriptPromptRequest(requestId, win.webContents.id)).toBeNull()
  })

  test('窗口关闭时取消请求并清理映射', async () => {
    const resultPromise = manager.showWebJavascriptPromptWindow({ hostWindow: hostWindow as never, message: '继续吗？' })
    const win = windows[0]!
    const requestId = new URL(win.loadedUrls[0]!).searchParams.get('requestId')!

    win.emit('closed')

    await expect(resultPromise).resolves.toEqual({ accept: false })
    expect(manager.getWebJavascriptPromptRequest(requestId, win.webContents.id)).toBeNull()
    expect(manager.resolveWebJavascriptPromptRequest({ requestId, accept: true }, win.webContents.id)).toBe(false)
  })

  test('加载失败或宿主窗口关闭时取消请求', async () => {
    const loadFailure = manager.showWebJavascriptPromptWindow({ hostWindow: hostWindow as never, message: '加载失败' })
    const failedWindow = windows[0]!
    failedWindow.webContents.emit('did-fail-load')
    await expect(loadFailure).resolves.toEqual({ accept: false })
    expect(failedWindow.close).toHaveBeenCalled()

    const hostClose = manager.showWebJavascriptPromptWindow({ hostWindow: hostWindow as never, message: '宿主关闭' })
    hostWindow.emit('closed')
    await expect(hostClose).resolves.toEqual({ accept: false })
  })
})
