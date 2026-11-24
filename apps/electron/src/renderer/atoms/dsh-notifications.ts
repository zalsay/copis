import { atom } from 'jotai'
import type { DshClientEvent } from '@copis/shared'

/** 与 Agent 独立，避免两种运行时出现相同 ID 时互相清除角标。 */
export const unviewedDshSessionIdsAtom = atom<ReadonlySet<string>>(new Set<string>())
const completedSequencesAtom = atom<ReadonlyMap<string, number>>(new Map<string, number>())

/** 返回 true 表示首次收到这一轮完成，可发送一次通知。 */
export const applyDshNotificationEventAtom = atom(null, (get, set, event: DshClientEvent): boolean => {
  if (event.type !== 'COPIS_DSH_SESSION_COMPLETED' && event.type !== 'COPIS_DSH_SESSION_VIEWED') return false
  const unread = new Set(get(unviewedDshSessionIdsAtom))
  if (event.type === 'COPIS_DSH_SESSION_VIEWED') {
    unread.delete(event.sessionId)
    set(unviewedDshSessionIdsAtom, unread)
    return false
  }
  const sequences = get(completedSequencesAtom)
  if (event.completionSeq <= (sequences.get(event.sessionId) ?? -1)) return false
  set(completedSequencesAtom, new Map(sequences).set(event.sessionId, event.completionSeq))
  if (event.viewed) unread.delete(event.sessionId)
  else unread.add(event.sessionId)
  set(unviewedDshSessionIdsAtom, unread)
  return true
})
