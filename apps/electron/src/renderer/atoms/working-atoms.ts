import { atom } from 'jotai'
import type { WorkingEvent, WorkingSessionSummary } from '@proma/shared'

export interface WorkingHistorySelection {
  session: WorkingSessionSummary
}

/** 当前在 Copis 主区域打开的 Working 云端历史。null 表示回到普通本地会话视图。 */
export const workingHistorySelectionAtom = atom<WorkingHistorySelection | null>(null)

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
