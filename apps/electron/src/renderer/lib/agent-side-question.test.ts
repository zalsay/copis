import { describe, expect, test } from 'bun:test'
import type { SDKMessage } from '@copis/shared'
import {
  buildAgentSideQuestionPrompt,
  findPreviousCompletedAssistantUuid,
} from './agent-side-question'

function assistantMessage(uuid: string): SDKMessage {
  return {
    type: 'assistant',
    uuid,
    message: { content: [] },
    parent_tool_use_id: null,
  }
}

describe('Agent 侧问答上下文', () => {
  test('只从已持久化且有 Pi entry binding 的 assistant 消息选择 fork 点', () => {
    const messages: SDKMessage[] = [
      assistantMessage('completed-1'),
      assistantMessage('currently-streaming'),
    ]

    expect(findPreviousCompletedAssistantUuid(messages, { 'completed-1': 'entry-1' }))
      .toBe('completed-1')
  })

  test('没有安全 fork 点时返回 null，由 Agent referenced session 兜底', () => {
    expect(findPreviousCompletedAssistantUuid([assistantMessage('unbound')], {})).toBeNull()
  })

  test('问答提示词保留选区，并明确要求基于父 Agent 上下文', () => {
    const prompt = buildAgentSideQuestionPrompt({
      quotedText: '被选中的内容',
      sourceLabel: 'Agent 历史 · Agent 回复',
      question: '请解释这段内容',
      referencedSessionId: 'parent-1',
    })

    expect(prompt).toContain('被选中的内容')
    expect(prompt).toContain('本轮之前的 Agent 对话上下文')
    expect(prompt).toContain('parent-1')
  })
})
