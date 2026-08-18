import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentSessionMeta, AgentWorkspace, BrowserWorkflowSaveInput } from '@copis/shared'
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
let currentTab: { id: string; url: string; title: string; isIncognito?: boolean } = { id: 'tab-1', url: 'https://example.com/account?tab=1', title: 'Account', isIncognito: false }
const createdWebTabInputs: Array<{ url?: string; incognito?: boolean; activate?: boolean }> = []
const unavailableTabIds = new Set<string>()
const rustRecordingStarts: Array<Record<string, unknown>> = []
const promotedWorkflowTabIds: string[] = []
let lifecycleListener: ((event: { type: string; tabId: string; snapshot: { tabs: unknown[]; activeTabId: string | null } }) => void) | undefined
let cdpEventSubscriptionCount = 0
let cdpDetachSubscriptionCount = 0
let rustRecordingContent: string | undefined
const persistenceEvents: string[] = []
const writeBrowserWorkflowDraftMarkdown = mock((_workspaceId: string) => {
  persistenceEvents.push('draft')
})
const saveBrowserWorkflow = mock((input: BrowserWorkflowSaveInput) => {
  persistenceEvents.push('json')
  return {
    schemaVersion: 1 as const,
    id: input.version.workflowId,
    workspaceId: input.workspaceId,
    name: input.name,
    description: input.description,
    status: 'ready' as const,
    currentVersion: input.version.version,
    profileId: 'copis-web',
    allowedOrigins: input.allowedOrigins,
    unattendedAllowed: input.unattendedAllowed === true,
    createdAt: input.version.createdAt,
    updatedAt: input.version.createdAt,
  }
})
const promoteBrowserWorkflowDraftMarkdown = mock((_workspaceId: string, _workflowId: string) => {
  persistenceEvents.push('workflow')
})

mock.module('./agent-session-manager', () => ({ getAgentSessionMeta, updateAgentSessionMeta }))
mock.module('./settings-service', () => ({ getSettings, updateSettings }))
mock.module('./agent-workspace-manager', () => ({
  ensureAgentWorkspaceBrowserSessionPath: (_workspace: AgentWorkspace, sessionId: string) => join(uploadProjectDir, 'browser', 'agent-workspaces', sessionId),
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
  saveBrowserWorkflow,
  writeBrowserWorkflowDraftMarkdown,
  promoteBrowserWorkflowDraftMarkdown,
}))
mock.module('./rust-browser-recording-client', () => ({
  appendRustBrowserRecordingEvent: () => Promise.resolve(),
  cancelRustBrowserRecording: () => Promise.resolve(),
  finishRustBrowserRecording: () => Promise.resolve(),
  readRustBrowserRecording: () => Promise.resolve(rustRecordingContent),
  releaseRustBrowserRecording: () => Promise.resolve(),
  startRustBrowserRecording: (input: Record<string, unknown>) => {
    rustRecordingStarts.push(input)
    return Promise.resolve(undefined)
  },
}))
mock.module('./web-tab-manager', () => ({
  createWebTab: (input: { url?: string; incognito?: boolean; activate?: boolean } = {}) => {
    createdWebTabInputs.push(input)
    currentTab = { id: 'tab-2', url: input.url ?? 'https://new.example.test', title: 'New tab', isIncognito: input.incognito === true }
    return { tabs: [currentTab], activeTabId: 'tab-2' }
  },
  getWebTabState: (tabId: string) => unavailableTabIds.has(tabId) ? undefined : currentTab,
  promoteWorkflowWebTab: (tabId: string) => {
    promotedWorkflowTabIds.push(tabId)
    currentTab = { id: tabId, url: 'https://example.com/account?tab=1', title: 'Workflow failure' }
    return currentTab
  },
  sendWebTabCdpCommandInternal: (command: { method: string }) => {
    if (command.method === 'Page.getFrameTree') {
      return Promise.resolve({ frameTree: { frame: { id: 'frame-1' } } })
    }
    if (command.method === 'Page.createIsolatedWorld') {
      return Promise.resolve({ executionContextId: 1 })
    }
    return Promise.resolve(undefined)
  },
  subscribeWebTabCdpEvents: () => {
    cdpEventSubscriptionCount += 1
    return () => undefined
  },
  subscribeWebTabCdpDetach: () => {
    cdpDetachSubscriptionCount += 1
    return () => undefined
  },
  subscribeWebTabLifecycle: (listener: typeof lifecycleListener) => {
    lifecycleListener = listener
    return () => { lifecycleListener = undefined }
  },
}))

