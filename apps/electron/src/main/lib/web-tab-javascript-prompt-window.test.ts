import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

type Listener = (...args: unknown[]) => void

class FakeWebContents {
  id: number
  destroyed = false
  private listeners = new Map<string, Listener[]>()

  constructor(id: number) {
    this.id = id
  }

  isDestroyed(): boolean { return this.destroyed }

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

  destroy(): void {
    this.destroyed = true
    this.emit('destroyed')
  }

  listenerCount(event: string): number {
    return this.listeners.get(event)?.length ?? 0
  }
}

class FakeBrowserWindow {
  static nextId = 100
  static throwOnLoadURL = false
  static throwOnLoadFile = false
  readonly webContents = new FakeWebContents(FakeBrowserWindow.nextId++)
  readonly options: Record<string, unknown>
  readonly loadedUrls: string[] = []
  readonly loadedFiles: Array<{ path: string; options?: unknown }> = []
  destroyed = false
  private listeners = new Map<string, Listener[]>()
  loadURL = mock((url: string) => {
    this.loadedUrls.push(url)
    if (FakeBrowserWindow.throwOnLoadURL) throw new Error('同步加载失败')
    return Promise.resolve()
  })
  loadFile = mock((path: string, options?: unknown) => {
    this.loadedFiles.push({ path, options })
    if (FakeBrowserWindow.throwOnLoadFile) throw new Error('同步加载文件失败')
    return Promise.resolve()
  })
  show = mock(() => undefined)
  focus = mock(() => undefined)
  close = mock(() => {
    this.emit('closed')
  })
  destroy = mock(() => {
    this.destroyed = true
    this.webContents.destroyed = true
    this.emit('closed')
  })

  constructor(options: Record<string, unknown>) {
    this.options = options
  }

  getParentWindow(): FakeBrowserWindow | null {
    return (this.options.parent as FakeBrowserWindow | undefined) ?? null
  }

  isDestroyed(): boolean { return this.destroyed }

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

  listenerCount(event: string): number {
    return this.listeners.get(event)?.length ?? 0
  }
}

const windows: FakeBrowserWindow[] = []
const hostWindow = new FakeBrowserWindow({})
const electronApp = { isPackaged: false }

