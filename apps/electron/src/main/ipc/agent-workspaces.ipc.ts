import { ipcMain } from 'electron'
import { AGENT_IPC_CHANNELS } from '@copis/shared'
import type { AgentWorkspace } from '@copis/shared'
import { getSettings } from '../lib/settings-service'
import { getWorkingModelCatalogAccess } from '../lib/working-model-catalog-access'
import { getWorkingApiClient } from '../lib/working-api-service'
import { runtimeAutomationApiClient } from '../lib/automation-api-client'
import { broadcastChanged as broadcastAutomationsChanged } from '../lib/automation-scheduler'
import { listAgentSessions, createAgentSession, deleteAgentSession } from '../lib/agent-session-manager'
import { stopAgent, isAgentSessionActive } from '../lib/agent-service'
import { listAgentWorkspaces, ensureInvestmentWorkspace, createAgentWorkspace, updateAgentWorkspace, relinkAgentWorkspaceProjectRoot, restoreAgentWorkspaceProjectRoot, deleteAgentWorkspace, reorderAgentWorkspaces, togglePinAgentWorkspace, getAgentWorkspace } from '../lib/agent-workspace-manager'
import { watchAttachedDirectory } from '../lib/workspace-watcher'
import { feishuBridgeManager } from '../lib/feishu-bridge-manager'
import { dingtalkBridgeManager } from '../lib/dingtalk-bridge-manager'
import { wechatBridge } from '../lib/wechat-bridge'
import { assertWorkingWorkspaceCreationAllowed } from '../lib/working-workspace-limit'
import { assertWorkingCustomModelSelection } from '../lib/working-model-catalog'
import { releaseDirectoryWatcherIfUnreferenced } from '../lib/attached-path-lifecycle'

