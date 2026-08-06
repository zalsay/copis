import type { SDKMessage } from '@copis/shared'

export interface AgentSideQuestionPromptInput {
  quotedText: string
  sourceLabel: string
  question: string
  referencedSessionId: string
}

/**
 * 只从持久化消息和 Pi entry 映射中选择 fork 点。
 * liveMessages 不进入这个函数，因此正在生成的 assistant turn 不会被带入分支。
 */
export function findPreviousCompletedAssistantUuid(
  persistedMessages: readonly SDKMessage[],
  piEntryBindings: Readonly<Record<string, string>>,
): string | null {
  let result: string | null = null
  for (const message of persistedMessages) {
    if (message.type !== 'assistant' || typeof message.uuid !== 'string' || message.uuid.length === 0) continue
    const entryId = piEntryBindings[message.uuid]
    if (typeof entryId === 'string' && entryId.length > 0) result = message.uuid
  }
  return result
}

export function buildAgentSideQuestionPrompt({
  quotedText,
  sourceLabel,
  question,
  referencedSessionId,
}: AgentSideQuestionPromptInput): string {
  return [
    '请基于本轮之前的 Agent 对话上下文回答问题。',
    `父 Agent 会话：${referencedSessionId}`,
    '',
    `引用来源：${sourceLabel}`,
    '---',
    quotedText,
    '---',
    '',
    `我的问题：${question}`,
  ].join('\n')
}
