import { expect, mock, test } from 'bun:test'
import { AGENT_TOOL_IPC_CHANNELS as C } from '@copis/shared'
import { createIpcHarness } from './t2-harness'
const h = createIpcHarness()
const updateCredentials = mock(() => undefined)
let authenticated = false
mock.module('electron', () => ({ ipcMain: h.ipcMain }))
mock.module('../lib/working-api-service', () => ({ getWorkingApiClient: () => ({ getAuthState: async () => ({ authenticated }) }) }))
mock.module('../lib/agent-tool-registry', () => ({ getAllAgentToolInfos: () => [] }))
mock.module('../lib/agent-tool-config', () => ({ updateAgentToolState: () => {}, updateAgentToolCredentials: updateCredentials, getAgentToolCredentials: () => ({}), addCustomAgentTool: () => {}, deleteCustomAgentTool: () => {} }))
test('Given 工具配置 When 更新凭据或测试 Then 保留工具归属和登录校验', async () => {
  const { registerAgentToolsIpcHandlers } = await import('../ipc/agent-tools.ipc')
  registerAgentToolsIpcHandlers()
  const credentials = { apiKey: 'test-only' }
  await h.invoke(C.UPDATE_TOOL_CREDENTIALS, {}, 'tool', credentials)
  expect(updateCredentials).toHaveBeenCalledWith('tool', credentials)
  expect(await h.invoke(C.TEST_TOOL, {}, 'web-search')).toEqual({ success: false, message: '请先填写 Tavily API Key' })
  expect(await h.invoke(C.TEST_TOOL, {}, 'nano-banana')).toEqual({ success: false, message: '请先登录 Copis Working' })
  authenticated = true
  expect(await h.invoke(C.TEST_TOOL, {}, 'nano-banana')).toEqual({ success: true, message: '已登录 Copis Working，图片生成由 edu-api 提供' })
})
