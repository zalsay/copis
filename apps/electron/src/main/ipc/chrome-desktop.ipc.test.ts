import { beforeEach, expect, mock, test } from 'bun:test'
import { CHROME_DESKTOP_IPC_CHANNELS as CHANNELS } from '@copis/shared'
const handlers = new Map<string, (...args: any[]) => any>()
const listeners = new Map<string, (...args: any[]) => any>()
const lifecycle = new Map<string, (...args: any[]) => any>()
const mainFrame = { url: 'file:///copis/index.html' }
const contents = { id: 1, mainFrame, getURL: () => mainFrame.url, send: mock(() => {}), on: (name: string, fn: (...args: any[]) => any) => lifecycle.set(name, fn) }
const mainWindow = { isDestroyed: () => false, webContents: contents, on: (name: string, fn: (...args: any[]) => any) => lifecycle.set(name, fn) }
const power = new Map<string, (...args: any[]) => any>()
const service = {
  releaseCurrentControl: mock(() => {}), releaseSessionControl: mock(() => {}), stopSessionControl: mock(async () => {}),
  checkSystemStatus: mock(async () => ({ supported: true, componentVersion: '0.1.0' })),
  listWindows: mock(async () => []), prepareCapture: mock(() => ({ ok: true })),
  confirmStart: mock(async () => ({ ok: true })), getSessionState: mock(() => ({ sessionId: 'A', controlId: 'c' })),
  setStateChangedListener: mock((_listener: any) => {}),
}
mock.module('electron', () => ({
  BrowserWindow: { getAllWindows: () => [mainWindow] },
  ipcMain: { handle: (name: string, fn: any) => handlers.set(name, fn), on: (name: string, fn: any) => listeners.set(name, fn) },
  powerMonitor: { on: (name: string, fn: any) => power.set(name, fn) },
}))
mock.module('../lib/chrome-desktop-service', () => ({ chromeDesktopService: service }))
const { registerChromeDesktopIpcHandlers } = await import('./chrome-desktop.ipc')
const trusted = { sender: contents, senderFrame: mainFrame }
beforeEach(() => { handlers.clear(); listeners.clear(); lifecycle.clear(); power.clear(); mock.clearAllMocks(); registerChromeDesktopIpcHandlers() })

test('Given 组件提供原生截图 When 注册IPC Then 不接受renderer图像或采集失败来终止原生连接', () => {
  expect(listeners.has('chrome-desktop:frame-response')).toBe(false)
  expect(listeners.has('chrome-desktop:stream-error')).toBe(false)
})
test('Given 非主窗口或iframe When 查询组件/窗口或操作控制 Then 拒绝且不调用服务', async () => {
  for (const channel of Object.values(CHANNELS).filter((name) => handlers.has(name))) {
    for (const event of [{ sender: { id: 99 }, senderFrame: mainFrame }, { sender: contents, senderFrame: { url: 'file:///iframe' } }]) {
      await expect(Promise.resolve().then(() => handlers.get(channel)!(event, { sessionId: 'A', controlId: 'c', windowId: 1, pid: 2 }))).rejects.toThrow('CHROME_UNSUPPORTED_CONTEXT')
    }
  }
  expect(service.listWindows).not.toHaveBeenCalled()
  expect(service.confirmStart).not.toHaveBeenCalled()
})
test('Given 用户已选择目标窗口 When 主窗口确认 Then 服务连接组件，无需renderer截帧器', async () => {
  const input = { sessionId: 'A', controlId: 'c', windowId: 42, pid: 123 }
  expect(await handlers.get(CHANNELS.PREPARE_CAPTURE)!(trusted, input)).toEqual({ ok: true })
  expect(await handlers.get(CHANNELS.CONFIRM_START)!(trusted, input)).toEqual({ ok: true })
  expect(service.confirmStart).toHaveBeenCalledWith(input)
})
test('Given 窗口ID或控制ID非法 When 确认连接 Then 在调用组件前拒绝', async () => {
  for (const input of [{}, { sessionId: 'A', controlId: 'c', windowId: 0, pid: 1 }, { sessionId: 'A', controlId: 'c', windowId: 1, pid: NaN }]) {
    await expect(Promise.resolve().then(() => handlers.get(CHANNELS.CONFIRM_START)!(trusted, input))).rejects.toThrow()
  }
  expect(service.confirmStart).not.toHaveBeenCalled()
})
test('Given 同一会话的新控制 When 旧主窗口事件请求停止 Then 传递controlId保护新连接', async () => {
  await handlers.get(CHANNELS.STOP_CONTROL)!(trusted, { sessionId: 'A', controlId: 'old' })
  expect(service.stopSessionControl).toHaveBeenCalledWith('A', 'old')
})
test('Given 应用关闭或锁屏 When 生命周期事件到达 Then 释放原生连接', () => {
  lifecycle.get('closed')!()
  power.get('lock-screen')!()
  power.get('suspend')!()
  expect(service.releaseCurrentControl).toHaveBeenCalledTimes(3)
})

test('Given 组件未确认停止 When 主窗口显式停止 Then IPC不能静默成功', async () => {
  service.stopSessionControl.mockRejectedValueOnce(new Error('CHROME_HELPER_FAILED: 尚未停止'))
  await expect(handlers.get(CHANNELS.STOP_CONTROL)!(trusted, { sessionId: 'A', controlId: 'c' })).rejects.toThrow('CHROME_HELPER_FAILED')
})
