/** 浏览器收藏夹与页面 Profile 的账号隔离增量同步协调器。 */

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
  WorkingAuthState,
} from '@copis/shared'
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
import {
  createWebSyncAccountContext,
  getWebSyncAccountContext,
  getWebSyncStateStoragePath,
  setWebSyncAccountContext,
  type WebSyncAccountContext,
} from './web-sync-account-storage'

export type WebSyncStateListener = (state: WebSyncState) => void

const DEFAULT_DEBOUNCE_MS = 5000
const DEFAULT_RETRY_MS = 30_000
const DEFAULT_POLL_INTERVAL_MS = 15 * 60 * 1000

interface PersistedWebSyncState extends WebSyncState {
  acknowledgedEntityFingerprints?: Record<string, string>
}

interface LocalEntity {
  key: string
  type: 'group' | 'bookmark' | 'pageProfile'
  id: string
  change: WebBookmarkGroupChange | WebBookmarkChange | WebPageProfileChange
  fingerprint: string
}

interface LocalEntitySnapshot {
  all: Map<string, LocalEntity>
  pending: Map<string, LocalEntity>
  changes: BrowserSyncRequest['changes']
}

function defaultState(deviceId: string, accountId: string | null): WebSyncState {
  return {
    deviceId,
    accountId,
    status: 'idle',
    serverCursor: 0,
    lastSyncedAt: 0,
    isSyncing: false,
    hasLocalChanges: false,
    lastSyncError: null,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

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

function buildLocalEntitySnapshot(acknowledged: Record<string, string>): LocalEntitySnapshot {
  const all = new Map<string, LocalEntity>()
  const add = (
    type: LocalEntity['type'],
    id: string,
    change: LocalEntity['change'],
  ): void => {
    const key = `${type}:${id}`
    const fingerprint = JSON.stringify(change)
    all.set(key, { key, type, id, change, fingerprint })
  }

  const rawBookmarks = getWebBookmarksRaw()
  for (const group of rawBookmarks.groups) {
    add('group', group.id, {
      id: group.id,
      name: group.name,
      createdAt: group.createdAt,
      updatedAt: group.updatedAt ?? group.createdAt,
      version: group.version ?? 1,
      isDeleted: Boolean(group.isDeleted),
      deletedAt: group.deletedAt,
    })
  }
  for (const bookmark of rawBookmarks.bookmarks) {
    add('bookmark', bookmark.id, {
      id: bookmark.id,
      title: bookmark.title,
      url: bookmark.url,
      faviconUrl: bookmark.faviconUrl,
      groupId: bookmark.groupId,
      createdAt: bookmark.createdAt,
      updatedAt: bookmark.updatedAt ?? bookmark.createdAt,
      version: bookmark.version ?? 1,
      isDeleted: Boolean(bookmark.isDeleted),
      deletedAt: bookmark.deletedAt,
    })
  }

  const rawProfiles = getWebPageProfilesRaw()
  for (const profile of rawProfiles.profiles) {
    add('pageProfile', profile.id, {
      id: profile.id,
      url: profile.url,
      domain: profile.domain,
      workspaceId: profile.workspaceId,
      preferences: profile.preferences,
      aiContext: profile.aiContext,
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt,
      version: profile.version,
      isDeleted: Boolean(profile.isDeleted),
      deletedAt: profile.deletedAt,
    })
  }

  const pending = new Map([...all].filter(([key, entity]) => acknowledged[key] !== entity.fingerprint))
  return {
    all,
    pending,
    changes: {
      groups: [...pending.values()].filter((entry) => entry.type === 'group').map((entry) => entry.change as WebBookmarkGroupChange),
      bookmarks: [...pending.values()].filter((entry) => entry.type === 'bookmark').map((entry) => entry.change as WebBookmarkChange),
      pageProfiles: [...pending.values()].filter((entry) => entry.type === 'pageProfile').map((entry) => entry.change as WebPageProfileChange),
    },
  }
}

function entityKey(type: LocalEntity['type'], id: string): string {
  return `${type}:${id}`
}

function validSyncResponse(value: unknown): value is BrowserSyncResponse {
  if (!isRecord(value) || typeof value.serverCursor !== 'number' || !Number.isFinite(value.serverCursor)) return false
  if (!isRecord(value.serverChanges)) return false
  return Array.isArray(value.serverChanges.groups)
    && Array.isArray(value.serverChanges.bookmarks)
    && Array.isArray(value.serverChanges.pageProfiles)
}

export class WebSyncCoordinator {
  private state: WebSyncState
  private acknowledgedEntityFingerprints: Record<string, string>
  private apiClient: WorkingApiClient
  private debounceTimer: ReturnType<typeof setTimeout> | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private pollIntervalTimer: ReturnType<typeof setInterval> | null = null
  private listeners = new Set<WebSyncStateListener>()
  private ongoingSync: { generation: number; promise: Promise<WebSyncState> } | null = null
  private generation = 0
  private authGeneration = 0
  private accountContext: WebSyncAccountContext
  private unbindBookmarkListener?: () => void
  private unbindProfileListener?: () => void

  constructor(options: { apiClient?: WorkingApiClient; autoStartInterval?: boolean } = {}) {
    this.apiClient = options.apiClient ?? getWorkingApiClient()
    this.accountContext = getWebSyncAccountContext()
    this.state = defaultState(getOrCreateClientDeviceId(), this.accountContext.accountId)
    this.acknowledgedEntityFingerprints = {}
    this.loadActiveState()

    this.unbindBookmarkListener = addBookmarkChangeListener(() => this.scheduleDebouncedSync())
    this.unbindProfileListener = addPageProfileChangeListener(() => this.scheduleDebouncedSync())

    if (options.autoStartInterval !== false) this.startPeriodicSync()
  }

  getState(): WebSyncState {
    return { ...this.state }
  }

  getAuthGeneration(): number {
    return this.authGeneration
  }

  setAuthStateIfCurrent(
    authState: { authenticated: boolean; user: WorkingAuthState['user']; backendUrl?: string },
    expectedGeneration: number,
  ): boolean {
    if (expectedGeneration !== this.authGeneration) return false
    this.setAuthState(authState)
    return true
  }

  addStateListener(listener: WebSyncStateListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** auth 事件同步切换账号分区并使旧请求失效；此方法不发起或等待网络请求。 */
  setAuthState(authState: {
    authenticated: boolean
    user: WorkingAuthState['user']
    backendUrl?: string
  }): void {
    const context = createWebSyncAccountContext(
      authState.authenticated,
      authState.user,
      authState.backendUrl ?? this.apiClient.baseUrl,
    )
    const accountChanged = context.accountId !== this.accountContext.accountId
      || context.backendNamespace !== this.accountContext.backendNamespace
      || context.userId !== this.accountContext.userId

    this.accountContext = context
    setWebSyncAccountContext(context)
    if (accountChanged) {
      this.authGeneration += 1
      this.generation += 1
      this.clearDebounceTimer()
      this.clearRetryTimer()
      this.acknowledgedEntityFingerprints = {}
      this.state = defaultState(getOrCreateClientDeviceId(), context.accountId)
      this.loadActiveState()
    }

    if (!authState.authenticated) {
      this.state.isSyncing = false
      this.state.status = 'signed-out'
      this.state.lastSyncError = null
      this.state.hasLocalChanges = this.state.hasLocalChanges || this.hasPendingLocalChanges()
    } else if (!context.userId) {
      this.state.isSyncing = false
      this.state.status = 'error'
      this.state.lastSyncError = '无法确认当前账号身份，浏览器云同步已暂停'
    } else {
      this.state.accountId = context.accountId
      this.state.hasLocalChanges = this.state.hasLocalChanges || this.hasPendingLocalChanges()
      if (this.state.status === 'signed-out' || accountChanged || this.state.status === 'idle') {
        this.state.status = 'pending'
      }
    }

    this.persistState(this.state, this.acknowledgedEntityFingerprints)
    this.notifyStateChanged()
    if (authState.authenticated && context.userId && (accountChanged || this.state.status === 'pending' || this.state.status === 'error')) {
      this.scheduleSyncAttempt(this.state.status === 'error' && !accountChanged ? DEFAULT_RETRY_MS : 0)
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

  private loadActiveState(): void {
    const path = getWebSyncStateStoragePath()
    const deviceId = getOrCreateClientDeviceId()
    const raw = readPureJsonFile<Partial<PersistedWebSyncState>>(path, 'WebSync 状态文件')
    if (!raw) {
      let hasStateFile = false
      try {
        lstatSync(path)
        hasStateFile = true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      if (hasStateFile) console.warn('[WebSync] 加载同步状态失败，使用默认值')
      else this.persistState(this.state, this.acknowledgedEntityFingerprints)
      return
    }

    const persistedStatus = raw.status
    this.state = {
      ...defaultState(deviceId, this.accountContext.accountId),
      serverCursor: typeof raw.serverCursor === 'number' && Number.isFinite(raw.serverCursor) ? raw.serverCursor : 0,
      lastSyncedAt: typeof raw.lastSyncedAt === 'number' && Number.isFinite(raw.lastSyncedAt) ? raw.lastSyncedAt : 0,
      hasLocalChanges: Boolean(raw.hasLocalChanges),
      lastSyncError: typeof raw.lastSyncError === 'string' ? raw.lastSyncError : null,
      status: persistedStatus === 'synced' || persistedStatus === 'error' || persistedStatus === 'pending' || persistedStatus === 'signed-out'
        ? persistedStatus
        : 'idle',
    }
    if (isRecord(raw.acknowledgedEntityFingerprints)) {
      this.acknowledgedEntityFingerprints = Object.fromEntries(
        Object.entries(raw.acknowledgedEntityFingerprints)
          .filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
      )
    }
    this.state.hasLocalChanges = Boolean(raw.hasLocalChanges) || this.hasPendingLocalChanges()
    if (this.state.hasLocalChanges && this.state.status !== 'error') {
      this.state.status = 'pending'
    }
  }

  private persistState(state: WebSyncState, acknowledged: Record<string, string>): boolean {
    const path = getWebSyncStateStoragePath()
    mkdirSync(dirname(path), { recursive: true })
    assertWritableStatePath(path)
    const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`
    try {
      const persisted: PersistedWebSyncState = {
        ...state,
        acknowledgedEntityFingerprints: acknowledged,
      }
      writeFileSync(tempPath, `${JSON.stringify(persisted, null, 2)}\n`, { encoding: 'utf-8', flag: 'wx' })
      renameSync(tempPath, path)
      assertWritableStatePath(path)
      return true
    } catch (error) {
      rmSync(tempPath, { force: true })
      console.error('[WebSync] 持久化状态失败:', error)
      return false
    }
  }

  private hasPendingLocalChanges(): boolean {
    return buildLocalEntitySnapshot(this.acknowledgedEntityFingerprints).pending.size > 0
  }

  private clearDebounceTimer(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    this.debounceTimer = null
  }

  private clearRetryTimer(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
  }

  private scheduleSyncAttempt(delayMs: number): void {
    this.clearRetryTimer()
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      void this.syncNow().catch(() => {})
    }, delayMs)
  }

  /** 触发防抖增量同步调度。 */
  scheduleDebouncedSync(delayMs = DEFAULT_DEBOUNCE_MS): void {
    this.state.hasLocalChanges = true
    if (this.state.status !== 'syncing') this.state.status = 'pending'
    this.persistState(this.state, this.acknowledgedEntityFingerprints)
    this.notifyStateChanged()
    this.clearDebounceTimer()
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null
      void this.syncNow().catch(() => {})
    }, delayMs)
  }

  /** 立即执行一次同步；不同账号的在途请求彼此不阻塞。 */
  async syncNow(): Promise<WebSyncState> {
    if (this.ongoingSync?.generation === this.generation) return this.ongoingSync.promise
    const generation = this.generation
    const promise = this.executeSync(generation)
    this.ongoingSync = { generation, promise }
    try {
      return await promise
    } finally {
      if (this.ongoingSync?.promise === promise) this.ongoingSync = null
    }
  }

  private isCurrentGeneration(generation: number): boolean {
    return generation === this.generation
  }

  private async executeSync(startGeneration: number): Promise<WebSyncState> {
    let authState: Awaited<ReturnType<WorkingApiClient['getAuthState']>>
    try {
      authState = await this.apiClient.getAuthState()
    } catch (error) {
      if (!this.isCurrentGeneration(startGeneration)) return this.getState()
      this.setSyncError(error)
      return this.getState()
    }

    // Rust 回调若已在请求期间报告新身份，旧 auth-state 响应不能把账号切回去。
    if (!this.isCurrentGeneration(startGeneration)) return this.getState()
    this.setAuthState({
      authenticated: authState.authenticated,
      user: authState.user,
      backendUrl: this.apiClient.baseUrl,
    })
    if (!this.isCurrentGeneration(startGeneration)) return this.getState()
    const generation = this.generation

    if (!authState.authenticated) {
      this.state.status = 'signed-out'
      this.state.isSyncing = false
      this.state.hasLocalChanges = this.hasPendingLocalChanges()
      this.state.lastSyncError = null
      this.persistState(this.state, this.acknowledgedEntityFingerprints)
      this.notifyStateChanged()
      return this.getState()
    }
    if (!this.accountContext.userId) {
      this.state.status = 'error'
      this.state.isSyncing = false
      this.state.lastSyncError = '无法确认当前账号身份，浏览器云同步已暂停'
      this.persistState(this.state, this.acknowledgedEntityFingerprints)
      this.notifyStateChanged()
      return this.getState()
    }

    this.clearRetryTimer()
    this.state.isSyncing = true
    this.state.status = 'syncing'
    this.state.lastSyncError = null
    this.state.accountId = this.accountContext.accountId
    this.notifyStateChanged()

    let acknowledgedBefore = { ...this.acknowledgedEntityFingerprints }
    try {
      acknowledgedBefore = { ...this.acknowledgedEntityFingerprints }
      const captured = buildLocalEntitySnapshot(acknowledgedBefore)
      const request: BrowserSyncRequest = {
        clientDeviceId: this.state.deviceId,
        clientCursor: this.state.serverCursor,
        expectedUserId: this.accountContext.userId,
        changes: captured.changes,
      }
      const response = await this.apiClient.syncBrowserData(request)
      if (!this.isCurrentGeneration(generation)) return this.getState()
      if (!validSyncResponse(response)) throw new Error('浏览器同步响应格式不正确')

      const current = buildLocalEntitySnapshot(acknowledgedBefore).all
      const changedDuringRequest = new Set<string>()
      for (const [key, entity] of current) {
        if (captured.all.get(key)?.fingerprint !== entity.fingerprint) changedDuringRequest.add(key)
      }

      const serverGroups = response.serverChanges.groups.filter(
        (change) => !changedDuringRequest.has(entityKey('group', change.id)),
      )
      const serverBookmarks = response.serverChanges.bookmarks.filter(
        (change) => !changedDuringRequest.has(entityKey('bookmark', change.id)),
      )
      const serverProfiles = response.serverChanges.pageProfiles.filter(
        (change) => !changedDuringRequest.has(entityKey('pageProfile', change.id)),
      )
      applyRemoteBookmarkChanges(serverGroups, serverBookmarks)
      applyRemotePageProfileChanges(serverProfiles)

      // ack 只覆盖请求开始时提交且响应后仍未被本地修改的实体；并入的远端实体也视为已确认。
      const nextAcknowledged = { ...acknowledgedBefore }
      const remoteKeys = new Set<string>([
        ...serverGroups.map((entry) => entityKey('group', entry.id)),
        ...serverBookmarks.map((entry) => entityKey('bookmark', entry.id)),
        ...serverProfiles.map((entry) => entityKey('pageProfile', entry.id)),
      ])
      purgeExpiredBookmarkTombstones()
      purgeExpiredPageProfileTombstones()
      const finalEntities = buildLocalEntitySnapshot(nextAcknowledged).all
      for (const key of captured.pending.keys()) {
        if (!changedDuringRequest.has(key) && finalEntities.has(key)) {
          nextAcknowledged[key] = finalEntities.get(key)!.fingerprint
        }
      }
      for (const key of remoteKeys) {
        if (finalEntities.has(key)) nextAcknowledged[key] = finalEntities.get(key)!.fingerprint
      }
      for (const key of Object.keys(nextAcknowledged)) {
        if (!finalEntities.has(key)) delete nextAcknowledged[key]
      }

      const pendingAfterSync = buildLocalEntitySnapshot(nextAcknowledged).pending.size > 0
      const needsAnotherPage = Boolean(response.hasMore)
      const nextState: WebSyncState = {
        ...this.state,
        serverCursor: response.serverCursor,
        lastSyncedAt: Date.now(),
        isSyncing: false,
        hasLocalChanges: pendingAfterSync,
        status: pendingAfterSync || needsAnotherPage ? 'pending' : 'synced',
        lastSyncError: null,
      }
      if (!this.persistState(nextState, nextAcknowledged)) {
        throw new Error('保存浏览器同步确认状态失败')
      }
      if (!this.isCurrentGeneration(generation)) return this.getState()
      this.acknowledgedEntityFingerprints = nextAcknowledged
      this.state = nextState
      this.notifyStateChanged()

      if (pendingAfterSync || needsAnotherPage) this.scheduleSyncAttempt(0)
      return this.getState()
    } catch (error) {
      if (!this.isCurrentGeneration(generation)) return this.getState()
      // 网络失败不确认任何 fingerprint，因而下轮请求会重发相同的本地内容。
      this.state.isSyncing = false
      this.state.hasLocalChanges = this.hasPendingLocalChanges()
      this.state.status = 'error'
      this.state.lastSyncError = error instanceof Error ? error.message : String(error)
      this.persistState(this.state, acknowledgedBefore)
      this.notifyStateChanged()
      this.scheduleSyncAttempt(DEFAULT_RETRY_MS)
      return this.getState()
    }
  }

  private setSyncError(error: unknown): void {
    this.state.isSyncing = false
    this.state.hasLocalChanges = this.hasPendingLocalChanges()
    this.state.status = 'error'
    this.state.lastSyncError = error instanceof Error ? error.message : String(error)
    this.persistState(this.state, this.acknowledgedEntityFingerprints)
    this.notifyStateChanged()
    this.scheduleSyncAttempt(DEFAULT_RETRY_MS)
  }

  private startPeriodicSync(): void {
    if (this.pollIntervalTimer) return
    this.pollIntervalTimer = setInterval(() => void this.syncNow().catch(() => {}), DEFAULT_POLL_INTERVAL_MS)
  }

  destroy(): void {
    this.clearDebounceTimer()
    this.clearRetryTimer()
    if (this.pollIntervalTimer) {
      clearInterval(this.pollIntervalTimer)
      this.pollIntervalTimer = null
    }
    this.unbindBookmarkListener?.()
    this.unbindBookmarkListener = undefined
    this.unbindProfileListener?.()
    this.unbindProfileListener = undefined
    this.listeners.clear()
    this.generation += 1
  }
}

let syncCoordinatorInstance: WebSyncCoordinator | null = null

/** 获取全局 WebSyncCoordinator 单例。 */
export function getWebSyncCoordinator(): WebSyncCoordinator {
  if (!syncCoordinatorInstance) syncCoordinatorInstance = new WebSyncCoordinator()
  return syncCoordinatorInstance
}

export function resetWebSyncCoordinatorForTests(): void {
  if (syncCoordinatorInstance) {
    syncCoordinatorInstance.destroy()
    syncCoordinatorInstance = null
  }
}
