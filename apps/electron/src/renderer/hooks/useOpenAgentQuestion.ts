import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { toast } from 'sonner'
import {
  agentDiffPanelTabAtom,
  agentPendingPromptAtom,
  agentSessionsAtom,
  agentSessionDraftsAtom,
  agentSidePanelOpenAtom,
  agentSideQuestionReferenceMapAtom,
  agentSideQuestionSessionMapAtom,
} from '@/atoms/agent-atoms'
import { quotedSelectionMapAtom } from '@/atoms/preview-atoms'
import { buildAgentSideQuestionPrompt, findPreviousCompletedAssistantUuid } from '@/lib/agent-side-question'

export interface OpenAgentQuestionSelection {
  text: string
  sourceLabel: string
  filePath?: string
  sourceType?: 'file' | 'agent-history' | 'scratch-pad'
  messageId?: string
  messageRole?: 'user' | 'assistant' | 'system'
  startLine?: number
  endLine?: number
}

export interface OpenAgentQuestionInput {
  parentSessionId: string
  selection: OpenAgentQuestionSelection
  question?: string
}

export type OpenAgentQuestion = (input: OpenAgentQuestionInput) => Promise<string | null>

/**
 * 打开或复用 Agent 右侧问答子会话。
 *
 * 该入口同时服务 Agent 历史和文件预览选区，保证两处都不会重新创建 Chat
 * conversation。问答子会话的选区以子 sessionId 为 key 保存。
 */
export function useOpenAgentQuestion(): OpenAgentQuestion {
  const sessions = useAtomValue(agentSessionsAtom)
  const setSessions = useSetAtom(agentSessionsAtom)
  const setDrafts = useSetAtom(agentSessionDraftsAtom)
  const setPendingPrompt = useSetAtom(agentPendingPromptAtom)
  const setQuotedSelections = useSetAtom(quotedSelectionMapAtom)
  const setQuestionMap = useSetAtom(agentSideQuestionSessionMapAtom)
  const setReferenceMap = useSetAtom(agentSideQuestionReferenceMapAtom)
  const setPanelOpen = useSetAtom(agentSidePanelOpenAtom)
  const setPanelTabs = useSetAtom(agentDiffPanelTabAtom)

  return React.useCallback(async ({ parentSessionId, selection, question }: OpenAgentQuestionInput): Promise<string | null> => {
    const parent = sessions.find((item) => item.id === parentSessionId)
    if (!parent) {
      toast.error('父 Agent 会话不存在')
      return null
    }

    let childSessionId = findExistingAgentQuestionChild(sessions, parentSessionId)
    let contextMode: 'fork' | 'referenced-session' = 'referenced-session'
    let createdChild = false

    try {
      if (!childSessionId) {
        const persistedMessages = parent.piEntryBindings
          ? await window.electronAPI.getAgentSessionSDKMessages(parent.id)
          : []
        const upToMessageUuid = findPreviousCompletedAssistantUuid(persistedMessages, parent.piEntryBindings ?? {}) ?? undefined
        const result = await window.electronAPI.createAgentSideQuestionSession({
          parentSessionId,
          upToMessageUuid,
          modelId: parent.modelId,
        })
        childSessionId = result.session.id
        contextMode = result.contextMode
        createdChild = true
        setSessions((prev) => prev.some((item) => item.id === result.session.id)
          ? prev.map((item) => item.id === result.session.id ? result.session : item)
          : [result.session, ...prev])
      } else {
        const referenceParentId = sessions.find((item) => item.id === childSessionId)?.parentSessionId
        contextMode = referenceParentId ? 'referenced-session' : 'fork'
      }

      const childId = childSessionId
      if (!childId) return null

      setQuestionMap((prev) => new Map(prev).set(parentSessionId, childId))
      setQuotedSelections((prev) => new Map(prev).set(childId, {
        text: selection.text,
        filePath: selection.filePath ?? selection.sourceLabel,
        sourceType: selection.sourceType ?? 'agent-history',
        sourceLabel: selection.sourceLabel,
        messageId: selection.messageId,
        messageRole: selection.messageRole,
        startLine: selection.startLine,
        endLine: selection.endLine,
        capturedAt: Date.now(),
      }))
      if (contextMode === 'referenced-session') {
        setReferenceMap((prev) => new Map(prev).set(childId, parentSessionId))
      } else {
        setReferenceMap((prev) => {
          if (!prev.has(childId)) return prev
          const next = new Map(prev)
          next.delete(childId)
          return next
        })
      }
      setDrafts((prev) => new Map(prev).set(childId, question?.trim() || '请基于本轮之前的 Agent 对话上下文回答问题。\n\n'))
      setPanelOpen(true)
      setPanelTabs((prev) => new Map(prev).set(parentSessionId, 'qa'))

      if (question?.trim()) {
        const prompt = buildAgentSideQuestionPrompt({
          quotedText: selection.text,
          sourceLabel: selection.sourceLabel,
          question: question.trim(),
          referencedSessionId: parentSessionId,
        })
        setPendingPrompt({
          sessionId: childId,
          message: prompt,
          ...(contextMode === 'referenced-session' && { mentionedSessionIds: [parentSessionId] }),
        })
      }
      return childId
    } catch (error) {
      console.error('[Agent 问答] 打开问答子会话失败:', error)
      if (createdChild && childSessionId) {
        setSessions((prev) => prev.filter((item) => item.id !== childSessionId))
      }
      toast.error('打开 Agent 问答失败', { description: error instanceof Error ? error.message : String(error) })
      return null
    }
  }, [sessions, setDrafts, setPanelOpen, setPanelTabs, setPendingPrompt, setQuestionMap, setQuotedSelections, setReferenceMap, setSessions])
}

function findExistingAgentQuestionChild(
  sessions: readonly { id: string; parentSessionId?: string; title: string }[],
  parentSessionId: string,
): string | null {
  return sessions.find((item) => item.parentSessionId === parentSessionId && item.title === 'Agent 问答')?.id ?? null
}
