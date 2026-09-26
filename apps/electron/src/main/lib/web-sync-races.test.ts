import { afterEach, beforeEach, describe, expect, jest, mock, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import * as realOs from 'node:os'
import type { BrowserSyncRequest, BrowserSyncResponse, WorkingUser } from '@copis/shared'

const BACKEND_URL = 'https://web-sync-race-test.invalid'
let testDir = mkdtempSync(join(realOs.tmpdir(), 'copis-web-sync-races-'))
let currentUserId: string | null = null
let syncHandler: (request: BrowserSyncRequest) => Promise<BrowserSyncResponse> = async () => response(1)

const mockApiClient = {
  baseUrl: BACKEND_URL,
  getCachedUser: () => currentUserId ? { id: currentUserId } : null,
  getAuthState: async () => ({
    authenticated: currentUserId !== null,
    user: currentUserId ? { id: currentUserId } : null,
  }),
  syncBrowserData: (request: BrowserSyncRequest) => syncHandler(request),
} as any

mock.module('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => testDir,
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString('utf-8'),
  },
}))

mock.module('node:os', () => ({
  ...realOs,
  homedir: () => testDir,
}))

mock.module('./working-api-service', () => ({
  getWorkingApiClient: () => mockApiClient,
}))

const actualConfigPaths = await import('./config-paths')
mock.module('./config-paths', () => ({
  ...actualConfigPaths,
  getConfigDir: () => join(testDir, 'config'),
  getAgentWorkspacesDir: () => join(testDir, 'agent-workspaces'),
  getClientDevicePath: () => join(testDir, 'legacy', 'client-device.json'),
  getWorkingAuthPath: () => join(testDir, 'legacy', 'working-auth.json'),
  getWorkingModelCatalogPath: () => join(testDir, 'legacy', 'working-model-catalog.json'),
  getWebSyncStatePath: () => join(testDir, 'legacy', 'web-sync-state.json'),
  getWebBookmarksPath: () => join(testDir, 'legacy', 'web-bookmarks.json'),
  getWebPageProfilesPath: () => join(testDir, 'legacy', 'web-page-profiles.json'),
  getWebProjectAssociationsPath: () => join(testDir, 'legacy', 'web-project-associations.json'),
}))

const { WebSyncCoordinator } = await import('./web-sync-coordinator')
const { resetWebSyncAccountContextForTests, createWebSyncAccountContext } = await import('./web-sync-account-storage')
const bookmarkService = await import('./web-bookmark-service')

