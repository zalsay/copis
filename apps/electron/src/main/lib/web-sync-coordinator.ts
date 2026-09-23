/**
 * 浏览器收藏夹与页面 Profile 增量同步调度核心服务。
 *
 * 职责：
 * 1. 维护本地同步游标与状态（~/.copis/web-sync-state.json）。
 * 2. 监听本地收藏夹和页面 Profile 的增删改，自动进行 5 秒防抖聚合上报。
 * 3. 通过 WorkingApiClient 调用本机 Rust Gateway 透传到 edu-api 服务端。
 * 4. 接收服务端下发的增量变更，调用对应 Service 执行双向合并与孤儿保护。
 * 5. 管理后台心跳轮询与墓碑清理生命周期。
 */

import { randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type {
  BrowserSyncRequest,
  BrowserSyncResponse,
  WebBookmarkChange,
  WebBookmarkGroupChange,
  WebPageProfileChange,
  WebSyncState,
} from '@copis/shared'
import { getWebSyncStatePath } from './config-paths'
import { getOrCreateClientDeviceId, readPureJsonFile } from './client-device-id'
import {
  addBookmarkChangeListener,
  applyRemoteBookmarkChanges,
  getWebBookmarksRaw,
  purgeExpiredBookmarkTombstones,
} from './web-bookmark-service'
import {
  addPageProfileChangeListener,
  applyRemotePageProfileChanges,
  getWebPageProfilesRaw,
  purgeExpiredPageProfileTombstones,
} from './web-page-profile-service'
import { getWorkingApiClient } from './working-api-service'
import type { WorkingApiClient } from './working-api-client'

export type WebSyncStateListener = (state: WebSyncState) => void

const DEFAULT_DEBOUNCE_MS = 5000
const DEFAULT_POLL_INTERVAL_MS = 15 * 60 * 1000

function assertWritableStatePath(path: string): void {
  let stats
  try {
    stats = lstatSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  if (!stats.isFile()) throw new Error('WebSync 状态文件路径不是普通文件')
}

export class WebSyncCoordinator {
  private state: WebSyncState
  private apiClient: WorkingApiClient
  private debounceTimer: ReturnType<typeof setTimeout> | null = null
  private pollIntervalTimer: ReturnType<typeof setInterval> | null = null
  private listeners = new Set<WebSyncStateListener>()
  private ongoingSyncPromise: Promise<WebSyncState> | null = null
  private unbindBookmarkListener?: () => void
  private unbindProfileListener?: () => void

  constructor(options: { apiClient?: WorkingApiClient; autoStartInterval?: boolean } = {}) {
    this.apiClient = options.apiClient ?? getWorkingApiClient()
    this.state = this.loadState()

    // 监听本地变更并启动防抖同步
    this.unbindBookmarkListener = addBookmarkChangeListener(() => {
      this.scheduleDebouncedSync()
    })
    this.unbindProfileListener = addPageProfileChangeListener(() => {
      this.scheduleDebouncedSync()
    })

    if (options.autoStartInterval !== false) {
      this.startPeriodicSync()
    }
  }

  getState(): WebSyncState {
    return { ...this.state }
  }

  addStateListener(listener: WebSyncStateListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private notifyStateChanged(): void {
    const snapshot = this.getState()
    for (const listener of this.listeners) {
      try {
        listener(snapshot)
      } catch (error) {
        console.error('[WebSync] 状态广播失败:', error)
      }
    }
  }

  private loadState(): WebSyncState {
    const path = getWebSyncStatePath()
    const deviceId = getOrCreateClientDeviceId()
    const raw = readPureJsonFile<Partial<WebSyncState>>(path, 'WebSync 状态文件')
    if (!raw) {
      let hasStateFile = false
      try {
        lstatSync(path)
        hasStateFile = true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      if (hasStateFile) {
        console.warn('[WebSync] 加载同步状态失败，使用默认值')
        return {
          deviceId,
          serverCursor: 0,
          lastSyncedAt: 0,
          isSyncing: false,
          hasLocalChanges: false,
          lastSyncError: null,
        }
      }
      const defaultState: WebSyncState = {
        deviceId,
        serverCursor: 0,
        lastSyncedAt: 0,
        isSyncing: false,
        hasLocalChanges: false,
        lastSyncError: null,
      }
      this.persistState(defaultState)
      return defaultState
    }

    return {
      deviceId,
      serverCursor: typeof raw.serverCursor === 'number' && Number.isFinite(raw.serverCursor) ? raw.serverCursor : 0,
      lastSyncedAt: typeof raw.lastSyncedAt === 'number' && Number.isFinite(raw.lastSyncedAt) ? raw.lastSyncedAt : 0,
      isSyncing: false,
      hasLocalChanges: Boolean(raw.hasLocalChanges),
      lastSyncError: typeof raw.lastSyncError === 'string' ? raw.lastSyncError : null,
    }
  }

  private persistState(state: WebSyncState): void {
    const path = getWebSyncStatePath()
    mkdirSync(dirname(path), { recursive: true })
    assertWritableStatePath(path)
    const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`
    try {
      writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf-8', flag: 'wx' })
      renameSync(tempPath, path)
      assertWritableStatePath(path)
    } catch (error) {
      rmSync(tempPath, { force: true })
      console.error('[WebSync] 持久化状态失败:', error)
    }
  }

  /** 触发防抖增量同步调度 */
  scheduleDebouncedSync(delayMs = DEFAULT_DEBOUNCE_MS): void {
    this.state.hasLocalChanges = true
    this.persistState(this.state)
    this.notifyStateChanged()

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
    }

    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null
      void this.syncNow().catch(() => {})
    }, delayMs)
  }

  /** 立即执行一次增量同步 */
  async syncNow(): Promise<WebSyncState> {
    if (this.ongoingSyncPromise) {
      return this.ongoingSyncPromise
    }

    this.ongoingSyncPromise = this.executeSync()
    try {
      return await this.ongoingSyncPromise
    } finally {
      this.ongoingSyncPromise = null
    }
  }

  private async executeSync(): Promise<WebSyncState> {
    // 检查认证状态：未登录时只记录本地脏数据，不向远端发送失败请求
    try {
      const authState = await this.apiClient.getAuthState()
      if (!authState.authenticated) {
        this.state.isSyncing = false
        this.notifyStateChanged()
        return this.getState()
      }
    } catch {
      // 本地 Rust 网关尚在初始化或网络不可达时保留脏数据状态
      this.state.isSyncing = false
      this.notifyStateChanged()
      return this.getState()
    }

    this.state.isSyncing = true
    this.notifyStateChanged()

    try {
      const isInitialSync = this.state.serverCursor === 0
      const lastSyncedAt = this.state.lastSyncedAt

      // 抓取本地变更
      const rawBookmarks = getWebBookmarksRaw()
      const groupsToSync: WebBookmarkGroupChange[] = rawBookmarks.groups
        .filter((g) => isInitialSync || (g.updatedAt ?? g.createdAt) > lastSyncedAt)
        .map((g) => ({
          id: g.id,
          name: g.name,
          createdAt: g.createdAt,
          updatedAt: g.updatedAt ?? g.createdAt,
          version: g.version ?? 1,
          isDeleted: Boolean(g.isDeleted),
          deletedAt: g.deletedAt,
        }))

      const bookmarksToSync: WebBookmarkChange[] = rawBookmarks.bookmarks
        .filter((b) => isInitialSync || (b.updatedAt ?? b.createdAt) > lastSyncedAt)
        .map((b) => ({
          id: b.id,
          title: b.title,
          url: b.url,
          faviconUrl: b.faviconUrl,
          groupId: b.groupId,
          createdAt: b.createdAt,
          updatedAt: b.updatedAt ?? b.createdAt,
          version: b.version ?? 1,
          isDeleted: Boolean(b.isDeleted),
          deletedAt: b.deletedAt,
        }))

      const rawProfiles = getWebPageProfilesRaw()
      const profilesToSync: WebPageProfileChange[] = rawProfiles.profiles
        .filter((p) => isInitialSync || p.updatedAt > lastSyncedAt)
        .map((p) => ({
          id: p.id,
          url: p.url,
          domain: p.domain,
          workspaceId: p.workspaceId,
          preferences: p.preferences,
          aiContext: p.aiContext,
          createdAt: p.createdAt,
          updatedAt: p.updatedAt,
          version: p.version,
          isDeleted: Boolean(p.isDeleted),
          deletedAt: p.deletedAt,
        }))

      const request: BrowserSyncRequest = {
        clientDeviceId: this.state.deviceId,
        clientCursor: this.state.serverCursor,
        changes: {
          groups: groupsToSync,
          bookmarks: bookmarksToSync,
          pageProfiles: profilesToSync,
        },
      }

      const response = await this.apiClient.syncBrowserData(request)

      // 应用服务端增量变更到本地
      if (response && response.serverChanges) {
        if (
          (response.serverChanges.groups && response.serverChanges.groups.length > 0)
          || (response.serverChanges.bookmarks && response.serverChanges.bookmarks.length > 0)
        ) {
          applyRemoteBookmarkChanges(
            response.serverChanges.groups ?? [],
            response.serverChanges.bookmarks ?? [],
          )
        }

        if (response.serverChanges.pageProfiles && response.serverChanges.pageProfiles.length > 0) {
          applyRemotePageProfileChanges(response.serverChanges.pageProfiles)
        }
      }

      // 同步成功，更新本地状态
      this.state.serverCursor = typeof response?.serverCursor === 'number' ? response.serverCursor : this.state.serverCursor + 1
      this.state.lastSyncedAt = Date.now()
      this.state.hasLocalChanges = false
      this.state.lastSyncError = null
      this.state.isSyncing = false
      this.persistState(this.state)
      this.notifyStateChanged()

      // 执行墓碑清理
      purgeExpiredBookmarkTombstones()
      purgeExpiredPageProfileTombstones()

      return this.getState()
    } catch (error) {
      console.warn('[WebSync] 增量同步失败:', error)
      this.state.isSyncing = false
      this.state.hasLocalChanges = true
      this.state.lastSyncError = error instanceof Error ? error.message : String(error)
      this.persistState(this.state)
      this.notifyStateChanged()
      return this.getState()
    }
  }

  private startPeriodicSync(): void {
    if (this.pollIntervalTimer) return
    this.pollIntervalTimer = setInterval(() => {
      void this.syncNow().catch(() => {})
    }, DEFAULT_POLL_INTERVAL_MS)
  }

  destroy(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }
    if (this.pollIntervalTimer) {
      clearInterval(this.pollIntervalTimer)
      this.pollIntervalTimer = null
    }
    if (this.unbindBookmarkListener) {
      this.unbindBookmarkListener()
      this.unbindBookmarkListener = undefined
    }
    if (this.unbindProfileListener) {
      this.unbindProfileListener()
      this.unbindProfileListener = undefined
    }
    this.listeners.clear()
  }
}

let syncCoordinatorInstance: WebSyncCoordinator | null = null

/** 获取全局 WebSyncCoordinator 单例 */
export function getWebSyncCoordinator(): WebSyncCoordinator {
  if (!syncCoordinatorInstance) {
    syncCoordinatorInstance = new WebSyncCoordinator()
  }
  return syncCoordinatorInstance
}

export function resetWebSyncCoordinatorForTests(): void {
  if (syncCoordinatorInstance) {
    syncCoordinatorInstance.destroy()
    syncCoordinatorInstance = null
  }
}
