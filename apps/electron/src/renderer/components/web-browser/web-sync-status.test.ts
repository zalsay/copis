import { describe, expect, test } from 'bun:test'
import type { WebSyncState } from '@copis/shared'
import {
  getWebSyncFeedback,
  getWebSyncStatusPresentation,
  isCurrentWebSyncRequest,
  isWebSyncRequestPendingForAccount,
} from './web-sync-status'

function makeState(status: WebSyncState['status'], overrides: Partial<WebSyncState> = {}): WebSyncState {
  return {
    status,
    accountId: null,
    deviceId: 'device-1',
    serverCursor: 0,
    lastSyncedAt: 0,
    isSyncing: status === 'syncing',
    hasLocalChanges: status === 'pending',
    lastSyncError: null,
    ...overrides,
  }
}

describe('网页云同步状态展示', () => {
  test('Given 初始化状态未知 When 显示地址栏按钮 Then 提示尚未确认而不误报同步', () => {
    const state = makeState('idle')
    expect(getWebSyncStatusPresentation(state)).toMatchObject({ icon: 'cloud', label: '网页同步状态未知，点击同步' })
    expect(getWebSyncFeedback(state)).toMatchObject({ kind: 'info' })
  })

  test('Given 用户未登录 When 点击同步 Then 提醒先登录且不提示成功', () => {
    const state = makeState('signed-out')
    expect(getWebSyncStatusPresentation(state)).toMatchObject({ icon: 'offline', label: '未登录，网页数据不会同步' })
    expect(getWebSyncFeedback(state)).toEqual({ kind: 'info', message: '请先登录账号后再同步网页数据' })
  })

  test('Given 有本地变更待上传 When 展示或完成请求 Then 保留待同步反馈', () => {
    const state = makeState('pending')
    expect(getWebSyncStatusPresentation(state)).toMatchObject({ icon: 'pending', label: '有网页数据待同步' })
    expect(getWebSyncFeedback(state).kind).toBe('info')
  })

  test('Given 同步正在进行 When 展示按钮 Then 显示进行中且不反馈成功', () => {
    const state = makeState('syncing')
    expect(getWebSyncStatusPresentation(state)).toMatchObject({ icon: 'syncing', label: '正在同步网页数据…' })
    expect(getWebSyncFeedback(state).kind).toBe('info')
  })

  test('Given 同步明确失败 When 展示或完成请求 Then 展示错误并反馈失败', () => {
    const state = makeState('error', { lastSyncError: '网络不可用' })
    expect(getWebSyncStatusPresentation(state).label).toContain('网络不可用')
    expect(getWebSyncFeedback(state)).toEqual({ kind: 'error', message: '网络不可用' })
  })

  test('Given 后端明确报告已同步 When 显示结果 Then 才反馈成功', () => {
    const state = makeState('synced', { lastSyncedAt: 1_800_000_000_000 })
    expect(getWebSyncStatusPresentation(state)).toMatchObject({ icon: 'cloud', label: '网页数据已同步' })
    expect(getWebSyncFeedback(state)).toEqual({ kind: 'success', message: '网页数据已与云端同步' })
  })

  test('Given 账号 A 的请求仍在等待 When 切换到账号 B Then A 的本地请求锁不阻塞 B', () => {
    const pendingRequest = { requestId: 12, accountId: 'account-a' }
    expect(isWebSyncRequestPendingForAccount(pendingRequest, 'account-b')).toBe(false)
    expect(isWebSyncRequestPendingForAccount(pendingRequest, 'account-a')).toBe(true)
  })

  test('Given 账号 A 的请求已经被 B 的新请求取代 When A 的 finally 执行 Then 不清除 B 的请求锁', () => {
    const requestA = { requestId: 12, accountId: 'account-a' }
    const requestB = { requestId: 13, accountId: 'account-b' }
    expect(isCurrentWebSyncRequest(requestA, requestB)).toBe(false)
    expect(isCurrentWebSyncRequest(requestB, requestB)).toBe(true)
  })
})
