import { ipcMain } from 'electron'
import { AGENT_IPC_CHANNELS, isCopisPermissionMode, isCopisWorkingChannelId, isWorkingMode } from '@copis/shared'
import type { AgentSessionMeta, AgentSendInput, AgentRuntime, AgentThinkingLevel, GetTaskOutputInput, GetTaskOutputResult, StopTaskInput, CopisPermissionMode } from '@copis/shared'
import { getChannelById } from '../lib/channel-manager'
import { resolvePiReasoningCapability } from '../lib/adapters/pi-model-registry'
import { refreshBrowserWorkflowStatus } from '../lib/browser-workflow-service'
import { getWorkingModelCatalogAccess } from '../lib/working-model-catalog-access'
import { getAgentSessionMeta, updateAgentSessionMeta } from '../lib/agent-session-manager'
import { runAgent, stopAgent, isAgentSessionActive, queueAgentMessage, updateAgentPermissionMode } from '../lib/agent-service'
import { feishuBridgeManager } from '../lib/feishu-bridge-manager'
import { assertWorkingCustomModelSelection } from '../lib/working-model-catalog'

import { isAgentRuntime } from '../lib/agent-runtime-validation'

export function registerAgentExecutionIpcHandlers(): void {
  // 发送 Agent 消息（触发 Agent SDK 流式响应）
  ipcMain.handle(
    AGENT_IPC_CHANNELS.SEND_MESSAGE,
    async (event, input: AgentSendInput): Promise<void> => {
      const session = getAgentSessionMeta(input.sessionId)
      if (session) {
        await feishuBridgeManager.startSessionMirrorRun(session).catch((error) => {
          console.error('[飞书 Session 镜像] 流式卡片初始化失败:', error)
        })
      }
      await runAgent(input, event.sender)
    }
  )

  // 中止 Agent 执行
  ipcMain.handle(
    AGENT_IPC_CHANNELS.STOP_AGENT,
    async (_, sessionId: string): Promise<void> => {
      feishuBridgeManager.stopSessionMirrorRun(sessionId)
      await stopAgent(sessionId)
    }
  )

  // ===== Agent 队列消息 =====

  // 排队发送消息
  ipcMain.handle(
    AGENT_IPC_CHANNELS.QUEUE_MESSAGE,
    async (event, input: import('@copis/shared').AgentQueueMessageInput): Promise<string> => {
      return queueAgentMessage(input, event.sender)
    }
  )

  // ===== Agent 后台任务管理 =====

  // 获取任务输出（保留接口，供未来扩展）
  ipcMain.handle(
    AGENT_IPC_CHANNELS.GET_TASK_OUTPUT,
    async (_, input: GetTaskOutputInput): Promise<GetTaskOutputResult> => {
      try {
        // TODO: 实现通过 SDK 的 TaskOutput 获取任务输出
        console.warn('[IPC] GET_TASK_OUTPUT: 当前版本暂未实现，返回空输出')
        return {
          output: '',
          isComplete: false,
        }
      } catch (error) {
        console.error('[IPC] 获取任务输出失败:', error)
        throw error
      }
    }
  )
}

