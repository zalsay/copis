import { EventEmitter } from 'node:events'
import { describe, expect, mock, test } from 'bun:test'
import { createWebTabWindowOpenHandler, installNativeWebPopupWindow } from './web-tab-native-popup'

class FakeWebContents extends EventEmitter {
  destroyed = false
  windowOpenHandler: ((details: Electron.HandlerDetails) => Electron.WindowOpenHandlerResponse) | null = null
  willNavigateHandler: ((event: { preventDefault(): void }, url: string) => void) | null = null
  setWindowOpenHandler(handler: (details: Electron.HandlerDetails) => Electron.WindowOpenHandlerResponse): void {
    this.windowOpenHandler = handler
  }
  isDestroyed(): boolean {
    return this.destroyed
  }
  override on(event: string, listener: (...args: any[]) => void): this {
    if (event === 'will-navigate') this.willNavigateHandler = listener
    return super.on(event, listener)
  }
}

class FakeWindow extends EventEmitter {
  destroyed = false
  visible = false
  focused = false
  closeCalls = 0
  readonly webContents = new FakeWebContents()
  isDestroyed(): boolean {
    return this.destroyed
  }
  show(): void {
    this.visible = true
  }
  focus(): void {
    this.focused = true
  }
  close(): void {
    this.closeCalls += 1
    this.destroyed = true
    this.webContents.destroyed = true
  }
}

function createContext(hostWindow: FakeWindow) {
  return {
    getHostWindow: () => hostWindow as never,
    openExternal: mock(async (_url: string) => undefined),
    logExternalFailure: mock((_error: unknown) => undefined),
  }
}

describe('网页原生子窗口策略', () => {
  test('Given HTTP(S) window.open When 请求新窗口 Then allow 并固定 parent 与安全 WebPreferences', () => {
    const hostWindow = new FakeWindow()
    const context = createContext(hostWindow)

    const response = createWebTabWindowOpenHandler(context)({ url: 'https://login.example' } as never)

    expect(response).toEqual(expect.objectContaining({
      action: 'allow',
      outlivesOpener: false,
      overrideBrowserWindowOptions: expect.objectContaining({
        parent: hostWindow,
        show: false,
        modal: false,
        webPreferences: expect.objectContaining({
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        }),
      }),
    }))
  })

  test('Given 非 HTTP(S) window.open When 请求新窗口 Then deny 并打开外部协议', async () => {
    const hostWindow = new FakeWindow()
    const context = createContext(hostWindow)

    const response = createWebTabWindowOpenHandler(context)({ url: 'mailto:owner@example.com' } as never)
    await Promise.resolve()

    expect(response).toEqual({ action: 'deny' })
    expect(context.openExternal).toHaveBeenCalledWith('mailto:owner@example.com')
  })

  test('Given 原生子窗口 When ready-to-show Then 显示聚焦且递归安装新窗口和导航策略', () => {
    const hostWindow = new FakeWindow()
    const owner = new FakeWebContents()
    const popup = new FakeWindow()
    const child = new FakeWindow()
    const context = createContext(hostWindow)

    installNativeWebPopupWindow({ ...context, window: popup as never, opener: owner as never })
    popup.emit('ready-to-show')

    expect(popup.visible).toBe(true)
    expect(popup.focused).toBe(true)
    expect(popup.webContents.windowOpenHandler).toBeFunction()
    expect(popup.webContents.willNavigateHandler).toBeFunction()

    const navigationEvent = { preventDefault: mock(() => undefined) }
    popup.webContents.willNavigateHandler!(navigationEvent, 'file:///tmp/private.html')
    expect(navigationEvent.preventDefault).toHaveBeenCalledTimes(1)
    expect(context.openExternal).toHaveBeenCalledWith('file:///tmp/private.html')

    popup.webContents.emit('did-create-window', child, { url: 'https://child.example' })
    expect(child.webContents.windowOpenHandler).toBeFunction()
    expect(child.webContents.willNavigateHandler).toBeFunction()
  })

  test('Given 原生子窗口 When host 或 opener 销毁 Then 安全关闭且不访问已销毁 webContents', () => {
    const hostWindow = new FakeWindow()
    const owner = new FakeWebContents()
    const popup = new FakeWindow()
    const context = createContext(hostWindow)

    installNativeWebPopupWindow({ ...context, window: popup as never, opener: owner as never })
    owner.emit('destroyed')
    expect(popup.closeCalls).toBe(1)

    popup.webContents.destroyed = true
    hostWindow.emit('closed')
    expect(popup.closeCalls).toBe(1)
  })
})
