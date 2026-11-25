import { join } from 'node:path'
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
let logoDirectory = join(import.meta.dir, 'missing-brand-logos')
mock.module('../lib/bundled-resources', () => ({ getBundledResourcesDir: () => '/resources', getBrandLogoDirectory: () => logoDirectory }))
mock.module('../lib/local-file-protocol', () => ({ registerCopisDirectoryPath: () => 'copis-file://logos' }))
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

test('Given 品牌素材按需安装 When 打开预览 Then 未安装时返回空，安装后提供受限目录地址', async () => {
  const { registerAttachmentsIpcHandlers } = await import('../ipc/attachments.ipc')
  registerAttachmentsIpcHandlers()
  expect(await h.invoke(C.GET_BRAND_LOGO_DIRECTORY_URL, {})).toBeNull()
  logoDirectory = join(import.meta.dir, '../../renderer/assets/bots/copis-logos')
  expect(await h.invoke(C.GET_BRAND_LOGO_DIRECTORY_URL, {})).toBe('copis-file://logos')
})
