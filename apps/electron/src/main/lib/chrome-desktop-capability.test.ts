import { describe, expect, it, beforeEach } from 'bun:test'
import {
  isEligibleForChromeDesktopControl,
  issueChromeDesktopWorkerCapability,
  validateChromeDesktopWorkerCapability,
  revokeChromeDesktopWorkerCapability,
  clearAllChromeDesktopWorkerCapabilitiesForTest,
} from './chrome-desktop-capability'

describe('chrome-desktop-capability matrix and lifecycle', () => {
  beforeEach(() => {
    clearAllChromeDesktopWorkerCapabilitiesForTest()
  })

  describe('isEligibleForChromeDesktopControl', () => {
    const baseValid = {
      sessionId: 's-valid',
      platform: 'darwin',
      triggeredBy: 'user' as const,
      isAutomationRun: false,
      isDelegationRun: false,
      isRemoteBotRun: false,
      isPaymentRun: false,
      isSessionProfessional: false,
      imageInputSupported: true,
    }

    it('approves standard user-triggered run with image model on macOS', () => {
      expect(isEligibleForChromeDesktopControl(baseValid)).toBe(true)
    })

    it('rejects non-macOS platforms (win32, linux)', () => {
      expect(isEligibleForChromeDesktopControl({ ...baseValid, platform: 'win32' })).toBe(false)
      expect(isEligibleForChromeDesktopControl({ ...baseValid, platform: 'linux' })).toBe(false)
    })

    it('rejects when triggeredBy is not user (automation, cron, etc.)', () => {
      expect(isEligibleForChromeDesktopControl({ ...baseValid, triggeredBy: 'automation' as any })).toBe(false)
      expect(isEligibleForChromeDesktopControl({ ...baseValid, triggeredBy: 'cron' as any })).toBe(false)
      expect(isEligibleForChromeDesktopControl({ ...baseValid, triggeredBy: 'system' as any })).toBe(false)
    })

    it('rejects automation run', () => {
      expect(isEligibleForChromeDesktopControl({ ...baseValid, isAutomationRun: true })).toBe(false)
    })

    it('rejects delegation run', () => {
      expect(isEligibleForChromeDesktopControl({ ...baseValid, isDelegationRun: true })).toBe(false)
    })

    it('rejects remote bot run (feishu, wechat, dingtalk)', () => {
      expect(isEligibleForChromeDesktopControl({ ...baseValid, isRemoteBotRun: true })).toBe(false)
    })

    it('rejects payment run', () => {
      expect(isEligibleForChromeDesktopControl({ ...baseValid, isPaymentRun: true })).toBe(false)
    })

    it('rejects professional runtime session', () => {
      expect(isEligibleForChromeDesktopControl({ ...baseValid, isSessionProfessional: true })).toBe(false)
    })

    it('rejects when model does not support images', () => {
      expect(isEligibleForChromeDesktopControl({ ...baseValid, imageInputSupported: false })).toBe(false)
      expect(isEligibleForChromeDesktopControl({ ...baseValid, imageInputSupported: undefined })).toBe(false)
    })
  })

  describe('issue, validate, and revoke lifecycle', () => {
    it('issues, validates, and revokes capability on eligible context', () => {
      const cap = issueChromeDesktopWorkerCapability({
        sessionId: 'sess-123',
        platform: 'darwin',
        imageInputSupported: true,
      })

      expect(cap).toBeDefined()
      expect(cap?.endpoint).toBe('/api/internal/agent/chrome-desktop-tool')
      expect(cap?.token.startsWith('cdc_')).toBe(true)

      const second = issueChromeDesktopWorkerCapability({
        sessionId: 'sess-123',
        platform: 'darwin',
        triggeredBy: 'user',
        imageInputSupported: true,
      })
      expect(second?.token).toBe(cap?.token)

      // 正确校验
      expect(validateChromeDesktopWorkerCapability('sess-123', cap!.token)).toBe(true)
      // 错误会话校验失败
      expect(validateChromeDesktopWorkerCapability('wrong-sess', cap!.token)).toBe(false)
      // 错误 token 校验失败
      expect(validateChromeDesktopWorkerCapability('sess-123', 'invalid-token')).toBe(false)

      // 旧 token 不得误撤销当前有效 token
      revokeChromeDesktopWorkerCapability('sess-123', 'cdc_stale_old_token')
      expect(validateChromeDesktopWorkerCapability('sess-123', cap!.token)).toBe(true)

      // 正确 token 撤销
      revokeChromeDesktopWorkerCapability('sess-123', cap!.token)
      expect(validateChromeDesktopWorkerCapability('sess-123', cap!.token)).toBe(false)
    })
  })
})
