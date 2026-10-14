import { describe, expect, test } from 'bun:test'
import { isCurrentWebBookmarkRequest } from './web-bookmark-snapshot'

describe('网页收藏快照账号隔离', () => {
  test('Given 账号 A 的读取或编辑尚未完成 When 当前账号切换到 B Then 丢弃 A 的旧响应', () => {
    expect(isCurrentWebBookmarkRequest({ accountId: 'account-a', generation: 4 }, 'account-b', 4)).toBe(false)
  })

  test('Given 同账号发起了更新的快照请求 When 较早请求后返回 Then 丢弃较早结果', () => {
    expect(isCurrentWebBookmarkRequest({ accountId: 'account-a', generation: 4 }, 'account-a', 5)).toBe(false)
  })

  test('Given 当前账号和请求代次均未变化 When 快照返回 Then 允许应用', () => {
    expect(isCurrentWebBookmarkRequest({ accountId: 'account-a', generation: 4 }, 'account-a', 4)).toBe(true)
  })
})
