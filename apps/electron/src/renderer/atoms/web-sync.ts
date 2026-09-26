import { atom } from 'jotai'
import type { WebSyncState, WebPageProfile } from '@copis/shared'

/** 初始同步状态 */
const INITIAL_WEB_SYNC_STATE: WebSyncState = {
  status: 'idle',
  accountId: null,
  deviceId: '',
  serverCursor: 0,
  lastSyncedAt: 0,
  isSyncing: false,
  hasLocalChanges: false,
  lastSyncError: null,
}

const webSyncStateValueAtom = atom<WebSyncState>(INITIAL_WEB_SYNC_STATE)
const webSyncAccountGenerationAtom = atom(0)

type WebSyncStateUpdate = WebSyncState | ((previous: WebSyncState) => WebSyncState)

/** 网页增量同步状态原子；账号切换时推进代次，丢弃迟到的旧账号请求。 */
export const webSyncStateAtom = atom(
  (get) => get(webSyncStateValueAtom),
  (get, set, update: WebSyncStateUpdate) => {
    const previous = get(webSyncStateValueAtom)
    const next = typeof update === 'function' ? update(previous) : update
    if (previous.accountId !== next.accountId) {
      set(webSyncAccountGenerationAtom, (generation) => generation + 1)
    }
    set(webSyncStateValueAtom, next)
  },
)

/** 是否正在执行同步 */
export const isWebSyncingAtom = atom<boolean>((get) => get(webSyncStateAtom).isSyncing)

/** 是否存在未同步的本地改动 */
export const hasWebSyncLocalChangesAtom = atom<boolean>((get) => Boolean(get(webSyncStateAtom).hasLocalChanges))

/** 本地缓存的全部页面 Profile 列表 */
export const webPageProfilesAtom = atom<WebPageProfile[]>([])

/** 立即触发增量同步的写原子 */
export const triggerWebSyncNowAtom = atom(
  null,
  async (get, set): Promise<WebSyncState | null> => {
    const requestAccountId = get(webSyncStateAtom).accountId
    const requestAccountGeneration = get(webSyncAccountGenerationAtom)
    const isCurrentAccount = (): boolean =>
      get(webSyncStateAtom).accountId === requestAccountId &&
      get(webSyncAccountGenerationAtom) === requestAccountGeneration
    try {
      const nextState = await window.electronAPI.webSync.syncNow()
      if (!isCurrentAccount() || nextState.accountId !== requestAccountId) return null
      set(webSyncStateAtom, nextState)
      return nextState
    } catch (error: unknown) {
      if (!isCurrentAccount()) return null
      set(webSyncStateAtom, (prev) => ({
        ...prev,
        status: 'error',
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
  async (get, set): Promise<WebSyncState> => {
    const requestAccountId = get(webSyncStateAtom).accountId
    const requestAccountGeneration = get(webSyncAccountGenerationAtom)
    try {
      const state = await window.electronAPI.webSync.getState()
      if (
        get(webSyncStateAtom).accountId === requestAccountId &&
        get(webSyncAccountGenerationAtom) === requestAccountGeneration &&
        state.accountId === requestAccountId
      ) set(webSyncStateAtom, state)
      return get(webSyncStateAtom)
    } catch {
      return INITIAL_WEB_SYNC_STATE
    }
  },
)

/** 刷新页面 Profile 列表原子 */
export const refreshWebPageProfilesAtom = atom(
  null,
  async (get, set): Promise<WebPageProfile[]> => {
    const requestAccountId = get(webSyncStateAtom).accountId
    const requestAccountGeneration = get(webSyncAccountGenerationAtom)
    try {
      const snapshot = await window.electronAPI.webSync.listProfiles()
      if (
        get(webSyncStateAtom).accountId === requestAccountId &&
        get(webSyncAccountGenerationAtom) === requestAccountGeneration
      ) set(webPageProfilesAtom, snapshot.profiles)
      return get(webSyncStateAtom).accountId === requestAccountId &&
        get(webSyncAccountGenerationAtom) === requestAccountGeneration
        ? snapshot.profiles
        : get(webPageProfilesAtom)
    } catch {
      return []
    }
  },
)
