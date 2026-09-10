import { expect, mock, test } from 'bun:test'
import { IPC_CHANNELS as C } from '@copis/shared'
import { createIpcHarness } from './t2-harness'
const h = createIpcHarness()
const diff = mock(() => 'diff')
mock.module('electron', () => ({ ipcMain: h.ipcMain }))
mock.module('../lib/runtime-init', () => ({ getGitRepoStatus: () => null }))
mock.module('../lib/git-diff-service', () => ({ getUnstagedChanges: () => [], getFileDiff: diff, getUntrackedContent: () => '', revertFile: () => {}, getDiffContents: () => null, listWorktrees: () => [], getWorktreeChanges: () => [] }))
mock.module('../lib/ipc-file-access', () => ({ normalizeFileAccessOptions: (x: unknown) => x, ensurePathAllowed: () => false, isPathAllowed: () => false, ensurePathAllowedWithWorktree: async (path: string) => path === '/allowed' }))
test('Given diff 请求 When 仓库或 gitRoot 越界 Then 不调用 Git 服务', async () => {
  const { registerGitIpcHandlers } = await import('../ipc/git.ipc')
  registerGitIpcHandlers()
  expect(await h.invoke(C.GET_FILE_DIFF, {}, { dirPath: '/denied', filePath: 'a' })).toBe('')
  expect(await h.invoke(C.GET_FILE_DIFF, {}, { dirPath: '/allowed', filePath: 'a', gitRoot: '/denied' })).toBe('')
  expect(diff).not.toHaveBeenCalled()
  expect(await h.invoke(C.GET_FILE_DIFF, {}, { dirPath: '/allowed', filePath: 'a', gitRoot: '/allowed' })).toBe('diff')
  expect(diff).toHaveBeenCalledWith('/allowed', 'a', '/allowed')
})
