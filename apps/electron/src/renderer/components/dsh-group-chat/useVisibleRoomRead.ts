import { useEffect, type RefObject } from 'react'
import { type createStore } from 'jotai'
import { roomReadScope, confirmRead } from './shared-room-unread'
import type { RoomRequest } from './useSharedRoomFeed'

/** 原生侧栏可能持有焦点，因此窗口前台由主进程验证；这里检查群面板是否确实显示。 */
export function useVisibleRoomRead(pane: RefObject<HTMLElement>, store: ReturnType<typeof createStore>, request: RoomRequest,
  roomId: string, enabled: boolean, loadedSeq: number) {
  useEffect(() => {
    if (!enabled || !loadedSeq) return
    const scope = store.get(roomReadScope)
    let active = true, sending = false, timer: ReturnType<typeof setTimeout>
    const current = () => active && store.get(roomReadScope) === scope
    const report = async () => {
      clearTimeout(timer)
      if (!current() || sending || (store.get(scope).get(roomId)?.read ?? 0) >= loadedSeq) return
      const host = pane.current
      if (document.visibilityState === 'visible' && host?.checkVisibility?.({ visibilityProperty:true }) && !host.closest('[aria-hidden="true"], [inert]')) {
        sending = true
        try {
          const ack = await request({action:'readRoom',roomId,seq:loadedSeq}) as {roomId?:unknown;seq?:unknown} | null
          if (current() && ack?.roomId === roomId && ack.seq === loadedSeq) {
            confirmRead(store,scope,roomId,loadedSeq); return
          }
        } catch { /* 网络恢复或窗口重新获得焦点后再确认，不提前消除红点。 */ }
        finally { sending = false }
      }
      if (current()) timer = setTimeout(() => void report(), 5000)
    }
    const resume = () => { void report() }
    resume(); window.addEventListener('focus', resume); document.addEventListener('visibilitychange', resume)
    return () => { active = false; clearTimeout(timer); window.removeEventListener('focus',resume); document.removeEventListener('visibilitychange',resume) }
  }, [pane,store,request,roomId,enabled,loadedSeq])
}