let bindBrowserAgentContext: typeof import('./browser-workflow-service')['bindBrowserAgentContext']
let unbindBrowserAgentContext: typeof import('./browser-workflow-service')['unbindBrowserAgentContext']
let assertBrowserWorkflowSessionOwner: typeof import('./browser-workflow-service')['assertBrowserWorkflowSessionOwner']
let getBrowserAgentContext: typeof import('./browser-workflow-service')['getBrowserAgentContext']
let getBrowserAgentSessionIdForTab: typeof import('./browser-workflow-service')['getBrowserAgentSessionIdForTab']
let getBrowserPageControlMode: typeof import('./browser-workflow-service')['getBrowserPageControlMode']
let setBrowserPageControlMode: typeof import('./browser-workflow-service')['setBrowserPageControlMode']
let openBrowserAgentTab: typeof import('./browser-workflow-service')['openBrowserAgentTab']
let handoffBrowserWorkflowFailure: (sessionId: string, tabId: string) => { tabId: string; url: string; title: string; incognito: boolean }
let startBrowserWorkflowRecording: typeof import('./browser-workflow-service')['startBrowserWorkflowRecording']
let stopBrowserWorkflowRecording: typeof import('./browser-workflow-service')['stopBrowserWorkflowRecording']
let submitBrowserWorkflowDraft: typeof import('./browser-workflow-service')['submitBrowserWorkflowDraft']
let approveBrowserWorkflowDraft: typeof import('./browser-workflow-service')['approveBrowserWorkflowDraft']
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
  handoffBrowserWorkflowFailure = (service as unknown as {
    handoffBrowserWorkflowFailure: (sessionId: string, tabId: string) => { tabId: string; url: string; title: string; incognito: boolean }
  }).handoffBrowserWorkflowFailure
  startBrowserWorkflowRecording = service.startBrowserWorkflowRecording
  stopBrowserWorkflowRecording = service.stopBrowserWorkflowRecording
  submitBrowserWorkflowDraft = service.submitBrowserWorkflowDraft
  approveBrowserWorkflowDraft = service.approveBrowserWorkflowDraft
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
  currentTab = { id: 'tab-1', url: 'https://example.com/account?tab=1', title: 'Account', isIncognito: false }
  createdWebTabInputs.length = 0
  unavailableTabIds.clear()
  rustRecordingStarts.length = 0
  promotedWorkflowTabIds.length = 0
  lifecycleListener = undefined
  cdpEventSubscriptionCount = 0
  cdpDetachSubscriptionCount = 0
  rustRecordingContent = undefined
  persistenceEvents.length = 0
  writeBrowserWorkflowDraftMarkdown.mockClear()
  saveBrowserWorkflow.mockClear()
  promoteBrowserWorkflowDraftMarkdown.mockClear()
  delete sessionMeta.advancedAuthorization
  delete sessionMeta.sourceAutomationId
  delete sessionMeta.sourceDelegationId
  unbindBrowserAgentContext('browser-session')
  unbindBrowserAgentContext('other-browser-session')
})

