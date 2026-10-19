import { expect, mock, test } from 'bun:test'
import { CHROME_DESKTOP_IPC_CHANNELS as CHANNELS } from '@copis/shared'

const handlers = new Map<string, (...args: any[]) => any>()
const listeners = new Map<string, (...args: any[]) => any>()
const mainFrame = { url: 'file:///copis/index.html' }
const mainContents = { id: 1, mainFrame, getURL: () => 'file:///copis/index.html', send: mock(() => {}), on: mock(() => {}) }
const mainWindow = { isDestroyed: () => false, webContents: mainContents, on: mock(() => {}) }
let broadcaster: (state: any) => void
const release = mock((..._args: unknown[]) => {})
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
  getSessionState: () => state,
  checkSystemStatus: async () => ({}), listWindows: async () => [],
  prepareCapture: () => ({ ok: true }), confirmStart: async () => ({ ok: true }),
  releaseSessionControl: release, releaseCurrentControl: release,
  stopSessionControl: async (sessionId: string, controlId: string) => release(sessionId, undefined, controlId),
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

test('Given 多窗口顺序并非主窗口优先 When 广播状态 Then 只发给可信主窗口', () => {
  const snapshot = { sessionId: 'A', controlId: 'control-new', state: 'active' }
  broadcaster(snapshot)
  expect(mainContents.send).toHaveBeenCalledWith(CHANNELS.STATE_CHANGED, snapshot)
})

test('Given 原生组件已连接 When renderer旧图像或stream-error事件到达 Then 没有可撤销连接的监听器', () => {
  expect(listeners.has('chrome-desktop:frame-response')).toBe(false)
  expect(listeners.has('chrome-desktop:stream-error')).toBe(false)
  expect(release).not.toHaveBeenCalled()
})

test('Given 迟到停止对象属于旧 control Then release 必须携带本次 controlId', async () => {
  release.mockClear()
  await handlers.get(CHANNELS.STOP_CONTROL)!(event, { sessionId: 'A', controlId: 'control-old' })
  expect(release).toHaveBeenCalledWith('A', undefined, 'control-old')
})
