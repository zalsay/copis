import { atom } from 'jotai'
import type { WorkingAuthState, WorkingClientConfig, WorkingEvent, WorkingSessionSummary } from '@proma/shared'

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
