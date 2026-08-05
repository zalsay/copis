import { describe, expect, test } from 'bun:test'
import type { BrowserWorkflowStatus } from '@copis/shared'
import { getBrowserWorkflowToolbarAction } from './browser-workflow-toolbar'

function status(state: BrowserWorkflowStatus['state'], run = false): BrowserWorkflowStatus {
  return {
    sessionId: 'session-1',
    state,
    ...(run ? { run: {
      runId: 'run-1',
      workflowId: 'workflow-1',
      version: 1,
      status: 'running' as const,
      startedAt: 1,
    } } : {}),
  }
}

describe('网页工具栏 Browser Workflow 状态', () => {
  test('Given 当前没有录制 When 点击 Copis 按钮 Then 应开始录制', () => {
    expect(getBrowserWorkflowToolbarAction(status('idle'))).toBe('start-recording')
  })

  test('Given 当前正在录制 When 点击 Copis 按钮 Then 应停止录制', () => {
    expect(getBrowserWorkflowToolbarAction(status('recording'))).toBe('stop-recording')
  })

  test('Given Workflow 正在总结或运行 When 点击 Copis 按钮 Then 只打开 Agent 面板', () => {
    expect(getBrowserWorkflowToolbarAction(status('awaiting_summary'))).toBe('open-agent')
    expect(getBrowserWorkflowToolbarAction(status('running', true))).toBe('open-agent')
  })
})
