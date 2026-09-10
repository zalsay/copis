import { expect, mock, test } from 'bun:test'
import { AGENT_IPC_CHANNELS as C } from '@copis/shared'
import { createIpcHarness } from './t2-harness'
const h = createIpcHarness()
const order: string[] = []
let active = true
const update = mock(() => ({}))
const run = mock(async () => { order.push('run') })
mock.module('electron', () => ({ ipcMain: h.ipcMain }))
mock.module('../lib/channel-manager', () => ({ getChannelById: () => null }))
mock.module('../lib/adapters/pi-model-registry', () => ({ resolvePiReasoningCapability: () => undefined }))
mock.module('../lib/browser-workflow-service', () => ({ refreshBrowserWorkflowStatus: () => {} }))
mock.module('../lib/working-model-catalog-access', () => ({ getWorkingModelCatalogAccess: () => ({ isVip: false }) }))
mock.module('../lib/agent-session-manager', () => ({ getAgentSessionMeta: () => ({ id: 's' }), updateAgentSessionMeta: update }))
mock.module('../lib/agent-service', () => ({ runAgent: run, stopAgent: async () => { order.push('stop') }, isAgentSessionActive: async () => active, queueAgentMessage: () => 'queued', updateAgentPermissionMode: async () => {} }))
mock.module('../lib/feishu-bridge-manager', () => ({ feishuBridgeManager: { startSessionMirrorRun: async () => { order.push('mirror-start') }, stopSessionMirrorRun: () => { order.push('mirror-stop') } } }))
mock.module('../lib/working-model-catalog', () => ({ assertWorkingCustomModelSelection: () => {} }))
test('Given 发送和中止 When 调用 Then 镜像先更新且 sender 透传', async () => {
  const { registerAgentExecutionIpcHandlers } = await import('../ipc/agent-execution.ipc')
  registerAgentExecutionIpcHandlers()
  const sender = { id: 1 }, input = { sessionId: 's' }
  await h.invoke(C.SEND_MESSAGE, { sender }, input)
  await h.invoke(C.STOP_AGENT, {}, 's')
  expect(order).toEqual(['mirror-start','run','mirror-stop','stop'])
  expect(run).toHaveBeenCalledWith(input, sender)
})
test('Given 运行中会话 When 切换 Fast Mode Then 拒绝写入；空闲后允许', async () => {
  const { registerAgentExecutionSettingsIpcHandlers } = await import('../ipc/agent-execution.ipc')
  registerAgentExecutionSettingsIpcHandlers()
  await expect(h.invoke(C.UPDATE_SESSION_CODEX_FAST_MODE, {}, 's', true)).rejects.toThrow('Agent 正在运行')
  expect(update).not.toHaveBeenCalled()
  active = false
  await h.invoke(C.UPDATE_SESSION_CODEX_FAST_MODE, {}, 's', true)
  expect(update).toHaveBeenCalledWith('s', { codexFastMode: true })
  await expect(h.invoke(C.UPDATE_SESSION_AGENT_RUNTIME, {}, 's', 'invalid')).rejects.toThrow('无效的 Agent runtime')
})
