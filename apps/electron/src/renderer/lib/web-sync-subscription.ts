import type { WebBookmarksSnapshot, WebPageProfilesSnapshot, WebSyncState } from '@copis/shared'

interface WebSyncSubscriptionApi {
  getState: () => Promise<WebSyncState>
  onStateChanged: (listener: (state: WebSyncState) => void) => () => void
  listBookmarks: () => Promise<WebBookmarksSnapshot>
  listProfiles: () => Promise<WebPageProfilesSnapshot>
}

interface WebSyncSubscriptionCallbacks {
  onState: (state: WebSyncState) => void
  onBookmarks: (snapshot: WebBookmarksSnapshot) => void
  onProfiles: (snapshot: WebPageProfilesSnapshot) => void
}

/** 账号切换时立即清空旧缓存，并丢弃旧账号及旧初始化请求的迟到结果。 */
export function subscribeWebSync(
  api: WebSyncSubscriptionApi,
  callbacks: WebSyncSubscriptionCallbacks,
): () => void {
  let disposed = false
  let receivedEvent = false
  let previousState: WebSyncState | undefined
  let snapshotVersion = 0

  const applyState = (state: WebSyncState): void => {
    if (disposed) return
    const accountChanged = !previousState || previousState.accountId !== state.accountId
    const refresh = accountChanged || previousState?.lastSyncedAt !== state.lastSyncedAt
    previousState = state
    callbacks.onState(state)
    if (!refresh) return

    const version = ++snapshotVersion
    if (accountChanged) {
      callbacks.onBookmarks({ groups: [], bookmarks: [] })
      callbacks.onProfiles({ profiles: [] })
    }
    void api.listBookmarks().then((snapshot) => {
      if (!disposed && version === snapshotVersion) callbacks.onBookmarks(snapshot)
    }).catch((error: unknown) => {
      console.error('[浏览器云同步] 刷新收藏夹失败:', error)
    })
    void api.listProfiles().then((snapshot) => {
      if (!disposed && version === snapshotVersion) callbacks.onProfiles(snapshot)
    }).catch((error: unknown) => {
      console.error('[浏览器云同步] 刷新页面配置失败:', error)
    })
  }

  const unsubscribe = api.onStateChanged((state) => {
    receivedEvent = true
    applyState(state)
  })
  void api.getState().then((state) => {
    if (!receivedEvent) applyState(state)
  }).catch((error: unknown) => {
    console.error('[浏览器云同步] 获取初始状态失败:', error)
  })

  return () => {
    disposed = true
    unsubscribe()
  }
}
