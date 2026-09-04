/** Working 账号的本地项目额度策略。 */

import type { AgentWorkspace } from '@copis/shared'

/** 非 VIP 可在默认工作区外创建的项目数量。 */
export const NON_VIP_EXTRA_WORKSPACE_LIMIT = 1
export const NON_VIP_WORKSPACE_LIMIT_ERROR = '非 VIP 账号最多可在默认工作区外创建 1 个项目，升级 VIP 后可创建更多项目。'

/**
 * 系统固定工作区（默认工作区、我的投资）由应用维护，不计入用户项目额度。
 * 未登录或账号状态无法确认时按非 VIP 处理，避免绕过额度限制。
 */
export function assertWorkingWorkspaceCreationAllowed(
  workspaces: readonly Pick<AgentWorkspace, 'slug'>[],
  isVip: boolean | undefined,
): void {
  if (isVip === true) return

  const extraWorkspaceCount = workspaces.filter(
    (workspace) => workspace.slug !== 'default' && workspace.slug !== 'investment'
  ).length
  if (extraWorkspaceCount >= NON_VIP_EXTRA_WORKSPACE_LIMIT) {
    throw new Error(NON_VIP_WORKSPACE_LIMIT_ERROR)
  }
}
