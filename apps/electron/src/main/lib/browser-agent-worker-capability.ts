import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { PiWorkerBrowserCapability } from './agent-rpc-protocol'
import { shortLogId } from './bridge-log-redaction'

export type BrowserAgentCapabilityTrigger = 'user' | 'automation' | 'delegation'

interface BrowserAgentWorkerCapabilityRecord {
  sessionId: string
  tabId?: string
  token: string
  triggeredBy: BrowserAgentCapabilityTrigger
}

export class BrowserAgentWorkerCapabilityError extends Error {
  readonly code: 'browser_capability_invalid' | 'browser_capability_stale'
  readonly status = 403

  constructor(code: 'browser_capability_invalid' | 'browser_capability_stale', message: string) {
    super(message)
    this.name = 'BrowserAgentWorkerCapabilityError'
    this.code = code
  }
}

const capabilities = new Map<string, BrowserAgentWorkerCapabilityRecord>()

function requireNonBlank(value: string, label: string): void {
  if (!value.trim()) throw new Error(`${label} 不能为空`)
}

function tokensMatch(expected: string, received: string): boolean {
  const expectedBytes = Buffer.from(expected)
  const receivedBytes = Buffer.from(received)
  return expectedBytes.length === receivedBytes.length && timingSafeEqual(expectedBytes, receivedBytes)
}

export function issueBrowserAgentWorkerCapability(input: {
  sessionId: string
  tabId?: string
  triggeredBy: BrowserAgentCapabilityTrigger
}): PiWorkerBrowserCapability {
  requireNonBlank(input.sessionId, 'sessionId')
  if (input.tabId !== undefined) requireNonBlank(input.tabId, 'tabId')
  const token = randomBytes(32).toString('base64url')
  capabilities.set(input.sessionId, {
    sessionId: input.sessionId,
    tabId: input.tabId,
    token,
    triggeredBy: input.triggeredBy,
  })
  console.info('[AI浏览器][Capability签发]', {
    sessionId: input.sessionId,
    tabId: input.tabId ?? '(undefined)',
    triggeredBy: input.triggeredBy,
    tokenFingerprint: shortLogId(token),
  })
  return { endpoint: '/api/internal/agent/browser-tool', token }
}

export function assertBrowserAgentWorkerCapability(input: {
  sessionId: string
  tabId?: string
  token: string
}): { triggeredBy: BrowserAgentCapabilityTrigger } {
  const record = capabilities.get(input.sessionId)
  if (!record) {
    console.warn('[AI浏览器][Capability校验] 失败: capability 记录不存在 (已失效或未签发)', {
      sessionId: input.sessionId,
      tabId: input.tabId,
      allActiveSessions: Array.from(capabilities.keys()),
    })
    throw new BrowserAgentWorkerCapabilityError('browser_capability_stale', 'AI浏览器 capability 已失效')
  }

  const sessionMatch = record.sessionId === input.sessionId
  const tokenMatch = tokensMatch(record.token, input.token)

  if (!sessionMatch || !tokenMatch) {
    console.error('[AI浏览器][Capability校验] 失败: capability 不正确 (session 或 token 不匹配)', {
      sessionId: input.sessionId,
      sessionMatch,
      tokenMatch,
      expectedTokenFingerprint: shortLogId(record.token),
      receivedTokenFingerprint: shortLogId(input.token),
    })
    throw new BrowserAgentWorkerCapabilityError('browser_capability_invalid', 'AI浏览器 capability 不正确')
  }

  // 自愈与对齐：如果签发时无 tabId（初始 undefined），而在调用时 session 已关联了有效 tabId
  if (record.tabId === undefined && input.tabId !== undefined) {
    console.info('[AI浏览器][Capability校验] 自动对齐初始未指定 tabId 的 capability', {
      sessionId: input.sessionId,
      alignedTabId: input.tabId,
    })
    record.tabId = input.tabId
  }

  // 页签匹配逻辑：
  // 1. 若 input.tabId 未提供（如 BrowserPageOpenTab 且尚无上下文），放行
  // 2. 否则要求 record.tabId 与 input.tabId 完全匹配
  const tabMatch = input.tabId === undefined || record.tabId === input.tabId

  if (!tabMatch) {
    console.error('[AI浏览器][Capability校验] 失败: capability 不正确 (tabId 不匹配)', {
      sessionId: input.sessionId,
      sessionMatch,
      tabMatch,
      tokenMatch,
      expectedTabId: record.tabId ?? '(undefined)',
      receivedTabId: input.tabId ?? '(undefined)',
      expectedTokenFingerprint: shortLogId(record.token),
      receivedTokenFingerprint: shortLogId(input.token),
    })
    throw new BrowserAgentWorkerCapabilityError('browser_capability_invalid', 'AI浏览器 capability 不正确')
  }

  console.info('[AI浏览器][Capability校验] 成功通过', {
    sessionId: input.sessionId,
    tabId: record.tabId,
    triggeredBy: record.triggeredBy,
  })
  return { triggeredBy: record.triggeredBy }
}

export function hasBrowserAgentWorkerCapability(sessionId: string): boolean {
  return capabilities.has(sessionId)
}

export function revokeBrowserAgentWorkerCapability(sessionId: string, token?: string): void {
  const record = capabilities.get(sessionId)
  if (!record) {
    console.info('[AI浏览器][Capability撤销] 记录已不存在或已被撤销', { sessionId })
    return
  }
  // 若提供了 token，必须与当前记录中的 token 完全一致才撤销，防止跨轮次或并发异步结束误杀新一轮有效 capability
  if (token && record.token !== token) {
    console.warn('[AI浏览器][Capability撤销] 忽略陈旧 token 的撤销请求', {
      sessionId,
      recordTokenFingerprint: shortLogId(record.token),
      requestedTokenFingerprint: shortLogId(token),
    })
    return
  }
  capabilities.delete(sessionId)
  console.info('[AI浏览器][Capability撤销]', {
    sessionId,
    hadRecord: true,
    tokenFingerprint: shortLogId(record.token),
  })
}

/** 保留同一 worker 的 token，把 capability 指向 Agent 新打开的页签。 */
export function updateBrowserAgentWorkerCapabilityTabId(sessionId: string, tabId: string): void {
  const record = capabilities.get(sessionId)
  if (!record) {
    console.warn('[AI浏览器][Capability更新TabId] 记录不存在，无法更新 tabId', { sessionId, tabId })
    return
  }
  requireNonBlank(tabId, 'tabId')
  const previousTabId = record.tabId
  record.tabId = tabId
  console.info('[AI浏览器][Capability更新TabId] 成功将 tabId 从旧页签更新到新页签', {
    sessionId,
    previousTabId: previousTabId ?? '(undefined)',
    newTabId: tabId,
  })
}
