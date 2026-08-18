import { atom } from 'jotai'
import type { WorkingAuthState, WorkingClientConfig, WorkingEvent, WorkingSessionSummary, WorkingVipStatus } from '@copis/shared'
import { agentWorkspacesAtom } from './agent-atoms'
import { EMPTY_WORKING_PAYMENT_STATE, workingPaymentStateAtom } from './working-payment-atoms'

/** 主窗口认证状态；认证凭证仍只由主进程持有。 */
export const workingAuthStateAtom = atom<WorkingAuthState | null>(null)

export interface WorkingHistorySelection {
  session: WorkingSessionSummary
}

/** 当前 Working 后端配置；不包含 token，token 只由主进程持有。 */
export const workingClientConfigAtom = atom<WorkingClientConfig | null>(null)

/** 兼容历史视图状态；null 表示回到普通本地会话视图。 */
export const workingHistorySelectionAtom = atom<WorkingHistorySelection | null>(null)

/** Working 账户设置页是否打开；与 Copis 本地设置面板分离。 */
export const workingSettingsOpenAtom = atom(false)

/** 最近一次从 Working 设置快照读取的 VIP 状态，供全局支付弹窗复用。 */
export const workingVipStatusAtom = atom<WorkingVipStatus | null>(null)

/** Working 设置面板当前区块 */
export type WorkingSettingsSectionId =
  | 'settings'
  | 'model-management'
  | 'messages'
  | 'orders'
  | 'tutorial'
  | 'voice-input'
  | 'migration'
  | 'storage'
  | 'appearance'
  | 'about'

/** Working 设置面板当前激活区块，供外部跳转（如语音输入开关提示）设置初始值。 */
export const workingSettingsSectionAtom = atom<WorkingSettingsSectionId>('settings')

/** 左侧 Copis Working 创建工作区弹窗是否打开。 */
export const createWorkspaceDialogOpenAtom = atom(false)

/** 新专家团工作区选择弹窗是否打开（由专家团队工作台左侧栏打开）。 */
export const newExpertTeamDialogOpenAtom = atom(false)

/** 最近一次通过左侧创建工作区弹窗成功创建的工作区 ID。 */
export const createdWorkspaceIdAtom = atom<string | null>(null)

export type WorkspaceCreationSource = 'sidebar' | 'expert-team' | 'expert-team-new'

/** 当前创建工作区请求的来源，用于保留来源页面的导航语义。 */
export const workspaceCreationSourceAtom = atom<WorkspaceCreationSource | null>(null)

/** 打开创建工作区弹窗，并清除上一次创建结果。 */
export const openCreateWorkspaceDialogAtom = atom(null, (_get, set, source: WorkspaceCreationSource): void => {
  const workspaces = _get(agentWorkspacesAtom)
  const isVip = _get(workingAuthStateAtom)?.user?.isVip === true
  const extraWorkspaceCount = workspaces.filter((workspace) => workspace.slug !== 'default').length
  if (!isVip && extraWorkspaceCount >= 1) {
    set(createWorkspaceDialogOpenAtom, false)
    set(workspaceCreationSourceAtom, null)
    set(workingPaymentStateAtom, {
      ...EMPTY_WORKING_PAYMENT_STATE,
      open: true,
      mode: 'vip',
      phase: 'selecting',
    })
    return
  }
  set(createdWorkspaceIdAtom, null)
  set(workspaceCreationSourceAtom, source)
  set(createWorkspaceDialogOpenAtom, true)
})

/** 本地 Agent 最近的 Working 语义事件，供运行态诊断和后续 Working UI 消费。 */
export const workingEventsAtom = atom<Map<string, WorkingEvent[]>>(new Map())

export function appendWorkingEvents(
  previous: Map<string, WorkingEvent[]>,
  sessionId: string,
  events: WorkingEvent[],
): Map<string, WorkingEvent[]> {
  if (events.length === 0) return previous
  const next = new Map(previous)
  const current = next.get(sessionId) ?? []
  next.set(sessionId, [...current, ...events].slice(-2000))
  return next
}
