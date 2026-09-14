/**
 * 网页收藏夹存储服务。
 *
 * 收藏数据保存在 Copis 配置目录下的 JSON 文件中，不使用本地数据库。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  CreateWebBookmarkGroupInput,
  RenameWebBookmarkGroupInput,
  SaveWebBookmarkInput,
  WebBookmark,
  WebBookmarkGroup,
  WebBookmarksSnapshot,
  WebBookmarkGroupChange,
  WebBookmarkChange,
} from '@copis/shared'
import { getWebBookmarksPath } from './config-paths'

const bookmarkChangeListeners = new Set<() => void>()

/** 注册收藏夹本地变更监听器。 */
export function addBookmarkChangeListener(listener: () => void): () => void {
  bookmarkChangeListeners.add(listener)
  return () => {
    bookmarkChangeListeners.delete(listener)
  }
}

function notifyBookmarkChangeListeners(): void {
  for (const listener of bookmarkChangeListeners) {
    try {
      listener()
    } catch (error) {
      console.error('[网页收藏夹] 变更监听回调失败:', error)
    }
  }
}

function emptySnapshot(): WebBookmarksSnapshot {
  return { groups: [], bookmarks: [] }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readGroups(value: unknown): WebBookmarkGroup[] {
  if (!Array.isArray(value)) return []

  const seenIds = new Set<string>()
  return value.flatMap((item): WebBookmarkGroup[] => {
    if (!isRecord(item)) return []
    if (typeof item.id !== 'string' || typeof item.name !== 'string' || typeof item.createdAt !== 'number') return []

    const id = item.id.trim()
    const name = item.name.trim()
    if (!id || !name || !Number.isFinite(item.createdAt) || seenIds.has(id)) return []

    seenIds.add(id)
    const updatedAt = typeof item.updatedAt === 'number' && Number.isFinite(item.updatedAt) ? item.updatedAt : item.createdAt
    const version = typeof item.version === 'number' && Number.isFinite(item.version) ? item.version : 1
    const isDeleted = typeof item.isDeleted === 'boolean' ? item.isDeleted : false
    const deletedAt = typeof item.deletedAt === 'number' && Number.isFinite(item.deletedAt) ? item.deletedAt : undefined
    return [{
      id,
      name,
      createdAt: item.createdAt,
      updatedAt,
      version,
      isDeleted,
      ...(deletedAt !== undefined ? { deletedAt } : {}),
    }]
  })
}

function resolveDefaultFaviconUrl(rawUrl?: string | null): string | null {
  if (!rawUrl) return null
  try {
    const parsed = new URL(rawUrl)
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return `${parsed.origin}/favicon.ico`
    }
  } catch {}
  return null
}

function readFaviconUrl(value: unknown, url?: string): string | null {
  if (typeof value === 'string') {
    const normalized = value.trim()
    if (/^https?:\/\//i.test(normalized) || /^data:image\//i.test(normalized)) {
      return normalized
    }
  }
  return resolveDefaultFaviconUrl(url)
}

function readBookmarks(value: unknown, groups: WebBookmarkGroup[]): WebBookmark[] {
  if (!Array.isArray(value)) return []
  const groupIds = new Set(groups.map((group) => group.id))

  return value.flatMap((item): WebBookmark[] => {
    if (!isRecord(item)) return []
    if (
      typeof item.id !== 'string'
      || typeof item.title !== 'string'
      || typeof item.url !== 'string'
      || typeof item.createdAt !== 'number'
    ) return []

    const id = item.id.trim()
    const title = item.title.trim()
    const url = item.url.trim()
    if (!id || !title || !url || !Number.isFinite(item.createdAt)) return []

    const groupId = typeof item.groupId === 'string' && groupIds.has(item.groupId) ? item.groupId : null
    const updatedAt = typeof item.updatedAt === 'number' && Number.isFinite(item.updatedAt) ? item.updatedAt : item.createdAt
    const version = typeof item.version === 'number' && Number.isFinite(item.version) ? item.version : 1
    const isDeleted = typeof item.isDeleted === 'boolean' ? item.isDeleted : false
    const deletedAt = typeof item.deletedAt === 'number' && Number.isFinite(item.deletedAt) ? item.deletedAt : undefined
    return [{
      id,
      title,
      url,
      faviconUrl: readFaviconUrl(item.faviconUrl, url),
      createdAt: item.createdAt,
      groupId,
      updatedAt,
      version,
      isDeleted,
      ...(deletedAt !== undefined ? { deletedAt } : {}),
    }]
  })
}

function readSnapshot(): WebBookmarksSnapshot {
  const filePath = getWebBookmarksPath()
  if (!existsSync(filePath)) return emptySnapshot()

  try {
    const raw: unknown = JSON.parse(readFileSync(filePath, 'utf-8'))
    if (!isRecord(raw)) return emptySnapshot()

    const groups = readGroups(raw.groups)
    return { groups, bookmarks: readBookmarks(raw.bookmarks, groups) }
  } catch (error) {
    console.error('[网页收藏夹] 读取失败:', error)
    return emptySnapshot()
  }
}

