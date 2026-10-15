import { describe, expect, it, beforeEach } from 'bun:test'
import {
  issueChromeDesktopWorkerCapability,
  validateChromeDesktopWorkerCapability,
  revokeChromeDesktopWorkerCapability,
  clearAllChromeDesktopWorkerCapabilitiesForTest,
} from './chrome-desktop-capability'

describe('chrome-desktop-capability', () => {
  beforeEach(() => {
    clearAllChromeDesktopWorkerCapabilitiesForTest()
  })

  it('rejects issuance when context is not eligible', () => {
    if (process.platform === 'darwin') {
      // 聊天室运行拒绝
      expect(issueChromeDesktopWorkerCapability({ sessionId: 's1', isChatroomRun: true, imageInputSupported: true })).toBeUndefined()
      // 自动化运行拒绝
      expect(issueChromeDesktopWorkerCapability({ sessionId: 's1', isAutomationRun: true, imageInputSupported: true })).toBeUndefined()
      // 委派运行拒绝
      expect(issueChromeDesktopWorkerCapability({ sessionId: 's1', isDelegationRun: true, imageInputSupported: true })).toBeUndefined()
      // 模型不支持图片拒绝
      expect(issueChromeDesktopWorkerCapability({ sessionId: 's1', imageInputSupported: false })).toBeUndefined()
    }
  })

  it('issues, validates, and revokes capability on eligible macOS context', () => {
    if (process.platform !== 'darwin') return

    const cap = issueChromeDesktopWorkerCapability({
      sessionId: 'sess-123',
      imageInputSupported: true,
    })

    expect(cap).toBeDefined()
    expect(cap?.endpoint).toBe('/api/internal/agent/chrome-desktop-tool')
    expect(cap?.token.startsWith('cdc_')).toBe(true)

    // 正确校验
    expect(validateChromeDesktopWorkerCapability('sess-123', cap!.token)).toBe(true)
    // 错误会话校验失败
    expect(validateChromeDesktopWorkerCapability('wrong-sess', cap!.token)).toBe(false)
    // 错误 token 校验失败
    expect(validateChromeDesktopWorkerCapability('sess-123', 'invalid-token')).toBe(false)

    // 撤销
    revokeChromeDesktopWorkerCapability('sess-123', cap!.token)
    expect(validateChromeDesktopWorkerCapability('sess-123', cap!.token)).toBe(false)
  })
})
