import { afterAll, expect, mock, test } from 'bun:test'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createIpcHarness } from './t2-harness'
const h = createIpcHarness()
const dir = mkdtempSync(join(tmpdir(), 'copis-preview-ipc-'))
const file = join(dir, 'note.md')
writeFileSync(file, 'original')
let allowed = false
mock.module('electron', () => ({ ipcMain: h.ipcMain, BrowserWindow: {} }))
mock.module('../lib/local-file-protocol', () => ({ registerCopisFilePath: () => 'file-url' }))
mock.module('../lib/ipc-file-access', () => ({ normalizeFileAccessOptions: (v: unknown) => v, getPreviewCandidateBasePaths: () => undefined, getAllowedCandidateBasePaths: () => undefined, isPathAllowed: () => allowed }))
mock.module('../lib/file-preview-service', () => ({ resolveFilePath: () => file }))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
test('Given 文本预览写入 When 路径越界 Then 返回 false 且文件不变；授权后写入', async () => {
  const { registerFilePreviewIpcHandlers } = await import('../ipc/file-preview.ipc')
  registerFilePreviewIpcHandlers()
  expect(await h.invoke('file:write-text', {}, file, 'changed')).toBe(false)
  expect(readFileSync(file, 'utf8')).toBe('original')
  allowed = true
  expect(await h.invoke('file:write-text', {}, file, 'changed')).toBe(true)
  expect(readFileSync(file, 'utf8')).toBe('changed')
  expect(await h.invoke('file:read-binary-base64', {}, file, undefined, 1)).toBeNull()
})
