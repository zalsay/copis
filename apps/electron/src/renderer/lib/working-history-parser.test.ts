import { describe, expect, test } from 'bun:test'
import type { SDKAssistantMessage, SDKMessage, SDKUserMessage } from '@proma/shared'
import { parseWorkingSessionHistory } from './working-history-parser'

function isAssistant(message: SDKMessage): message is SDKAssistantMessage {
  return message.type === 'assistant'
}

function isUser(message: SDKMessage): message is SDKUserMessage {
  return message.type === 'user'
}

function toolNames(messages: SDKMessage[]): string[] {
  return messages
    .filter(isAssistant)
    .flatMap((message) => message.message.content)
    .map((block) => block as unknown as Record<string, unknown>)
    .filter((block) => block.type === 'tool_use' && typeof block.name === 'string')
    .map((block) => block.name as string)
}

describe('Working 历史 JSONL 解析', () => {
  test('将消息、工具、文件变更、Patch 和 Todo 转换为 Proma SDK 消息', () => {
    const jsonl = [
      JSON.stringify({ type: 'session_meta', payload: { session_id: 'working-session-1' } }),
      JSON.stringify({ type: 'event_msg', timestamp: '2026-08-01T00:00:00Z', payload: { type: 'user_message', message: '整理周报' } }),
      JSON.stringify({ type: 'response_item', timestamp: '2026-08-01T00:00:01Z', payload: { type: 'function_call', call_id: 'call-1', name: 'Bash', arguments: '{"command":"pwd"}' } }),
      JSON.stringify({ type: 'response_item', timestamp: '2026-08-01T00:00:02Z', payload: { type: 'function_call_output', call_id: 'call-1', output: '/tmp/workspace' } }),
      JSON.stringify({ type: 'item.completed', timestamp: '2026-08-01T00:00:03Z', item: { type: 'file_change', path: 'report.md', content: '# 周报', status: 'completed' } }),
      JSON.stringify({ type: 'item.completed', timestamp: '2026-08-01T00:00:04Z', item: { type: 'todo_list', todos: [{ content: '发送周报', status: 'pending' }] } }),
      JSON.stringify({ type: 'response_item', timestamp: '2026-08-01T00:00:05Z', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '已完成' }] } }),
      JSON.stringify({ type: 'turn.completed', timestamp: '2026-08-01T00:00:06Z', usage: { input_tokens: 10, output_tokens: 4 } }),
    ].join('\n')

    const result = parseWorkingSessionHistory(jsonl)
    expect(result.sessionId).toBe('working-session-1')
    expect(result.status).toBe('completed')
    expect(result.diagnostics).toEqual([])
    expect(result.messages.filter((message) => message.type === 'user').length).toBeGreaterThanOrEqual(3)
    expect(result.messages.filter(isAssistant).some((message) => message.isReplay === true)).toBeFalse()
    expect(toolNames(result.messages)).toEqual(expect.arrayContaining(['Bash', 'Write', 'TodoWrite']))
    expect(result.messages.some((message) => message.type === 'result')).toBeTrue()
  })

  test('从 Working patch proposal 显示文件内容，并过滤内部环境 prompt', () => {
    const proposal = JSON.stringify({
      type: 'working.patch_proposal',
      summary: '更新说明',
      files: [{ path: 'README.md', content: '# Copis' }],
    })
    const result = parseWorkingSessionHistory([
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>internal</environment_context>\n{"submitted_message":"真实任务"}' }] } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: proposal }] } }),
    ].join('\n'))

    const userTexts = result.messages
      .filter(isUser)
      .flatMap((message) => message.message?.content ?? [])
      .map((block) => block as unknown as Record<string, unknown>)
      .filter((block) => block.type === 'text')
      .map((block) => block.text as string)
    expect(userTexts).toEqual(['真实任务'])
    expect(toolNames(result.messages)).toContain('Write')
  })

  test('保留失败和停止状态，并报告坏 JSONL 行', () => {
    const result = parseWorkingSessionHistory([
      '{bad json',
      JSON.stringify({ type: 'turn.failed', error: { message: '模型失败' } }),
      JSON.stringify({ type: 'turn.aborted', reason: '用户停止' }),
    ].join('\n'))

    expect(result.diagnostics).toHaveLength(1)
    expect(result.status).toBe('stopped')
    expect(result.messages.filter(isAssistant).filter((message) => message.error).map((message) => message.error?.message)).toEqual(['模型失败', '用户停止'])
  })
})
