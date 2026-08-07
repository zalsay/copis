import { beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { AgentSessionMeta, AgentWorkspace } from '@copis/shared'
import { assertBrowserAgentWorkerCapability, issueBrowserAgentWorkerCapability } from './browser-agent-worker-capability'

interface TestBrowserPageAuthorizations {
  [sessionId: string]: string[]
}

const sessionMeta = {
  id: 'browser-session',
  title: '网页 Browser Agent',
  workspaceId: 'workspace-1',
  permissionMode: 'plan',
} as AgentSessionMeta
const workspace = {
  id: 'workspace-1',
  name: 'Browser 工作区',
  slug: 'browser-workspace',
} as AgentWorkspace

const getAgentSessionMeta = mock(() => sessionMeta)
const updateAgentSessionMeta = mock((sessionId: string, updates: Record<string, unknown>) => ({
  ...sessionMeta,
  id: sessionId,
  ...updates,
}))
const settings = {
  browserPageAuthorizations: {} as TestBrowserPageAuthorizations,
}
const getSettings = mock(() => settings)
const updateSettings = mock((updates: { browserPageAuthorizations?: TestBrowserPageAuthorizations }) => {
  Object.assign(settings, updates)
  return settings
})
let currentTab = { id: 'tab-1', url: 'https://example.com/account?tab=1', title: 'Account' }

mock.module('./agent-session-manager', () => ({ getAgentSessionMeta, updateAgentSessionMeta }))
mock.module('./settings-service', () => ({ getSettings, updateSettings }))
mock.module('./agent-workspace-manager', () => ({ getAgentWorkspace: () => workspace }))
mock.module('./browser-workflow-store', () => ({
  getBrowserWorkflow: () => undefined,
  saveBrowserWorkflow: () => undefined,
}))
mock.module('./rust-browser-recording-client', () => ({
  appendRustBrowserRecordingEvent: () => Promise.resolve(),
  cancelRustBrowserRecording: () => Promise.resolve(),
  finishRustBrowserRecording: () => Promise.resolve(),
  readRustBrowserRecording: () => Promise.resolve(undefined),
  startRustBrowserRecording: () => Promise.resolve(undefined),
}))
mock.module('./web-tab-manager', () => ({
  getWebTabState: () => currentTab,
  sendWebTabCdpCommandInternal: () => Promise.resolve(undefined),
  subscribeWebTabCdpEvents: () => () => undefined,
  subscribeWebTabCdpDetach: () => () => undefined,
  subscribeWebTabLifecycle: () => () => undefined,
}))

let bindBrowserAgentContext: typeof import('./browser-workflow-service')['bindBrowserAgentContext']
let unbindBrowserAgentContext: typeof import('./browser-workflow-service')['unbindBrowserAgentContext']
let getBrowserPageControlMode: typeof import('./browser-workflow-service')['getBrowserPageControlMode']
let setBrowserPageControlMode: typeof import('./browser-workflow-service')['setBrowserPageControlMode']

beforeAll(async () => {
  const service = await import('./browser-workflow-service')
  bindBrowserAgentContext = service.bindBrowserAgentContext
  unbindBrowserAgentContext = service.unbindBrowserAgentContext
  getBrowserPageControlMode = service.getBrowserPageControlMode
  setBrowserPageControlMode = service.setBrowserPageControlMode
})

beforeEach(() => {
  settings.browserPageAuthorizations = {}
  currentTab = { id: 'tab-1', url: 'https://example.com/account?tab=1', title: 'Account' }
  unbindBrowserAgentContext('browser-session')
  unbindBrowserAgentContext('other-browser-session')
})

describe('Browser Agent Context 绑定', () => {
  test('Given 新会话元数据为 plan When Browser Context 绑定成功 Then 持久化为 bypassPermissions', () => {
    bindBrowserAgentContext('browser-session', { tabId: 'tab-1' })

    expect(updateAgentSessionMeta).toHaveBeenCalledWith('browser-session', {
      permissionMode: 'bypassPermissions',
    })

    unbindBrowserAgentContext('browser-session')
  })

  test('Given active capability When Browser Context changes tab Then the old capability is revoked', () => {
    bindBrowserAgentContext('browser-session', { tabId: 'tab-1' })
    const capability = issueBrowserAgentWorkerCapability({
      sessionId: 'browser-session',
      tabId: 'tab-1',
      triggeredBy: 'user',
    })

    bindBrowserAgentContext('browser-session', { tabId: 'tab-2' })

    expect(() => assertBrowserAgentWorkerCapability({
      sessionId: 'browser-session',
      tabId: 'tab-1',
      token: capability.token,
    })).toThrow(expect.objectContaining({ code: 'browser_capability_stale' }))

    unbindBrowserAgentContext('browser-session')
  })

  test('Given active capability When Browser Context unbinds Then the capability is revoked', () => {
    const capability = issueBrowserAgentWorkerCapability({
      sessionId: 'browser-session',
      tabId: 'tab-1',
      triggeredBy: 'user',
    })

    unbindBrowserAgentContext('browser-session')

    expect(() => assertBrowserAgentWorkerCapability({
      sessionId: 'browser-session',
      tabId: 'tab-1',
      token: capability.token,
    })).toThrow(expect.objectContaining({ code: 'browser_capability_stale' }))
  })

  test('Given account URL is authorized When settings URL changes path and query Then the same Origin remains authorized', () => {
    bindBrowserAgentContext('browser-session', { tabId: 'tab-1' })
    expect(setBrowserPageControlMode('browser-session', 'authorized').controlMode).toBe('authorized')
    expect(settings.browserPageAuthorizations).toEqual({
      'browser-session': ['https://example.com'],
    })

    for (const url of ['https://example.com/settings', 'https://example.com/settings?tab=2#section']) {
      currentTab.url = url
      expect(getBrowserPageControlMode('browser-session')).toBe('authorized')
    }

    unbindBrowserAgentContext('browser-session')
  })

  test('Given settings contains a legacy complete URL When the binding is recreated Then it migrates to Origin authorization', () => {
    settings.browserPageAuthorizations = {
      'browser-session': [
        'https://example.com/account?tab=1',
        'https://example.com',
        'https://example.com/settings#section',
      ],
    }
    currentTab.url = 'https://example.com/settings?tab=2'
    bindBrowserAgentContext('browser-session', { tabId: 'tab-1' })

    expect(getBrowserPageControlMode('browser-session')).toBe('authorized')
    expect(settings.browserPageAuthorizations).toEqual({
      'browser-session': ['https://example.com'],
    })

    unbindBrowserAgentContext('browser-session')
  })

  test('Given an Origin is authorized in one session When another session opens that Origin Then it remains ask', () => {
    bindBrowserAgentContext('browser-session', { tabId: 'tab-1' })
    setBrowserPageControlMode('browser-session', 'authorized')
    unbindBrowserAgentContext('browser-session')

    bindBrowserAgentContext('other-browser-session', { tabId: 'tab-1' })

    expect(getBrowserPageControlMode('other-browser-session')).toBe('ask')

    unbindBrowserAgentContext('other-browser-session')
  })

  test('Given two Origins are authorized When the current Origin is set to ask Then the other Origin remains authorized', () => {
    bindBrowserAgentContext('browser-session', { tabId: 'tab-1' })
    setBrowserPageControlMode('browser-session', 'authorized')

    currentTab.url = 'https://other.example/settings?tab=1'
    bindBrowserAgentContext('browser-session', { tabId: 'tab-1' })
    setBrowserPageControlMode('browser-session', 'authorized')
    setBrowserPageControlMode('browser-session', 'ask')

    currentTab.url = 'https://example.com/account?tab=1'
    expect(getBrowserPageControlMode('browser-session')).toBe('authorized')
    expect(settings.browserPageAuthorizations).toEqual({
      'browser-session': ['https://example.com'],
    })

    unbindBrowserAgentContext('browser-session')
  })

  test('Given one Origin is authorized When the bound page changes protocol host subdomain or port Then it requires authorization again', () => {
    bindBrowserAgentContext('browser-session', { tabId: 'tab-1' })
    setBrowserPageControlMode('browser-session', 'authorized')

    for (const url of [
      'http://example.com/settings',
      'https://other.example/settings',
      'https://sub.example.com/settings',
      'https://example.com:8443/settings',
    ]) {
      currentTab.url = url
      expect(getBrowserPageControlMode('browser-session')).toBe('ask')
    }

    unbindBrowserAgentContext('browser-session')
  })

  test('Given a non HTTP(S) tab When binding Browser Context Then it is rejected', () => {
    currentTab.url = 'about:blank'

    expect(() => bindBrowserAgentContext('browser-session', { tabId: 'tab-1' })).toThrow('HTTP(S)')
  })
})
