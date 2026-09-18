import { describe, expect, test, beforeEach, afterEach, mock } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { BrowserSyncRequest, BrowserSyncResponse } from '@copis/shared'

const testDir = join(tmpdir(), `copis-web-sync-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`)
const syncStatePath = join(testDir, 'web-sync-state.json')
const bookmarksPath = join(testDir, 'web-bookmarks.json')
const profilesPath = join(testDir, 'web-page-profiles.json')

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
const bookmarkService = await import('./web-bookmark-service')
const profileService = await import('./web-page-profile-service')

describe('WebSyncCoordinator 增量同步调度', () => {
  beforeEach(() => {
    mkdirSync(testDir, { recursive: true })
    mkdirSync(join(testDir, 'agent-workspaces', 'chatrooms'), { recursive: true })
  })

  afterEach(() => {
    resetWebSyncCoordinatorForTests()
    rmSync(testDir, { recursive: true, force: true })
  })

  test('初始加载生成默认同步状态并持久化', () => {
    const coordinator = new WebSyncCoordinator({ autoStartInterval: false })
    const state = coordinator.getState()

    expect(state.deviceId).toBeDefined()
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

  test('当用户未登录时，syncNow 优雅跳过请求并保留本地脏标记', async () => {
    let syncDataCalled = false
    const mockClient = {
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

    coordinator.destroy()
  })

  test('增量同步成功后更新游标并应用服务端下发的增量变更', async () => {
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
      getAuthState: async () => ({ authenticated: true }),
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
    expect(stateAfterSync.lastSyncError).toBeNull()

    // 验证远端变更已合入本地
    const bookmarks = bookmarkService.getWebBookmarks()
    expect(bookmarks.bookmarks.some((b) => b.id === 'rb-cloud')).toBe(true)

    const profiles = profileService.getWebPageProfiles()
    expect(profiles.profiles.some((p) => p.id === 'rp-cloud')).toBe(true)

    coordinator.destroy()
  })

  test('网络失败时记录错误且不阻塞后续重试', async () => {
    const mockClient = {
      getAuthState: async () => ({ authenticated: true }),
      syncBrowserData: async () => {
        throw new Error('网络连接超时')
      },
    } as any

    const coordinator = new WebSyncCoordinator({ apiClient: mockClient, autoStartInterval: false })
    const state = await coordinator.syncNow()

    expect(state.isSyncing).toBe(false)
    expect(state.hasLocalChanges).toBe(true)
    expect(state.lastSyncError).toBe('网络连接超时')

    coordinator.destroy()
  })
})
