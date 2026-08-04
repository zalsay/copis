import { atom } from 'jotai'
import type { WebTabState } from '@copis/shared'

/** 主进程维护的网页页签状态。 */
export const webTabsAtom = atom<WebTabState[]>([])

/** 当前激活的网页页签；null 表示固定的 Copis 首页。 */
export const activeWebTabIdAtom = atom<string | null>(null)

/** 当前激活的 Chromium 页签。 */
export const activeWebTabAtom = atom<WebTabState | null>((get) => {
  const activeId = get(activeWebTabIdAtom)
  if (!activeId) return null
  return get(webTabsAtom).find((tab) => tab.id === activeId) ?? null
})
