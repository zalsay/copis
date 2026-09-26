/** 按 Working 账号隔离浏览器数据文件；无法确认账号归属的旧文件始终留在 guest。 */

import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { WorkingUser } from '@copis/shared'
import {
  getConfigDir,
  getWebBookmarksPath,
  getWebPageProfilesPath,
  getWebProjectAssociationsPath,
  getWebSyncStatePath,
} from './config-paths'
import { getWorkingApiClient } from './working-api-service'

export interface WebSyncAccountContext {
  authenticated: boolean
  accountId: string | null
  userId: string | null
  backendNamespace: string
}

function normalizeBackendNamespace(value: string | undefined): string {
  if (!value) return ''
  try {
    const url = new URL(value)
    return `${url.protocol.toLowerCase()}//${url.host.toLowerCase()}${url.pathname.replace(/\/$/, '')}`
  } catch {
    return value.trim().replace(/\/+$/, '').toLowerCase()
  }
}

function stableUserId(user: Pick<WorkingUser, 'id' | 'userId'> | null | undefined): string | null {
  const raw = user as unknown as Record<string, unknown> | null | undefined
  const normalize = (value: unknown): string | null => {
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
    if (typeof value === 'string' && value.trim()) return value.trim()
    return null
  }
  return normalize(user?.id)
    ?? normalize(user?.userId)
    ?? normalize(raw?.ID)
    ?? normalize(raw?.user_id)
    ?? normalize(raw?.userId)
}

export function createWebSyncAccountContext(
  authenticated: boolean,
  user: Pick<WorkingUser, 'id' | 'userId'> | null | undefined,
  backendUrl?: string,
): WebSyncAccountContext {
  const userId = authenticated ? stableUserId(user) : null
  const backendNamespace = normalizeBackendNamespace(backendUrl)
  if (!userId) {
    return { authenticated, accountId: null, userId: null, backendNamespace }
  }

  const accountId = createHash('sha256')
    .update(`${backendNamespace}\0${userId}`)
    .digest('hex')
  return { authenticated, accountId, userId, backendNamespace }
}

let activeContext: WebSyncAccountContext | null = null

/** 更新当前本地数据分区；由 Working auth 状态同步调用，不等待网络。 */
export function setWebSyncAccountContext(context: WebSyncAccountContext): void {
  activeContext = { ...context }
}

/** 启动时使用持久化认证资料恢复分区；它不代表认证已通过网络复核。 */
export function getWebSyncAccountContext(): WebSyncAccountContext {
  if (activeContext) return { ...activeContext }
  const client = getWorkingApiClient()
  return createWebSyncAccountContext(
    client.getCachedUser() !== null,
    client.getCachedUser(),
    client.baseUrl,
  )
}

function accountPath(fileName: string, guestPath: string): string {
  const { accountId } = getWebSyncAccountContext()
  if (!accountId) return guestPath
  return join(getConfigDir(), 'web-accounts', accountId, fileName)
}

export function getWebBookmarksStoragePath(): string {
  return accountPath('web-bookmarks.json', getWebBookmarksPath())
}

export function getWebPageProfilesStoragePath(): string {
  return accountPath('web-page-profiles.json', getWebPageProfilesPath())
}

export function getWebProjectAssociationsStoragePath(): string {
  return accountPath('web-project-associations.json', getWebProjectAssociationsPath())
}

export function getWebSyncStateStoragePath(): string {
  return accountPath('web-sync-state.json', getWebSyncStatePath())
}

export function resetWebSyncAccountContextForTests(): void {
  activeContext = null
}
