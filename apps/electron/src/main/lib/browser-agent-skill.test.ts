import { describe, expect, test } from 'bun:test'
import {
  BROWSER_PAGE_CONTROL_SKILL,
  BROWSER_WORKFLOW_AUTOMATION_SKILL,
  getBrowserAgentPlanToolDenial,
  resolveBrowserAgentPermissionMode,
  resolveBrowserAgentSkillMentions,
} from './browser-agent-skill'

describe('Browser Agent 自动 Skill 引用', () => {
  test('有 Browser Context 时自动加入网页控制与工作流自动化 Skill', () => {
    expect(resolveBrowserAgentSkillMentions(['writing-plans'], true)).toEqual([
      'writing-plans',
      BROWSER_PAGE_CONTROL_SKILL,
      BROWSER_WORKFLOW_AUTOMATION_SKILL,
    ])
  })

  test('没有 Browser Context 时不注入网页控制或工作流自动化 Skill', () => {
    expect(resolveBrowserAgentSkillMentions(['writing-plans'], false)).toEqual(['writing-plans'])
    expect(resolveBrowserAgentSkillMentions(undefined, false)).toBeUndefined()
  })

  test('显式引用同名 Skill 时不重复添加', () => {
    expect(resolveBrowserAgentSkillMentions(['writing-plans', BROWSER_WORKFLOW_AUTOMATION_SKILL], true)).toEqual([
      'writing-plans',
      BROWSER_WORKFLOW_AUTOMATION_SKILL,
      BROWSER_PAGE_CONTROL_SKILL,
    ])
  })

  test('有 Browser Context 时始终使用完全自动权限，覆盖遗留计划模式', () => {
    expect(resolveBrowserAgentPermissionMode(true, 'plan')).toBe('bypassPermissions')
    expect(resolveBrowserAgentPermissionMode(true, undefined)).toBe('bypassPermissions')
    expect(resolveBrowserAgentPermissionMode(false, 'plan')).toBe('plan')
  })

  test('Browser Agent 拒绝进入或退出计划模式，普通 Agent 保持原策略', () => {
    expect(getBrowserAgentPlanToolDenial('EnterPlanMode', true)).toContain('AI浏览器')
    expect(getBrowserAgentPlanToolDenial('ExitPlanMode', true)).toContain('AI浏览器')
    expect(getBrowserAgentPlanToolDenial('Read', true)).toBeUndefined()
    expect(getBrowserAgentPlanToolDenial('EnterPlanMode', false)).toBeUndefined()
  })
})
