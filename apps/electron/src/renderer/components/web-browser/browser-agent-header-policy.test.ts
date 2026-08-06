import { describe, expect, test } from 'bun:test'
import type { BrowserWorkflowStatus } from '@copis/shared'
import { getBrowserAgentHeaderState } from './browser-agent-header-policy'

function status(input: Partial<BrowserWorkflowStatus>): BrowserWorkflowStatus {
  return { state: 'idle', ...input }
}

describe('Browser Agent Header 状态', () => {
  test('Given 尚未授权当前页面 When 渲染 Header Then 选中询问模式', () => {
    expect(getBrowserAgentHeaderState(status({
      controlMode: 'ask',
      pageOrigin: 'https://example.com',
    }))).toEqual({
      mode: 'ask',
      tone: 'safe',
      originLabel: 'example.com',
      canAuthorize: true,
    })
  })

  test('Given 当前 Origin 已授权 When 渲染 Header Then 选中授权模式', () => {
    expect(getBrowserAgentHeaderState(status({
      controlMode: 'authorized',
      pageOrigin: 'https://example.com',
    }))).toMatchObject({ mode: 'authorized', tone: 'warning' })
  })

  test('Given 当前不是 HTTP 页面 When 渲染 Header Then 禁用授权按钮', () => {
    expect(getBrowserAgentHeaderState(status({ controlMode: 'ask', pageOrigin: '' })).canAuthorize).toBe(false)
  })
})
