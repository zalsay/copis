import { describe, expect, it, beforeEach, beforeAll, mock } from 'bun:test'

mock.module('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => '/tmp',
    getName: () => 'Copis',
  },
  BrowserWindow: {
    getAllWindows: () => [],
    fromWebContents: () => null,
  },
  powerMonitor: { on: () => {} },
  net: {},
  Menu: { setApplicationMenu: () => {} },
  nativeImage: {},
  nativeTheme: { on: () => {} },
  protocol: { handle: () => {} },
  shell: { openExternal: async () => {} },
  dialog: {},
  ipcMain: {
    handle: () => {},
    on: () => {},
  },
  clipboard: {
    readText: () => '',
    writeText: () => {},
  },
  screen: {
    getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
  },
  session: {
    defaultSession: {},
  },
  desktopCapturer: {
    getSources: async () => [],
  },
  systemPreferences: {
    getMediaAccessStatus: () => 'granted',
  },
}))

describe('chrome-desktop.ipc frame correlation', () => {
  let handleFrameResponsePayload: typeof import('./chrome-desktop.ipc').handleFrameResponsePayload
  let setPendingFrameCaptureForTest: typeof import('./chrome-desktop.ipc').setPendingFrameCaptureForTest
  type PendingFrameCaptureRecord = import('./chrome-desktop.ipc').PendingFrameCaptureRecord

  beforeAll(async () => {
    const mod = await import('./chrome-desktop.ipc')
    handleFrameResponsePayload = mod.handleFrameResponsePayload
    setPendingFrameCaptureForTest = mod.setPendingFrameCaptureForTest
  })

  beforeEach(() => {
    setPendingFrameCaptureForTest(null)
  })

  it('drops late frame response when no pending capture request exists', () => {
    const handled = handleFrameResponsePayload(1, {
      controlId: 'cd_1',
      requestId: 'req_1',
      width: 100,
      height: 100,
      capturedAt: Date.now(),
      data: 'data:image/jpeg;base64,xxx',
    })
    expect(handled).toBe(false)
  })

  it('drops frame response when controlId mismatches', () => {
    let resolved = false
    let rejected = false
    const pending: PendingFrameCaptureRecord = {
      controlId: 'cd_expected',
      requestId: 'req_1',
      webContentsId: 1,
      timer: setTimeout(() => {}, 10000),
      resolve: () => { resolved = true },
      reject: () => { rejected = true },
    }
    setPendingFrameCaptureForTest(pending)

    const handled = handleFrameResponsePayload(1, {
      controlId: 'cd_different',
      requestId: 'req_1',
      width: 100,
      height: 100,
      capturedAt: Date.now(),
      data: 'data:image/jpeg;base64,xxx',
    })

    clearTimeout(pending.timer)
    expect(handled).toBe(false)
    expect(resolved).toBe(false)
    expect(rejected).toBe(false)
  })

  it('drops frame response when requestId mismatches', () => {
    let resolved = false
    let rejected = false
    const pending: PendingFrameCaptureRecord = {
      controlId: 'cd_1',
      requestId: 'req_expected',
      webContentsId: 1,
      timer: setTimeout(() => {}, 10000),
      resolve: () => { resolved = true },
      reject: () => { rejected = true },
    }
    setPendingFrameCaptureForTest(pending)

    const handled = handleFrameResponsePayload(1, {
      controlId: 'cd_1',
      requestId: 'req_stale',
      width: 100,
      height: 100,
      capturedAt: Date.now(),
      data: 'data:image/jpeg;base64,xxx',
    })

    clearTimeout(pending.timer)
    expect(handled).toBe(false)
    expect(resolved).toBe(false)
    expect(rejected).toBe(false)
  })

  it('drops frame response when webContentsId mismatches (originated from another renderer)', () => {
    let resolved = false
    let rejected = false
    const pending: PendingFrameCaptureRecord = {
      controlId: 'cd_1',
      requestId: 'req_1',
      webContentsId: 1,
      timer: setTimeout(() => {}, 10000),
      resolve: () => { resolved = true },
      reject: () => { rejected = true },
    }
    setPendingFrameCaptureForTest(pending)

    const handled = handleFrameResponsePayload(999, {
      controlId: 'cd_1',
      requestId: 'req_1',
      width: 100,
      height: 100,
      capturedAt: Date.now(),
      data: 'data:image/jpeg;base64,xxx',
    })

    clearTimeout(pending.timer)
    expect(handled).toBe(false)
    expect(resolved).toBe(false)
    expect(rejected).toBe(false)
  })

  it('accepts and resolves matching frame response', async () => {
    const promise = new Promise<{ width: number; height: number; capturedAt: number; data: string }>((resolve, reject) => {
      const pending: PendingFrameCaptureRecord = {
        controlId: 'cd_1',
        requestId: 'req_1',
        webContentsId: 42,
        timer: setTimeout(() => {}, 10000),
        resolve,
        reject,
      }
      setPendingFrameCaptureForTest(pending)
    })

    const now = Date.now()
    const handled = handleFrameResponsePayload(42, {
      controlId: 'cd_1',
      requestId: 'req_1',
      width: 1920,
      height: 1080,
      capturedAt: now,
      data: 'jpeg_payload',
    })

    expect(handled).toBe(true)
    const result = await promise
    expect(result.width).toBe(1920)
    expect(result.height).toBe(1080)
    expect(result.capturedAt).toBe(now)
    expect(result.data).toBe('jpeg_payload')
  })

  it('rejects pending capture when response contains error message', async () => {
    const promise = new Promise<{ width: number; height: number; capturedAt: number; data: string }>((resolve, reject) => {
      const pending: PendingFrameCaptureRecord = {
        controlId: 'cd_1',
        requestId: 'req_1',
        webContentsId: 42,
        timer: setTimeout(() => {}, 10000),
        resolve,
        reject,
      }
      setPendingFrameCaptureForTest(pending)
    })

    const handled = handleFrameResponsePayload(42, {
      controlId: 'cd_1',
      requestId: 'req_1',
      width: 0,
      height: 0,
      capturedAt: Date.now(),
      data: '',
      error: 'CHROME_CAPTURE_FAILED: 超过 1 MiB 限制',
    })

    expect(handled).toBe(true)
    await expect(promise).rejects.toThrow('CHROME_CAPTURE_FAILED: 超过 1 MiB 限制')
  })
})
