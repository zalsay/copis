import { beforeEach, expect, mock, test } from 'bun:test'
import { PLANNING_CONFLICT_ERROR, PLANNING_IPC_CHANNELS } from '@copis/shared'
import { createIpcHarness } from './t2-harness'

const harness = createIpcHarness()
const existing = { id: 'todo-1', title: '修复问题', workspaceId: 'old-workspace', updatedAt: 100 }
const updated = { ...existing, workspaceId: 'workspace-1', updatedAt: 101 }
const session = { id: 'session-1' }
const updateTodo = mock(() => updated)
const createAgentSession = mock(() => session)
const broadcastPlanningChanged = mock(() => {})
const ensureSessionMirror = mock(() => Promise.resolve())

mock.module('electron', () => ({
  ipcMain: harness.ipcMain,
  BrowserWindow: { getAllWindows: () => [] },
}))
mock.module('../lib/settings-service', () => ({ getSettings: () => ({}) }))
mock.module('../lib/working-model-catalog-access', () => ({
  getWorkingModelCatalogAccess: () => ({ isVip: false, ownerId: 'owner-1' }),
}))
mock.module('../lib/working-model-catalog', () => ({ assertWorkingCustomModelSelection: () => {} }))
mock.module('../lib/agent-workspace-manager', () => ({ getAgentWorkspace: () => ({ id: 'workspace-1' }) }))
mock.module('../lib/agent-session-manager', () => ({ createAgentSession }))
mock.module('../lib/planning-events', () => ({ broadcastPlanningChanged }))
mock.module('../lib/feishu-bridge-manager', () => ({ feishuBridgeManager: { ensureSessionMirror } }))
mock.module('../lib/planning-manager', () => ({
  getTodo: () => existing,
  updateTodo,
  ...Object.fromEntries([
    'listTodos', 'createTodo', 'deleteTodo', 'listCalendarEvents', 'createCalendarEvent',
    'updateCalendarEvent', 'deleteCalendarEvent', 'listPlanningGroups', 'createPlanningGroup',
    'updatePlanningGroup', 'deletePlanningGroup', 'listPlanningTags', 'listActivePlanningReminders',
    'acknowledgePlanningReminder', 'snoozePlanningReminder',
  ].map((name) => [name, mock(() => undefined)])),
}))

const { registerPlanningIpcHandlers } = await import('../ipc/planning.ipc')
registerPlanningIpcHandlers()

const event = { sender: { id: 1, getURL: () => 'http://localhost/' } }
const input = {
  todoId: existing.id,
  workspaceId: 'workspace-1',
  expectedUpdatedAt: existing.updatedAt,
  channelId: 'channel-1',
  modelId: 'model-1',
}

beforeEach(() => {
  updateTodo.mockClear()
  createAgentSession.mockClear()
  broadcastPlanningChanged.mockClear()
  ensureSessionMirror.mockClear()
})

test('Given 有效任务版本 When 启动 Agent Then 同步更新归属并返回会话', () => {
  const result = harness.invoke(PLANNING_IPC_CHANNELS.START_TODO_AGENT, event, input)

  expect(result).not.toBeInstanceOf(Promise)
  expect(result).toEqual({ todo: updated, session })
  expect(updateTodo).toHaveBeenCalledWith({
    id: existing.id, workspaceId: input.workspaceId, expectedUpdatedAt: existing.updatedAt,
  })
  expect(createAgentSession).toHaveBeenCalledWith(
    '处理：修复问题', input.channelId, input.workspaceId, input.modelId, 'pi',
  )
  expect(broadcastPlanningChanged).toHaveBeenCalledWith(['todos', 'reminders'])
  expect(ensureSessionMirror).toHaveBeenCalledWith(session)
})

test('Given 任务已被修改 When 使用旧版本启动 Agent Then 同步报冲突且不产生写入', () => {
  expect(() => harness.invoke(PLANNING_IPC_CHANNELS.START_TODO_AGENT, event, {
    ...input, expectedUpdatedAt: 99,
  })).toThrow(PLANNING_CONFLICT_ERROR)

  expect(updateTodo).not.toHaveBeenCalled()
  expect(createAgentSession).not.toHaveBeenCalled()
  expect(broadcastPlanningChanged).not.toHaveBeenCalled()
  expect(ensureSessionMirror).not.toHaveBeenCalled()
})
