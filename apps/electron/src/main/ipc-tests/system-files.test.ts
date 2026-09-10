import { expect, mock, test } from 'bun:test'
import { IPC_CHANNELS as C } from '@copis/shared'
import { createIpcHarness } from './t2-harness'
const h = createIpcHarness()
const openExternal = mock(async () => undefined)
const writeText = mock(() => undefined)
mock.module('electron', () => ({ ipcMain: h.ipcMain, shell: { openExternal }, clipboard: { writeText } }))
mock.module('../lib/ipc-file-access', () => ({ normalizeFileAccessOptions: () => undefined, isPathAllowed: () => false }))
mock.module('../lib/system-app-info', () => ({ KNOWN_EDITORS: [], getDefaultAppInfoForFile: () => null }))
test('Given 外链和剪贴板请求 When 协议或类型无效 Then 保留原拒绝行为', async () => {
  const { registerSystemFilesIpcHandlers } = await import('../ipc/system-files.ipc')
  registerSystemFilesIpcHandlers()
  await h.invoke(C.OPEN_EXTERNAL, {}, 'file:///tmp/private')
  expect(openExternal).not.toHaveBeenCalled()
  await h.invoke(C.OPEN_EXTERNAL, {}, 'https://example.com')
  expect(openExternal).toHaveBeenCalledWith('https://example.com')
  await expect(h.invoke(C.WRITE_CLIPBOARD_TEXT, {}, 1)).rejects.toThrow('剪贴板文本必须是字符串')
  expect(writeText).not.toHaveBeenCalled()
})
