import { atom } from 'jotai'
import type { WebSyncState, WebPageProfile } from '@copis/shared'

/** 初始同步状态 */
const INITIAL_WEB_SYNC_STATE: WebSyncState = {
  deviceId: '',
  serverCursor: 0,
  lastSyncedAt: 0,
  isSyncing: false,
  hasLocalChanges: false,
  lastSyncError: null,
}

/** 网页增量同步状态原子 */
export const webSyncStateAtom = atom<WebSyncState>(INITIAL_WEB_SYNC_STATE)

/** 是否正在执行同步 */
export const isWebSyncingAtom = atom<boolean>((get) => get(webSyncStateAtom).isSyncing)

/** 是否存在未同步的本地改动 */
export const hasWebSyncLocalChangesAtom = atom<boolean>((get) => Boolean(get(webSyncStateAtom).hasLocalChanges))

/** 本地缓存的全部页面 Profile 列表 */
export const webPageProfilesAtom = atom<WebPageProfile[]>([])

/** 立即触发增量同步的写原子 */
export const triggerWebSyncNowAtom = atom(
  null,
  async (_get, set): Promise<WebSyncState> => {
    try {
      const nextState = await window.electronAPI.webSync.syncNow()
      set(webSyncStateAtom, nextState)
      return nextState
    } catch (error: unknown) {
      set(webSyncStateAtom, (prev) => ({
        ...prev,
        isSyncing: false,
        lastSyncError: error instanceof Error ? error.message : String(error),
      }))
      throw error
    }
  },
)

/** 刷新同步状态原子 */
export const refreshWebSyncStateAtom = atom(
  null,
  async (_get, set): Promise<WebSyncState> => {
    try {
      const state = await window.electronAPI.webSync.getState()
      set(webSyncStateAtom, state)
      return state
    } catch {
      return INITIAL_WEB_SYNC_STATE
    }
  },
)

/** 刷新页面 Profile 列表原子 */
export const refreshWebPageProfilesAtom = atom(
  null,
  async (_get, set): Promise<WebPageProfile[]> => {
    try {
      const snapshot = await window.electronAPI.webSync.listProfiles()
      set(webPageProfilesAtom, snapshot.profiles)
      return snapshot.profiles
    } catch {
      return []
    }
  },
)
