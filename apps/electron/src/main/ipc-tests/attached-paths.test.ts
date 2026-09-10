import { expect, mock, test } from 'bun:test'
import { AGENT_IPC_CHANNELS as C } from '@copis/shared'
import { createIpcHarness } from './t2-harness'
const h = createIpcHarness()
const sessions: Record<string, { attachedDirectories: string[] }> = { one: { attachedDirectories: ['/shared'] }, two: { attachedDirectories: ['/shared'] } }
const unwatch = mock(() => undefined)
mock.module('electron', () => ({ ipcMain: h.ipcMain }))
mock.module('../lib/agent-session-manager', () => ({ getAgentSessionMeta: (id: string) => sessions[id], updateAgentSessionMeta: (id: string, updates: { attachedDirectories: string[] }) => { sessions[id] = updates }, listAgentSessions: () => Object.values(sessions) }))
mock.module('../lib/agent-workspace-manager', () => ({
  listAgentWorkspaces: () => [], getWorkspaceAttachedDirectories: () => [], getWorkspaceAttachedFiles: () => [],
  attachWorkspaceDirectory: () => [], attachWorkspaceFile: () => [], detachWorkspaceDirectory: () => [], detachWorkspaceFile: () => [],
  getWorktreeRepos: () => [], addWorktreeRepo: () => {}, removeWorktreeRepo: () => {},
}))
mock.module('../lib/workspace-watcher', () => ({ watchAttachedDirectory: () => {}, unwatchAttachedDirectory: unwatch }))
test('Given 两个会话共享目录 When 依次移除引用 Then 最后一个引用移除后才释放监听', async () => {
  const { registerAttachedPathsIpcHandlers } = await import('../ipc/attached-paths.ipc')
  registerAttachedPathsIpcHandlers()
  expect(await h.invoke(C.DETACH_DIRECTORY, {}, { sessionId: 'one', directoryPath: '/shared' })).toEqual([])
  expect(unwatch).not.toHaveBeenCalled()
  await h.invoke(C.DETACH_DIRECTORY, {}, { sessionId: 'two', directoryPath: '/shared' })
  expect(unwatch).toHaveBeenCalledTimes(1)
  expect(unwatch).toHaveBeenCalledWith('/shared')
})
