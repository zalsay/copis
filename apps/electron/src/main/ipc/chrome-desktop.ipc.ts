/** Chrome 组件控制 IPC；图片与输入只由主进程调用原生组件。 */
import { BrowserWindow, ipcMain, powerMonitor, type IpcMainInvokeEvent } from 'electron'
import { CHROME_DESKTOP_IPC_CHANNELS, type ChromeDesktopSessionState } from '@copis/shared'
import { chromeDesktopService } from '../lib/chrome-desktop-service'

function resolveMainWindow(): BrowserWindow | null {
  return BrowserWindow.getAllWindows().find((window) => {
    if (window.isDestroyed()) return false
    const url = window.webContents.mainFrame?.url ?? window.webContents.getURL?.()
    try { return Boolean(url) && new URL(url).searchParams.get('window') === null } catch { return false }
  }) ?? null
}
function requireMainSender(event: IpcMainInvokeEvent): void {
  const main = resolveMainWindow()
  if (!main || event.sender.id !== main.webContents.id || event.senderFrame !== main.webContents.mainFrame) throw new Error('CHROME_UNSUPPORTED_CONTEXT: 仅允许主窗口顶层调用')
}
function requireControlInput(input: unknown): asserts input is { sessionId: string; controlId: string } {
  if (!input || typeof input !== 'object' || !('sessionId' in input) || typeof input.sessionId !== 'string' || !input.sessionId || !('controlId' in input) || typeof input.controlId !== 'string' || !input.controlId) throw new Error('CHROME_CAPABILITY_STALE: 缺少控制标识')
}
function requireWindowInput(input: unknown): asserts input is { sessionId: string; controlId: string; windowId: number; pid: number } {
  requireControlInput(input)
  if (!('windowId' in input) || !Number.isSafeInteger(input.windowId) || (input.windowId as number) <= 0 || !('pid' in input) || !Number.isSafeInteger(input.pid) || (input.pid as number) <= 0) throw new Error('CHROME_WINDOW_UNAVAILABLE: 窗口标识不合法')
}
export function registerChromeDesktopIpcHandlers(): void {
  const watched = new WeakSet<BrowserWindow>()
  const stop = () => chromeDesktopService.releaseCurrentControl(true)
  const watchWindow = () => {
    const main = resolveMainWindow()
    if (!main || watched.has(main)) return
    watched.add(main)
    main.on('minimize', stop)
    main.on('closed', stop)
    main.webContents.on('render-process-gone', stop)
    main.webContents.on('did-start-navigation', (_event, _url, _inPlace, isMainFrame) => { if (isMainFrame) stop() })
  }
  chromeDesktopService.setStateChangedListener((state: ChromeDesktopSessionState) => {
    watchWindow()
    resolveMainWindow()?.webContents.send(CHROME_DESKTOP_IPC_CHANNELS.STATE_CHANGED, state)
  })
  powerMonitor.on('lock-screen', stop)
  powerMonitor.on('suspend', stop)
  watchWindow()

  ipcMain.handle(CHROME_DESKTOP_IPC_CHANNELS.CHECK_STATUS, async (event) => {
    requireMainSender(event)
    return chromeDesktopService.checkSystemStatus()
  })
  ipcMain.handle(CHROME_DESKTOP_IPC_CHANNELS.LIST_WINDOWS, async (event) => {
    requireMainSender(event)
    return chromeDesktopService.listWindows()
  })
  ipcMain.handle(CHROME_DESKTOP_IPC_CHANNELS.PREPARE_CAPTURE, (event, input: unknown) => {
    requireMainSender(event)
    requireWindowInput(input)
    return chromeDesktopService.prepareCapture(input)
  })
  ipcMain.handle(CHROME_DESKTOP_IPC_CHANNELS.CONFIRM_START, async (event, input: unknown) => {
    requireMainSender(event)
    requireWindowInput(input)
    return chromeDesktopService.confirmStart(input)
  })
  ipcMain.handle(CHROME_DESKTOP_IPC_CHANNELS.STOP_CONTROL, async (event, input: unknown) => {
    requireMainSender(event)
    requireControlInput(input)
    await chromeDesktopService.stopSessionControl(input.sessionId, input.controlId)
  })
  ipcMain.handle(CHROME_DESKTOP_IPC_CHANNELS.GET_STATE, (event) => {
    requireMainSender(event)
    return chromeDesktopService.getSessionState()
  })
}
