/**
 * Chrome Desktop Worker Capability 签发与校验
 *
 * 内存持有，绑定会话与运行代次。
 * 严格限制签发条件：macOS、用户主会话、支持图片的模型、非敏感/自动化上下文。
 */

import { randomUUID } from 'node:crypto'
import type { PiWorkerChromeDesktopCapability } from '@copis/shared'
import { CHROME_DESKTOP_ENDPOINT } from '@copis/shared'

interface IssuedChromeDesktopCapability {
  sessionId: string
  token: string
  issuedAt: number
}

const activeCapabilities = new Map<string, IssuedChromeDesktopCapability>()

export interface IssueChromeDesktopCapabilityOptions {
  sessionId: string
  platform?: string
  triggeredBy?: string
  isChatroomRun?: boolean
  isAutomationRun?: boolean
  isDelegationRun?: boolean
  isRemoteBotRun?: boolean
  isPaymentRun?: boolean
  isSessionProfessional?: boolean
  imageInputSupported?: boolean
}

/**
 * 严格校验当前运行上下文是否符合 Chrome 桌面控制签发资格。
 * 仅允许 macOS 本机、用户主动触发（非自动化/委派/远程/支付）、支持图片模型的运行。
 */
export function isEligibleForChromeDesktopControl(
  options: IssueChromeDesktopCapabilityOptions,
): boolean {
  const currentPlatform = options.platform ?? process.platform
  if (currentPlatform !== 'darwin') return false
  if (options.triggeredBy !== undefined && options.triggeredBy !== 'user') return false
  if (options.isChatroomRun === true) return false
  if (options.isAutomationRun === true) return false
  if (options.isDelegationRun === true) return false
  if (options.isRemoteBotRun === true) return false
  if (options.isPaymentRun === true) return false
  if (options.isSessionProfessional === true) return false
  if (options.imageInputSupported !== true) return false
  return true
}

/**
 * 为一次符合安全边界的 Agent 运行签发 Chrome Desktop Worker capability。
 */
export function issueChromeDesktopWorkerCapability(
  options: IssueChromeDesktopCapabilityOptions,
): PiWorkerChromeDesktopCapability | undefined {
  if (!isEligibleForChromeDesktopControl(options)) {
    return undefined
  }

  const existing = activeCapabilities.get(options.sessionId)
  if (existing) {
    return {
      endpoint: CHROME_DESKTOP_ENDPOINT,
      token: existing.token,
    }
  }

  const token = `cdc_${randomUUID().replace(/-/g, '')}`
  activeCapabilities.set(options.sessionId, {
    sessionId: options.sessionId,
    token,
    issuedAt: Date.now(),
  })

  return {
    endpoint: CHROME_DESKTOP_ENDPOINT,
    token,
  }
}

/**
 * 校验 capability 是否有效且属于指定会话。
 */
export function validateChromeDesktopWorkerCapability(
  sessionId: string,
  token: string,
): boolean {
  if (!sessionId || !token) return false
  const active = activeCapabilities.get(sessionId)
  if (!active) return false
  return active.token === token
}

/**
 * 撤销指定会话的 capability。
 */
export function revokeChromeDesktopWorkerCapability(
  sessionId: string,
  token?: string,
): void {
  const active = activeCapabilities.get(sessionId)
  if (!active) return
  if (!token || active.token === token) {
    activeCapabilities.delete(sessionId)
  }
}

/**
 * 清空所有已签发的 capability（仅供测试）。
 */
export function clearAllChromeDesktopWorkerCapabilitiesForTest(): void {
  activeCapabilities.clear()
}
