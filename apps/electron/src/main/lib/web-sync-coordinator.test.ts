import { describe, expect, test, beforeEach, afterEach, mock } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { BrowserSyncRequest, BrowserSyncResponse } from '@copis/shared'

const testDir = join(tmpdir(), `copis-web-sync-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`)
const syncStatePath = join(testDir, 'web-sync-state.json')
const bookmarksPath = join(testDir, 'web-bookmarks.json')
const profilesPath = join(testDir, 'web-page-profiles.json')
const LEGACY_DEVICE_ID = '123e4567-e89b-42d3-a456-426614174000'

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

const actualConfigPaths = await import('./config-paths')
mock.module('./config-paths', () => ({
  ...actualConfigPaths,
  getConfigDir: () => testDir,
  getAgentWorkspacesDir: () => join(testDir, 'agent-workspaces'),
  getClientDevicePath: () => join(testDir, 'client-device.json'),
  getWorkingAuthPath: () => join(testDir, 'working-auth.json'),
  getWorkingModelCatalogPath: () => join(testDir, 'working-model-catalog.json'),
  getWebSyncStatePath: () => syncStatePath,
  getWebBookmarksPath: () => bookmarksPath,
  getWebPageProfilesPath: () => profilesPath,
  getWebProjectAssociationsPath: () => join(testDir, 'web-project-associations.json'),
}))

const { WebSyncCoordinator, resetWebSyncCoordinatorForTests } = await import('./web-sync-coordinator')
const { getOrCreateClientDeviceId } = await import('./client-device-id')
const accountStorage = await import('./web-sync-account-storage')
const bookmarkService = await import('./web-bookmark-service')
const profileService = await import('./web-page-profile-service')

