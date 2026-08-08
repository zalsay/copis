/**
 * useCreateSession — 共享的创建 Agent 会话逻辑
 *
 * 从 LeftSidebar 提取，供 WelcomeView 模式切换和侧边栏共同使用。
 */

import { useAtomValue, useSetAtom } from 'jotai'
import {
  agentSessionsAtom,
  agentChannelIdAtom,
  agentModelIdAtom,
  currentAgentWorkspaceIdAtom,
} from '@/atoms/agent-atoms'
import { activeViewAtom } from '@/atoms/active-view'
import { draftSessionIdsAtom } from '@/atoms/draft-session-atoms'
import { useOpenSession } from './useOpenSession'
import { isAgentSessionMeta, sanitizeAgentSessions } from '@/lib/agent-session-list'
import type { AgentExpertTeamSession } from '@copis/shared'

interface CreateSessionOptions {
  /** 覆盖默认标题。 */
  title?: string
  /** 标记为草稿会话（不在侧边栏显示，发送首条消息后自动取消） */
  draft?: boolean
  /** 覆盖默认渠道 ID（仅 Agent 会话） */
  channelId?: string
  /** 覆盖默认模型 ID（仅 Agent 会话） */
  modelId?: string
  /** 覆盖当前工作区 ID（仅 Agent 会话） */
  workspaceId?: string
  /** 专家团队工作台创建的主控会话关联信息。 */
  expertTeamSession?: AgentExpertTeamSession
  /** 由「新专家团」入口创建的筹备会话：主理人 Agent 先询问需求，再组建专家团队。 */
  expertTeamSetup?: boolean
}

interface CreateSessionActions {
  /** 创建新 Agent 会话并打开标签页 */
  createAgent: (options?: CreateSessionOptions) => Promise<string | undefined>
}

export function useCreateSession(): CreateSessionActions {
  const openSession = useOpenSession()
  const setActiveView = useSetAtom(activeViewAtom)
  const setDraftSessionIds = useSetAtom(draftSessionIdsAtom)

  // Agent
  const setAgentSessions = useSetAtom(agentSessionsAtom)
  const agentChannelId = useAtomValue(agentChannelIdAtom)
  const agentModelId = useAtomValue(agentModelIdAtom)
  const currentWorkspaceId = useAtomValue(currentAgentWorkspaceIdAtom)

  const createAgent = async (options?: CreateSessionOptions): Promise<string | undefined> => {
    try {
      const meta = await window.electronAPI.createAgentSession(
        options?.title,
        options?.channelId ?? agentChannelId ?? undefined,
        options?.workspaceId ?? currentWorkspaceId ?? undefined,
        options?.modelId ?? agentModelId ?? undefined,
        options?.expertTeamSession,
        options?.expertTeamSetup,
      )
      if (!isAgentSessionMeta(meta)) throw new Error('创建 Agent 会话未返回有效会话')
      setAgentSessions((prev) => [meta, ...sanitizeAgentSessions(prev)])
      openSession('agent', meta.id, meta.title)
      setActiveView('conversations')
      if (options?.draft) {
        setDraftSessionIds((prev: Set<string>) => { const next = new Set(prev); next.add(meta.id); return next })
      }
      return meta.id
    } catch (error) {
      // 浏览器模式的兼容层可能不提供本地 Agent 创建能力；清理此前可能残留的无效条目。
      setAgentSessions((prev) => sanitizeAgentSessions(prev))
      console.error('[创建会话] 创建 Agent 会话失败:', error)
      return undefined
    }
  }

  return { createAgent }
}
