/**
 * Chrome Desktop 桌面视觉自动化 IPC 处理器
 */

import { BrowserWindow, ipcMain, powerMonitor, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import {
  CHROME_DESKTOP_IPC_CHANNELS,
  type ChromeDesktopErrorCode,
  type ChromeDesktopSessionState,
  type ChromeDesktopSystemStatus,
  type ChromeDesktopWindowInfo,
} from '@copis/shared'
import { chromeDesktopService } from '../lib/chrome-desktop-service'

export interface PendingFrameCaptureRecord {
  controlId: string
  requestId: string
  webContentsId: number
  resolve: (res: {
    width: number
    height: number
    capturedAt: number
    data: string
    presentedFrames?: number
    mediaTime?: number
    encodedAt?: number
  }) => void
  reject: (err: any) => void
  timer: ReturnType<typeof setTimeout>
}

let frameRequestSeq = 0
let pendingFrameCapture: PendingFrameCaptureRecord | null = null

export function getPendingFrameCapture(): PendingFrameCaptureRecord | null {
  return pendingFrameCapture
}

export function setPendingFrameCaptureForTest(record: PendingFrameCaptureRecord | null): void {
  pendingFrameCapture = record
}

export function handleFrameResponsePayload(
  senderWebContentsId: number,
  res: {
    controlId: string
    requestId: string
    width: number
    height: number
    capturedAt: number
    data: string
    error?: string
    presentedFrames?: number
    mediaTime?: number
    encodedAt?: number
  },
): boolean {
  if (!pendingFrameCapture) {
    console.warn(`[ChromeDesktop:IPC] 收到迟到帧回传 (当前无等待请求): controlId=${res.controlId}, requestId=${res.requestId}`)
    return false
  }

  if (
    pendingFrameCapture.controlId !== res.controlId ||
    pendingFrameCapture.requestId !== res.requestId ||
    pendingFrameCapture.webContentsId !== senderWebContentsId
  ) {
    console.warn(
      `[ChromeDesktop:IPC] 丢弃不匹配的帧回传: 期望(controlId=${pendingFrameCapture.controlId}, reqId=${pendingFrameCapture.requestId}, wcId=${pendingFrameCapture.webContentsId}), ` +
      `收到(controlId=${res.controlId}, reqId=${res.requestId}, wcId=${senderWebContentsId})`,
    )
    return false
  }

  clearTimeout(pendingFrameCapture.timer)
  const cur = pendingFrameCapture
  pendingFrameCapture = null

  if (res.error) {
    cur.reject(new Error(res.error))
  } else {
    cur.resolve({
      width: res.width,
      height: res.height,
      capturedAt: res.capturedAt,
      data: res.data,
      ...(res.presentedFrames !== undefined ? { presentedFrames: res.presentedFrames } : {}),
      ...(res.mediaTime !== undefined ? { mediaTime: res.mediaTime } : {}),
      ...(res.encodedAt !== undefined ? { encodedAt: res.encodedAt } : {}),
    })
  }
  return true
}

function isMainRendererWindow(win: BrowserWindow): boolean {
  if (win.isDestroyed()) return false
  const url = win.webContents.mainFrame?.url ?? win.webContents.getURL?.() ?? ''
  if (!url) return false
  try {
    return new URL(url).searchParams.get('window') === null
  } catch {
    return false
  }
}

function resolveMainWindow(): BrowserWindow | null {
  return BrowserWindow.getAllWindows().find((win) => isMainRendererWindow(win)) ?? null
}

function requireMainSender(event: IpcMainEvent | IpcMainInvokeEvent): void {
  const win = resolveMainWindow()
  if (!win || event.sender.id !== win.webContents.id || event.senderFrame !== win.webContents.mainFrame) {
    throw new Error('CHROME_UNSUPPORTED_CONTEXT: 仅允许主窗口顶层调用')
  }
}

function requireControlInput(input: unknown): asserts input is { sessionId: string; controlId: string } {
  if (!input || typeof input !== 'object' || !('sessionId' in input) || typeof input.sessionId !== 'string' || !input.sessionId || !('controlId' in input) || typeof input.controlId !== 'string' || !input.controlId) {
    throw new Error('CHROME_CAPABILITY_STALE: 缺少控制标识')
  }
}

function cancelPendingFrame(): void {
  const pending = pendingFrameCapture
  if (!pending) return
  pendingFrameCapture = null
  clearTimeout(pending.timer)
  pending.reject(new Error('CHROME_CANCELLED: 本次采集已结束'))
}

export function registerChromeDesktopIpcHandlers(): void {
  // 原生窗口不保证按创建顺序排列，采集只绑定主窗口。
  const watched = new WeakSet<object>()
  const watchWindow = () => {
    const win = resolveMainWindow()
    if (!win || watched.has(win)) return
    watched.add(win)
    const stop = () => { chromeDesktopService.releaseCurrentControl(true); cancelPendingFrame() }
    win.on('minimize', stop)
    win.on('closed', stop)
    win.webContents.on('render-process-gone', stop)
    win.webContents.on('did-start-navigation', (_event, _url, _isInPlace, isMainFrame) => {
      if (isMainFrame) stop()
    })
  }
  chromeDesktopService.setStateChangedListener((state: ChromeDesktopSessionState) => {
    watchWindow()
    if (['paused', 'stopped', 'error'].includes(state.state)) cancelPendingFrame()
    const win = resolveMainWindow()
    if (win) win.webContents.send(CHROME_DESKTOP_IPC_CHANNELS.STATE_CHANGED, state)
  })
  const releaseForPowerState = () => { chromeDesktopService.releaseCurrentControl(true); cancelPendingFrame() }
  powerMonitor.on('lock-screen', releaseForPowerState)
  powerMonitor.on('suspend', releaseForPowerState)

  // 绑定单帧图片提取处理器
  chromeDesktopService.setFrameCapturer((req) => {
    return new Promise((resolve, reject) => {
      if (pendingFrameCapture) {
        clearTimeout(pendingFrameCapture.timer)
        pendingFrameCapture.reject(new Error('被后续截屏请求取代'))
        pendingFrameCapture = null
      }

      const mainWin = resolveMainWindow()
      if (!mainWin || mainWin.isDestroyed()) {
        return reject(new Error('CHROME_CAPTURE_FAILED: 主窗口不可用'))
      }

      const requestId = `req_${++frameRequestSeq}_${Date.now()}`
      const timer = setTimeout(() => {
        if (pendingFrameCapture && pendingFrameCapture.requestId === requestId) {
          pendingFrameCapture = null
          reject(new Error('CHROME_CAPTURE_FAILED: 渲染进程截帧超时 (2s)'))
        }
      }, 2000)

      pendingFrameCapture = {
        controlId: req.controlId,
        requestId,
        webContentsId: mainWin.webContents.id,
        resolve,
        reject,
        timer,
      }
      mainWin.webContents.send(CHROME_DESKTOP_IPC_CHANNELS.REQUEST_FRAME, {
        controlId: req.controlId,
        requestId,
        geometryVersion: req.geometryVersion,
      })
    })
  })

  // ===== IPC Handlers =====

  ipcMain.handle(
    CHROME_DESKTOP_IPC_CHANNELS.CHECK_STATUS,
    async (event): Promise<ChromeDesktopSystemStatus> => {
      requireMainSender(event)
      return chromeDesktopService.checkSystemStatus()
    },
  )

  ipcMain.handle(
    CHROME_DESKTOP_IPC_CHANNELS.LIST_WINDOWS,
    async (event): Promise<ChromeDesktopWindowInfo[]> => {
      requireMainSender(event)
      return chromeDesktopService.listWindows()
    },
  )

  ipcMain.handle(
    CHROME_DESKTOP_IPC_CHANNELS.PREPARE_CAPTURE,
    async (
      event,
      params: { sessionId: string; controlId: string; windowId: number; pid: number },
    ): Promise<{ ok: boolean; error?: ChromeDesktopErrorCode; message?: string }> => {
      requireMainSender(event)
      requireControlInput(params)
      if (!Number.isSafeInteger(params.windowId) || params.windowId <= 0 || !Number.isSafeInteger(params.pid) || params.pid <= 0) throw new Error('窗口参数不合法')
      return chromeDesktopService.prepareCapture(params)
    },
  )

  ipcMain.handle(
    CHROME_DESKTOP_IPC_CHANNELS.CONFIRM_START,
    async (
      event,
      params: { sessionId: string; controlId: string; windowId: number; pid: number },
    ): Promise<{ ok: boolean; error?: ChromeDesktopErrorCode; message?: string }> => {
      requireMainSender(event)
      requireControlInput(params)
      if (!Number.isSafeInteger(params.windowId) || params.windowId <= 0 || !Number.isSafeInteger(params.pid) || params.pid <= 0) throw new Error('窗口参数不合法')
      return chromeDesktopService.confirmStart(params)
    },
  )

  ipcMain.handle(
    CHROME_DESKTOP_IPC_CHANNELS.STOP_CONTROL,
    async (event, input: { sessionId: string; controlId: string }): Promise<void> => {
      requireMainSender(event)
      requireControlInput(input)
      chromeDesktopService.releaseSessionControl(input.sessionId, undefined, input.controlId)
    },
  )

  ipcMain.handle(
    CHROME_DESKTOP_IPC_CHANNELS.GET_STATE,
    async (event): Promise<ChromeDesktopSessionState | null> => {
      requireMainSender(event)
      return chromeDesktopService.getSessionState()
    },
  )

  // 渲染进程回传截取到的单帧图片
  ipcMain.on(
    CHROME_DESKTOP_IPC_CHANNELS.FRAME_RESPONSE,
    (
      event,
      res: {
        controlId: string
        requestId: string
        width: number
        height: number
        capturedAt: number
        data: string
        error?: string
      },
    ) => {
      try { requireMainSender(event) } catch { return }
      handleFrameResponsePayload(event.sender.id, res)
    },
  )

  ipcMain.on(
    CHROME_DESKTOP_IPC_CHANNELS.STREAM_ERROR,
    (event, error: { controlId: string; reason: ChromeDesktopErrorCode; message: string }) => {
      try { requireMainSender(event) } catch { return }
      const state = chromeDesktopService.getSessionState()
      if (!error || !state || state.controlId !== error.controlId) return
      chromeDesktopService.releaseSessionControl(state.sessionId, undefined, error.controlId)
    },
  )
}
