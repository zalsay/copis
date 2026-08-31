import { EventEmitter } from 'node:events'
import { describe, expect, mock, test } from 'bun:test'
import { createWebTabWindowOpenHandler, installNativeWebPopupWindow } from './web-tab-native-popup'

class FakeWebContents extends EventEmitter {
  destroyed = false
  readonly session: Electron.Session
  windowOpenHandler: ((details: Electron.HandlerDetails) => Electron.WindowOpenHandlerResponse) | null = null
  willNavigateHandler: ((event: { preventDefault(): void }, url: string) => void) | null = null
  willRedirectHandler: ((event: { preventDefault(): void }, url: string) => void) | null = null
  constructor(session: Electron.Session = {} as Electron.Session) {
    super()
    this.session = session
  }
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
  test('Given 常规页签 HTTP(S) window.open When 请求新窗口 Then 继承 opener session 并固定 parent 与安全 WebPreferences', () => {
    const hostWindow = new FakeWindow()
    const context = createContext(hostWindow)
    const regularSession = {} as unknown as Electron.Session
    const opener = new FakeWebContents(regularSession)

    const response = createWebTabWindowOpenHandler(context, opener as never)({ url: 'https://login.example' } as never)

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
          session: regularSession,
        }),
      }),
    }))
  })

  test('Given 无痕页签 HTTP(S) window.open When 请求新窗口 Then 使用该无痕页签的独立 session', () => {
    const hostWindow = new FakeWindow()
    const context = createContext(hostWindow)
    const incognitoSession = {} as unknown as Electron.Session
    const opener = new FakeWebContents(incognitoSession)

    const response = createWebTabWindowOpenHandler(context, opener as never)({ url: 'https://login.example' } as never)

    expect(response.overrideBrowserWindowOptions?.webPreferences?.session).toBe(incognitoSession)
  })

  test('Given 非 HTTP(S) window.open When 请求新窗口 Then deny 并打开外部协议', async () => {
    const hostWindow = new FakeWindow()
    const context = createContext(hostWindow)

    const response = createWebTabWindowOpenHandler(context)({ url: 'mailto:owner@example.com' } as never)
    await Promise.resolve()

    expect(response).toEqual({ action: 'deny' })
    expect(context.openExternal).toHaveBeenCalledWith('mailto:owner@example.com')
  })

  test('Given Google OAuth window.open When 请求新窗口 Then deny 并用精确 URL 打开外部浏览器', () => {
    const hostWindow = new FakeWindow()
    const context = createContext(hostWindow)
    const oauthUrl = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=copis&redirect_uri=http%3A%2F%2Flocalhost%2Fcallback'

    const response = createWebTabWindowOpenHandler(context)({ url: oauthUrl } as never)

    expect(response).toEqual({ action: 'deny' })
    expect(context.openExternal).toHaveBeenCalledWith(oauthUrl)
  })

  test('Given 原生子窗口 When 导航或重定向到 Google OAuth Then 阻止导航、打开精确 URL 并关闭窗口', () => {
    for (const event of ['will-navigate', 'will-redirect'] as const) {
      const hostWindow = new FakeWindow()
      const popup = new FakeWindow()
      const context = createContext(hostWindow)
      const oauthUrl = `https://accounts.google.com/o/oauth2/v2/auth?state=${event}`

      installNativeWebPopupWindow({ ...context, window: popup as never })
      const navigationEvent = { preventDefault: mock(() => undefined) }
      const handler = event === 'will-navigate'
        ? popup.webContents.willNavigateHandler
        : popup.webContents.willRedirectHandler

      handler!(navigationEvent, oauthUrl)

      expect(navigationEvent.preventDefault).toHaveBeenCalledTimes(1)
      expect(context.openExternal).toHaveBeenCalledWith(oauthUrl)
      expect(popup.closeCalls).toBe(1)
      expect(popup.isDestroyed()).toBe(true)
      expect(hostWindow.listenerCount('closed')).toBe(0)
      expect(hostWindow.webContents.listenerCount('destroyed')).toBe(0)
      expect(hostWindow.webContents.listenerCount('render-process-gone')).toBe(0)
    }
  })

  test('Given accounts.google.com.evil.example When window.open 或导航 Then 保持普通 HTTP(S) popup 行为', () => {
    const hostWindow = new FakeWindow()
    const popup = new FakeWindow()
    const context = createContext(hostWindow)
    const attackerUrl = 'https://accounts.google.com.evil.example/o/oauth2/v2/auth'

    const response = createWebTabWindowOpenHandler(context)({ url: attackerUrl } as never)
    installNativeWebPopupWindow({ ...context, window: popup as never })
    const navigationEvent = { preventDefault: mock(() => undefined) }
    popup.webContents.willNavigateHandler!(navigationEvent, attackerUrl)

    expect(response.action).toBe('allow')
    expect(navigationEvent.preventDefault).not.toHaveBeenCalled()
    expect(context.openExternal).not.toHaveBeenCalled()
    expect(popup.closeCalls).toBe(0)
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

    const nestedPopup = child.webContents.windowOpenHandler!({ url: 'https://nested.example' } as never)
    expect(nestedPopup.overrideBrowserWindowOptions?.webPreferences?.session).toBe(child.webContents.session)
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

  test('Given 原生子窗口 When 自身 webContents 丢失渲染器 Then 关闭并清理生命周期监听器', () => {
    for (const event of ['destroyed', 'render-process-gone'] as const) {
      const hostWindow = new FakeWindow()
      const owner = new FakeWebContents()
      const popup = new FakeWindow()
      const context = createContext(hostWindow)

      installNativeWebPopupWindow({ ...context, window: popup as never, opener: owner as never })
      popup.webContents.destroyed = true
      popup.webContents.emit(event)

      expect(popup.closeCalls).toBe(1)
      expect(popup.isDestroyed()).toBe(true)
      expect(popup.listenerCount('closed')).toBe(0)
      expect(owner.listenerCount('destroyed')).toBe(0)
      expect(owner.listenerCount('render-process-gone')).toBe(0)
      expect(hostWindow.webContents.listenerCount('destroyed')).toBe(0)
      expect(hostWindow.webContents.listenerCount('render-process-gone')).toBe(0)
    }
  })

  test('Given 原生子窗口 When opener webContents 丢失渲染器 Then 关闭并清理生命周期监听器', () => {
    const hostWindow = new FakeWindow()
    const owner = new FakeWebContents()
    const popup = new FakeWindow()
    const context = createContext(hostWindow)

    installNativeWebPopupWindow({ ...context, window: popup as never, opener: owner as never })
    owner.emit('render-process-gone', { reason: 'crashed' })

    expect(popup.closeCalls).toBe(1)
    expect(popup.isDestroyed()).toBe(true)
    expect(owner.listenerCount('destroyed')).toBe(0)
    expect(owner.listenerCount('render-process-gone')).toBe(0)
    expect(hostWindow.webContents.listenerCount('destroyed')).toBe(0)
    expect(hostWindow.webContents.listenerCount('render-process-gone')).toBe(0)
  })

  test('Given 原生子窗口 When host webContents 丢失渲染器 Then 关闭并清理生命周期监听器', () => {
    for (const event of ['destroyed', 'render-process-gone'] as const) {
      const hostWindow = new FakeWindow()
      const owner = new FakeWebContents()
      const popup = new FakeWindow()
      const context = createContext(hostWindow)

      installNativeWebPopupWindow({ ...context, window: popup as never, opener: owner as never })
      hostWindow.webContents.destroyed = true
      hostWindow.webContents.emit(event, { reason: 'crashed' })

      expect(popup.closeCalls).toBe(1)
      expect(popup.isDestroyed()).toBe(true)
      expect(owner.listenerCount('destroyed')).toBe(0)
      expect(owner.listenerCount('render-process-gone')).toBe(0)
      expect(hostWindow.listenerCount('closed')).toBe(0)
      expect(hostWindow.webContents.listenerCount('destroyed')).toBe(0)
      expect(hostWindow.webContents.listenerCount('render-process-gone')).toBe(0)
    }
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
