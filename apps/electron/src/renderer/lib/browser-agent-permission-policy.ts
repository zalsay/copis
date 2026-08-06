import type { CopisPermissionMode } from '@copis/shared'

export type AgentConversationSurfaceVariant = 'main' | 'browser'

/** Browser 对话表面固定使用完全自动模式，避免会话元数据或 stale atom 污染 UI。 */
export function resolveAgentConversationPermissionMode(
  variant: AgentConversationSurfaceVariant,
  resolvedPermissionMode: CopisPermissionMode,
): CopisPermissionMode {
  return variant === 'browser' ? 'bypassPermissions' : resolvedPermissionMode
}

/** Browser 对话表面不显示 Copis 计划阶段状态。 */
export function shouldShowAgentPlanUi(
  variant: AgentConversationSurfaceVariant,
  active: boolean,
): boolean {
  return variant !== 'browser' && active
}

/** Browser 对话表面不显示 Copis ExitPlanMode 审批横幅。 */
export function shouldShowExitPlanBanner(
  variant: AgentConversationSurfaceVariant,
  pendingRequestCount: number,
): boolean {
  return variant !== 'browser' && pendingRequestCount > 0
}
