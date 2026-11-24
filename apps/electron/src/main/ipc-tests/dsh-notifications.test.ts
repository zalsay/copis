import { beforeEach, expect, mock, test } from 'bun:test'
import { DSH_CORDIS_IPC_CHANNELS as C } from '@copis/shared'
import { createIpcHarness } from './t2-harness'
const h = createIpcHarness()
const send = mock(() => {})
let focused = false
mock.module('electron', () => ({ ipcMain: h.ipcMain, BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, isFocused: () => focused, webContents: { send } }] } }))
mock.module('../lib/dsh-cordis-service', () => ({ getDshCordisStatus: () => ({ running: true, url: 'http://127.0.0.1:53080/' }), reloadDshCordisPlugins: async () => {}, startDshCordisServer: async () => {}, stopDshCordisServerAndWait: async () => {}, setDshStatusChangeBroadcaster: () => {} }))
mock.module('../lib/dsh-view-manager', () => ({ isDshViewSender: (id: number) => id === 42, ensureDshView: () => {}, updateDshViewBounds: () => {}, dispatchToDshClient: () => {} }))
const { registerDshIpcHandlers } = await import('../ipc/dsh.ipc')
const frame = { url: 'http://127.0.0.1:53080/' }
const event = { sender: { id: 42, mainFrame: frame }, senderFrame: frame }
const completion = { type: 'COPIS_DSH_SESSION_COMPLETED', sessionId: 'a', title: '测试', completionSeq: 10, viewed: false, windowFocused: false }
beforeEach(() => { send.mockClear(); focused = false; registerDshIpcHandlers() })

test('Given 当前 DSH 主 frame 的正常完成和已查看事件 When 上报 Then 沿现有客户端通道广播', () => {
  h.emit(C.CLIENT_EVENT, event, completion)
  h.emit(C.CLIENT_EVENT, event, { type: 'COPIS_DSH_SESSION_VIEWED', sessionId: 'a' })
  expect(send).toHaveBeenCalledTimes(2)
})

test('Given Copis 的原生网页页签获得焦点 When DSH 后台完成 Then 由主进程确认应用在前台', () => {
  focused = true
  h.emit(C.CLIENT_EVENT, event, completion)
  expect(send).toHaveBeenCalledWith(C.CLIENT_EVENT, { ...completion, windowFocused: true })
})

test('Given 普通网页、子 frame 或非法完成参数 When 上报 Then 不允许伪造系统通知', () => {
  for (const source of [{ ...event, sender: { ...event.sender, id: 9 } }, { ...event, senderFrame: { ...frame } }, { sender: { id: 42, mainFrame: { url: 'https://example.com' } }, senderFrame: { url: 'https://example.com' } }]) h.emit(C.CLIENT_EVENT, source, completion)
  for (const override of [{ sessionId: '' }, { completionSeq: NaN }, { completionSeq: -1 }, { viewed: 'yes' }, { windowFocused: undefined }, { title: null }]) h.emit(C.CLIENT_EVENT, event, { ...completion, ...override })
  expect(send).not.toHaveBeenCalled()
})
