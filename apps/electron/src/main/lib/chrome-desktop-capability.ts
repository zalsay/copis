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
  isChatroomRun?: boolean
  isAutomationRun?: boolean
  isDelegationRun?: boolean
  isRemoteBotRun?: boolean
  isPaymentRun?: boolean
  imageInputSupported?: boolean
}

/**
 * 为一次符合安全边界的 Agent 运行签发 Chrome Desktop Worker capability。
 */
export function issueChromeDesktopWorkerCapability(
  options: IssueChromeDesktopCapabilityOptions,
): PiWorkerChromeDesktopCapability | undefined {
  if (process.platform !== 'darwin') return undefined
  if (options.isChatroomRun) return undefined
  if (options.isAutomationRun) return undefined
  if (options.isDelegationRun) return undefined
  if (options.isRemoteBotRun) return undefined
  if (options.isPaymentRun) return undefined
  if (options.imageInputSupported !== true) return undefined

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
