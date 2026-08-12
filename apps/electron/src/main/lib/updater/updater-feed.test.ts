import { describe, expect, test } from 'bun:test'
import { DEFAULT_COPIS_UPDATER_URL, getUpdaterFeedUrl } from './updater-feed'

describe('COS 自动更新源', () => {
  test('Given 打包配置 When 未设置运行时覆盖 Then 使用默认 COS 更新目录', () => {
    expect(getUpdaterFeedUrl('')).toBe(DEFAULT_COPIS_UPDATER_URL)
  })

  test('Given HTTPS COS 地址 When 读取更新源 Then 保留地址并移除末尾斜杠', () => {
    expect(getUpdaterFeedUrl('https://download.example.com/copis/updates/stable///'))
      .toBe('https://download.example.com/copis/updates/stable')
  })

  test('Given 非 HTTPS 地址 When 读取更新源 Then 回退到默认 COS 地址', () => {
    expect(getUpdaterFeedUrl('http://download.example.com/copis/updates/stable'))
      .toBe(DEFAULT_COPIS_UPDATER_URL)
  })
})
