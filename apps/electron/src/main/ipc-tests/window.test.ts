import { expect, mock, test } from 'bun:test'
import { IPC_CHANNELS as C } from '@copis/shared'
import { QUICK_TASK_IPC_CHANNELS as Q } from '../../types'
import { createIpcHarness } from './t2-harness'

const h = createIpcHarness()
const close = mock(() => undefined)
const quit = mock(() => undefined)
const maximize = mock(() => undefined)
const unmaximize = mock(() => undefined)
let maximized = false
let destroyed = false
const source = { isDestroyed: () => destroyed, close, maximize, unmaximize, isMaximized: () => maximized }
const fromWebContents = mock(() => source)
const order: string[] = []
const send = mock(() => { order.push('send') })
mock.module('electron', () => ({ ipcMain: h.ipcMain, app: { quit }, BrowserWindow: { fromWebContents } }))
mock.module('../lib/quick-task-window', () => ({ hideQuickTaskWindow: () => { order.push('hide') } }))
mock.module('../index', () => ({ getMainWindow: () => ({ isDestroyed: () => false, webContents: { send }, show: () => {}, focus: () => {} }) }))

test('Given 来源窗口 When 最大化与关闭 Then 只操作来源窗口且显式退出才 quit', async () => {
  const { registerWindowIpcHandlers } = await import('../ipc/window.ipc')
  registerWindowIpcHandlers()
  const sender = { id: 9 }
  await h.invoke(C.WINDOW_MAXIMIZE, { sender })
  maximized = true
  await h.invoke(C.WINDOW_MAXIMIZE, { sender })
  expect(maximize).toHaveBeenCalledTimes(1)
  expect(unmaximize).toHaveBeenCalledTimes(1)
  await h.invoke(C.WINDOW_CLOSE, { sender }, 'true')
  expect(close).toHaveBeenCalledTimes(1)
  await h.invoke(C.WINDOW_CLOSE, { sender }, true)
  expect(quit).toHaveBeenCalledTimes(1)
  destroyed = true
  await h.invoke(C.WINDOW_CLOSE, { sender }, true)
  expect(quit).toHaveBeenCalledTimes(1)
  expect(fromWebContents).toHaveBeenCalledWith(sender)
})

test('Given 快速任务 When 提交 Then 先隐藏再向主窗口传递文本和附件', async () => {
  const { registerQuickTaskIpcHandlers } = await import('../ipc/window.ipc')
  registerQuickTaskIpcHandlers()
  const input = { text: '任务', files: [] }
  await h.invoke(Q.SUBMIT, {}, input)
  expect(order).toEqual(['hide', 'send'])
  expect(send).toHaveBeenCalledWith('quick-task:open-session', input)
})
