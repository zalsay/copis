import { describe, expect, test } from 'bun:test'
import {
  resolveAgentConversationPermissionMode,
  shouldShowAgentPlanUi,
  shouldShowExitPlanBanner,
} from './browser-agent-permission-policy'

describe('Browser Agent 对话表面权限策略', () => {
  test('Browser variant 固定完全自动并忽略 stale plan 状态', () => {
    expect(resolveAgentConversationPermissionMode('browser', 'plan')).toBe('bypassPermissions')
    expect(shouldShowAgentPlanUi('browser', true)).toBe(false)
    expect(shouldShowExitPlanBanner('browser', 1)).toBe(false)
  })

  test('main variant 保持普通 Agent 的计划模式行为', () => {
    expect(resolveAgentConversationPermissionMode('main', 'plan')).toBe('plan')
    expect(shouldShowAgentPlanUi('main', true)).toBe(true)
    expect(shouldShowExitPlanBanner('main', 1)).toBe(true)
  })
})
