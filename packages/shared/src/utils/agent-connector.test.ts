import { describe, expect, test } from 'bun:test'
import { isAppConnectorSession } from './agent-connector'

describe('isAppConnectorSession', () => {
  test('Given session with source feishu / wechat / dingtalk When checking Then returns true', () => {
    expect(isAppConnectorSession({ source: 'feishu' })).toBe(true)
    expect(isAppConnectorSession({ source: 'wechat' })).toBe(true)
    expect(isAppConnectorSession({ source: 'dingtalk' })).toBe(true)
    expect(isAppConnectorSession({ source: 'bridge' })).toBe(true)
  })

  test('Given session with dedicated flag When checking Then returns true', () => {
    expect(isAppConnectorSession({ feishuDedicated: true })).toBe(true)
    expect(isAppConnectorSession({ wechatDedicated: true })).toBe(true)
    expect(isAppConnectorSession({ dingtalkDedicated: true })).toBe(true)
  })

  test('Given externalSource param feishu / wechat / dingtalk / bridge When checking Then returns true', () => {
    expect(isAppConnectorSession(null, 'feishu')).toBe(true)
    expect(isAppConnectorSession(null, 'wechat')).toBe(true)
    expect(isAppConnectorSession(null, 'dingtalk')).toBe(true)
    expect(isAppConnectorSession(null, 'bridge')).toBe(true)
  })

  test('Given regular desktop or delegation session When checking Then returns false', () => {
    expect(isAppConnectorSession({ source: 'desktop' })).toBe(false)
    expect(isAppConnectorSession({ source: 'automation' })).toBe(false)
    expect(isAppConnectorSession(null)).toBe(false)
    expect(isAppConnectorSession(undefined)).toBe(false)
  })
})
