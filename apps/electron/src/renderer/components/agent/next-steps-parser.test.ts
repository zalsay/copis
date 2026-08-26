import { describe, expect, test } from 'bun:test'
import {
  extractLatestAssistantNextSteps,
  extractNextStepSuggestions,
  stripNextStepsBlock,
} from './next-steps-parser'
import type { SDKAssistantMessage, SDKMessage, SDKUserMessage } from '@copis/shared'

describe('next-steps-parser', () => {
  test('提取标准 json:next-steps 代码块中的建议', () => {
    const text = `
任务已完成。所有测试均已通过。

\`\`\`json:next-steps
{
  "next_steps": [
    {
      "type": "summarize-workflow",
      "title": "总结工作流",
      "description": "沉淀实施 SOP",
      "action": "总结这次任务的工作流与实施要点"
    },
    {
      "type": "automation",
      "title": "自动化办公",
      "description": "设置为每日自动巡检",
      "action": "将该流程创建为定时任务"
    }
  ]
}
\`\`\`
`
    const result = extractNextStepSuggestions(text)
    expect(result).toHaveLength(2)
    expect(result[0]!.title).toBe('总结工作流')
    expect(result[0]!.type).toBe('summarize-workflow')
    expect(result[0]!.action).toBe('总结这次任务的工作流与实施要点')
    expect(result[1]!.title).toBe('自动化办公')
    expect(result[1]!.type).toBe('automation')
  })

  test('提取普通 json 代码块中包含 next_steps 的结构', () => {
    const text = `
已修复问题。

\`\`\`json
{
  "next_steps": [
    {
      "type": "session-summary",
      "title": "会话总结",
      "description": "整理本次长会话要点",
      "action": "总结本次会话"
    }
  ]
}
\`\`\`
`
    const result = extractNextStepSuggestions(text)
    expect(result).toHaveLength(1)
    expect(result[0]!.title).toBe('会话总结')
    expect(result[0]!.type).toBe('session-summary')
  })

  test('文本中无 next_steps 时返回空数组', () => {
    const text = '这是普通回复，没有建议。'
    expect(extractNextStepSuggestions(text)).toEqual([])
  })

  test('stripNextStepsBlock 移除代码块并保留正文', () => {
    const text = `这里是回复内容。

\`\`\`json:next-steps
{
  "next_steps": [
    { "title": "总结工作流" }
  ]
}
\`\`\``

    const stripped = stripNextStepsBlock(text)
    expect(stripped).toBe('这里是回复内容。')
    expect(stripped).not.toContain('json:next-steps')
  })

  test('extractLatestAssistantNextSteps 提取最新助手消息中的建议', () => {
    const messages: SDKMessage[] = [
      {
        type: 'user',
        parent_tool_use_id: null,
      } as SDKUserMessage,
      {
        type: 'assistant',
        parent_tool_use_id: null,
        message: {
          content: [
            {
              type: 'text',
              text: '实施完毕。\n```json:next-steps\n{"next_steps": [{"title": "会话总结"}]}\n```',
            },
          ],
        },
      } as SDKAssistantMessage,
    ]

    const result = extractLatestAssistantNextSteps(messages)
    expect(result).toHaveLength(1)
    expect(result[0]!.title).toBe('会话总结')
  })

  test('若用户已发出新一轮消息，extractLatestAssistantNextSteps 返回空数组', () => {
    const messages: SDKMessage[] = [
      {
        type: 'assistant',
        parent_tool_use_id: null,
        message: {
          content: [
            {
              type: 'text',
              text: '实施完毕。\n```json:next-steps\n{"next_steps": [{"title": "会话总结"}]}\n```',
            },
          ],
        },
      } as SDKAssistantMessage,
      {
        type: 'user',
        parent_tool_use_id: null,
      } as SDKUserMessage,
    ]

    const result = extractLatestAssistantNextSteps(messages)
    expect(result).toEqual([])
  })
})
