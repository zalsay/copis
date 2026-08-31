/**
 * 网页 window.open 的原生子窗口策略。
 *
 * 子窗口不属于网页页签记录，生命周期只由打开它的 WebContents 和主窗口管理。
 */

export interface NativePopupContext {
  getHostWindow: () => Electron.BrowserWindow | null
  openExternal: (url: string) => Promise<void> | void
  logExternalFailure: (error: unknown) => void
}

export interface NativePopupInstallInput extends NativePopupContext {
  window: Electron.BrowserWindow
  opener?: Electron.WebContents | null
}

function isHttpWebUrl(url: string): boolean {
  return /^https?:\/\//i.test(url)
}

function openExternalSafely(input: NativePopupContext, url: string): void {
  if (!url) return
  try {
    const result = input.openExternal(url)
    if (result && typeof result.then === 'function') {
      void result.catch(input.logExternalFailure)
    }
  } catch (error) {
    input.logExternalFailure(error)
  }
}

function closeWindowSafely(window: Electron.BrowserWindow): void {
  if (window.isDestroyed()) return
  window.close()
  // beforeunload 可以取消 close；owner/host 销毁时必须保证 popup 不会遗留。
  if (!window.isDestroyed()) window.destroy()
}

function installNavigationPolicy(input: NativePopupContext, contents: Electron.WebContents): void {
  if (contents.isDestroyed()) return

  const handleNavigation = (event: Electron.Event, url: string): void => {
    if (contents.isDestroyed() || isHttpWebUrl(url)) return
    event.preventDefault()
    openExternalSafely(input, url)
  }

  contents.on('will-navigate', handleNavigation)
  contents.on('will-redirect', handleNavigation)
}

export function createWebTabWindowOpenHandler(
  input: NativePopupContext,
  opener?: Electron.WebContents | null,
): (details: Electron.HandlerDetails) => Electron.WindowOpenHandlerResponse {
  return ({ url }: Electron.HandlerDetails): Electron.WindowOpenHandlerResponse => {
    if (!isHttpWebUrl(url)) {
      openExternalSafely(input, url)
      return { action: 'deny' }
    }

    const host = input.getHostWindow()
    if (!host || host.isDestroyed()) return { action: 'deny' }

    return {
      action: 'allow',
      outlivesOpener: false,
      overrideBrowserWindowOptions: {
        parent: host,
        show: false,
        modal: false,
        autoHideMenuBar: true,
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          ...(opener && !opener.isDestroyed() ? { session: opener.session } : {}),
        },
      },
    }
  }
}

export function installNativeWebPopupWindow(input: NativePopupInstallInput): void {
  const popup = input.window
  if (popup.isDestroyed()) return

  const contents = popup.webContents
  if (!contents || contents.isDestroyed()) return

  const host = input.getHostWindow()
  if (!host || host.isDestroyed() || input.opener?.isDestroyed()) {
    closeWindowSafely(popup)
    return
  }

  let cleanupDone = false
  const cleanup = (): void => {
    if (cleanupDone) return
    cleanupDone = true
    input.opener?.removeListener('destroyed', closePopup)
    input.opener?.removeListener('render-process-gone', closePopup)
    host.removeListener('closed', closePopup)
    host.webContents.removeListener('destroyed', closePopup)
    host.webContents.removeListener('render-process-gone', closePopup)
    contents.removeListener('destroyed', closePopup)
    contents.removeListener('render-process-gone', closePopup)
  }
  const closePopup = (): void => {
    closeWindowSafely(popup)
    if (popup.isDestroyed()) cleanup()
  }

  contents.setWindowOpenHandler(createWebTabWindowOpenHandler(input, contents))
  installNavigationPolicy(input, contents)
  contents.on('did-create-window', (childWindow) => {
    installNativeWebPopupWindow({
      ...input,
      window: childWindow,
      opener: contents,
    })
  })

  popup.once('ready-to-show', () => {
    if (popup.isDestroyed()) return
    popup.show()
    if (!popup.isDestroyed()) popup.focus()
  })
  popup.once('closed', cleanup)
  contents.once('destroyed', closePopup)
  contents.once('render-process-gone', closePopup)
  input.opener?.once('destroyed', closePopup)
  input.opener?.once('render-process-gone', closePopup)
  host.once('closed', closePopup)
  host.webContents.once('destroyed', closePopup)
  host.webContents.once('render-process-gone', closePopup)
}
