import { describe, expect, test } from 'bun:test'
import type { AgentStreamCompletePayload, AgentStreamEvent, SDKMessage } from '../types/agent'
import { adaptWorkingStreamComplete, adaptWorkingStreamError, adaptWorkingStreamEvent } from './working-event-adapter'

function stream(message: SDKMessage): AgentStreamEvent {
  return {
    sessionId: 'session-1',
    payload: { kind: 'sdk_message', message },
  }
}

describe('Working 事件适配', () => {
  test('将 Pi init 消息映射为运行开始事件', () => {
    const events = adaptWorkingStreamEvent(stream({
      type: 'system',
      subtype: 'init',
      model: 'working-model',
      session_id: 'session-1',
      _createdAt: 123,
    }))
    expect(events).toEqual([{
      type: 'run_started',
      sessionId: 'session-1',
      startedAt: 123,
      model: 'working-model',
    }])
  })

  test('将 Pi assistant 消息映射为文本、文件变更和 Todo 事件', () => {
    const events = adaptWorkingStreamEvent(stream({
      type: 'assistant',
      uuid: 'assistant-1',
      parent_tool_use_id: null,
      message: {
        content: [
          { type: 'text', text: '已完成' },
          { type: 'tool_use', id: 'edit-1', name: 'Edit', input: { file_path: 'a.ts', old_string: 'a', new_string: 'b' } },
          { type: 'tool_use', id: 'todo-1', name: 'TodoWrite', input: { todos: [{ content: '检查', status: 'pending' }] } },
        ],
      },
    }))

    expect(events.map((event) => event.type)).toEqual(['message_delta', 'tool_call', 'file_change', 'tool_call', 'todo'])
    expect(events[1]).toMatchObject({ toolUseId: 'edit-1', toolName: 'Edit' })
    expect(events[2]).toMatchObject({ path: 'a.ts', operation: 'Edit' })
    expect(events[4]).toMatchObject({ toolUseId: 'todo-1', todos: [{ content: '检查', status: 'pending' }] })
  })

  test('将工具结果和终态错误映射为 Working 事件', () => {
    const toolEvents = adaptWorkingStreamEvent(stream({
      type: 'user',
      uuid: 'result-1',
      parent_tool_use_id: null,
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: '失败', is_error: true }],
      },
    }))
    expect(toolEvents).toEqual([{
      type: 'tool_result',
      sessionId: 'session-1',
      toolUseId: 'tool-1',
      result: '失败',
      isError: true,
    }])

    const complete: AgentStreamCompletePayload = {
      sessionId: 'session-1',
      resultSubtype: 'error_during_execution',
      resultErrors: ['命令失败'],
    }
    expect(adaptWorkingStreamComplete(complete)).toEqual({
      type: 'run_failed',
      sessionId: 'session-1',
      error: '命令失败',
    })
    expect(adaptWorkingStreamError('session-1', '连接断开')).toEqual({
      type: 'run_failed',
      sessionId: 'session-1',
      error: '连接断开',
    })
  })

  test('保留用户停止语义，并支持旧版 Agent 事件', () => {
    const stopped = adaptWorkingStreamComplete({ sessionId: 'session-1', stoppedByUser: true })
    expect(stopped).toEqual({ type: 'run_stopped', sessionId: 'session-1', reason: '用户已停止运行' })

    const legacy = adaptWorkingStreamEvent({
      sessionId: 'session-1',
      payload: { kind: 'proma_event', event: { type: 'model_resolved', model: 'model-1' } },
      event: { type: 'tool_start', toolName: 'Bash', toolUseId: 'bash-1', input: { command: 'pwd' } },
    })
    expect(legacy).toEqual([{
      type: 'tool_call',
      sessionId: 'session-1',
      toolUseId: 'bash-1',
      toolName: 'Bash',
      input: { command: 'pwd' },
    }])
  })
})
