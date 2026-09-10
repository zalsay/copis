import { afterAll, expect, mock, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AGENT_IPC_CHANNELS as C } from '@copis/shared'
import { createIpcHarness } from './t2-harness'
const h = createIpcHarness()
const dir = mkdtempSync(join(tmpdir(), 'copis-agent-file-ipc-'))
const file = join(dir, 'keep.txt')
writeFileSync(file, 'keep')
mock.module('electron', () => ({ ipcMain: h.ipcMain, shell: {} }))
mock.module('../lib/ipc-file-access', () => ({ isPathAllowed: () => false, normalizeFileAccessOptions: (v: unknown) => v, getPreviewCandidateBasePaths: () => undefined }))
mock.module('../lib/agent-session-manager', () => ({ getAgentSessionMeta: () => undefined }))
mock.module('../lib/config-paths', () => ({ getAgentSessionWorkspacePath: () => dir, getAgentWorkspacesDir: () => dir }))
mock.module('../lib/agent-workspace-manager', () => ({ getAgentWorkspace: () => undefined, getAgentWorkspaceBySlug: () => undefined, getAgentWorkspaceReadableRoots: () => [], getProjectFilesPath: () => dir, getWorkspaceAttachedDirectories: () => [], getWorkspaceAttachedFiles: () => [] }))
mock.module('../lib/workspace-file-search', () => ({ searchWorkspaceFiles: () => [] }))
mock.module('../lib/file-move-service', () => ({ movePathSafely: () => undefined }))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
test('Given 未授权文件 When 删除或枚举 Then 抛出授权错误且文件仍存在', async () => {
  const { registerAgentFileCoreIpcHandlers } = await import('../ipc/agent-files.ipc')
  registerAgentFileCoreIpcHandlers()
  await expect(h.invoke(C.DELETE_FILE, {}, file)).rejects.toThrow('访问路径超出当前会话的授权范围')
  await expect(h.invoke(C.LIST_DIRECTORY, {}, dir)).rejects.toThrow('访问路径超出当前会话的授权范围')
  expect(existsSync(file)).toBe(true)
})
