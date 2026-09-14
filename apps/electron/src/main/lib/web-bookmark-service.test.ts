import { describe, expect, test, beforeEach, afterEach, mock } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const testDir = join(tmpdir(), `copis-web-bookmark-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`)
const bookmarksPath = join(testDir, 'bookmarks.json')

const actualConfigPaths = await import('./config-paths')
mock.module('./config-paths', () => ({
  ...actualConfigPaths,
  getWebBookmarksPath: () => bookmarksPath,
}))

const service = await import('./web-bookmark-service')

describe('网页收藏夹存储', () => {
  beforeEach(() => {
    mkdirSync(testDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true })
  })

  test('首次读取时返回空分组和收藏列表', () => {
    expect(service.getWebBookmarks()).toEqual({ groups: [], bookmarks: [] })
  })

  test('兼容没有分组字段和图标的旧收藏数据并自动补齐默认图标', () => {
    writeFileSync(bookmarksPath, JSON.stringify({
      bookmarks: [{ id: 'legacy', title: '旧页面', url: 'https://copis.example.com/docs', createdAt: 1 }],
    }))

    expect(service.getWebBookmarks()).toEqual({
      groups: [],
      bookmarks: [{
        id: 'legacy',
        title: '旧页面',
        url: 'https://copis.example.com/docs',
        faviconUrl: 'https://copis.example.com/favicon.ico',
        createdAt: 1,
        updatedAt: 1,
        version: 1,
        isDeleted: false,
        groupId: null,
      }],
    })
  })

  test('保存收藏并写入 JSON，未传 faviconUrl 时自动回退为站点根 favicon.ico', () => {
    const group = service.createWebBookmarkGroup({ name: '开发文档' }).groups[0]!
    const first = service.saveWebBookmark({ title: 'Copis', url: 'https://copis.example.com/docs', groupId: group.id })
    expect(first.bookmarks).toHaveLength(1)
    expect(first.bookmarks[0]).toMatchObject({
      title: 'Copis',
      url: 'https://copis.example.com/docs',
      faviconUrl: 'https://copis.example.com/favicon.ico',
      groupId: group.id,
      version: 1,
      isDeleted: false,
    })
    expect(existsSync(bookmarksPath)).toBe(true)
    expect(JSON.parse(readFileSync(bookmarksPath, 'utf-8'))).toEqual(service.getWebBookmarksRaw())
  })

  test('Given 已加载网站图标的网页 When 保存收藏并仅移动分组 Then 持久化并保留该图标', () => {
    const group = service.createWebBookmarkGroup({ name: '常用网站' }).groups[0]!
    const faviconUrl = 'https://copis.example.com/custom-icon.png'
    const saved = service.saveWebBookmark({
      title: 'Copis',
      url: 'https://copis.example.com/',
      faviconUrl,
    })

    expect(saved.bookmarks[0]).toMatchObject({ faviconUrl })

    const moved = service.saveWebBookmark({
      title: 'Copis',
      url: 'https://copis.example.com/',
      groupId: group.id,
    })

    expect(moved.bookmarks[0]).toMatchObject({ groupId: group.id, faviconUrl })
    expect(JSON.parse(readFileSync(bookmarksPath, 'utf-8'))).toEqual(service.getWebBookmarksRaw())
  })

  test('删除收藏项使用软删除墓碑标记，公开列表过滤但原始快照保留', () => {
    const saved = service.saveWebBookmark({ title: '要删除的页面', url: 'https://example.com/delete' })
    const bookmarkId = saved.bookmarks[0]!.id

    const afterRemove = service.removeWebBookmark(bookmarkId)
    expect(afterRemove.bookmarks).toHaveLength(0)

    const raw = service.getWebBookmarksRaw()
    expect(raw.bookmarks).toHaveLength(1)
    expect(raw.bookmarks[0]).toMatchObject({
      id: bookmarkId,
      isDeleted: true,
      version: 2,
    })
    expect(raw.bookmarks[0]!.deletedAt).toBeGreaterThan(0)
  })

  test('删除分组时该分组置为墓碑态，且所属书签自动降级为未分组', () => {
    const group = service.createWebBookmarkGroup({ name: '临时分组' }).groups[0]!
    const saved = service.saveWebBookmark({ title: '测试页面', url: 'https://example.com/test', groupId: group.id })
    const bookmarkId = saved.bookmarks[0]!.id

    const afterRemoveGroup = service.removeWebBookmarkGroup(group.id)
    expect(afterRemoveGroup.groups).toHaveLength(0)
    expect(afterRemoveGroup.bookmarks).toHaveLength(1)
    expect(afterRemoveGroup.bookmarks[0]!.groupId).toBeNull()

    const raw = service.getWebBookmarksRaw()
    expect(raw.groups[0]).toMatchObject({
      id: group.id,
      isDeleted: true,
      version: 2,
    })
  })

  test('applyRemoteBookmarkChanges 支持增量合并与孤儿收藏保护', () => {
    const remoteGroups = [
      { id: 'rg-1', name: '云端分组', createdAt: 100, updatedAt: 200, version: 1, isDeleted: false },
    ]
    const remoteBookmarks = [
      {
        id: 'rb-1',
        title: '云端书签',
        url: 'https://remote.com',
        faviconUrl: null,
        groupId: 'rg-1',
        createdAt: 100,
        updatedAt: 200,
        version: 1,
        isDeleted: false,
      },
      {
        id: 'rb-orphan',
        title: '孤儿书签',
        url: 'https://orphan.com',
        faviconUrl: null,
        groupId: 'non-existent-group',
        createdAt: 100,
        updatedAt: 200,
        version: 1,
        isDeleted: false,
      },
    ]

    const merged = service.applyRemoteBookmarkChanges(remoteGroups, remoteBookmarks)
    expect(merged.groups).toHaveLength(1)
    expect(merged.groups[0]!.name).toBe('云端分组')

    const bookmark = merged.bookmarks.find((b) => b.id === 'rb-1')
    expect(bookmark?.groupId).toBe('rg-1')

    const orphan = merged.bookmarks.find((b) => b.id === 'rb-orphan')
    expect(orphan?.groupId).toBeNull()
  })

  test('purgeExpiredBookmarkTombstones 清理过期墓碑', () => {
    const saved = service.saveWebBookmark({ title: '过期测试', url: 'https://expire.com' })
    const id = saved.bookmarks[0]!.id
    service.removeWebBookmark(id)

    // 清理 0ms 之前（即全部已删除）的墓碑
    service.purgeExpiredBookmarkTombstones(0)

    const raw = service.getWebBookmarksRaw()
    expect(raw.bookmarks.some((b) => b.id === id)).toBe(false)
  })
})
