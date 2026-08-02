import { describe, expect, test } from 'bun:test'
import { deriveWorkingRunState } from './working-run-state'

describe('Working 本地运行状态', () => {
  test('汇总工具、文件和 Todo 事件，并保留最终成功状态', () => {
    const state = deriveWorkingRunState([
      { type: 'run_started', sessionId: 'session-1', startedAt: 1 },
      { type: 'tool_call', sessionId: 'session-1', toolUseId: 'tool-1', toolName: 'Edit', input: {} },
      { type: 'file_change', sessionId: 'session-1', path: 'src/app.ts' },
      { type: 'patch', sessionId: 'session-1', files: [{ path: 'src/index.ts' }, { path: 'src/main.ts' }] },
      { type: 'todo', sessionId: 'session-1', todos: [{ content: '检查' }, { content: '测试' }] },
      { type: 'run_completed', sessionId: 'session-1' },
    ])

    expect(state).toMatchObject({
      status: 'completed',
      toolCallCount: 1,
      fileChangeCount: 3,
      todoCount: 2,
    })
  })

  test('失败状态保留可展示的错误，下一轮开始时清除旧错误', () => {
    const state = deriveWorkingRunState([
      { type: 'run_started', sessionId: 'session-1', startedAt: 1 },
      { type: 'run_failed', sessionId: 'session-1', error: '连接断开' },
      { type: 'run_started', sessionId: 'session-1', startedAt: 2 },
    ])

    expect(state).toMatchObject({ status: 'running', error: undefined })
  })
})
