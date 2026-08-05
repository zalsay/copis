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
} from '@copis/shared'
import { getWebBookmarksPath } from './config-paths'

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
    return [{ id, name, createdAt: item.createdAt }]
  })
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
    return [{ id, title, url, createdAt: item.createdAt, groupId }]
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

function writeSnapshot(snapshot: WebBookmarksSnapshot): WebBookmarksSnapshot {
  const filePath = getWebBookmarksPath()
  mkdirSync(dirname(filePath), { recursive: true })
  try {
    writeFileSync(filePath, JSON.stringify(snapshot, null, 2), 'utf-8')
  } catch (error) {
    console.error('[网页收藏夹] 写入失败:', error)
    throw new Error('写入网页收藏夹失败')
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

/** 获取当前网页收藏夹。 */
export function getWebBookmarks(): WebBookmarksSnapshot {
  return readSnapshot()
}

/** 保存网页收藏；相同 URL 只保留一条并更新标题和分组。 */
export function saveWebBookmark(input: SaveWebBookmarkInput): WebBookmarksSnapshot {
  const url = validateUrl(input.url)
  const title = input.title.trim() || url
  const current = readSnapshot()
  const existing = current.bookmarks.find((bookmark) => bookmark.url === url)
  const groupId = resolveGroupId(input.groupId, current, existing)

  if (existing) {
    return writeSnapshot({
      groups: current.groups,
      bookmarks: current.bookmarks.map((bookmark) => bookmark.id === existing.id
        ? { ...bookmark, title, url, groupId }
        : bookmark),
    })
  }

  const bookmark: WebBookmark = {
    id: randomUUID(),
    title,
    url,
    createdAt: Date.now(),
    groupId,
  }
  return writeSnapshot({ groups: current.groups, bookmarks: [bookmark, ...current.bookmarks] })
}

/** 删除指定网页收藏。 */
export function removeWebBookmark(bookmarkId: string): WebBookmarksSnapshot {
  const current = readSnapshot()
  return writeSnapshot({
    groups: current.groups,
    bookmarks: current.bookmarks.filter((bookmark) => bookmark.id !== bookmarkId),
  })
}

/** 创建网页收藏分组。 */
export function createWebBookmarkGroup(input: CreateWebBookmarkGroupInput): WebBookmarksSnapshot {
  const name = validateGroupName(input.name)
  const current = readSnapshot()
  ensureGroupNameAvailable(name, current.groups)

  const group: WebBookmarkGroup = { id: randomUUID(), name, createdAt: Date.now() }
  return writeSnapshot({ groups: [group, ...current.groups], bookmarks: current.bookmarks })
}

/** 重命名网页收藏分组。 */
export function renameWebBookmarkGroup(input: RenameWebBookmarkGroupInput): WebBookmarksSnapshot {
  const name = validateGroupName(input.name)
  const current = readSnapshot()
  if (!current.groups.some((group) => group.id === input.groupId)) throw new Error('收藏分组不存在')
  ensureGroupNameAvailable(name, current.groups, input.groupId)

  return writeSnapshot({
    groups: current.groups.map((group) => group.id === input.groupId ? { ...group, name } : group),
    bookmarks: current.bookmarks,
  })
}

/** 删除网页收藏分组；分组内的收藏会移动到未分组。 */
export function removeWebBookmarkGroup(groupId: string): WebBookmarksSnapshot {
  const current = readSnapshot()
  if (!current.groups.some((group) => group.id === groupId)) return current

  return writeSnapshot({
    groups: current.groups.filter((group) => group.id !== groupId),
    bookmarks: current.bookmarks.map((bookmark) => bookmark.groupId === groupId
      ? { ...bookmark, groupId: null }
      : bookmark),
  })
}
