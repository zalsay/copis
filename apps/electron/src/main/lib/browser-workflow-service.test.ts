import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
const uploadFixtureDir = mkdtempSync(join(tmpdir(), 'copis-browser-upload-'))
const uploadProjectDir = join(uploadFixtureDir, 'project')
const uploadSessionDir = join(uploadFixtureDir, 'session')
const uploadFixtureFile = join(uploadProjectDir, 'contract.pdf')
const uploadOutsideFile = join(uploadFixtureDir, 'private.pdf')
mkdirSync(uploadProjectDir, { recursive: true })
mkdirSync(uploadSessionDir, { recursive: true })
writeFileSync(uploadFixtureFile, 'contract')
writeFileSync(uploadOutsideFile, 'private')
workspace.projectPath = uploadProjectDir

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
const unavailableTabIds = new Set<string>()

mock.module('./agent-session-manager', () => ({ getAgentSessionMeta, updateAgentSessionMeta }))
mock.module('./settings-service', () => ({ getSettings, updateSettings }))
mock.module('./agent-workspace-manager', () => ({
  getAgentWorkspace: () => workspace,
  getAgentWorkspaceWritableRoot: () => uploadProjectDir,
  getProjectFilesPath: () => uploadProjectDir,
  getWorkspaceAttachedDirectories: () => [],
  getWorkspaceAttachedFiles: () => [],
}))
mock.module('./config-paths', () => ({
  getAgentSessionWorkspacePath: () => uploadSessionDir,
}))
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
  createWebTab: (input: { url?: string } = {}) => {
    currentTab = { id: 'tab-2', url: input.url ?? 'https://new.example.test', title: 'New tab' }
    return { tabs: [currentTab], activeTabId: 'tab-2' }
  },
  getWebTabState: (tabId: string) => unavailableTabIds.has(tabId) ? undefined : currentTab,
  sendWebTabCdpCommandInternal: () => Promise.resolve(undefined),
  subscribeWebTabCdpEvents: () => () => undefined,
  subscribeWebTabCdpDetach: () => () => undefined,
  subscribeWebTabLifecycle: () => () => undefined,
}))

let bindBrowserAgentContext: typeof import('./browser-workflow-service')['bindBrowserAgentContext']
let unbindBrowserAgentContext: typeof import('./browser-workflow-service')['unbindBrowserAgentContext']
let assertBrowserWorkflowSessionOwner: typeof import('./browser-workflow-service')['assertBrowserWorkflowSessionOwner']
let getBrowserAgentContext: typeof import('./browser-workflow-service')['getBrowserAgentContext']
let getBrowserAgentSessionIdForTab: typeof import('./browser-workflow-service')['getBrowserAgentSessionIdForTab']
let getBrowserPageControlMode: typeof import('./browser-workflow-service')['getBrowserPageControlMode']
let setBrowserPageControlMode: typeof import('./browser-workflow-service')['setBrowserPageControlMode']
let openBrowserAgentTab: typeof import('./browser-workflow-service')['openBrowserAgentTab']
let resolveBrowserPageUploadPaths: (sessionId: string, paths: string[]) => string[]
let refreshBrowserWorkflowStatus: typeof import('./browser-workflow-service')['refreshBrowserWorkflowStatus']
let subscribeBrowserWorkflowStatus: typeof import('./browser-workflow-service')['subscribeBrowserWorkflowStatus']

beforeAll(async () => {
  const service = await import('./browser-workflow-service')
  bindBrowserAgentContext = service.bindBrowserAgentContext
  unbindBrowserAgentContext = service.unbindBrowserAgentContext
  assertBrowserWorkflowSessionOwner = service.assertBrowserWorkflowSessionOwner
  getBrowserAgentContext = service.getBrowserAgentContext
  getBrowserAgentSessionIdForTab = service.getBrowserAgentSessionIdForTab
  getBrowserPageControlMode = service.getBrowserPageControlMode
  setBrowserPageControlMode = service.setBrowserPageControlMode
  openBrowserAgentTab = service.openBrowserAgentTab
  resolveBrowserPageUploadPaths = (service as unknown as {
    resolveBrowserPageUploadPaths: (sessionId: string, paths: string[]) => string[]
  }).resolveBrowserPageUploadPaths
  refreshBrowserWorkflowStatus = service.refreshBrowserWorkflowStatus
  subscribeBrowserWorkflowStatus = service.subscribeBrowserWorkflowStatus
})

afterAll(() => {
  rmSync(uploadFixtureDir, { recursive: true, force: true })
})

beforeEach(() => {
  settings.browserPageAuthorizations = {}
  currentTab = { id: 'tab-1', url: 'https://example.com/account?tab=1', title: 'Account' }
  unavailableTabIds.clear()
  delete sessionMeta.advancedAuthorization
  delete sessionMeta.sourceAutomationId
  delete sessionMeta.sourceDelegationId
  unbindBrowserAgentContext('browser-session')
  unbindBrowserAgentContext('other-browser-session')
})

