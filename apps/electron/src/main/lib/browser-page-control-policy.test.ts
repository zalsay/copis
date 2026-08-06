import { describe, expect, test } from 'bun:test'
import {
  authorizeBrowserPageOrigin,
  requiresBrowserPageActionConfirmation,
  resolveBrowserPageControlState,
} from './browser-page-control-policy'

describe('Browser Agent 页面授权策略', () => {
  test('Given 尚未授权 When 打开页面 Then 默认使用询问模式', () => {
    expect(resolveBrowserPageControlState('https://example.com/account')).toEqual({
      mode: 'ask',
      pageOrigin: 'https://example.com',
    })
  })

  test('Given 已授权当前 Origin When 页面同站导航 Then 保持授权模式', () => {
    const authorizedOrigin = authorizeBrowserPageOrigin('https://example.com/account')

    expect(resolveBrowserPageControlState('https://example.com/settings', authorizedOrigin)).toEqual({
      mode: 'authorized',
      pageOrigin: 'https://example.com',
      authorizedOrigin: 'https://example.com',
    })
  })

  test('Given 已授权当前 Origin When 页面跨站导航 Then 自动回到询问模式', () => {
    expect(resolveBrowserPageControlState('https://other.example/path', 'https://example.com')).toEqual({
      mode: 'ask',
      pageOrigin: 'https://other.example',
    })
  })

  test('Given 非 HTTP 页面 When 请求授权 Then 拒绝授权', () => {
    expect(() => authorizeBrowserPageOrigin('about:blank')).toThrow('HTTP(S)')
  })

  test('Given Agent 按下 Delete When 判断页面操作风险 Then 要求单次确认', () => {
    expect(requiresBrowserPageActionConfirmation({ key: 'Delete' })).toBe(true)
  })

  test('Given Agent 选择高风险选项 When 判断页面操作风险 Then 仅高风险值要求单次确认', () => {
    expect(requiresBrowserPageActionConfirmation({ value: '删除当前账号' })).toBe(true)
    expect(requiresBrowserPageActionConfirmation({ value: '普通选项' })).toBe(false)
  })
})
