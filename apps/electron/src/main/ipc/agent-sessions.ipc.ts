import { ipcMain } from 'electron'
import { AGENT_IPC_CHANNELS } from '@copis/shared'
import type { AgentSessionMeta, AgentExpertTeamSession, AgentRuntime, AgentGenerateTitleInput, MoveSessionToWorkspaceInput, ForkSessionInput, CreateAgentSideQuestionSessionInput, AgentSideQuestionSessionResult, RewindSessionInput, RewindSessionResult, AgentSessionReferenceSearchInput, SDKMessage } from '@copis/shared'
import { getSettings } from '../lib/settings-service'
import { getWorkingModelCatalogAccess } from '../lib/working-model-catalog-access'
import { listAgentSessions, createAgentSession, getAgentSessionSDKMessages, updateAgentSessionMeta, deleteAgentSession, createAgentSideQuestionSession, moveSessionToWorkspace, forkAgentSession, searchAgentSessionMessages, searchAgentSessionReferences } from '../lib/agent-session-manager'
import { generateAgentTitle, isAgentSessionActive, rewindAgentSession } from '../lib/agent-service'
import { permissionService } from '../lib/agent-permission-service'
import { askUserService } from '../lib/agent-ask-user-service'
import { exitPlanService } from '../lib/agent-exit-plan-service'
import { watchAttachedDirectory } from '../lib/workspace-watcher'
import { feishuBridgeManager } from '../lib/feishu-bridge-manager'
import { assertWorkingCustomModelSelection } from '../lib/working-model-catalog'

