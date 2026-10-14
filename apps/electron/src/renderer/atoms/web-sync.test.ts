import { createStore } from 'jotai/vanilla'
import { afterEach, describe, expect, test } from 'bun:test'
import type { WebPageProfile, WebSyncState } from '@copis/shared'
import {
  refreshWebPageProfilesAtom,
  triggerWebSyncNowAtom,
  webPageProfilesAtom,
  webSyncStateAtom,
} from './web-sync'

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
afterEach(() => {
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
  else Reflect.deleteProperty(globalThis, 'window')
})

function makeState(accountId: string | null, status: WebSyncState['status'] = 'idle'): WebSyncState {
  return {
    accountId,
    status,
    deviceId: 'device-1',
    serverCursor: 0,
    lastSyncedAt: 0,
    isSyncing: status === 'syncing',
    hasLocalChanges: status === 'pending',
    lastSyncError: null,
  }
}

function setWebSyncApi(webSync: Record<string, unknown>): void {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { electronAPI: { webSync } },
  })
}

describe('网页同步状态 atoms', () => {
  test('Given 初始渲染 When 读取同步状态 Then 初始状态未知且没有已登录账号', () => {
    const store = createStore()
    expect(store.get(webSyncStateAtom)).toMatchObject({ status: 'idle', accountId: null })
  })

  test('Given syncNow 返回待同步状态 When 手动触发 Then atom 保留后端状态而不伪造已同步', async () => {
    const store = createStore()
    store.set(webSyncStateAtom, makeState('account-a'))
    const pendingState = makeState('account-a', 'pending')
    setWebSyncApi({ syncNow: async () => pendingState })

    const result = await store.set(triggerWebSyncNowAtom)

    expect(result?.status).toBe('pending')
    expect(store.get(webSyncStateAtom).status).toBe('pending')
  })

  test('Given 同步调用抛错 When 手动触发 Then 状态标记失败并保留错误信息', async () => {
    const store = createStore()
    store.set(webSyncStateAtom, makeState('account-a'))
    setWebSyncApi({ syncNow: async () => { throw new Error('网络不可用') } })

    await expect(store.set(triggerWebSyncNowAtom)).rejects.toThrow('网络不可用')

    expect(store.get(webSyncStateAtom)).toMatchObject({
      status: 'error',
      isSyncing: false,
      lastSyncError: '网络不可用',
    })
  })

  test('Given 账号 A 的同步请求迟到且账号已切换到 B When 返回 A 状态 Then 不覆盖 B 的状态', async () => {
    const store = createStore()
    store.set(webSyncStateAtom, makeState('account-a'))
    let resolveSync!: (state: WebSyncState) => void
    const syncRequest = new Promise<WebSyncState>((resolve) => { resolveSync = resolve })
    setWebSyncApi({ syncNow: () => syncRequest })

    const request = store.set(triggerWebSyncNowAtom)
    store.set(webSyncStateAtom, makeState('account-b', 'pending'))
    resolveSync(makeState('account-a', 'synced'))
    const result = await request

    expect(result).toBeNull()
    expect(store.get(webSyncStateAtom)).toMatchObject({ accountId: 'account-b', status: 'pending' })
  })

  test('Given A 的旧同步未完成 When 切到 B 再回 A Then 仍丢弃第一轮 A 的响应', async () => {
    const store = createStore()
    store.set(webSyncStateAtom, makeState('account-a'))
    let resolveSync!: (state: WebSyncState) => void
    setWebSyncApi({ syncNow: () => new Promise<WebSyncState>((resolve) => { resolveSync = resolve }) })
    const request = store.set(triggerWebSyncNowAtom)
    store.set(webSyncStateAtom, makeState('account-b'))
    store.set(webSyncStateAtom, makeState('account-a', 'pending'))
    resolveSync(makeState('account-a', 'synced'))
    expect(await request).toBeNull()
    expect(store.get(webSyncStateAtom).status).toBe('pending')
  })

  test('Given 账号 A 的 Profile 读取尚未完成 When 切换到 B Then 不写入 A 的 Profile 快照', async () => {
    const store = createStore()
    store.set(webSyncStateAtom, makeState('account-a'))
    let resolveProfiles!: (value: { profiles: WebPageProfile[] }) => void
    const profilesRequest = new Promise<{ profiles: WebPageProfile[] }>((resolve) => { resolveProfiles = resolve })
    setWebSyncApi({ listProfiles: () => profilesRequest })

    const request = store.set(refreshWebPageProfilesAtom)
    store.set(webSyncStateAtom, makeState('account-b'))
    resolveProfiles({ profiles: [{} as WebPageProfile] })
    await request

    expect(store.get(webPageProfilesAtom)).toEqual([])
  })
})