describe('Browser Agent Context 绑定', () => {
  test('Given 当前工作区文件 When Agent 上传页面文件 Then 仅解析工作区范围内的常规文件', () => {
    bindBrowserAgentContext('browser-session', { tabId: 'tab-1' })
    try {
      expect(resolveBrowserPageUploadPaths('browser-session', ['contract.pdf'])).toEqual([realpathSync(uploadFixtureFile)])
      expect(() => resolveBrowserPageUploadPaths('browser-session', [uploadOutsideFile]))
        .toThrow('当前 Agent 工作区或已附加文件')
    } finally {
      unbindBrowserAgentContext('browser-session')
    }
  })
  test('Given 新会话元数据为 plan When Browser Context 绑定成功 Then 持久化为 bypassPermissions', () => {
    bindBrowserAgentContext('browser-session', { tabId: 'tab-1' })

    expect(updateAgentSessionMeta).toHaveBeenCalledWith('browser-session', {
      permissionMode: 'bypassPermissions',
    })

    unbindBrowserAgentContext('browser-session')
  })

  test('Given BrowserPageOpenTab When opens and binds a new tab Then the same worker token follows the new tab', () => {
    bindBrowserAgentContext('browser-session', { tabId: 'tab-1' })
    const capability = issueBrowserAgentWorkerCapability({
      sessionId: 'browser-session',
      tabId: 'tab-1',
      triggeredBy: 'user',
    })

    const result = openBrowserAgentTab('browser-session', 'https://new.example.test')

    expect(result).toEqual({
      tabId: 'tab-2',
      url: 'https://new.example.test/',
      title: 'New tab',
    })
    expect(assertBrowserAgentWorkerCapability({
      sessionId: 'browser-session',
      tabId: 'tab-2',
      token: capability.token,
    })).toEqual({ triggeredBy: 'user' })
    expect(() => assertBrowserAgentWorkerCapability({
      sessionId: 'browser-session',
      tabId: 'tab-1',
      token: capability.token,
    })).toThrow(expect.objectContaining({ code: 'browser_capability_invalid' }))

    unbindBrowserAgentContext('browser-session')
  })

  test('Given an unbound Agent session When it opens its first browser tab Then the new tab becomes its Browser Context', () => {
    const capability = issueBrowserAgentWorkerCapability({
      sessionId: 'browser-session',
      triggeredBy: 'user',
    })

    const result = openBrowserAgentTab('browser-session', 'https://www.xiaohongshu.com/')

    expect(result).toEqual({
      tabId: 'tab-2',
      url: 'https://www.xiaohongshu.com/',
      title: 'New tab',
    })
    expect(getBrowserAgentContext('browser-session')).toEqual({ tabId: 'tab-2' })
    expect(assertBrowserAgentWorkerCapability({
      sessionId: 'browser-session',
      tabId: 'tab-2',
      token: capability.token,
    })).toEqual({ triggeredBy: 'user' })

    unbindBrowserAgentContext('browser-session')
  })

  test('Given the bound tab was closed When Agent opens a new tab Then it recovers with the current worker capability', () => {
    bindBrowserAgentContext('browser-session', { tabId: 'tab-1' })
    const capability = issueBrowserAgentWorkerCapability({
      sessionId: 'browser-session',
      tabId: 'tab-1',
      triggeredBy: 'user',
    })
    unavailableTabIds.add('tab-1')

    expect(getBrowserAgentContext('browser-session')).toBeUndefined()

    const result = openBrowserAgentTab('browser-session', 'https://recover.example.test/')

    expect(result.tabId).toBe('tab-2')
    expect(assertBrowserAgentWorkerCapability({
      sessionId: 'browser-session',
      tabId: 'tab-2',
      token: capability.token,
    })).toEqual({ triggeredBy: 'user' })

    unbindBrowserAgentContext('browser-session')
  })

  test('Given an Agent opens its first browser tab When the browser surface restores the active tab Then it can recover the bound session ID', () => {
    const result = openBrowserAgentTab('browser-session', 'https://www.xiaohongshu.com/')

    expect(getBrowserAgentSessionIdForTab(result.tabId)).toBe('browser-session')

    unbindBrowserAgentContext('browser-session')
  })

  test('Given an Agent opens its first browser tab When the main renderer restores its context Then the renderer claims the initially unowned binding', () => {
    const result = openBrowserAgentTab('browser-session', 'https://www.xiaohongshu.com/')

    expect(() => bindBrowserAgentContext('browser-session', { tabId: result.tabId }, 42)).not.toThrow()
    expect(() => assertBrowserWorkflowSessionOwner('browser-session', 42)).not.toThrow()

    unbindBrowserAgentContext('browser-session', 42)
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

  test('Given a user session opens Composer advanced authorization When its page has no origin grant Then the page is authorized', () => {
    sessionMeta.advancedAuthorization = true
    bindBrowserAgentContext('browser-session', { tabId: 'tab-1' })

    expect(getBrowserPageControlMode('browser-session')).toBe('authorized')

    unbindBrowserAgentContext('browser-session')
  })

  test('Given a bound page When Composer advanced authorization changes Then browser status listeners receive the effective mode', () => {
    bindBrowserAgentContext('browser-session', { tabId: 'tab-1' })
    const statuses: string[] = []
    const unsubscribe = subscribeBrowserWorkflowStatus((_sessionId, status) => {
      statuses.push(status.controlMode ?? 'ask')
    })

    sessionMeta.advancedAuthorization = true
    refreshBrowserWorkflowStatus('browser-session')

    expect(statuses).toEqual(['authorized'])

    unsubscribe()
    unbindBrowserAgentContext('browser-session')
  })

  for (const source of ['automation', 'delegation'] as const) {
    test(`Given a ${source} session has Composer advanced authorization When its page has no origin grant Then the page remains ask`, () => {
      sessionMeta.advancedAuthorization = true
      if (source === 'automation') sessionMeta.sourceAutomationId = 'automation-1'
      else sessionMeta.sourceDelegationId = 'delegation-1'
      bindBrowserAgentContext('browser-session', { tabId: 'tab-1' })

      expect(getBrowserPageControlMode('browser-session')).toBe('ask')

      unbindBrowserAgentContext('browser-session')
    })
  }

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
