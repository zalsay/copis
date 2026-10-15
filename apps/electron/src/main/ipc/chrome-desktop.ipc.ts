/**
 * Chrome Desktop 桌面视觉自动化 IPC 处理器
 */

import { ipcMain, BrowserWindow } from 'electron'
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

export function registerChromeDesktopIpcHandlers(): void {
  // 绑定状态广播给渲染进程
  chromeDesktopService.setStateChangedListener((state: ChromeDesktopSessionState) => {
    const allWins = BrowserWindow.getAllWindows()
    for (const win of allWins) {
      if (!win.isDestroyed()) {
        win.webContents.send(CHROME_DESKTOP_IPC_CHANNELS.STATE_CHANGED, state)
      }
    }
  })

  // 绑定单帧图片提取处理器
  chromeDesktopService.setFrameCapturer((req) => {
    return new Promise((resolve, reject) => {
      if (pendingFrameCapture) {
        clearTimeout(pendingFrameCapture.timer)
        pendingFrameCapture.reject(new Error('被后续截屏请求取代'))
        pendingFrameCapture = null
      }

      const allWins = BrowserWindow.getAllWindows()
      const mainWin = allWins.find((w) => !w.isDestroyed())
      if (!mainWin) {
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
    async (): Promise<ChromeDesktopSystemStatus> => {
      return chromeDesktopService.checkSystemStatus()
    },
  )

  ipcMain.handle(
    CHROME_DESKTOP_IPC_CHANNELS.LIST_WINDOWS,
    async (): Promise<ChromeDesktopWindowInfo[]> => {
      return chromeDesktopService.listWindows()
    },
  )

  ipcMain.handle(
    CHROME_DESKTOP_IPC_CHANNELS.PREPARE_CAPTURE,
    async (
      _,
      params: { sessionId: string; controlId: string; windowId: number; pid: number },
    ): Promise<{ ok: boolean; error?: ChromeDesktopErrorCode; message?: string }> => {
      return chromeDesktopService.prepareCapture(params)
    },
  )

  ipcMain.handle(
    CHROME_DESKTOP_IPC_CHANNELS.CONFIRM_START,
    async (
      _,
      params: { sessionId: string; controlId: string; windowId: number; pid: number },
    ): Promise<{ ok: boolean; error?: ChromeDesktopErrorCode; message?: string }> => {
      return chromeDesktopService.confirmStart(params)
    },
  )

  ipcMain.handle(
    CHROME_DESKTOP_IPC_CHANNELS.STOP_CONTROL,
    async (_, sessionId?: string): Promise<void> => {
      if (sessionId) {
        chromeDesktopService.releaseSessionControl(sessionId)
      } else {
        chromeDesktopService.releaseCurrentControl(true)
      }
    },
  )

  ipcMain.handle(
    CHROME_DESKTOP_IPC_CHANNELS.GET_STATE,
    async (): Promise<ChromeDesktopSessionState | null> => {
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
      handleFrameResponsePayload(event.sender.id, res)
    },
  )

  ipcMain.on(
    CHROME_DESKTOP_IPC_CHANNELS.STREAM_ERROR,
    (_, error: { reason: ChromeDesktopErrorCode; message: string }) => {
      console.warn('[ChromeDesktop:IPC] 渲染进程上报采集流错误:', error)
      chromeDesktopService.releaseCurrentControl(true)
    },
  )
}
