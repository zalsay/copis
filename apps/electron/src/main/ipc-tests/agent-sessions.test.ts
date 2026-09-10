import { expect, mock, test } from 'bun:test'
import { AGENT_IPC_CHANNELS as C } from '@copis/shared'
import { createIpcHarness } from './t2-harness'
const h = createIpcHarness()
const order: string[] = []
const mark = (name: string) => (id: string) => { order.push(name + ':' + id) }
const update = mock(() => ({ id: 'session' }))
mock.module('electron', () => ({ ipcMain: h.ipcMain }))
mock.module('../lib/settings-service', () => ({ getSettings: () => ({}) }))
mock.module('../lib/working-model-catalog-access', () => ({ getWorkingModelCatalogAccess: () => ({ isVip: false }) }))
mock.module('../lib/working-model-catalog', () => ({ assertWorkingCustomModelSelection: () => {} }))
mock.module('../lib/agent-session-manager', () => ({
  ...Object.fromEntries(['createAgentSession','getAgentSessionSDKMessages','createAgentSideQuestionSession','moveSessionToWorkspace','forkAgentSession','searchAgentSessionMessages','searchAgentSessionReferences'].map(n => [n, () => undefined])),
  listAgentSessions: () => [{ id: 'session', pinned: false, archived: true }],
  updateAgentSessionMeta: update, deleteAgentSession: mark('delete'),
}))
mock.module('../lib/agent-service', () => ({ generateAgentTitle: () => '', isAgentSessionActive: () => false, rewindAgentSession: () => null }))
mock.module('../lib/agent-permission-service', () => ({ permissionService: { clearSessionWhitelist: mark('whitelist'), clearSessionPending: mark('permission') } }))
mock.module('../lib/agent-ask-user-service', () => ({ askUserService: { clearSessionPending: mark('ask') } }))
mock.module('../lib/agent-exit-plan-service', () => ({ exitPlanService: { clearSessionPending: mark('plan') } }))
mock.module('../lib/workspace-watcher', () => ({ watchAttachedDirectory: () => {} }))
mock.module('../lib/feishu-bridge-manager', () => ({ feishuBridgeManager: {} }))
test('Given 会话删除 When 调用 Then 先清理交互状态再删除数据', async () => {
  const { registerAgentSessionsIpcHandlers } = await import('../ipc/agent-sessions.ipc')
  registerAgentSessionsIpcHandlers()
  await h.invoke(C.DELETE_SESSION, {}, 'session')
  expect(order).toEqual(['whitelist:session','permission:session','ask:session','plan:session','delete:session'])
  await h.invoke(C.TOGGLE_PIN, {}, 'session')
  expect(update).toHaveBeenCalledWith('session', { pinned: true, archived: false })
})
