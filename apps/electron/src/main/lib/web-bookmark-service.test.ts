import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

type WebBookmarkServiceModule = typeof import('./web-bookmark-service')

let service: WebBookmarkServiceModule
let tempDir: string
let bookmarksPath: string

mock.module('./config-paths', () => ({
  getWebBookmarksPath: () => bookmarksPath,
}))

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'copis-web-bookmarks-'))
  bookmarksPath = join(tempDir, 'web-bookmarks.json')
  service = await import('./web-bookmark-service')
})

beforeEach(() => {
  rmSync(bookmarksPath, { force: true })
})

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

describe('网页收藏夹存储', () => {
  test('首次读取时返回空分组和收藏列表', () => {
    expect(service.getWebBookmarks()).toEqual({ groups: [], bookmarks: [] })
  })

  test('兼容没有分组字段的旧收藏数据', () => {
    writeFileSync(bookmarksPath, JSON.stringify({
      bookmarks: [{ id: 'legacy', title: '旧页面', url: 'https://copis.example.com/', createdAt: 1 }],
    }))

    expect(service.getWebBookmarks()).toEqual({
      groups: [],
      bookmarks: [{ id: 'legacy', title: '旧页面', url: 'https://copis.example.com/', createdAt: 1, groupId: null }],
    })
  })

  test('保存收藏并写入 JSON，重复 URL 更新原记录和分组', () => {
    const group = service.createWebBookmarkGroup({ name: '开发文档' }).groups[0]!
    const first = service.saveWebBookmark({ title: 'Copis', url: 'https://copis.example.com/', groupId: group.id })
    expect(first.bookmarks).toHaveLength(1)
    expect(first.bookmarks[0]).toMatchObject({ title: 'Copis', url: 'https://copis.example.com/', groupId: group.id })
    expect(existsSync(bookmarksPath)).toBe(true)
    expect(JSON.parse(readFileSync(bookmarksPath, 'utf-8'))).toEqual(first)

    const updated = service.saveWebBookmark({ title: 'Copis 首页', url: 'https://copis.example.com/', groupId: null })
    expect(updated.bookmarks).toHaveLength(1)
    expect(updated.bookmarks[0]).toMatchObject({ title: 'Copis 首页', url: 'https://copis.example.com/', groupId: null })
  })

  test('支持创建、重命名和删除分组，删除分组不删除收藏', () => {
    const created = service.createWebBookmarkGroup({ name: '稍后阅读' })
    const group = created.groups[0]!
    const saved = service.saveWebBookmark({ title: 'Copis', url: 'https://copis.example.com/', groupId: group.id })

    const renamed = service.renameWebBookmarkGroup({ groupId: group.id, name: '待读' })
    expect(renamed.groups[0]).toMatchObject({ id: group.id, name: '待读' })

    const removed = service.removeWebBookmarkGroup(group.id)
    expect(removed.groups).toEqual([])
    expect(removed.bookmarks[0]).toMatchObject({ id: saved.bookmarks[0]!.id, groupId: null })
  })

  test('拒绝重复或空分组名称及不存在的分组', () => {
    const group = service.createWebBookmarkGroup({ name: '开发文档' }).groups[0]!
    expect(() => service.createWebBookmarkGroup({ name: '开发文档' })).toThrow('收藏分组已存在')
    expect(() => service.renameWebBookmarkGroup({ groupId: group.id, name: '   ' })).toThrow('收藏分组名称不能为空')
    expect(() => service.saveWebBookmark({ title: 'Copis', url: 'https://copis.example.com/', groupId: 'missing' })).toThrow('收藏分组不存在')
  })

  test('删除指定网页收藏后持久化剩余列表', () => {
    const saved = service.saveWebBookmark({ title: 'Copis', url: 'https://copis.example.com/' })
    const removed = service.removeWebBookmark(saved.bookmarks[0]!.id)

    expect(removed).toEqual({ groups: [], bookmarks: [] })
    expect(JSON.parse(readFileSync(bookmarksPath, 'utf-8'))).toEqual(removed)
  })

  test('拒绝非 HTTP(S) 地址', () => {
    expect(() => service.saveWebBookmark({ title: '危险地址', url: 'javascript:alert(1)' })).toThrow('仅支持 HTTP 或 HTTPS 网页')
  })
})