describe('Browser Agent Context 绑定', () => {
  test('Given 浏览器会话 When 开始录制 Then 将该会话的 browser 目录传给 Rust', async () => {
    bindBrowserAgentContext('browser-session', { tabId: 'tab-1' })

    await startBrowserWorkflowRecording('browser-session')

    expect(rustRecordingStarts).toHaveLength(1)
    expect(rustRecordingStarts[0]).toMatchObject({
      recordingDirectory: join(uploadProjectDir, 'browser', 'agent-workspaces', 'browser-session'),
    })

    unbindBrowserAgentContext('browser-session')
  })

  test('Given 已完成录制的 Agent 总结 When 用户确认 Workflow Then 先写 draft.md 再保存 JSON 并提升 workflow.md', async () => {
    rustRecordingContent = '{"type":"click","url":"https://example.com/account"}\n'
    bindBrowserAgentContext('browser-session', { tabId: 'tab-1' })
    await startBrowserWorkflowRecording('browser-session')
    await stopBrowserWorkflowRecording('browser-session')

    const draft = submitBrowserWorkflowDraft('browser-session', {
      schemaVersion: 1,
      start: { tabAlias: 'main', url: 'https://example.com/account', origin: 'https://example.com' },
      variables: [],
      steps: [{
        id: 'step-1',
        type: 'click',
        tabAlias: 'main',
        origin: 'https://example.com',
        target: {
          framePath: { frameIds: [] },
          strategies: [{ kind: 'id', value: 'submit' }],
          fingerprint: { tagName: 'button', visible: true, enabled: true },
        },
      }],
    })
    approveBrowserWorkflowDraft('browser-session', '提交资料')

    expect(writeBrowserWorkflowDraftMarkdown).toHaveBeenCalledWith('workspace-1', draft)
    expect(promoteBrowserWorkflowDraftMarkdown).toHaveBeenCalledWith('workspace-1', draft.workflowId)
    expect(persistenceEvents).toEqual(['draft', 'json', 'workflow'])

    unbindBrowserAgentContext('browser-session')
  })

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
      incognito: false,
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

  test('Given incognito=true When Agent opens a tab Then it uses an isolated tab and marks the result', () => {
    const result = openBrowserAgentTab('browser-session', 'https://new.example.test', true)

    expect(createdWebTabInputs.at(-1)).toEqual({ url: 'https://new.example.test', activate: true, incognito: true })
    expect(result.incognito).toBe(true)
  })

  test('Given incognito is omitted When Agent opens a tab Then it remains a normal tab', () => {
    const result = openBrowserAgentTab('browser-session', 'https://new.example.test')

    expect(createdWebTabInputs.at(-1)).toEqual({ url: 'https://new.example.test', activate: true, incognito: false })
    expect(result.incognito).toBe(false)
  })

  test('Given recording page is recreated When lifecycle emits recreated Then CDP recording is reattached on the same tab without revoking capability', async () => {
    rustRecordingContent = '{"type":"click","url":"https://example.com/account"}\n'
    bindBrowserAgentContext('browser-session', { tabId: 'tab-1' })
    const capability = issueBrowserAgentWorkerCapability({
      sessionId: 'browser-session',
      tabId: 'tab-1',
      triggeredBy: 'user',
    })
    await startBrowserWorkflowRecording('browser-session')
    const beforeSubscriptions = { cdpEvent: cdpEventSubscriptionCount, cdpDetach: cdpDetachSubscriptionCount }

    lifecycleListener?.({
      type: 'recreated',
      tabId: 'tab-1',
      snapshot: { tabs: [currentTab], activeTabId: 'tab-1' },
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(cdpEventSubscriptionCount).toBeGreaterThan(beforeSubscriptions.cdpEvent)
    expect(cdpDetachSubscriptionCount).toBeGreaterThan(beforeSubscriptions.cdpDetach)
    expect(assertBrowserAgentWorkerCapability({
      sessionId: 'browser-session',
      tabId: 'tab-1',
      token: capability.token,
    })).toEqual({ triggeredBy: 'user' })

    await stopBrowserWorkflowRecording('browser-session')
    unbindBrowserAgentContext('browser-session')
  })

  test('Given 用户运行 Workflow 的专用失败页面 When 接管现场 Then 页面成为当前 Browser Context 且当前 Worker token 跟随它', () => {
    bindBrowserAgentContext('browser-session', { tabId: 'tab-1' })
    const capability = issueBrowserAgentWorkerCapability({
      sessionId: 'browser-session',
      tabId: 'tab-1',
      triggeredBy: 'user',
    })

    const result = handoffBrowserWorkflowFailure('browser-session', 'workflow-tab')

    expect(result).toEqual({
      tabId: 'workflow-tab',
      url: 'https://example.com/account?tab=1',
      title: 'Workflow failure',
      incognito: false,
    })
    expect(promotedWorkflowTabIds).toEqual(['workflow-tab'])
    expect(getBrowserAgentContext('browser-session')).toEqual({ tabId: 'workflow-tab' })
    expect(assertBrowserAgentWorkerCapability({
      sessionId: 'browser-session',
      tabId: 'workflow-tab',
      token: capability.token,
    })).toEqual({ triggeredBy: 'user' })

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
      incognito: false,
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