export function registerAgentWorkspacesIpcHandlers(): void {
  // ===== Agent 工作区管理相关 =====

  // 获取 Agent 工作区列表
  ipcMain.handle(
    AGENT_IPC_CHANNELS.LIST_WORKSPACES,
    async (): Promise<AgentWorkspace[]> => {
      ensureInvestmentWorkspace()
      const workspaces = listAgentWorkspaces()
      for (const workspace of workspaces) {
        if (workspace.projectRootPath) watchAttachedDirectory(workspace.projectRootPath)
      }
      return workspaces
    }
  )

  // 创建 Agent 工作区（保留给迁移与低层管理调用；交互式项目创建应使用 CREATE_PROJECT）。
  ipcMain.handle(
    AGENT_IPC_CHANNELS.CREATE_WORKSPACE,
    async (_, input: import('@copis/shared').CreateAgentWorkspaceInput): Promise<AgentWorkspace> => {
      assertWorkingWorkspaceCreationAllowed(
        listAgentWorkspaces(),
        getWorkingApiClient().getCachedUser()?.isVip,
      )
      const workspace = createAgentWorkspace(input)
      if (workspace.projectRootPath) watchAttachedDirectory(workspace.projectRootPath)
      return workspace
    }
  )

  // 创建项目时同时生成其首个 Agent 会话，避免项目以无会话状态进入界面。
  ipcMain.handle(
    AGENT_IPC_CHANNELS.CREATE_PROJECT,
    async (_, input: import('@copis/shared').CreateAgentWorkspaceInput, channelId?: string, modelId?: string): Promise<import('@copis/shared').CreateAgentProjectResult> => {
      const access = getWorkingModelCatalogAccess()
      assertWorkingCustomModelSelection(channelId, modelId, access.isVip, access.ownerId)
      assertWorkingWorkspaceCreationAllowed(
        listAgentWorkspaces(),
        getWorkingApiClient().getCachedUser()?.isVip,
      )
      const workspace = createAgentWorkspace(input)
      if (workspace.projectRootPath) watchAttachedDirectory(workspace.projectRootPath)

      try {
        const session = createAgentSession(undefined, channelId, workspace.id, modelId, getSettings().agentRuntime ?? 'pi')
        feishuBridgeManager.ensureSessionMirror(session).catch((error) => {
          console.error('[飞书 Session 镜像] 项目首个会话建群失败:', error)
        })
        return { workspace, session }
      } catch (error) {
        try {
          deleteAgentWorkspace(workspace.id)
        } catch (rollbackError) {
          console.error('[项目创建] 首个会话创建失败后的项目回滚失败:', rollbackError)
        }
        throw error
      }
    }
  )

  // 更新 Agent 工作区
  ipcMain.handle(
    AGENT_IPC_CHANNELS.UPDATE_WORKSPACE,
    async (_, id: string, updates: import('@copis/shared').UpdateAgentWorkspaceInput): Promise<AgentWorkspace> => {
      return updateAgentWorkspace(id, updates)
    }
  )

  // 重新选择本地项目根目录，保留原项目、会话和配置。
  ipcMain.handle(
    AGENT_IPC_CHANNELS.RELINK_WORKSPACE_PROJECT_ROOT,
    async (_, id: string, projectRootPath: string): Promise<AgentWorkspace> => {
      const previousRoot = getAgentWorkspace(id)?.projectRootPath
      const updated = relinkAgentWorkspaceProjectRoot(id, projectRootPath)
      if (previousRoot && previousRoot !== updated.projectRootPath) {
        releaseDirectoryWatcherIfUnreferenced(previousRoot)
      }
      if (updated.projectRootPath) watchAttachedDirectory(updated.projectRootPath)
      return updated
    }
  )

  // 在缺失本地项目的原路径恢复空目录。
  ipcMain.handle(
    AGENT_IPC_CHANNELS.RESTORE_WORKSPACE_PROJECT_ROOT,
    async (_, id: string): Promise<AgentWorkspace> => {
      const updated = restoreAgentWorkspaceProjectRoot(id)
      if (updated.projectRootPath) watchAttachedDirectory(updated.projectRootPath)
      return updated
    }
  )

  // 删除 Agent 工作区
  ipcMain.handle(
    AGENT_IPC_CHANNELS.DELETE_WORKSPACE,
    async (_, id: string): Promise<void> => {
      const deletingWorkspace = getAgentWorkspace(id)
      if (!deletingWorkspace) {
        return deleteAgentWorkspace(id)
      }

      // 守卫前置：在删除任何会话/自动任务前就拦截不可删除的工作区，
      // 否则会先把绑定数据删光、再由 deleteAgentWorkspace 抛错，造成数据丢失与状态不一致
      if (deletingWorkspace.slug === 'default' || deletingWorkspace.slug === 'investment') {
        throw new Error('系统固定工作区不能删除')
      }

      const affectedSessionIds = listAgentSessions()
        .filter((session) => session.workspaceId === id)
        .map((session) => session.id)
      const affectedAutomationIds = (await runtimeAutomationApiClient.list())
        .filter((automation) => automation.workspaceId === id)
        .map((automation) => automation.id)
      const deletedProjectRoot = deletingWorkspace.projectRootPath
      const removedDingTalkBindings = dingtalkBridgeManager.removeBindingsForDeletedWorkspace(id, affectedSessionIds)
      const removedWeChatBindings = wechatBridge.removeBindingsForDeletedWorkspace(id, affectedSessionIds)
      const removedFeishuBindings = feishuBridgeManager.removeBindingsForDeletedWorkspace(id, affectedSessionIds)

      if (removedDingTalkBindings > 0) {
        console.log(`[项目删除] 已移除 ${removedDingTalkBindings} 条钉钉聊天绑定`)
      }
      if (removedWeChatBindings > 0) {
        console.log(`[项目删除] 已移除 ${removedWeChatBindings} 条微信聊天绑定`)
      }
      if (removedFeishuBindings > 0) {
        console.log(`[项目删除] 已移除 ${removedFeishuBindings} 条飞书聊天绑定`)
      }

      for (const sessionId of affectedSessionIds) {
        if (await isAgentSessionActive(sessionId)) {
          await stopAgent(sessionId)
        }
        deleteAgentSession(sessionId)
      }
      for (const automationId of affectedAutomationIds) {
        await runtimeAutomationApiClient.delete(automationId)
      }
      if (affectedAutomationIds.length > 0) {
        broadcastAutomationsChanged()
      }
      deleteAgentWorkspace(id)

      if (deletedProjectRoot) releaseDirectoryWatcherIfUnreferenced(deletedProjectRoot)
    }
  )

  // 重排工作区顺序
  ipcMain.handle(
    AGENT_IPC_CHANNELS.REORDER_WORKSPACES,
    async (_, orderedIds: string[]): Promise<AgentWorkspace[]> => {
      return reorderAgentWorkspaces(orderedIds)
    }
  )

  // 切换工作区置顶状态
  ipcMain.handle(
    AGENT_IPC_CHANNELS.TOGGLE_PIN_WORKSPACE,
    async (_, workspaceId: string): Promise<AgentWorkspace[]> => {
      return togglePinAgentWorkspace(workspaceId)
    }
  )
}