function writeSnapshot(snapshot: WebBookmarksSnapshot, notify = true): WebBookmarksSnapshot {
  const filePath = getWebBookmarksPath()
  mkdirSync(dirname(filePath), { recursive: true })
  try {
    writeFileSync(filePath, JSON.stringify(snapshot, null, 2), 'utf-8')
  } catch (error) {
    console.error('[网页收藏夹] 写入失败:', error)
    throw new Error('写入网页收藏夹失败')
  }
  if (notify) {
    notifyBookmarkChangeListeners()
  }
  return snapshot
}

function validateUrl(url: string): string {
  const normalized = url.trim()
  if (!/^https?:\/\//i.test(normalized)) {
    throw new Error('仅支持 HTTP 或 HTTPS 网页')
  }

  try {
    return new URL(normalized).toString()
  } catch {
    throw new Error('网页地址无效')
  }
}

function validateFaviconUrl(faviconUrl: SaveWebBookmarkInput['faviconUrl']): string | null | undefined {
  if (faviconUrl === undefined || faviconUrl === null) return faviconUrl

  const normalized = faviconUrl.trim()
  if (!/^https?:\/\//i.test(normalized) && !/^data:image\//i.test(normalized)) {
    throw new Error('网页图标地址无效')
  }
  return normalized
}

function validateGroupName(name: string): string {
  const normalized = name.trim()
  if (!normalized) throw new Error('收藏分组名称不能为空')
  if (normalized.length > 80) throw new Error('收藏分组名称不能超过 80 个字符')
  return normalized
}

function resolveGroupId(
  groupId: SaveWebBookmarkInput['groupId'],
  current: WebBookmarksSnapshot,
  existing: WebBookmark | undefined,
): string | null {
  if (groupId === undefined) return existing?.groupId ?? null
  if (groupId === null) return null
  if (typeof groupId !== 'string' || !current.groups.some((group) => group.id === groupId)) {
    throw new Error('收藏分组不存在')
  }
  return groupId
}

