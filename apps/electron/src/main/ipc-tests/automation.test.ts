import { expect, mock, test } from 'bun:test'
import { AUTOMATION_IPC_CHANNELS as C } from '@copis/shared'
import { createIpcHarness } from './t2-harness'
const h = createIpcHarness(), order: string[] = []
const create = mock(async (input: unknown) => { order.push('create'); return input })
mock.module('electron', () => ({ ipcMain: h.ipcMain }))
mock.module('../lib/automation-api-client', () => ({ runtimeAutomationApiClient: { create } }))
mock.module('../lib/automation-scheduler', () => ({ broadcastChanged: () => { order.push('broadcast') } }))
test('Given 定时任务输入 When 非法间隔或时间 Then 不写入；合法输入先写入后广播', async () => {
  const { registerAutomationIpcHandlers } = await import('../ipc/automation.ipc')
  registerAutomationIpcHandlers()
  const input = { name: 'task', prompt: 'test', scheduleType: 'interval', intervalMinutes: 5 }
  for (const intervalMinutes of [NaN, Infinity, -1, 0, 0.5]) {
    await expect(h.invoke(C.CREATE, {}, { ...input, intervalMinutes })).rejects.toThrow('intervalMinutes')
  }
  expect(create).not.toHaveBeenCalled()
  expect(await h.invoke(C.CREATE, {}, input)).toEqual(input)
  expect(order).toEqual(['create','broadcast'])
})
