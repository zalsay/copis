import { describe, expect, test } from 'bun:test'
import {
  assertBrowserAgentWorkerCapability,
  issueBrowserAgentWorkerCapability,
  revokeBrowserAgentWorkerCapability,
  updateBrowserAgentWorkerCapabilityTabId,
} from './browser-agent-worker-capability'

describe('Browser Agent Worker capability', () => {
  test('Given issued capability When session and tab match Then it returns the trigger source', () => {
    const capability = issueBrowserAgentWorkerCapability({
      sessionId: 'session-1',
      tabId: 'tab-1',
      triggeredBy: 'user',
    })

    expect(assertBrowserAgentWorkerCapability({
      sessionId: 'session-1',
      tabId: 'tab-1',
      token: capability.token,
    })).toEqual({ triggeredBy: 'user' })

    revokeBrowserAgentWorkerCapability('session-1')
  })

  test('Given capability When session or tab does not match Then it is rejected without exposing the token', () => {
    const capability = issueBrowserAgentWorkerCapability({
      sessionId: 'session-1',
      tabId: 'tab-1',
      triggeredBy: 'delegation',
    })

    expect(() => assertBrowserAgentWorkerCapability({
      sessionId: 'session-2',
      tabId: 'tab-1',
      token: capability.token,
    })).toThrow(expect.objectContaining({ code: 'browser_capability_stale' }))
    expect(() => assertBrowserAgentWorkerCapability({
      sessionId: 'session-1',
      tabId: 'tab-2',
      token: capability.token,
    })).toThrow(expect.objectContaining({ code: 'browser_capability_invalid' }))

    revokeBrowserAgentWorkerCapability('session-1')
  })

  test('Given issued capability When tab id updates with the same token Then only the new tab matches', () => {
    const capability = issueBrowserAgentWorkerCapability({
      sessionId: 'session-tab-switch',
      tabId: 'tab-1',
      triggeredBy: 'user',
    })

    updateBrowserAgentWorkerCapabilityTabId('session-tab-switch', 'tab-2')

    expect(assertBrowserAgentWorkerCapability({
      sessionId: 'session-tab-switch',
      tabId: 'tab-2',
      token: capability.token,
    })).toEqual({ triggeredBy: 'user' })
    expect(() => assertBrowserAgentWorkerCapability({
      sessionId: 'session-tab-switch',
      tabId: 'tab-1',
      token: capability.token,
    })).toThrow(expect.objectContaining({ code: 'browser_capability_invalid' }))

    revokeBrowserAgentWorkerCapability('session-tab-switch')
  })

  test('Given capability issued for one session When another query session presents its token Then it is rejected', () => {
    const capability = issueBrowserAgentWorkerCapability({
      sessionId: 'session-bound',
      tabId: 'tab-1',
      triggeredBy: 'user',
    })

    expect(() => assertBrowserAgentWorkerCapability({
      sessionId: 'session-other',
      tabId: 'tab-1',
      token: capability.token,
    })).toThrow(expect.objectContaining({ code: 'browser_capability_stale' }))

    revokeBrowserAgentWorkerCapability('session-bound')
  })

  test('Given capability When revoked or expired Then it is rejected as stale', () => {
    const capability = issueBrowserAgentWorkerCapability({
      sessionId: 'session-1',
      tabId: 'tab-1',
      triggeredBy: 'automation',
    })

    revokeBrowserAgentWorkerCapability('session-1')
    expect(() => assertBrowserAgentWorkerCapability({
      sessionId: 'session-1',
      tabId: 'tab-1',
      token: capability.token,
    })).toThrow(expect.objectContaining({ code: 'browser_capability_stale' }))
  })

  test('Given issued capability When the TTL has elapsed Then it is rejected as stale', () => {
    const originalDateNow = Date.now
    const issuedAt = originalDateNow()
    Date.now = () => issuedAt
    const capability = issueBrowserAgentWorkerCapability({
      sessionId: 'session-expiring',
      tabId: 'tab-1',
      triggeredBy: 'automation',
    })

    try {
      Date.now = () => issuedAt + 30 * 60_000 + 1

      expect(() => assertBrowserAgentWorkerCapability({
        sessionId: 'session-expiring',
        tabId: 'tab-1',
        token: capability.token,
      })).toThrow(expect.objectContaining({ code: 'browser_capability_stale' }))
    } finally {
      Date.now = originalDateNow
      revokeBrowserAgentWorkerCapability('session-expiring')
    }
  })
})
