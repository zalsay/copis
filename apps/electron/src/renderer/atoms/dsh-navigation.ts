import { atom } from 'jotai'
import { activeWebTabIdAtom } from './web-tabs'
import { activeViewAtom } from './active-view'
import { workingSettingsOpenAtom } from './working-atoms'

export const dshReturnToSessionAtom = atom(0)
/** 宿主从网页或设置返回时，同时收起原生网页，避免后续快照重新激活它。 */
export const showDshConversationAtom = atom(null, (get, set) => {
  if (get(activeWebTabIdAtom)) {
    set(activeWebTabIdAtom, null)
    void window.electronAPI.webTabs.activate(null).catch((error) => console.error('[创造模式] 退出网页页签失败:', error))
  }
  set(workingSettingsOpenAtom, false)
  set(activeViewAtom, 'conversations')
  set(dshReturnToSessionAtom, (n) => n + 1)
})
/** IPC 投递并不表示插件已经接收；只在收到队首请求的回执后出队。 */
export const pendingDshNewSessionsAtom = atom<string[]>([])
export const requestDshNewSessionAtom = atom(null, (_get, set) => {
  const id = crypto.randomUUID()
  set(pendingDshNewSessionsAtom, (queue) => [...queue, id])
})
export const acknowledgeDshNewSessionAtom = atom(null, (_get, set, id: string) => {
  set(pendingDshNewSessionsAtom, (queue) => queue[0] === id ? queue.slice(1) : queue)
})