export function registerAgentSessionsIpcHandlers(): void {
  // ===== Agent 会话管理相关 =====

  // 获取 Agent 会话列表
  ipcMain.handle(
    AGENT_IPC_CHANNELS.LIST_SESSIONS,
    async (): Promise<AgentSessionMeta[]> => {
      const sessions = listAgentSessions()
      // 启动所有已有附加目录的文件监听
      for (const session of sessions) {
        if (session.attachedDirectories) {
          for (const dir of session.attachedDirectories) {
            watchAttachedDirectory(dir)
          }
        }
      }
      return sessions
    }
  )

  // 创建 Agent 会话
  ipcMain.handle(
    AGENT_IPC_CHANNELS.CREATE_SESSION,
    async (_, title?: string, channelId?: string, workspaceId?: string, modelId?: string, expertTeamSession?: AgentExpertTeamSession, expertTeamSetup?: boolean, options?: { agentRuntime?: AgentRuntime; mode?: 'agent' | 'creation' }): Promise<AgentSessionMeta> => {
      const access = getWorkingModelCatalogAccess()
      assertWorkingCustomModelSelection(channelId, modelId, access.isVip, access.ownerId)
      const runtime = options?.agentRuntime ?? getSettings().agentRuntime ?? 'pi'
      const session = createAgentSession(
        title,
        channelId,
        workspaceId,
        modelId,
        runtime,
        undefined,
        expertTeamSession,
        expertTeamSetup,
        options?.mode ? { mode: options.mode } : undefined,
      )
      feishuBridgeManager.ensureSessionMirror(session).catch((error) => {
        console.error('[飞书 Session 镜像] 新会话建群失败:', error)
      })
      return session
    }
  )

  // 创建 Agent 右侧问答子会话；后续消息仍复用普通 Agent 发送链路。
  ipcMain.handle(
    AGENT_IPC_CHANNELS.CREATE_SIDE_QUESTION_SESSION,
    async (_, input: CreateAgentSideQuestionSessionInput): Promise<AgentSideQuestionSessionResult> => {
      const result = await createAgentSideQuestionSession(input)
      feishuBridgeManager.ensureSessionMirror(result.session).catch((error) => {
        console.error('[飞书 Session 镜像] Agent 问答子会话建群失败:', error)
      })
      return result
    },
  )

  // 获取 Agent 会话 SDKMessage（Phase 4 新格式）
  ipcMain.handle(
    AGENT_IPC_CHANNELS.GET_SDK_MESSAGES,
    async (_, id: string): Promise<SDKMessage[]> => {
      return getAgentSessionSDKMessages(id)
    }
  )

  // 更新 Agent 会话标题
  ipcMain.handle(
    AGENT_IPC_CHANNELS.UPDATE_TITLE,
    async (_, id: string, title: string): Promise<AgentSessionMeta> => {
      return updateAgentSessionMeta(id, { title })
    }
  )

  // 更新 Agent 会话模型选择
  ipcMain.handle(
    AGENT_IPC_CHANNELS.UPDATE_SESSION_MODEL,
    async (_, id: string, channelId?: string, modelId?: string): Promise<AgentSessionMeta> => {
      // 模型切换允许在运行中提交；当前 query 继续使用启动时的模型，下一轮读取新配置。
      const access = getWorkingModelCatalogAccess()
      assertWorkingCustomModelSelection(channelId, modelId, access.isVip, access.ownerId)
      return updateAgentSessionMeta(id, { channelId, modelId })
    }
  )

  // 生成 Agent 会话标题
  ipcMain.handle(
    AGENT_IPC_CHANNELS.GENERATE_TITLE,
    async (_, input: AgentGenerateTitleInput): Promise<string | null> => {
      return generateAgentTitle(input)
    }
  )

  // 删除 Agent 会话
  ipcMain.handle(
    AGENT_IPC_CHANNELS.DELETE_SESSION,
    async (_, id: string): Promise<void> => {
      // 清理权限服务中该会话的白名单
      permissionService.clearSessionWhitelist(id)
      permissionService.clearSessionPending(id)
      // 清理 AskUser 服务中的待处理请求
      askUserService.clearSessionPending(id)
      // 清理 ExitPlanMode 服务中的待处理请求
      exitPlanService.clearSessionPending(id)
      return deleteAgentSession(id)
    }
  )

  // 切换 Agent 会话置顶状态
  ipcMain.handle(
    AGENT_IPC_CHANNELS.TOGGLE_PIN,
    async (_, id: string): Promise<AgentSessionMeta> => {
      const sessions = listAgentSessions()
      const current = sessions.find((s) => s.id === id)
      if (!current) throw new Error(`Agent session not found: ${id}`)
      const newPinned = !current.pinned
      // 置顶时自动取消归档
      const updates: Partial<AgentSessionMeta> = { pinned: newPinned }
      if (newPinned && current.archived) {
        updates.archived = false
      }
      return updateAgentSessionMeta(id, updates)
    }
  )

  // 切换 Agent 会话星标状态
  ipcMain.handle(
    AGENT_IPC_CHANNELS.TOGGLE_STAR,
    async (_, id: string): Promise<AgentSessionMeta> => {
      const sessions = listAgentSessions()
      const current = sessions.find((s) => s.id === id)
      if (!current) throw new Error(`Agent session not found: ${id}`)
      return updateAgentSessionMeta(id, { starred: !current.starred })
    }
  )

  // 清除 Agent 会话完成状态（兼容清除旧版 manualWorking）
  ipcMain.handle(
    AGENT_IPC_CHANNELS.CLEAR_COMPLETION_STATE,
    async (_, id: string): Promise<AgentSessionMeta> => {
      const sessions = listAgentSessions()
      const current = sessions.find((s) => s.id === id)
      if (!current) throw new Error(`Agent session not found: ${id}`)
      const updates: Partial<AgentSessionMeta> = {}
      if (current.manualWorking) updates.manualWorking = false
      if (current.completedButUnconfirmed) updates.completedButUnconfirmed = false
      if (Object.keys(updates).length === 0) return current
      return updateAgentSessionMeta(id, updates)
    }
  )

  // 切换 Agent 会话归档状态
  ipcMain.handle(
    AGENT_IPC_CHANNELS.TOGGLE_ARCHIVE,
    async (_, id: string): Promise<AgentSessionMeta> => {
      const sessions = listAgentSessions()
      const current = sessions.find((s) => s.id === id)
      if (!current) throw new Error(`Agent session not found: ${id}`)
      const newArchived = !current.archived
      // 归档时自动取消置顶
      const updates: Partial<AgentSessionMeta> = { archived: newArchived }
      if (newArchived && current.pinned) {
        updates.pinned = false
      }
      return updateAgentSessionMeta(id, updates)
    }
  )

  // 搜索 Agent 会话消息内容
  ipcMain.handle(
    AGENT_IPC_CHANNELS.SEARCH_MESSAGES,
    async (_, query: string) => {
      return searchAgentSessionMessages(query)
    }
  )

  // 搜索可引用的 Agent 会话；省略 workspaceId 时跨工作区搜索。
  ipcMain.handle(
    AGENT_IPC_CHANNELS.SEARCH_SESSION_REFERENCES,
    async (_, input: AgentSessionReferenceSearchInput) => {
      return searchAgentSessionReferences(input)
    }
  )

  // 迁移 Agent 会话到另一个工作区
  ipcMain.handle(
    AGENT_IPC_CHANNELS.MOVE_SESSION_TO_WORKSPACE,
    async (_, input: MoveSessionToWorkspaceInput): Promise<AgentSessionMeta> => {
      // Pi Worker 的 SSE complete 与状态清理有极短竞态，短暂等待后由 Rust 再确认。
      if (await isAgentSessionActive(input.sessionId)) {
        await new Promise((r) => setTimeout(r, 500))
        if (await isAgentSessionActive(input.sessionId)) {
          throw new Error('会话正在运行中，请停止后再迁移')
        }
      }
      return moveSessionToWorkspace(input.sessionId, input.targetWorkspaceId)
    }
  )

  // 分叉 Agent 会话
  ipcMain.handle(
    AGENT_IPC_CHANNELS.FORK_SESSION,
    async (_, input: ForkSessionInput): Promise<AgentSessionMeta> => {
      const session = await forkAgentSession(input)
      // Fork 直接在 session manager 内创建元数据，绕过 CREATE_SESSION 的镜像生命周期。
      // 将它作为新的桌面会话处理，确保 Pi fork 也会立即获得可双向续聊的飞书群。
      feishuBridgeManager.ensureSessionMirror(session).catch((error) => {
        console.error('[飞书 Session 镜像] 分叉会话建群失败:', error)
      })
      return session
    }
  )

  // 快照回退（同一会话内回退到指定点）
  ipcMain.handle(
    AGENT_IPC_CHANNELS.REWIND_SESSION,
    async (_, input: RewindSessionInput): Promise<RewindSessionResult> => {
      return rewindAgentSession(
        input.sessionId,
        input.assistantMessageUuid,
      )
    }
  )
}