describe('WebSyncCoordinator 增量同步调度', () => {
  beforeEach(() => {
    mkdirSync(testDir, { recursive: true })
    mkdirSync(join(testDir, 'agent-workspaces', 'chatrooms'), { recursive: true })
  })

  afterEach(() => {
    resetWebSyncCoordinatorForTests()
    accountStorage.resetWebSyncAccountContextForTests()
    rmSync(testDir, { recursive: true, force: true })
  })

  test('初始加载生成默认同步状态并持久化', () => {
    const coordinator = new WebSyncCoordinator({ autoStartInterval: false })
    const state = coordinator.getState()

    expect(state.deviceId).toBeDefined()
    expect(state.accountId).toBeNull()
    expect(state.status).toBe('idle')
    expect(state.serverCursor).toBe(0)
    expect(state.isSyncing).toBe(false)
    expect(existsSync(syncStatePath)).toBe(true)

    coordinator.destroy()
  })

  test('WebSync 与聊天室共享同一个稳定客户端设备 ID', () => {
    const coordinator = new WebSyncCoordinator({ autoStartInterval: false })

    expect(coordinator.getState().deviceId).toBe(getOrCreateClientDeviceId())

    coordinator.destroy()
  })

  test('迁移旧 WebSync 设备 ID 时保留非零游标和最后同步时间', () => {
    writeFileSync(syncStatePath, JSON.stringify({
      deviceId: LEGACY_DEVICE_ID,
      serverCursor: 42,
      lastSyncedAt: 123456,
      hasLocalChanges: true,
    }))

    const coordinator = new WebSyncCoordinator({ autoStartInterval: false })
    const state = coordinator.getState()

    expect(state.deviceId).toBe(LEGACY_DEVICE_ID)
    expect(state.serverCursor).toBe(42)
    expect(state.lastSyncedAt).toBe(123456)
    expect(state.hasLocalChanges).toBe(true)
    expect(getOrCreateClientDeviceId()).toBe(state.deviceId)

    coordinator.destroy()
  })

  test('WebSync 状态的临时恢复文件不会被读取路径提升', () => {
    writeFileSync(syncStatePath, '{broken')
    writeFileSync(`${syncStatePath}.tmp`, JSON.stringify({
      deviceId: LEGACY_DEVICE_ID,
      serverCursor: 99,
      lastSyncedAt: 123,
    }))

    const coordinator = new WebSyncCoordinator({ autoStartInterval: false })
    expect(coordinator.getState().serverCursor).toBe(0)
    expect(existsSync(`${syncStatePath}.tmp`)).toBe(true)
    coordinator.destroy()
  })

  test('WebSync 状态符号链接不会被跟随读取', () => {
    if (process.platform === 'win32') return
    const externalPath = join(testDir, 'external-sync-state.json')
    writeFileSync(externalPath, JSON.stringify({
      deviceId: LEGACY_DEVICE_ID,
      serverCursor: 77,
    }))
    symlinkSync(externalPath, syncStatePath)

    expect(() => new WebSyncCoordinator({ autoStartInterval: false })).toThrow('WebSync 状态文件路径不是普通文件')
    expect(JSON.parse(readFileSync(externalPath, 'utf8')).serverCursor).toBe(77)
  })

  test('当用户未登录时，syncNow 优雅跳过请求并保留本地脏标记', async () => {
    let syncDataCalled = false
    const mockClient = {
      baseUrl: 'https://working.example',
      getAuthState: async () => ({ authenticated: false }),
      syncBrowserData: async () => {
        syncDataCalled = true
        return { serverCursor: 1, serverChanges: { groups: [], bookmarks: [], pageProfiles: [] } }
      },
    } as any

    const coordinator = new WebSyncCoordinator({ apiClient: mockClient, autoStartInterval: false })
    coordinator.scheduleDebouncedSync(1000)

    const state = await coordinator.syncNow()
    expect(syncDataCalled).toBe(false)
    expect(state.isSyncing).toBe(false)
    expect(state.hasLocalChanges).toBe(true)
    expect(state.status).toBe('signed-out')

    coordinator.destroy()
  })

  test('增量同步成功后更新游标并应用服务端下发的增量变更', async () => {
    accountStorage.setWebSyncAccountContext(accountStorage.createWebSyncAccountContext(true, { id: 'user-1' }, 'https://working.example'))
    // 准备本地数据
    bookmarkService.saveWebBookmark({ title: '本地书签', url: 'https://local.example.com' })
    profileService.saveWebPageProfile({ url: 'https://local.example.com', workspaceId: 'ws-local' })

    let capturedRequest: BrowserSyncRequest | null = null

    const mockResponse: BrowserSyncResponse = {
      serverCursor: 108,
      serverChanges: {
        groups: [{ id: 'rg-cloud', name: '云端文件夹', createdAt: 100, updatedAt: 200, version: 1, isDeleted: false }],
        bookmarks: [{
          id: 'rb-cloud',
          title: '云端书签',
          url: 'https://cloud.example.com',
          faviconUrl: null,
          groupId: 'rg-cloud',
          createdAt: 100,
          updatedAt: 200,
          version: 1,
          isDeleted: false,
        }],
        pageProfiles: [{
          id: 'rp-cloud',
          url: 'https://cloud.example.com',
          domain: 'cloud.example.com',
          workspaceId: 'ws-remote',
          preferences: { zoomFactor: 1.2 },
          aiContext: { tags: ['云端'] },
          createdAt: 100,
          updatedAt: 200,
          version: 1,
          isDeleted: false,
        }],
      },
    }

    const mockClient = {
      baseUrl: 'https://working.example',
      getAuthState: async () => ({ authenticated: true, user: { id: 'user-1' } }),
      syncBrowserData: async (req: BrowserSyncRequest) => {
        capturedRequest = req
        return mockResponse
      },
    } as any

    const coordinator = new WebSyncCoordinator({ apiClient: mockClient, autoStartInterval: false })
    const stateAfterSync = await coordinator.syncNow()

    expect(capturedRequest).not.toBeNull()
    expect(capturedRequest!.changes.bookmarks).toHaveLength(1)
    expect(capturedRequest!.changes.pageProfiles).toHaveLength(1)

    expect(stateAfterSync.serverCursor).toBe(108)
    expect(stateAfterSync.hasLocalChanges).toBe(false)
    expect(stateAfterSync.status).toBe('synced')
    expect(stateAfterSync.accountId).not.toBeNull()
    expect(stateAfterSync.lastSyncError).toBeNull()

    // 验证远端变更已合入本地
    const bookmarks = bookmarkService.getWebBookmarks()
    expect(bookmarks.bookmarks.some((b) => b.id === 'rb-cloud')).toBe(true)

    const profiles = profileService.getWebPageProfiles()
    expect(profiles.profiles.some((p) => p.id === 'rp-cloud')).toBe(true)

    coordinator.destroy()
  })

  test('网络失败时记录错误且不阻塞后续重试', async () => {
    accountStorage.setWebSyncAccountContext(accountStorage.createWebSyncAccountContext(true, { id: 'retry-user' }, 'https://working.example'))
    bookmarkService.saveWebBookmark({ title: '待重试', url: 'https://retry.example.com' })
    const requests: BrowserSyncRequest[] = []
    let attempts = 0
    const mockClient = {
      baseUrl: 'https://working.example',
      getAuthState: async () => ({ authenticated: true, user: { id: 'retry-user' } }),
      syncBrowserData: async (request: BrowserSyncRequest) => {
        requests.push(request)
        attempts += 1
        if (attempts === 1) throw new Error('网络连接超时')
        return { serverCursor: 2, serverChanges: { groups: [], bookmarks: [], pageProfiles: [] } }
      },
    } as any

    const coordinator = new WebSyncCoordinator({ apiClient: mockClient, autoStartInterval: false })
    const state = await coordinator.syncNow()

    expect(state.isSyncing).toBe(false)
    expect(state.hasLocalChanges).toBe(true)
    expect(state.lastSyncError).toBe('网络连接超时')
    expect(state.status).toBe('error')

    const retried = await coordinator.syncNow()
    expect(retried.status).toBe('synced')
    expect(retried.hasLocalChanges).toBe(false)
    expect(requests).toHaveLength(2)
    expect(requests[0]!.expectedUserId).toBe('retry-user')
    expect(requests[1]!.changes.bookmarks).toEqual(requests[0]!.changes.bookmarks)

    coordinator.destroy()
  })

  test('请求失败后重启会重发未确认项，成功 ack 和游标也能跨重启恢复', async () => {
    accountStorage.setWebSyncAccountContext(accountStorage.createWebSyncAccountContext(true, { id: 'restart-user' }, 'https://working.example'))
    bookmarkService.saveWebBookmark({ title: '重启后重试', url: 'https://restart.example.com' })
    const requests: BrowserSyncRequest[] = []
    const firstClient = {
      baseUrl: 'https://working.example',
      getAuthState: async () => ({ authenticated: true, user: { id: 'restart-user' } }),
      syncBrowserData: async (request: BrowserSyncRequest) => {
        requests.push(request)
        throw new Error('首次网络失败')
      },
    } as any

    const firstCoordinator = new WebSyncCoordinator({ apiClient: firstClient, autoStartInterval: false })
    expect((await firstCoordinator.syncNow()).status).toBe('error')
    firstCoordinator.destroy()

    const retryClient = {
      baseUrl: 'https://working.example',
      getAuthState: async () => ({ authenticated: true, user: { id: 'restart-user' } }),
      syncBrowserData: async (request: BrowserSyncRequest) => {
        requests.push(request)
        return { serverCursor: 31, serverChanges: { groups: [], bookmarks: [], pageProfiles: [] } }
      },
    } as any
    const retryCoordinator = new WebSyncCoordinator({ apiClient: retryClient, autoStartInterval: false })
    expect((await retryCoordinator.syncNow()).status).toBe('synced')
    retryCoordinator.destroy()

    const verifyClient = {
      baseUrl: 'https://working.example',
      getAuthState: async () => ({ authenticated: true, user: { id: 'restart-user' } }),
      syncBrowserData: async (request: BrowserSyncRequest) => {
        requests.push(request)
        return { serverCursor: 32, serverChanges: { groups: [], bookmarks: [], pageProfiles: [] } }
      },
    } as any
    const verifyCoordinator = new WebSyncCoordinator({ apiClient: verifyClient, autoStartInterval: false })
    expect(verifyCoordinator.getState().serverCursor).toBe(31)
    await verifyCoordinator.syncNow()

    expect(requests).toHaveLength(3)
    expect(requests[0]!.changes.bookmarks).toHaveLength(1)
    expect(requests[1]!.changes.bookmarks).toEqual(requests[0]!.changes.bookmarks)
    expect(requests[2]!.clientCursor).toBe(31)
    expect(requests[2]!.changes.bookmarks).toHaveLength(0)
    verifyCoordinator.destroy()
  })
})
