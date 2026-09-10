import { expect, mock, test } from 'bun:test'
import { AGENT_IPC_CHANNELS as C } from '@copis/shared'
import { createIpcHarness } from './t2-harness'
const h = createIpcHarness()
const order: string[] = []
const save = mock(() => undefined)
mock.module('electron', () => ({ ipcMain: h.ipcMain }))
mock.module('../lib/config-paths', () => ({ getWorkspaceSkillsDir: () => '/skills' }))
mock.module('../lib/builtin-mcp/settings', () => ({ setBuiltinMcpUserEnabled: (id: string, enabled: boolean) => { order.push(id + ':' + enabled) } }))
mock.module('../lib/agent-workspace-manager', () => ({
  ...Object.fromEntries(['getWorkspaceMcpConfig','getAllWorkspaceSkills','getOtherWorkspaceSkills','getDefaultSkillSlugs','deleteWorkspaceSkill','importSkillFromWorkspace','updateSkillFromSource','readWorkspaceSkillContent','writeWorkspaceSkillContent','toggleWorkspaceSkill','listSkillFiles','readSkillFile','writeSkillFile','createSkillEntry','deleteSkillEntry','renameSkillEntry'].map(n => [n, () => undefined])),
  saveWorkspaceMcpConfig: save,
  getWorkspaceCapabilities: (slug: string) => { order.push(slug); return { skills: [] } },
}))
mock.module('../lib/mcp-validator', () => ({ validateMcpServer: async () => ({ valid: false, reason: '拒绝连接' }) }))
test('Given 工作区能力配置 When 保存或切换 Then 透传配置并在开关更新后读取快照', async () => {
  const { registerWorkspaceCapabilitiesIpcHandlers } = await import('../ipc/workspace-capabilities.ipc')
  registerWorkspaceCapabilitiesIpcHandlers()
  const config = { mcpServers: {} }
  await h.invoke(C.SAVE_MCP_CONFIG, {}, 'workspace', config)
  expect(save).toHaveBeenCalledWith('workspace', config)
  expect(await h.invoke(C.SET_BUILTIN_MCP_ENABLED, {}, 'workspace', 'browser', false)).toEqual({ skills: [] })
  expect(order).toEqual(['browser:false', 'workspace'])
  expect(await h.invoke(C.TEST_MCP_SERVER, {}, 'server', {})).toEqual({ success: false, message: '拒绝连接' })
})
