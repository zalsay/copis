import { expect, mock, test } from 'bun:test'
import { CHROME_DESKTOP_IPC_CHANNELS as CHANNELS } from '@copis/shared'

const handlers = new Map<string, (...args: any[]) => any>()
const listeners = new Map<string, (...args: any[]) => any>()
const mainFrame = { url: 'file:///copis/index.html' }
const mainContents = { id: 1, mainFrame, getURL: () => 'file:///copis/index.html', send: mock(() => {}), on: mock(() => {}) }
const mainWindow = { isDestroyed: () => false, webContents: mainContents, on: mock(() => {}) }
let broadcaster: (state: any) => void
let capture: (request: any) => Promise<any>
const release = mock(() => {})
let state = { sessionId: 'A', controlId: 'control-new', state: 'active' }
mock.module('electron', () => ({
  BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: { id: 99, send: mock(() => {}) } }, mainWindow] },
  powerMonitor: { on: () => {} },
  net: {},
  Menu: { setApplicationMenu: () => {} },
  nativeImage: {},
  nativeTheme: { on: () => {} },
  protocol: { handle: () => {} },
  shell: { openExternal: async () => {} },
  app: { isPackaged: false, getPath: () => '/tmp', getName: () => 'Copis' },
  dialog: {},
  ipcMain: {
    handle: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler),
    on: (name: string, handler: (...args: any[]) => any) => listeners.set(name, handler),
  },
}))
mock.module('../lib/chrome-desktop-service', () => ({ chromeDesktopService: {
  setStateChangedListener: (listener: typeof broadcaster) => { broadcaster = listener },
  setFrameCapturer: (fn: typeof capture) => { capture = fn },
  getSessionState: () => state,
  checkSystemStatus: async () => ({}), listWindows: async () => [],
  prepareCapture: () => ({ ok: true }), confirmStart: async () => ({ ok: true }),
  releaseSessionControl: release, releaseCurrentControl: release,
} }))
const { registerChromeDesktopIpcHandlers } = await import('./chrome-desktop.ipc')
registerChromeDesktopIpcHandlers()
const event = { sender: mainContents, senderFrame: mainFrame }

test('Given 其他窗口或子 frame When 准备/确认/停止/读取 Then 拒绝 IPC', async () => {
  for (const channel of [CHANNELS.CHECK_STATUS, CHANNELS.LIST_WINDOWS, CHANNELS.PREPARE_CAPTURE, CHANNELS.CONFIRM_START, CHANNELS.STOP_CONTROL, CHANNELS.GET_STATE]) {
    await expect(Promise.resolve().then(() => handlers.get(channel)!({ sender: { id: 99 }, senderFrame: mainFrame }, {}))).rejects.toThrow()
    await expect(Promise.resolve().then(() => handlers.get(channel)!({ sender: mainContents, senderFrame: { parent: mainFrame } }, {}))).rejects.toThrow()
  }
})

test('Given 多窗口顺序并非主窗口优先 When 请求帧 Then 只发给可信主窗口', async () => {
  const pending = capture({ controlId: 'control-new', geometryVersion: 1 })
  expect(mainContents.send).toHaveBeenCalledWith(CHANNELS.REQUEST_FRAME, expect.objectContaining({ controlId: 'control-new' }))
  const request = (mainContents.send.mock.calls as any[]).at(-1)![1] as any
  listeners.get(CHANNELS.FRAME_RESPONSE)!(event, { controlId: 'control-new', requestId: request.requestId, width: 100, height: 100, capturedAt: Date.now(), data: '/9j/AA==' })
  await pending
})

test('Given 旧流错误回报 When 新控制已运行 Then 不释放新控制', () => {
  release.mockClear()
  listeners.get(CHANNELS.STREAM_ERROR)!(event, { controlId: 'control-old', reason: 'CHROME_CAPTURE_FAILED', message: '旧流已结束' })
  expect(release).not.toHaveBeenCalled()
})

test('Given 其他 Renderer 发出停止错误事件 Then 无权释放控制', () => {
  release.mockClear()
  listeners.get(CHANNELS.STREAM_ERROR)!({ sender: { id: 99 }, senderFrame: mainFrame }, { controlId: 'control-new', reason: 'CHROME_CAPTURE_FAILED', message: '伪造' })
  expect(release).not.toHaveBeenCalled()
})

test('Given 迟到停止对象属于旧 control Then release 必须携带本次 controlId', async () => {
  release.mockClear()
  await handlers.get(CHANNELS.STOP_CONTROL)!(event, { sessionId: 'A', controlId: 'control-old' })
  expect(release).toHaveBeenCalledWith('A', undefined, 'control-old')
})
