import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { PiWorkerBrowserCapability } from './agent-rpc-protocol'

const BROWSER_AGENT_CAPABILITY_TTL_MS = 30 * 60_000

export type BrowserAgentCapabilityTrigger = 'user' | 'automation' | 'delegation'

interface BrowserAgentWorkerCapabilityRecord {
  sessionId: string
  tabId: string
  token: string
  triggeredBy: BrowserAgentCapabilityTrigger
  expiresAt: number
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
  tabId: string
  triggeredBy: BrowserAgentCapabilityTrigger
}): PiWorkerBrowserCapability {
  requireNonBlank(input.sessionId, 'sessionId')
  requireNonBlank(input.tabId, 'tabId')
  const token = randomBytes(32).toString('base64url')
  capabilities.set(input.sessionId, {
    sessionId: input.sessionId,
    tabId: input.tabId,
    token,
    triggeredBy: input.triggeredBy,
    expiresAt: Date.now() + BROWSER_AGENT_CAPABILITY_TTL_MS,
  })
  return { endpoint: '/api/internal/agent/browser-tool', token }
}

export function assertBrowserAgentWorkerCapability(input: {
  sessionId: string
  tabId: string
  token: string
}): { triggeredBy: BrowserAgentCapabilityTrigger } {
  const record = capabilities.get(input.sessionId)
  if (!record) {
    throw new BrowserAgentWorkerCapabilityError('browser_capability_stale', 'AI浏览器 capability 已失效')
  }
  if (record.expiresAt <= Date.now()) {
    capabilities.delete(input.sessionId)
    throw new BrowserAgentWorkerCapabilityError('browser_capability_stale', 'AI浏览器 capability 已过期')
  }
  if (record.sessionId !== input.sessionId || record.tabId !== input.tabId || !tokensMatch(record.token, input.token)) {
    throw new BrowserAgentWorkerCapabilityError('browser_capability_invalid', 'AI浏览器 capability 不正确')
  }
  return { triggeredBy: record.triggeredBy }
}

export function revokeBrowserAgentWorkerCapability(sessionId: string): void {
  capabilities.delete(sessionId)
}
