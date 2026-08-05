import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

type WebTabSessionServiceModule = typeof import('./web-tab-session-service')

let service: WebTabSessionServiceModule
let tempDir: string
let sessionPath: string

mock.module('./config-paths', () => ({
  getWebTabsPath: () => sessionPath,
}))

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'copis-web-tabs-'))
  sessionPath = join(tempDir, 'web-tabs.json')
  service = await import('./web-tab-session-service')
})

beforeEach(() => {
  rmSync(sessionPath, { force: true })
  rmSync(`${sessionPath}.tmp`, { force: true })
  rmSync(`${sessionPath}.bak`, { force: true })
})

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

describe('网页页签恢复状态', () => {
  test('没有保存文件时返回空状态', () => {
    expect(service.getPersistedWebTabs()).toEqual({ tabs: [], activeTabIndex: null })
  })

  test('保存并读取网页地址及激活索引', () => {
    const session = {
      tabs: [{ url: 'https://copis.example.com/docs' }, { url: 'about:blank' }],
      activeTabIndex: 1,
    }

    service.savePersistedWebTabs(session)

    expect(existsSync(sessionPath)).toBe(true)
    expect(service.getPersistedWebTabs()).toEqual(session)
    expect(JSON.parse(readFileSync(sessionPath, 'utf-8'))).toMatchObject({ version: 1, ...session })
  })

  test('读取时过滤不支持的地址并修正无效激活索引', () => {
    service.savePersistedWebTabs({
      tabs: [
        { url: 'https://copis.example.com/' },
        { url: 'file:///tmp/private.txt' },
        { url: 'javascript:alert(1)' },
      ],
      activeTabIndex: 2,
    })

    expect(service.getPersistedWebTabs()).toEqual({
      tabs: [{ url: 'https://copis.example.com/' }],
      activeTabIndex: null,
    })
  })
})
