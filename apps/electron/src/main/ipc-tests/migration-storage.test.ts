import { afterAll, expect, mock, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createIpcHarness } from './t2-harness'
const h = createIpcHarness()
const root = mkdtempSync(join(tmpdir(), 'copis-migration-test-'))
const keep = mkdtempSync(join(root, 'keep-')), remove = mkdtempSync(join(root, 'copis-import-'))
const confirm = mock(async (input: unknown) => input)
mock.module('electron', () => ({ ipcMain: h.ipcMain, dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) } }))
mock.module('../lib/storage-service', () => ({ calculateStorageStats: () => ({}), cleanupStorage: () => ({}), cleanupTempFiles: () => ({}) }))
mock.module('../lib/migration-service', () => ({ confirmImport: confirm }))
afterAll(() => rmSync(root, { recursive: true, force: true }))
test('Given 迁移取消 When 目录不匹配 Then 保留目录；匹配时清理并保留对话框取消结果', async () => {
  const { registerStorageIpcHandlers } = await import('../ipc/storage.ipc')
  const { registerMigrationIpcHandlers } = await import('../ipc/migration.ipc')
  registerStorageIpcHandlers(); registerMigrationIpcHandlers()
  await h.invoke('migration:cancelImport', {}, keep)
  expect(existsSync(keep)).toBe(true)
  await h.invoke('migration:cancelImport', {}, remove)
  expect(existsSync(remove)).toBe(false)
  expect(await h.invoke('migration:openFileDialog')).toBeNull()
  const options = { id: 'preview' }
  expect(await h.invoke('migration:confirmImport', {}, options)).toEqual(options)
})
