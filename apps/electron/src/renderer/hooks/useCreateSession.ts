/**
 * useCreateSession — 共享的创建 Chat 对话 / Agent 会话逻辑
 *
 * 从 LeftSidebar 提取，供 WelcomeView 模式切换和侧边栏共同使用。
 */

import { useAtomValue, useSetAtom } from 'jotai'
import {
  conversationsAtom,
  selectedModelAtom,
} from '@/atoms/chat-atoms'
import {
  agentSessionsAtom,
  agentChannelIdAtom,
  agentModelIdAtom,
  currentAgentWorkspaceIdAtom,
} from '@/atoms/agent-atoms'
import { activeViewAtom } from '@/atoms/active-view'
import { promptConfigAtom, selectedPromptIdAtom } from '@/atoms/system-prompt-atoms'
import { draftSessionIdsAtom } from '@/atoms/draft-session-atoms'
import { useOpenSession } from './useOpenSession'
import { isAgentSessionMeta, sanitizeAgentSessions } from '@/lib/agent-session-list'
import { isHttpApiBridgeActive } from '@/lib/http-api-bridge'

function isSessionMeta(value: unknown): value is { id: string; title: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return typeof record.id === 'string' && record.id.length > 0 && typeof record.title === 'string'
}

interface CreateSessionOptions {
  /** 标记为草稿会话（不在侧边栏显示，发送首条消息后自动取消） */
  draft?: boolean
  /** 覆盖默认渠道 ID（仅 Agent 会话） */
  channelId?: string
  /** 覆盖默认模型 ID（仅 Agent 会话） */
  modelId?: string
  /** 覆盖当前工作区 ID（仅 Agent 会话） */
  workspaceId?: string
}

interface CreateSessionActions {
  /** 创建新 Chat 对话并打开标签页 */
  createChat: (options?: CreateSessionOptions) => Promise<string | undefined>
  /** 创建新 Agent 会话并打开标签页 */
  createAgent: (options?: CreateSessionOptions) => Promise<string | undefined>
}

export function useCreateSession(): CreateSessionActions {
  const openSession = useOpenSession()
  const setActiveView = useSetAtom(activeViewAtom)
  const setDraftSessionIds = useSetAtom(draftSessionIdsAtom)

  // Chat
  const setConversations = useSetAtom(conversationsAtom)
  const selectedModel = useAtomValue(selectedModelAtom)
  const promptConfig = useAtomValue(promptConfigAtom)
  const setSelectedPromptId = useSetAtom(selectedPromptIdAtom)

  // Agent
  const setAgentSessions = useSetAtom(agentSessionsAtom)
  const agentChannelId = useAtomValue(agentChannelIdAtom)
  const agentModelId = useAtomValue(agentModelIdAtom)
  const currentWorkspaceId = useAtomValue(currentAgentWorkspaceIdAtom)

  const createChat = async (options?: CreateSessionOptions): Promise<string | undefined> => {
    if (isHttpApiBridgeActive()) return undefined
    try {
      const meta = await window.electronAPI.createConversation(
        undefined,
        selectedModel?.modelId,
        selectedModel?.channelId,
      )
      if (!isSessionMeta(meta)) throw new Error('创建 Chat 对话未返回有效会话')
      setConversations((prev) => [meta, ...prev])
      openSession('chat', meta.id, meta.title)
      setActiveView('conversations')
      if (promptConfig.defaultPromptId) {
        setSelectedPromptId(promptConfig.defaultPromptId)
      }
      if (options?.draft) {
        setDraftSessionIds((prev: Set<string>) => { const next = new Set(prev); next.add(meta.id); return next })
      }
      return meta.id
    } catch (error) {
      console.error('[创建会话] 创建 Chat 对话失败:', error)
      return undefined
    }
  }

  const createAgent = async (options?: CreateSessionOptions): Promise<string | undefined> => {
    if (isHttpApiBridgeActive()) return undefined
    try {
      const meta = await window.electronAPI.createAgentSession(
        undefined,
        options?.channelId ?? agentChannelId ?? undefined,
        options?.workspaceId ?? currentWorkspaceId ?? undefined,
        options?.modelId ?? agentModelId ?? undefined,
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

  return { createChat, createAgent }
}
