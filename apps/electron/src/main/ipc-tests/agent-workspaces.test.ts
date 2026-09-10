import { beforeEach, expect, mock, test } from 'bun:test'
import { AGENT_IPC_CHANNELS as C } from '@copis/shared'
import { createIpcHarness } from './t2-harness'

const h = createIpcHarness()
const calls: string[] = []
let workspace = { id: 'workspace', slug: 'project', projectRootPath: '/project' }
let failSessionCreation = false
mock.module('electron', () => ({ ipcMain: h.ipcMain }))
mock.module('../lib/agent-workspace-manager', () => ({
  listAgentWorkspaces: () => [workspace], getAgentWorkspace: () => workspace,
  ensureInvestmentWorkspace: () => {}, createAgentWorkspace: () => workspace,
  updateAgentWorkspace: () => workspace, relinkAgentWorkspaceProjectRoot: () => workspace,
  restoreAgentWorkspaceProjectRoot: () => workspace,
  deleteAgentWorkspace: (id: string) => { calls.push(`workspace:${id}`) },
  reorderAgentWorkspaces: () => [], togglePinAgentWorkspace: () => [],
}))
mock.module('../lib/agent-session-manager', () => ({
  listAgentSessions: () => [
    { id: 'active', workspaceId: 'workspace' }, { id: 'idle', workspaceId: 'workspace' }, { id: 'other', workspaceId: 'other' },
  ],
  createAgentSession: () => {
    if (failSessionCreation) throw new Error('首个会话创建失败')
    return { id: 'created' }
  },
  deleteAgentSession: (id: string) => { calls.push(`session:${id}`) },
}))
mock.module('../lib/agent-service', () => ({
  isAgentSessionActive: async (id: string) => id === 'active',
  stopAgent: async (id: string) => { calls.push(`stop:${id}`) },
}))
mock.module('../lib/automation-api-client', () => ({ runtimeAutomationApiClient: {
  list: async () => [{ id: 'automation', workspaceId: 'workspace' }, { id: 'other', workspaceId: 'other' }],
  delete: async (id: string) => { calls.push(`automation:${id}`) },
} }))
mock.module('../lib/automation-scheduler', () => ({ broadcastChanged: () => { calls.push('broadcast') } }))
mock.module('../lib/dingtalk-bridge-manager', () => ({ dingtalkBridgeManager: {
  removeBindingsForDeletedWorkspace: () => { calls.push('dingtalk'); return 0 },
} }))
mock.module('../lib/wechat-bridge', () => ({ wechatBridge: {
  removeBindingsForDeletedWorkspace: () => { calls.push('wechat'); return 0 },
} }))
mock.module('../lib/feishu-bridge-manager', () => ({ feishuBridgeManager: {
  removeBindingsForDeletedWorkspace: () => { calls.push('feishu'); return 0 }, ensureSessionMirror: async () => {},
} }))
mock.module('../lib/attached-path-lifecycle', () => ({ releaseDirectoryWatcherIfUnreferenced: (path: string) => { calls.push(`release:${path}`) } }))
mock.module('../lib/workspace-watcher', () => ({ watchAttachedDirectory: () => {} }))
mock.module('../lib/settings-service', () => ({ getSettings: () => ({}) }))
mock.module('../lib/working-api-service', () => ({ getWorkingApiClient: () => ({ getCachedUser: () => ({ isVip: true }) }) }))
mock.module('../lib/working-model-catalog-access', () => ({ getWorkingModelCatalogAccess: () => ({ isVip: true }) }))
mock.module('../lib/working-model-catalog', () => ({ assertWorkingCustomModelSelection: () => {} }))
mock.module('../lib/working-workspace-limit', () => ({ assertWorkingWorkspaceCreationAllowed: () => {} }))

beforeEach(async () => {
  calls.length = 0
  workspace = { id: 'workspace', slug: 'project', projectRootPath: '/project' }
  failSessionCreation = false
  const { registerAgentWorkspacesIpcHandlers } = await import('../ipc/agent-workspaces.ipc')
  registerAgentWorkspacesIpcHandlers()
})

test('Given 项目包含运行会话和自动任务 When 删除项目 Then 依次解绑停止清理任务删除项目并释放目录', async () => {
  await h.invoke(C.DELETE_WORKSPACE, {}, 'workspace')
  expect(calls).toEqual([
    'dingtalk', 'wechat', 'feishu', 'stop:active', 'session:active', 'session:idle',
    'automation:automation', 'broadcast', 'workspace:workspace', 'release:/project',
  ])
})

test('Given 系统固定工作区 When 请求删除 Then 在任何绑定或数据清理前拒绝', async () => {
  for (const slug of ['default', 'investment']) {
    workspace.slug = slug
    await expect(h.invoke(C.DELETE_WORKSPACE, {}, 'workspace')).rejects.toThrow('系统固定工作区不能删除')
    expect(calls).toEqual([])
  }
})

test('Given 创建项目时首个会话创建失败 When 返回错误 Then 回滚已创建的工作区', async () => {
  failSessionCreation = true
  await expect(h.invoke(C.CREATE_PROJECT, {}, { name: '项目' })).rejects.toThrow('首个会话创建失败')
  expect(calls).toEqual(['workspace:workspace'])
})
