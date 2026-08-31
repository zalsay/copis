import { describe, expect, test, beforeEach, afterEach, mock } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const testDir = join(tmpdir(), `copis-web-bookmark-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`)
const bookmarksPath = join(testDir, 'bookmarks.json')

mock.module('./config-paths', () => ({
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
    })
    expect(existsSync(bookmarksPath)).toBe(true)
    expect(JSON.parse(readFileSync(bookmarksPath, 'utf-8'))).toEqual(first)
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
    expect(JSON.parse(readFileSync(bookmarksPath, 'utf-8'))).toEqual(moved)
  })
})
