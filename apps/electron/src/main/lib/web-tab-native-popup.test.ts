import { EventEmitter } from 'node:events'
import { describe, expect, mock, test } from 'bun:test'
import { createWebTabWindowOpenHandler, installNativeWebPopupWindow } from './web-tab-native-popup'

class FakeWebContents extends EventEmitter {
  destroyed = false
  windowOpenHandler: ((details: Electron.HandlerDetails) => Electron.WindowOpenHandlerResponse) | null = null
  willNavigateHandler: ((event: { preventDefault(): void }, url: string) => void) | null = null
  willRedirectHandler: ((event: { preventDefault(): void }, url: string) => void) | null = null
  setWindowOpenHandler(handler: (details: Electron.HandlerDetails) => Electron.WindowOpenHandlerResponse): void {
    this.windowOpenHandler = handler
  }
  isDestroyed(): boolean {
    return this.destroyed
  }
  override on(event: string, listener: (...args: any[]) => void): this {
    if (event === 'will-navigate') this.willNavigateHandler = listener
    if (event === 'will-redirect') this.willRedirectHandler = listener
    return super.on(event, listener)
  }
}

class FakeWindow extends EventEmitter {
  destroyed = false
  visible = false
  focused = false
  closeCalls = 0
  destroyCalls = 0
  cancelClose = false
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
    if (this.cancelClose) return
    this.dispose()
  }
  destroy(): void {
    this.destroyCalls += 1
    this.dispose()
  }
  private dispose(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.webContents.destroyed = true
    this.emit('closed')
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
    expect(popup.webContents.willRedirectHandler).toBeFunction()

    const navigationEvent = { preventDefault: mock(() => undefined) }
    popup.webContents.willNavigateHandler!(navigationEvent, 'file:///tmp/private.html')
    expect(navigationEvent.preventDefault).toHaveBeenCalledTimes(1)
    expect(context.openExternal).toHaveBeenCalledWith('file:///tmp/private.html')

    popup.webContents.emit('did-create-window', child, { url: 'https://child.example' })
    expect(child.webContents.windowOpenHandler).toBeFunction()
    expect(child.webContents.willNavigateHandler).toBeFunction()
  })

  test('Given 原生子窗口收到 HTTP(S) 导航 When 触发 will-navigate Then 不阻止页内跳转且不交给外部协议处理', () => {
    const hostWindow = new FakeWindow()
    const popup = new FakeWindow()
    const context = createContext(hostWindow)

    installNativeWebPopupWindow({ ...context, window: popup as never })

    const httpNavigateEvent = { preventDefault: mock(() => undefined) }
    popup.webContents.willNavigateHandler!(httpNavigateEvent, 'https://inside.example/next')

    expect(httpNavigateEvent.preventDefault).not.toHaveBeenCalled()
    expect(context.openExternal).not.toHaveBeenCalled()
  })

  test('Given 原生子窗口收到非 HTTP(S) 导航 When 触发 will-navigate Then 阻止页内跳转并交给外部协议处理', () => {
    const hostWindow = new FakeWindow()
    const popup = new FakeWindow()
    const context = createContext(hostWindow)

    installNativeWebPopupWindow({ ...context, window: popup as never })

    const externalNavigateEvent = { preventDefault: mock(() => undefined) }
    popup.webContents.willNavigateHandler!(externalNavigateEvent, 'file:///tmp/private.html')

    expect(externalNavigateEvent.preventDefault).toHaveBeenCalledTimes(1)
    expect(context.openExternal).toHaveBeenCalledWith('file:///tmp/private.html')
  })

  test('Given 原生子窗口收到 HTTP(S) 重定向 When 触发 will-redirect Then 不阻止页内跳转且不交给外部协议处理', () => {
    const hostWindow = new FakeWindow()
    const popup = new FakeWindow()
    const context = createContext(hostWindow)

    installNativeWebPopupWindow({ ...context, window: popup as never })

    const httpRedirectEvent = { preventDefault: mock(() => undefined) }
    popup.webContents.willRedirectHandler!(httpRedirectEvent, 'https://inside.example/next')

    expect(httpRedirectEvent.preventDefault).not.toHaveBeenCalled()
    expect(context.openExternal).not.toHaveBeenCalled()
  })

  test('Given 原生子窗口收到非 HTTP(S) 重定向 When 触发 will-redirect Then 阻止页内跳转并交给外部协议处理', () => {
    const hostWindow = new FakeWindow()
    const popup = new FakeWindow()
    const context = createContext(hostWindow)

    installNativeWebPopupWindow({ ...context, window: popup as never })

    const externalRedirectEvent = { preventDefault: mock(() => undefined) }
    popup.webContents.willRedirectHandler!(externalRedirectEvent, 'mailto:owner@example.com')

    expect(externalRedirectEvent.preventDefault).toHaveBeenCalledTimes(1)
    expect(context.openExternal).toHaveBeenCalledWith('mailto:owner@example.com')
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

  test('Given owner 与 host 各有独立 popup When 分别销毁 Then 各自关闭 popup 并清理对应生命周期监听器', () => {
    const ownerHostWindow = new FakeWindow()
    const owner = new FakeWebContents()
    const ownerPopup = new FakeWindow()
    const ownerContext = createContext(ownerHostWindow)

    installNativeWebPopupWindow({ ...ownerContext, window: ownerPopup as never, opener: owner as never })
    owner.emit('destroyed')

    expect(ownerPopup.closeCalls).toBe(1)
    expect(ownerPopup.isDestroyed()).toBe(true)
    expect(owner.listenerCount('destroyed')).toBe(0)
    expect(ownerHostWindow.listenerCount('closed')).toBe(0)

    const hostWindow = new FakeWindow()
    const hostOwner = new FakeWebContents()
    const hostPopup = new FakeWindow()
    const hostContext = createContext(hostWindow)

    installNativeWebPopupWindow({ ...hostContext, window: hostPopup as never, opener: hostOwner as never })
    hostWindow.emit('closed')

    expect(hostPopup.closeCalls).toBe(1)
    expect(hostPopup.isDestroyed()).toBe(true)
    expect(hostOwner.listenerCount('destroyed')).toBe(0)
    expect(hostWindow.listenerCount('closed')).toBe(0)
  })

  test('Given popup 页面取消 beforeunload When owner 或 host 销毁 Then 仍强制销毁 popup 且保留生命周期清理', () => {
    const hostWindow = new FakeWindow()
    const owner = new FakeWebContents()
    const popup = new FakeWindow()
    popup.cancelClose = true
    const context = createContext(hostWindow)

    installNativeWebPopupWindow({ ...context, window: popup as never, opener: owner as never })
    owner.emit('destroyed')

    expect(popup.closeCalls).toBe(1)
    expect(popup.destroyCalls).toBe(1)
    expect(popup.isDestroyed()).toBe(true)
    expect(popup.listenerCount('closed')).toBe(0)
    expect(owner.listenerCount('destroyed')).toBe(0)
    expect(hostWindow.listenerCount('closed')).toBe(0)

    hostWindow.emit('closed')
    expect(popup.closeCalls).toBe(1)
    expect(popup.destroyCalls).toBe(1)
  })
})
