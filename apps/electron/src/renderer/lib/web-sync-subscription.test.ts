import { describe, expect, test } from 'bun:test'
import type { WebBookmarksSnapshot, WebSyncState } from '@copis/shared'
import { subscribeWebSync } from './web-sync-subscription'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function state(accountId: string | null, lastSyncedAt = 0): WebSyncState {
  return {
    accountId, status: accountId ? 'synced' : 'signed-out', deviceId: 'device',
    serverCursor: 0, lastSyncedAt, isSyncing: false,
    hasLocalChanges: false, lastSyncError: null,
  }
}

describe('浏览器云同步状态订阅', () => {
  test('Given 账号切换通知先到 When 初始状态请求迟到 Then 不恢复旧账号', async () => {
    const initial = deferred<WebSyncState>()
    const states: WebSyncState[] = []
    let notify!: (next: WebSyncState) => void
    const stop = subscribeWebSync({
      getState: () => initial.promise,
      onStateChanged: (listener) => { notify = listener; return () => {} },
      listBookmarks: async () => ({ bookmarks: [], groups: [] }),
      listProfiles: async () => ({ profiles: [] }),
    }, {
      onState: (next) => states.push(next), onBookmarks: () => {}, onProfiles: () => {},
    })
    notify(state('B'))
    initial.resolve(state('A'))
    await initial.promise
    expect(states.map((next) => next.accountId)).toEqual(['B'])
    stop()
  })

  test('Given A 快照尚未返回 When 切换 B Then 立即清空且丢弃迟到 A 快照', async () => {
    const a = deferred<WebBookmarksSnapshot>()
    const b = deferred<WebBookmarksSnapshot>()
    const seen: WebBookmarksSnapshot[] = []
    const empty = { bookmarks: [], groups: [] }
    const aSnapshot = { bookmarks: [], groups: [{ id: 'A', name: 'A', createdAt: 1 }] }
    const bSnapshot = { bookmarks: [], groups: [{ id: 'B', name: 'B', createdAt: 1 }] }
    let notify!: (next: WebSyncState) => void
    let reads = 0
    const stop = subscribeWebSync({
      getState: async () => state('A'),
      onStateChanged: (listener) => { notify = listener; return () => {} },
      listBookmarks: () => ++reads === 1 ? a.promise : b.promise,
      listProfiles: async () => ({ profiles: [] }),
    }, { onState: () => {}, onBookmarks: (next) => seen.push(next), onProfiles: () => {} })
    await Promise.resolve()
    notify(state('B'))
    expect(seen).toEqual([empty, empty])
    b.resolve(bSnapshot)
    await b.promise
    a.resolve(aSnapshot)
    await a.promise
    expect(seen.at(-1)).toEqual(bSnapshot)
    expect(seen).not.toContainEqual(aSnapshot)
    stop()
  })

  test('Given 已订阅状态 When 同步完成或销毁 Then 刷新数据且销毁后忽略结果', async () => {
    let notify!: (next: WebSyncState) => void
    let reads = 0
    let updates = 0
    let unsubscribed = false
    const stop = subscribeWebSync({
      getState: async () => state('A'),
      onStateChanged: (listener) => { notify = listener; return () => { unsubscribed = true } },
      listBookmarks: async () => { reads++; return { bookmarks: [], groups: [] } },
      listProfiles: async () => ({ profiles: [] }),
    }, { onState: () => {}, onBookmarks: () => { updates++ }, onProfiles: () => {} })
    await Promise.resolve()
    await Promise.resolve()
    notify(state('A', 10))
    expect(reads).toBe(2)
    stop()
    const before = updates
    await Promise.resolve()
    notify(state('B'))
    expect(updates).toBe(before)
    expect(unsubscribed).toBe(true)
  })
})
