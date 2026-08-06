import { COPIS_DEFAULT_PERMISSION_MODE, type CopisPermissionMode } from '@copis/shared'

export const BROWSER_PAGE_CONTROL_SKILL = 'browser-page-control'

const BROWSER_PLAN_TOOL_DENIAL_MESSAGE = 'Browser Agent 不支持计划模式，网页控制请使用 Browser Page 工具及其网页授权流程。'

/** Browser Agent 不受工作区只读默认值影响，始终以完全自动模式运行。 */
export function resolveBrowserAgentPermissionMode(
  hasBrowserContext: boolean,
  requestedMode: CopisPermissionMode | undefined,
): CopisPermissionMode {
  return hasBrowserContext ? 'bypassPermissions' : requestedMode ?? COPIS_DEFAULT_PERMISSION_MODE
}

/** Browser Agent 不参与 Copis 的 EnterPlanMode/ExitPlanMode 审批链。 */
export function getBrowserAgentPlanToolDenial(
  toolName: string,
  hasBrowserContext: boolean,
): string | undefined {
  if (!hasBrowserContext) return undefined
  return toolName === 'EnterPlanMode' || toolName === 'ExitPlanMode'
    ? BROWSER_PLAN_TOOL_DENIAL_MESSAGE
    : undefined
}

/** 根据当前会话是否绑定网页页签，计算本轮传给 Pi 的 Skill 引用。 */
export function resolveBrowserAgentSkillMentions(
  mentionedSkills: readonly string[] | undefined,
  hasBrowserContext: boolean,
): string[] | undefined {
  if (!hasBrowserContext) return mentionedSkills ? [...mentionedSkills] : undefined

  const effectiveSkills = [...new Set(mentionedSkills ?? [])]
  if (!effectiveSkills.includes(BROWSER_PAGE_CONTROL_SKILL)) {
    effectiveSkills.push(BROWSER_PAGE_CONTROL_SKILL)
  }

  return effectiveSkills.length > 0 ? effectiveSkills : undefined
}