export function registerAgentExecutionSettingsIpcHandlers(): void {
  // 停止任务
  ipcMain.handle(
    AGENT_IPC_CHANNELS.STOP_TASK,
    async (_, input: StopTaskInput): Promise<void> => {
      try {
        if (input.type === 'shell') {
          console.warn('[IPC] STOP_TASK: Shell 任务停止功能待实现')
        } else {
          console.warn('[IPC] STOP_TASK: Agent 任务暂不支持单独停止')
        }
      } catch (error) {
        console.error('[IPC] 停止任务失败:', error)
        throw error
      }
    }
  )

  // 热切换指定会话的权限模式（运行中生效，不广播）
  ipcMain.handle(
    AGENT_IPC_CHANNELS.UPDATE_SESSION_PERMISSION_MODE,
    async (_, sessionId: string, mode: CopisPermissionMode): Promise<void> => {
      if (!isCopisPermissionMode(mode)) {
        throw new Error(`无效的权限模式: ${mode}`)
      }
      // 会话不存在时直接抛错（避免 updateAgentSessionMeta 的通用异常被降级为 warn）
      if (!getAgentSessionMeta(sessionId)) {
        throw new Error(`Agent 会话不存在: ${sessionId}`)
      }
      // 持久化到 session meta（重启后可恢复，即使 session 未运行也要写）。
      // 这里的 catch 仅用于兜底磁盘 I/O 类异常，不影响后续热切换。
      try {
        updateAgentSessionMeta(sessionId, { permissionMode: mode })
      } catch (err) {
        console.warn(`[IPC] 持久化 session 权限模式失败: sessionId=${sessionId}`, err)
      }
      // Rust 根据会话策略是否存在判断是否正在运行：空闲会话正常返回，运行中会话立即更新 Rust 策略。
      await updateAgentPermissionMode(sessionId, mode).catch((err) => {
        console.warn(`[IPC] 运行中权限模式切换失败: sessionId=${sessionId}`, err)
        throw err
      })
    }
  )

  // 切换指定会话的 Composer 高级授权；网页控制立即同步，Git/SSH 在下一轮执行时生效。
  ipcMain.handle(
    AGENT_IPC_CHANNELS.UPDATE_SESSION_ADVANCED_AUTHORIZATION,
    async (_, sessionId: string, enabled: boolean): Promise<AgentSessionMeta> => {
      if (typeof enabled !== 'boolean') {
        throw new Error(`无效的高级授权状态: ${String(enabled)}`)
      }
      if (!getAgentSessionMeta(sessionId)) {
        throw new Error(`Agent 会话不存在: ${sessionId}`)
      }
      const updated = updateAgentSessionMeta(sessionId, { advancedAuthorization: enabled })
      refreshBrowserWorkflowStatus(sessionId)
      return updated
    }
  )

  // 切换指定会话的 Agent runtime（空闲后下一轮生效）
  ipcMain.handle(
    AGENT_IPC_CHANNELS.UPDATE_SESSION_CODEX_FAST_MODE,
    async (_, sessionId: string, enabled: boolean): Promise<AgentSessionMeta> => {
      if (typeof enabled !== 'boolean') {
        throw new Error(`无效的 Codex Fast Mode 状态: ${String(enabled)}`)
      }
      if (!getAgentSessionMeta(sessionId)) {
        throw new Error(`Agent 会话不存在: ${sessionId}`)
      }
      if (await isAgentSessionActive(sessionId)) {
        throw new Error('Agent 正在运行，完成后再切换快速模式')
      }
      return updateAgentSessionMeta(sessionId, { codexFastMode: enabled })
    }
  )

  // 切换 Copis Working 模式；当前运行仍使用启动时的模式，下一轮生效。
  ipcMain.handle(
    AGENT_IPC_CHANNELS.UPDATE_SESSION_WORKING_MODE,
    async (_, sessionId: string, mode: unknown, channelId?: string, modelId?: string): Promise<AgentSessionMeta> => {
      if (!isWorkingMode(mode)) {
        throw new Error(`无效的 Working 模式: ${String(mode)}`)
      }
      if (!getAgentSessionMeta(sessionId)) {
        throw new Error(`Agent 会话不存在: ${sessionId}`)
      }
      if (await isAgentSessionActive(sessionId)) {
        throw new Error('Agent 正在运行，完成后再切换 Working 模式')
      }
      const access = getWorkingModelCatalogAccess()
      assertWorkingCustomModelSelection(channelId, modelId, access.isVip, access.ownerId)
      const updates: Partial<Pick<AgentSessionMeta, 'channelId' | 'modelId' | 'workingMode'>> = { workingMode: mode }
      if (channelId !== undefined) updates.channelId = channelId
      if (modelId !== undefined) updates.modelId = modelId
      return updateAgentSessionMeta(sessionId, updates)
    }
  )

  ipcMain.handle(
    AGENT_IPC_CHANNELS.GET_PI_REASONING_CAPABILITY,
    async (_, channelId: string, modelId: string) => {
      if (!channelId || !modelId) return undefined
      if (isCopisWorkingChannelId(channelId)) {
        return resolvePiReasoningCapability('openai-responses', modelId)
      }
      const channel = getChannelById(channelId)
      if (!channel) return undefined
      return resolvePiReasoningCapability(channel.provider, modelId)
    }
  )

  ipcMain.handle(
    AGENT_IPC_CHANNELS.UPDATE_SESSION_REASONING_LEVEL,
    async (_, sessionId: string, thinkingLevel: AgentThinkingLevel): Promise<AgentSessionMeta> => {
      const validThinkingLevels: AgentThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
      if (!validThinkingLevels.includes(thinkingLevel)) {
        throw new Error(`无效的 Codex 思考深度: ${String(thinkingLevel)}`)
      }
      if (!getAgentSessionMeta(sessionId)) {
        throw new Error(`Agent 会话不存在: ${sessionId}`)
      }
      // 当前运行已在启动时读取推理深度；此处只更新会话的下一轮配置。
      return updateAgentSessionMeta(sessionId, { reasoningLevel: thinkingLevel })
    }
  )

  ipcMain.handle(
    AGENT_IPC_CHANNELS.UPDATE_SESSION_AGENT_RUNTIME,
    async (_, sessionId: string, runtime: AgentRuntime): Promise<AgentSessionMeta> => {
      if (!isAgentRuntime(runtime)) {
        throw new Error(`无效的 Agent runtime: ${String(runtime)}`)
      }
      const current = getAgentSessionMeta(sessionId)
      if (!current) {
        throw new Error(`Agent 会话不存在: ${sessionId}`)
      }

      const updates: Partial<Pick<AgentSessionMeta, 'agentRuntime' | 'sdkSessionId' | 'piSessionFile' | 'piEntryBindings'>> = {
        agentRuntime: runtime,
      }
      // 旧版本可能留下 Claude session ID，但没有 Pi artifact；不能把它交给 Pi resume。
      if (!current.piSessionFile && current.sdkSessionId) {
        updates.sdkSessionId = undefined
        updates.piEntryBindings = undefined
      }

      return updateAgentSessionMeta(sessionId, updates)
    }
  )
}