function response(serverCursor: number, serverChanges: BrowserSyncResponse['serverChanges'] = {
  groups: [],
  bookmarks: [],
  pageProfiles: [],
}): BrowserSyncResponse {
  return { serverCursor, serverChanges }
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function activateAccount(coordinator: InstanceType<typeof WebSyncCoordinator>, id: string): void {
  currentUserId = id
  coordinator.setAuthState({ authenticated: true, user: { id } as WorkingUser, backendUrl: BACKEND_URL })
}

function expectNoLocalChanges(request: BrowserSyncRequest): void {
  expect(request.changes.groups).toHaveLength(0)
  expect(request.changes.bookmarks).toHaveLength(0)
  expect(request.changes.pageProfiles).toHaveLength(0)
}

let coordinator: InstanceType<typeof WebSyncCoordinator> | null = null

describe('WebSyncCoordinator 账号与在途竞态回归', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    jest.setSystemTime(new Date('2026-09-26T10:00:00.000Z'))
    rmSync(testDir, { recursive: true, force: true })
    testDir = mkdtempSync(join(realOs.tmpdir(), 'copis-web-sync-races-'))
    mkdirSync(join(testDir, 'legacy'), { recursive: true })
    mkdirSync(join(testDir, 'config'), { recursive: true })
    currentUserId = null
    syncHandler = async () => response(1)
    coordinator = null
    resetWebSyncAccountContextForTests()
  })

  afterEach(() => {
    coordinator?.destroy()
    coordinator = null
    resetWebSyncAccountContextForTests()
    jest.useRealTimers()
    if (testDir) rmSync(testDir, { recursive: true, force: true })
  })

  test('Given 请求在途时同毫秒修改并新增收藏 When 第一轮成功 Then 仍 pending 且下一轮发送新内容', async () => {
    coordinator = new WebSyncCoordinator({ apiClient: mockApiClient, autoStartInterval: false })
    activateAccount(coordinator, 'A')
    bookmarkService.saveWebBookmark({ title: '旧标题', url: 'https://same-ms.example.test' })

    const firstRequest = deferred<BrowserSyncResponse>()
    const firstRequestStarted = deferred<void>()
    const capturedRequests: BrowserSyncRequest[] = []
    syncHandler = async (request) => {
      capturedRequests.push(request)
      if (capturedRequests.length === 1) {
        firstRequestStarted.resolve()
        return firstRequest.promise
      }
      return response(2)
    }

    const firstRound = coordinator.syncNow()
    await firstRequestStarted.promise
    expect(capturedRequests[0]?.changes.bookmarks.map(({ title }) => title)).toEqual(['旧标题'])

    const updated = bookmarkService.saveWebBookmark({ title: '同毫秒新标题', url: 'https://same-ms.example.test' })
      .bookmarks[0]
    const added = bookmarkService.saveWebBookmark({ title: '在途新增', url: 'https://new-during-sync.example.test' })
      .bookmarks[0]
    expect(updated?.updatedAt).toBe(capturedRequests[0]?.changes.bookmarks[0]?.updatedAt)

    firstRequest.resolve(response(1))
    const firstState = await firstRound
    expect(firstState.status).toBe('pending')
    expect(firstState.hasLocalChanges).toBe(true)

    const secondState = await coordinator.syncNow()
    expect(capturedRequests).toHaveLength(2)
    expect(capturedRequests[1]?.changes.bookmarks.map(({ title }) => title).sort()).toEqual(['同毫秒新标题', '在途新增'].sort())
    expect(capturedRequests[1]?.changes.bookmarks.map(({ url }) => url).sort()).toEqual([
      'https://new-during-sync.example.test/',
      'https://same-ms.example.test/',
    ].sort())
    expect(secondState.status).toBe('synced')
  })

  test('Given A 已有数据/游标且 A 请求在途 When 切换到 B 并让 A 响应迟到 Then B 不受污染且切回仍恢复 A 分区', async () => {
    coordinator = new WebSyncCoordinator({ apiClient: mockApiClient, autoStartInterval: false })
    const requestsByUser: Record<'A' | 'B', BrowserSyncRequest[]> = { A: [], B: [] }
    const staleAResponse = deferred<BrowserSyncResponse>()
    const staleAStarted = deferred<void>()
    let aRequestCount = 0
    syncHandler = async (request) => {
      const userId = request.expectedUserId as 'A' | 'B'
      requestsByUser[userId].push(request)
      if (userId === 'A' && ++aRequestCount === 2) {
        staleAStarted.resolve()
        return staleAResponse.promise
      }
      return response(userId === 'A' ? 11 : 22)
    }

    activateAccount(coordinator, 'A')
    bookmarkService.saveWebBookmark({ title: 'A 本地收藏', url: 'https://a-local.example.test' })
    await coordinator.syncNow()
    expect(coordinator.getState().serverCursor).toBe(11)

    bookmarkService.saveWebBookmark({ title: 'A 在途期间保留', url: 'https://a-pending.example.test' })
    const aInFlight = coordinator.syncNow()
    await staleAStarted.promise

    activateAccount(coordinator, 'B')
    bookmarkService.saveWebBookmark({ title: 'B 本地收藏', url: 'https://b-local.example.test' })
    await coordinator.syncNow()
    expect(coordinator.getState()).toMatchObject({ accountId: expect.any(String), serverCursor: 22 })

    staleAResponse.resolve(response(99, {
      groups: [],
      bookmarks: [{
        id: 'stale-a-remote',
        title: 'A 迟到远端数据',
        url: 'https://stale-a-remote.example.test',
        faviconUrl: null,
        groupId: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        version: 1,
        isDeleted: false,
      }],
      pageProfiles: [],
    }))
    await aInFlight

    expect(coordinator.getState().serverCursor).toBe(22)
    expect(bookmarkService.getWebBookmarks().bookmarks.map(({ url }) => url)).toEqual(['https://b-local.example.test/'])

    activateAccount(coordinator, 'A')
    expect(coordinator.getState().serverCursor).toBe(11)
    expect(bookmarkService.getWebBookmarks().bookmarks.map(({ url }) => url)).toEqual(expect.arrayContaining([
      'https://a-local.example.test/',
      'https://a-pending.example.test/',
    ]))
    expect(bookmarkService.getWebBookmarks().bookmarks.some(({ url }) => url.includes('stale-a-remote'))).toBe(false)

    activateAccount(coordinator, 'B')
    expect(coordinator.getState().serverCursor).toBe(22)
    expect(bookmarkService.getWebBookmarks().bookmarks.some(({ url }) => url.includes('a-local'))).toBe(false)
  })

  test('Given guest 旧文件含本地数据 When 首次登录新账号同步 Then 不上传 guest 数据且旧文件保留', async () => {
    coordinator = new WebSyncCoordinator({ apiClient: mockApiClient, autoStartInterval: false })
    const guestBookmarksPath = join(testDir, 'legacy', 'web-bookmarks.json')
    bookmarkService.saveWebBookmark({ title: '仅 guest 数据', url: 'https://guest-only.example.test' })
    expect(existsSync(guestBookmarksPath)).toBe(true)

    const sentRequests: BrowserSyncRequest[] = []
    syncHandler = async (request) => {
      sentRequests.push(request)
      return response(1)
    }
    activateAccount(coordinator, 'A')

    await coordinator.syncNow()

    expect(sentRequests).toHaveLength(1)
    expectNoLocalChanges(sentRequests[0]!)
    expect(existsSync(guestBookmarksPath)).toBe(true)
    expect(readFileSync(guestBookmarksPath, 'utf8')).toContain('guest-only.example.test')
  })

  test('Given 已确认内容持久化后停机期间同毫秒修改 When 重建协调器 Then 恢复待同步并只发送修改项', async () => {
    coordinator = new WebSyncCoordinator({ apiClient: mockApiClient, autoStartInterval: false })
    activateAccount(coordinator, 'A')
    const requests: BrowserSyncRequest[] = []
    syncHandler = async (request) => {
      requests.push(request)
      return response(requests.length)
    }
    bookmarkService.saveWebBookmark({ title: '已确认', url: 'https://restart.example.test' })
    await coordinator.syncNow()
    coordinator.destroy()
    bookmarkService.saveWebBookmark({ title: '停机后修改', url: 'https://restart.example.test' })

    coordinator = new WebSyncCoordinator({ apiClient: mockApiClient, autoStartInterval: false })
    expect(coordinator.getState().hasLocalChanges).toBe(true)
    expect(coordinator.getState().status).toBe('pending')
    await coordinator.syncNow()
    expect(requests[1]?.changes.bookmarks.map((bookmark) => bookmark.title)).toEqual(['停机后修改'])
    await coordinator.syncNow()
    expectNoLocalChanges(requests[2]!)
  })

  test('Given 首轮网络失败 When 原样重试 Then 重发未确认变更并推进游标', async () => {
    coordinator = new WebSyncCoordinator({ apiClient: mockApiClient, autoStartInterval: false })
    activateAccount(coordinator, 'A')
    bookmarkService.saveWebBookmark({ title: '待重试收藏', url: 'https://retry.example.test' })

    const requests: BrowserSyncRequest[] = []
    syncHandler = async (request) => {
      requests.push(request)
      if (requests.length === 1) throw new Error('模拟网络断开')
      return response(7)
    }

    const failed = await coordinator.syncNow()
    expect(failed.status).toBe('error')
    expect(failed.lastSyncError).toBe('模拟网络断开')

    const retried = await coordinator.syncNow()
    expect(requests).toHaveLength(2)
    expect(requests[1]?.changes.bookmarks).toEqual(requests[0]?.changes.bookmarks)
    expect(retried).toMatchObject({ status: 'synced', serverCursor: 7, hasLocalChanges: false })
  })
})
