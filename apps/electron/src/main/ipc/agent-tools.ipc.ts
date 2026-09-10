import { ipcMain } from 'electron'
import { AGENT_TOOL_IPC_CHANNELS } from '@copis/shared'
import type { AgentToolInfo, AgentToolState, AgentToolMeta } from '@copis/shared'
import { getWorkingApiClient } from '../lib/working-api-service'
import { getAllAgentToolInfos } from '../lib/agent-tool-registry'
import { updateAgentToolState, updateAgentToolCredentials, getAgentToolCredentials, addCustomAgentTool, deleteCustomAgentTool } from '../lib/agent-tool-config'

export function registerAgentToolsIpcHandlers(): void {
  // ===== Agent 工具管理 =====

  // 获取所有工具信息
  ipcMain.handle(
    AGENT_TOOL_IPC_CHANNELS.GET_ALL_TOOLS,
    async (): Promise<AgentToolInfo[]> => {
      return getAllAgentToolInfos()
    }
  )

  // 获取工具凭据
  ipcMain.handle(
    AGENT_TOOL_IPC_CHANNELS.GET_TOOL_CREDENTIALS,
    async (_, toolId: string): Promise<Record<string, string>> => {
      return getAgentToolCredentials(toolId)
    }
  )

  // 更新工具开关状态
  ipcMain.handle(
    AGENT_TOOL_IPC_CHANNELS.UPDATE_TOOL_STATE,
    async (_, toolId: string, state: AgentToolState): Promise<void> => {
      updateAgentToolState(toolId, state)
    }
  )

  // 更新工具凭据
  ipcMain.handle(
    AGENT_TOOL_IPC_CHANNELS.UPDATE_TOOL_CREDENTIALS,
    async (_, toolId: string, credentials: Record<string, string>): Promise<void> => {
      updateAgentToolCredentials(toolId, credentials)
    }
  )

  // 创建自定义工具
  ipcMain.handle(
    AGENT_TOOL_IPC_CHANNELS.CREATE_CUSTOM_TOOL,
    async (_, meta: AgentToolMeta): Promise<void> => {
      addCustomAgentTool(meta)
    }
  )

  // 删除自定义工具
  ipcMain.handle(
    AGENT_TOOL_IPC_CHANNELS.DELETE_CUSTOM_TOOL,
    async (_, toolId: string): Promise<void> => {
      deleteCustomAgentTool(toolId)
    }
  )

  // 测试工具连接
  ipcMain.handle(
    AGENT_TOOL_IPC_CHANNELS.TEST_TOOL,
    async (_, toolId: string): Promise<{ success: boolean; message: string }> => {
      // 联网搜索工具测试
      if (toolId === 'web-search') {
        const { getAgentToolCredentials: getCredentials } = await import('../lib/agent-tool-config')
        const credentials = getCredentials('web-search')
        if (!credentials.apiKey) {
          return { success: false, message: '请先填写 Tavily API Key' }
        }
        try {
          const response = await fetch('https://api.tavily.com/search', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${credentials.apiKey}`,
            },
            body: JSON.stringify({
              query: 'test connection',
              search_depth: 'basic',
              max_results: 1,
            }),
          })
          if (!response.ok) {
            const errorText = await response.text()
            return { success: false, message: `API 请求失败 (${response.status}): ${errorText}` }
          }
          return { success: true, message: '连接成功，Tavily 搜索 API 可用' }
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error)
          return { success: false, message: `连接失败: ${msg}` }
        }
      }
      // Copis 图片生成工具测试（图片生成由 edu-api 提供，仅校验登录态）
      if (toolId === 'nano-banana') {
        const authState = await getWorkingApiClient().getAuthState()
        return authState.authenticated
          ? { success: true, message: '已登录 Copis Working，图片生成由 edu-api 提供' }
          : { success: false, message: '请先登录 Copis Working' }
      }
      return { success: false, message: `工具 ${toolId} 不支持测试` }
    }
  )
}
