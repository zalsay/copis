import { expect, mock, test } from 'bun:test'
import { AGENT_IPC_CHANNELS as C } from '@copis/shared'
import { createIpcHarness } from './t2-harness'
const h = createIpcHarness()
let pending = true
const order: string[] = []
const update = mock(() => { order.push('persist'); return {} })
const respond = () => { const id = pending ? 's' : undefined; pending = false; return id }
mock.module('electron', () => ({ ipcMain: h.ipcMain }))
mock.module('../lib/agent-session-manager', () => ({ getAgentSessionMeta: () => ({ id: 's' }), updateAgentSessionMeta: update }))
mock.module('../lib/agent-permission-service', () => ({ permissionService: { respondToPermission: respond, getPendingRequests: () => [] } }))
mock.module('../lib/agent-ask-user-service', () => ({ askUserService: { respondToAskUser: () => undefined, getPendingRequests: () => [] } }))
mock.module('../lib/agent-exit-plan-service', () => ({ exitPlanService: { respondToExitPlanMode: () => ({ sessionId: 's', targetMode: 'default' }), getPendingRequests: () => [] } }))
test('Given 重复权限答复 When 已处理请求再次提交 Then 不重复发送 resolved', async () => {
  const { registerAgentPermissionResponseIpcHandlers, registerAgentInteractionsIpcHandlers } = await import('../ipc/agent-interactions.ipc')
  registerAgentPermissionResponseIpcHandlers()
  registerAgentInteractionsIpcHandlers()
  const send = mock(() => undefined), event = { sender: { send } }
  const response = { requestId: 'r', behavior: 'allow' }
  await h.invoke(C.PERMISSION_RESPOND, event, response)
  await h.invoke(C.PERMISSION_RESPOND, event, response)
  expect(send).toHaveBeenCalledTimes(1)
  expect(send).toHaveBeenCalledWith(C.STREAM_EVENT, { sessionId: 's', payload: { kind: 'copis_event', event: { type: 'permission_resolved', requestId: 'r', behavior: 'allow' } } })
  await h.invoke(C.ASK_USER_RESPOND, event, { requestId: 'expired', answers: {} })
  expect(send).toHaveBeenCalledTimes(1)
})
test('Given 计划审批切换模式 When 响应 Then resolved、持久化和模式广播顺序不变', async () => {
  const { registerAgentInteractionsIpcHandlers } = await import('../ipc/agent-interactions.ipc')
  registerAgentInteractionsIpcHandlers()
  const send = (_channel: string, data: { payload: { event: { type: string } } }) => { order.push(data.payload.event.type) }
  await h.invoke(C.EXIT_PLAN_MODE_RESPOND, { sender: { send } }, { requestId: 'plan' })
  expect(order).toEqual(['exit_plan_mode_resolved','persist','permission_mode_changed'])
  expect(update).toHaveBeenCalledWith('s', { permissionMode: 'default' })
})
