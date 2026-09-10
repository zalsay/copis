import { expect, mock, test } from 'bun:test'
import { ATTACHMENT_IPC_CHANNELS as C, AGENT_IPC_CHANNELS as A } from '@copis/shared'
import { createIpcHarness } from './t2-harness'
const h = createIpcHarness()
const read = mock(async () => 'base64')
const save = mock(async () => [{ path: '/saved' }])
mock.module('electron', () => ({ ipcMain: h.ipcMain, dialog: {}, BrowserWindow: {} }))
mock.module('../lib/attachment-service', () => ({ readAttachmentAsBase64: read, openFileDialog: () => null, openFileOrFolderDialog: () => null }))
mock.module('../lib/agent-service', () => ({ saveFilesToAgentSession: save, saveFilesToWorkspaceFiles: () => [] }))
mock.module('../lib/config-paths', () => ({ getWorkspaceFilesDir: () => '/files' }))
mock.module('../lib/agent-workspace-manager', () => ({ getAgentWorkspaceBySlug: () => null, getAgentWorkspaceSourceRoot: () => '/files' }))
mock.module('../lib/bundled-resources', () => ({ getBundledResourcesDir: () => '/resources' }))
test('Given 附件读取和保存 When 调用 Then 保留参数与服务结果', async () => {
  const { registerAttachmentsIpcHandlers, registerAgentAttachmentsIpcHandlers } = await import('../ipc/attachments.ipc')
  registerAttachmentsIpcHandlers()
  registerAgentAttachmentsIpcHandlers()
  expect(await h.invoke(C.READ_ATTACHMENT, {}, '/attachment')).toBe('base64')
  expect(read).toHaveBeenCalledWith('/attachment')
  const input = { sessionId: 'session', files: [] }
  expect(await h.invoke(A.SAVE_FILES_TO_SESSION, {}, input)).toEqual([{ path: '/saved' }])
  expect(save).toHaveBeenCalledWith(input)
})