mock.module('electron', () => ({
  app: electronApp,
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
    hostWindow.destroyed = false
    hostWindow.webContents.destroyed = false
    FakeBrowserWindow.throwOnLoadURL = false
    FakeBrowserWindow.throwOnLoadFile = false
    electronApp.isPackaged = false
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

  test('Given bridge 的 AbortSignal When prompt 仍未完成 Then 仅关闭对应子窗口并清理映射', async () => {
    const controller = new AbortController()
    const resultPromise = manager.showWebJavascriptPromptWindow({
      hostWindow: hostWindow as never,
      message: '桥接取消',
      signal: controller.signal,
    })
    const win = windows[0]!
    const requestId = new URL(win.loadedUrls[0]!).searchParams.get('requestId')!

    controller.abort()

    await expect(resultPromise).resolves.toEqual({ accept: false })
    expect(manager.getWebJavascriptPromptRequest(requestId, win.webContents.id)).toBeNull()
    expect(win.close).toHaveBeenCalledTimes(1)
    expect(win.listenerCount('closed')).toBe(0)
  })

  test('Given 两个宿主窗口各有 prompt When 仅取消一个 signal Then 不关闭另一个宿主的子窗口', async () => {
    const otherHost = new FakeBrowserWindow({})
    const firstController = new AbortController()
    const first = manager.showWebJavascriptPromptWindow({
      hostWindow: hostWindow as never,
      message: '第一个',
      signal: firstController.signal,
    })
    const second = manager.showWebJavascriptPromptWindow({
      hostWindow: otherHost as never,
      message: '第二个',
    })
    const firstWindow = windows[0]!
    const secondWindow = windows[1]!
    const secondRequestId = new URL(secondWindow.loadedUrls[0]!).searchParams.get('requestId')!

    firstController.abort()

    await expect(first).resolves.toEqual({ accept: false })
    expect(secondWindow.close).not.toHaveBeenCalled()
    expect(manager.getWebJavascriptPromptRequest(secondRequestId, secondWindow.webContents.id)).not.toBeNull()
    expect(firstWindow.close).toHaveBeenCalledTimes(1)

    // 通过宿主销毁收尾，确保该测试不留下未决 prompt。
    otherHost.emit('closed')
    await expect(second).resolves.toEqual({ accept: false })
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

  test('prompt webContents destroyed 时取消请求、清理映射并关闭仍存活的窗口', async () => {
    const resultPromise = manager.showWebJavascriptPromptWindow({ hostWindow: hostWindow as never, message: '渲染器崩溃' })
    const win = windows[0]!
    const requestId = new URL(win.loadedUrls[0]!).searchParams.get('requestId')!

    win.webContents.destroyed = true
    win.webContents.emit('destroyed')

    await expect(resultPromise).resolves.toEqual({ accept: false })
    expect(manager.getWebJavascriptPromptRequest(requestId, win.webContents.id)).toBeNull()
    expect(win.close).toHaveBeenCalledTimes(1)
    expect(win.listenerCount('closed')).toBe(0)
    expect(win.webContents.listenerCount('destroyed')).toBe(0)
  })

  test('prompt render-process-gone 时取消请求、清理映射并关闭窗口', async () => {
    const resultPromise = manager.showWebJavascriptPromptWindow({ hostWindow: hostWindow as never, message: '渲染进程退出' })
    const win = windows[0]!
    const requestId = new URL(win.loadedUrls[0]!).searchParams.get('requestId')!

    win.webContents.emit('render-process-gone', { reason: 'crashed' })

    await expect(resultPromise).resolves.toEqual({ accept: false })
    expect(manager.getWebJavascriptPromptRequest(requestId, win.webContents.id)).toBeNull()
    expect(win.close).toHaveBeenCalledTimes(1)
    expect(win.webContents.listenerCount('render-process-gone')).toBe(0)
  })

  test('宿主 webContents destroyed 时关闭所有子窗口、清理映射并取消请求', async () => {
    const first = manager.showWebJavascriptPromptWindow({ hostWindow: hostWindow as never, message: '第一个' })
    const second = manager.showWebJavascriptPromptWindow({ hostWindow: hostWindow as never, message: '第二个' })
    const firstWindow = windows[0]!
    const secondWindow = windows[1]!
    const firstRequestId = new URL(firstWindow.loadedUrls[0]!).searchParams.get('requestId')!
    const secondRequestId = new URL(secondWindow.loadedUrls[0]!).searchParams.get('requestId')!

    expect(hostWindow.webContents.listenerCount('destroyed')).toBe(1)
    hostWindow.webContents.destroyed = true
    hostWindow.webContents.emit('destroyed')

    await expect(first).resolves.toEqual({ accept: false })
    await expect(second).resolves.toEqual({ accept: false })
    expect(manager.getWebJavascriptPromptRequest(firstRequestId, firstWindow.webContents.id)).toBeNull()
    expect(manager.getWebJavascriptPromptRequest(secondRequestId, secondWindow.webContents.id)).toBeNull()
    expect(firstWindow.close).toHaveBeenCalledTimes(1)
    expect(secondWindow.close).toHaveBeenCalledTimes(1)
    expect(hostWindow.webContents.listenerCount('destroyed')).toBe(0)
  })

  test('同步 loadURL 异常时关闭窗口并取消请求', async () => {
    FakeBrowserWindow.throwOnLoadURL = true
    const originalConsoleError = console.error
    const loggedErrors = mock(() => undefined)
    console.error = loggedErrors

    try {
      const resultPromise = manager.showWebJavascriptPromptWindow({ hostWindow: hostWindow as never, message: '同步加载失败' })
      const win = windows[0]!
      const requestId = new URL(win.loadedUrls[0]!).searchParams.get('requestId')!

      await expect(resultPromise).resolves.toEqual({ accept: false })
      expect(manager.getWebJavascriptPromptRequest(requestId, win.webContents.id)).toBeNull()
      expect(win.close).toHaveBeenCalledTimes(1)
      expect(loggedErrors).toHaveBeenCalled()
    } finally {
      console.error = originalConsoleError
    }
  })

  test('同步 loadFile 异常时关闭窗口并取消请求', async () => {
    electronApp.isPackaged = true
    FakeBrowserWindow.throwOnLoadFile = true
    const originalConsoleError = console.error
    const loggedErrors = mock(() => undefined)
    console.error = loggedErrors

    try {
      const resultPromise = manager.showWebJavascriptPromptWindow({ hostWindow: hostWindow as never, message: '同步加载文件失败' })
      const win = windows[0]!
      const requestId = (win.loadedFiles[0]!.options as { query: { requestId: string } }).query.requestId

      await expect(resultPromise).resolves.toEqual({ accept: false })
      expect(manager.getWebJavascriptPromptRequest(requestId, win.webContents.id)).toBeNull()
      expect(win.close).toHaveBeenCalledTimes(1)
      expect(loggedErrors).toHaveBeenCalled()
    } finally {
      console.error = originalConsoleError
    }
  })
})