function ensureGroupNameAvailable(
  name: string,
  groups: WebBookmarkGroup[],
  ignoredGroupId?: string,
): void {
  if (groups.some((group) => group.id !== ignoredGroupId && group.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
    throw new Error('收藏分组已存在')
  }
}

/** 获取当前活跃网页收藏夹（过滤掉已被软删除项）。 */
export function getWebBookmarks(): WebBookmarksSnapshot {
  const current = readSnapshot()
  return {
    groups: current.groups.filter((group) => !group.isDeleted),
    bookmarks: current.bookmarks.filter((bookmark) => !bookmark.isDeleted),
  }
}

/** 获取完整网页收藏夹快照（包含墓碑项，供同步服务使用）。 */
export function getWebBookmarksRaw(): WebBookmarksSnapshot {
  return readSnapshot()
}

/** 保存网页收藏；相同 URL 只保留一条并更新标题和分组。 */
export function saveWebBookmark(input: SaveWebBookmarkInput): WebBookmarksSnapshot {
  const url = validateUrl(input.url)
  const title = input.title.trim() || url
  const fallbackFavicon = resolveDefaultFaviconUrl(url)
  const validatedFavicon = validateFaviconUrl(input.faviconUrl)
  const faviconUrl = validatedFavicon === undefined ? undefined : (validatedFavicon ?? fallbackFavicon)
  const current = readSnapshot()
  const existing = current.bookmarks.find((bookmark) => bookmark.url === url)
  const groupId = resolveGroupId(input.groupId, current, existing)
  const now = Date.now()

  if (existing) {
    const nextFavicon = faviconUrl === undefined
      ? (existing.faviconUrl ?? fallbackFavicon)
      : faviconUrl
    return writeSnapshot({
      groups: current.groups,
      bookmarks: current.bookmarks.map((bookmark) => bookmark.id === existing.id
        ? {
          ...bookmark,
          title,
          url,
          faviconUrl: nextFavicon,
          groupId,
          updatedAt: now,
          version: (existing.version ?? 1) + 1,
          isDeleted: false,
          deletedAt: undefined,
        }
        : bookmark),
    })
  }

  const bookmark: WebBookmark = {
    id: randomUUID(),
    title,
    url,
    faviconUrl: faviconUrl ?? fallbackFavicon,
    createdAt: now,
    updatedAt: now,
    version: 1,
    isDeleted: false,
    groupId,
  }
  return writeSnapshot({ groups: current.groups, bookmarks: [bookmark, ...current.bookmarks] })
}

/** 删除指定网页收藏（使用墓碑标记以便增量同步）。 */
export function removeWebBookmark(bookmarkId: string): WebBookmarksSnapshot {
  const current = readSnapshot()
  const target = current.bookmarks.find((bookmark) => bookmark.id === bookmarkId)
  if (!target) return getWebBookmarks()

  const now = Date.now()
  writeSnapshot({
    groups: current.groups,
    bookmarks: current.bookmarks.map((bookmark) => bookmark.id === bookmarkId
      ? {
        ...bookmark,
        isDeleted: true,
        deletedAt: now,
        updatedAt: now,
        version: (bookmark.version ?? 1) + 1,
      }
      : bookmark),
  })
  return getWebBookmarks()
}

/** 创建网页收藏分组。 */
export function createWebBookmarkGroup(input: CreateWebBookmarkGroupInput): WebBookmarksSnapshot {
  const name = validateGroupName(input.name)
  const current = readSnapshot()
  ensureGroupNameAvailable(name, current.groups.filter((g) => !g.isDeleted))
  const now = Date.now()

  const group: WebBookmarkGroup = {
    id: randomUUID(),
    name,
    createdAt: now,
    updatedAt: now,
    version: 1,
    isDeleted: false,
  }
  return writeSnapshot({ groups: [group, ...current.groups], bookmarks: current.bookmarks })
}

/** 重命名网页收藏分组。 */
export function renameWebBookmarkGroup(input: RenameWebBookmarkGroupInput): WebBookmarksSnapshot {
  const name = validateGroupName(input.name)
  const current = readSnapshot()
  const target = current.groups.find((group) => group.id === input.groupId && !group.isDeleted)
  if (!target) throw new Error('收藏分组不存在')
  ensureGroupNameAvailable(name, current.groups.filter((g) => !g.isDeleted), input.groupId)
  const now = Date.now()

  return writeSnapshot({
    groups: current.groups.map((group) => group.id === input.groupId
      ? { ...group, name, updatedAt: now, version: (group.version ?? 1) + 1 }
      : group),
    bookmarks: current.bookmarks,
  })
}

/** 删除网页收藏分组；分组标记墓碑，分组内的收藏会移动到未分组。 */
export function removeWebBookmarkGroup(groupId: string): WebBookmarksSnapshot {
  const current = readSnapshot()
  const target = current.groups.find((group) => group.id === groupId)
  if (!target) return getWebBookmarks()

  const now = Date.now()
  const nextGroups = current.groups.map((group) => group.id === groupId
    ? {
      ...group,
      isDeleted: true,
      deletedAt: now,
      updatedAt: now,
      version: (group.version ?? 1) + 1,
    }
    : group)

  const nextBookmarks = current.bookmarks.map((bookmark) => bookmark.groupId === groupId
    ? {
      ...bookmark,
      groupId: null,
      updatedAt: now,
      version: (bookmark.version ?? 1) + 1,
    }
    : bookmark)

  writeSnapshot({
    groups: nextGroups,
    bookmarks: nextBookmarks,
  })
  return getWebBookmarks()
}

/** 批量合并远端增量变更（供同步服务调用，写操作时不额外触发同步推送通知）。 */
export function applyRemoteBookmarkChanges(
  remoteGroups: WebBookmarkGroupChange[],
  remoteBookmarks: WebBookmarkChange[],
): WebBookmarksSnapshot {
  const current = readSnapshot()
  const groupMap = new Map(current.groups.map((g) => [g.id, { ...g }]))

  for (const remote of remoteGroups) {
    const existing = groupMap.get(remote.id)
    if (!existing) {
      groupMap.set(remote.id, { ...remote })
    } else if (remote.updatedAt >= (existing.updatedAt ?? existing.createdAt)) {
      groupMap.set(remote.id, { ...remote })
    }
  }

  const mergedGroups = Array.from(groupMap.values())
  const validGroupIds = new Set(
    mergedGroups.filter((g) => !g.isDeleted).map((g) => g.id),
  )

  const bookmarkMap = new Map(current.bookmarks.map((b) => [b.id, { ...b }]))
  for (const remote of remoteBookmarks) {
    const existing = bookmarkMap.get(remote.id)
    const effectiveGroupId = remote.groupId && validGroupIds.has(remote.groupId) ? remote.groupId : null
    const remoteWithGroup = { ...remote, groupId: effectiveGroupId }
    if (!existing) {
      bookmarkMap.set(remote.id, remoteWithGroup)
    } else if (remote.updatedAt >= (existing.updatedAt ?? existing.createdAt)) {
      bookmarkMap.set(remote.id, remoteWithGroup)
    }
  }

  const mergedBookmarks = Array.from(bookmarkMap.values()).map((b) => {
    if (b.groupId && !validGroupIds.has(b.groupId)) {
      return { ...b, groupId: null }
    }
    return b
  })

  return writeSnapshot({ groups: mergedGroups, bookmarks: mergedBookmarks }, false)
}

/** 定时清理超过保留期的本地墓碑记录（默认 30 天）。 */
export function purgeExpiredBookmarkTombstones(maxAgeMs = 30 * 24 * 60 * 60 * 1000): void {
  const current = readSnapshot()
  const threshold = Date.now() - maxAgeMs
  const groups = current.groups.filter((g) => !g.isDeleted || (g.deletedAt ?? 0) > threshold)
  const bookmarks = current.bookmarks.filter((b) => !b.isDeleted || (b.deletedAt ?? 0) > threshold)
  if (groups.length !== current.groups.length || bookmarks.length !== current.bookmarks.length) {
    writeSnapshot({ groups, bookmarks }, false)
  }
}
