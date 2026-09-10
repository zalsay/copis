import { afterAll, expect, mock, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SCRATCH_PAD_IPC_CHANNELS as C } from '../../types'
import { createIpcHarness } from './t2-harness'

const h = createIpcHarness()
const dir = mkdtempSync(join(tmpdir(), 'copis-ipc-scratch-'))
let path = join(dir, 'scratch.md')
mock.module('electron', () => ({ ipcMain: h.ipcMain, BrowserWindow: {}, dialog: {}, clipboard: {}, nativeImage: {} }))
mock.module('../lib/config-paths', () => ({ getScratchPadPath: () => path }))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

test('Given beforeunload 保存 When 同步调用 Then 写盘与 returnValue 在返回前完成', async () => {
  const { registerScratchPadIpcHandlers } = await import('../ipc/scratch-pad.ipc')
  registerScratchPadIpcHandlers()
  const event = { returnValue: undefined as unknown }
  expect(h.emit(C.SAVE_SYNC, event, '# 草稿')).toBeUndefined()
  expect(event.returnValue).toBe(true)
  expect(readFileSync(path, 'utf8')).toBe('# 草稿')
  expect(await h.invoke(C.LOAD)).toBe('# 草稿')
  path = join(dir, 'missing', 'scratch.md')
  const log = mock(() => undefined)
  const original = console.error
  console.error = log
  try {
    h.emit(C.SAVE_SYNC, event, '失败')
    expect(event.returnValue).toBe(false)
  } finally { console.error = original }
})
