import { beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import type {
  BrowserWorkflowManifest,
  BrowserWorkflowRunEvent,
  BrowserWorkflowStatus,
  BrowserWorkflowVersion,
} from '@copis/shared'

const workflowEvents: BrowserWorkflowRunEvent[] = []
const workflowStatuses: BrowserWorkflowStatus[] = []
const workflowFailureHandoffs: Array<{ sessionId: string; tabId: string }> = []
const createdTabs: Array<{ id: string; url: string; partition?: string }> = []
const scriptRuns: Array<{ targetId: string; partition?: string; scriptPath: string }> = []
const scriptIntegrityChecks: string[] = []
let workflow: { manifest: BrowserWorkflowManifest; version: BrowserWorkflowVersion }
let browserContext: { tabId: string } | undefined
let scriptResult: 'success' | 'failure' = 'success'

mock.module('./web-tab-manager', () => ({
  closeWorkflowWebTab: () => undefined,
  createWorkflowWebTab: (input: { url?: string; partition?: string } = {}) => {
    const tab = {
      id: 'workflow-tab',
      isLoading: false,
      title: 'Dashboard',
      url: input.url ?? 'https://example.com/dashboard',
      partition: input.partition,
    }
    createdTabs.push(tab)
    return tab
  },
  getWebTabCdpTargetId: () => Promise.resolve('target-1'),
  getWebTabLoadError: () => undefined,
  getWebTabState: () => ({
    id: 'workflow-tab',
    isLoading: false,
    title: 'Dashboard',
    url: 'https://example.com/dashboard',
  }),
  setWorkflowWebTabVisible: () => undefined,
  subscribeWebTabCdpDetach: () => () => undefined,
  waitForWebTabLoad: () => Promise.resolve(),
}))

mock.module('./playwright-cdp-endpoint', () => ({
  getPlaywrightCdpEndpoint: () => Promise.resolve('http://127.0.0.1:43123'),
}))
mock.module('./playwright-core-runtime', () => ({
  resolvePlaywrightCoreEntrypoint: () => '/modules/playwright-core/index.js',
}))
mock.module('./functional-module-manager', () => ({
  getFunctionalModulePath: () => '/modules/node-runtime/bin/node',
}))
mock.module('./browser-workflow-playwright-script', () => ({
  getBrowserWorkflowPlaywrightVersionPath: () => '/workflows/workflow-1/playwright/v1.mjs',
  writeBrowserWorkflowPlaywrightVersion: () => '/workflows/workflow-1/playwright/v1.mjs',
  assertBrowserWorkflowPlaywrightScriptIntegrity: (_version: unknown, scriptPath: string) => {
    scriptIntegrityChecks.push(scriptPath)
  },
}))
mock.module('./browser-workflow-playwright-executor', () => ({
  startBrowserWorkflowPlaywrightScript: (input: {
    targetId: string
    scriptPath: string
    onEvent: (event: unknown) => void
  }) => {
    scriptRuns.push({ targetId: input.targetId, scriptPath: input.scriptPath, partition: createdTabs.at(-1)?.partition })
    const promise = Promise.resolve().then(() => {
      input.onEvent({ type: 'step_started', stepId: 'step-1' })
      if (scriptResult === 'success') {
        input.onEvent({ type: 'fallback_used', stepId: 'step-1' })
        input.onEvent({ type: 'step_completed', stepId: 'step-1' })
      } else {
        input.onEvent({ type: 'error', message: '无法定位 Workflow 元素: step-1' })
        throw new Error('无法定位 Workflow 元素: step-1')
      }
    })
    return {
      promise,
      send: () => undefined,
      cancel: () => undefined,
    }
  },
}))
mock.module('./browser-workflow-service', () => ({
  getBrowserAgentContext: () => browserContext,
  getBrowserAgentWorkspaceId: () => browserContext ? 'workspace-1' : undefined,
  handoffBrowserWorkflowFailure: (sessionId: string, tabId: string) => {
    workflowFailureHandoffs.push({ sessionId, tabId })
  },
  publishBrowserWorkflowStatus: (_sessionId: string, status: BrowserWorkflowStatus) => workflowStatuses.push(status),
}))
mock.module('./automation-manager', () => ({ registerAutomationWorkflowRun: () => undefined }))
mock.module('./browser-workflow-profile-lease', () => ({ acquireBrowserWorkflowProfileLease: () => () => undefined }))
mock.module('./browser-workflow-store', () => ({
  appendBrowserWorkflowRunEvent: (_workspaceId: string, _workflowId: string, event: BrowserWorkflowRunEvent) => workflowEvents.push(event),
  getBrowserWorkflow: () => workflow,
  getBrowserWorkflowArtifactDirectory: () => '/workflows/workflow-1/artifacts/run-1',
  saveLatestBrowserWorkflowRun: () => undefined,
  writeBrowserWorkflowArtifact: () => 'artifacts/run-1/failure.json',
}))

let runBrowserWorkflow: typeof import('./browser-workflow-runner')['runBrowserWorkflow']

beforeAll(async () => {
  ;({ runBrowserWorkflow } = await import('./browser-workflow-runner'))
})

beforeEach(() => {
  workflowEvents.length = 0
  workflowStatuses.length = 0
  workflowFailureHandoffs.length = 0
  createdTabs.length = 0
  scriptRuns.length = 0
  scriptIntegrityChecks.length = 0
  browserContext = undefined
  scriptResult = 'success'
})

function createReadyWorkflow(version: BrowserWorkflowVersion): { manifest: BrowserWorkflowManifest; version: BrowserWorkflowVersion } {
  return {
    manifest: {
      schemaVersion: 1,
      id: version.workflowId,
      workspaceId: 'workspace-1',
      name: '账户自动化',
      status: 'ready',
      currentVersion: version.version,
      profileId: 'copis-web',
      allowedOrigins: ['https://example.com'],
      unattendedAllowed: true,
      createdAt: 1,
      updatedAt: 1,
    },
    version,
  }
}

function createVersion(): BrowserWorkflowVersion {
  return {
    schemaVersion: 1,
    workflowId: 'workflow-1',
    version: 1,
    start: { tabAlias: 'main', url: 'https://example.com/dashboard', origin: 'https://example.com' },
    variables: [],
    steps: [{
      id: 'step-1',
      type: 'click',
      tabAlias: 'main',
      origin: 'https://example.com',
      target: {
        framePath: { frameIds: [] },
        strategies: [{ kind: 'role', role: 'link', name: '账户' }],
        fingerprint: { tagName: 'a', accessibleName: '账户', visible: true, enabled: true },
      },
    }],
    createdAt: 1,
    createdBySessionId: 'session-1',
    approval: { status: 'approved' },
  }
}

describe('Browser Workflow 运行', () => {
  test('Given 已批准 Workflow When 运行 Then 使用 copis-web partition、精确 target 并保留 fallback 事件', async () => {
    workflow = createReadyWorkflow(createVersion())

    await expect(runBrowserWorkflow({
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      workflowId: 'workflow-1',
      source: 'automation',
    })).resolves.toMatchObject({ status: 'completed' })

    expect(createdTabs[0]?.partition).toBe('persist:copis-web')
    expect(scriptRuns).toEqual([{ targetId: 'target-1', scriptPath: '/workflows/workflow-1/playwright/v1.mjs', partition: 'persist:copis-web' }])
    expect(scriptIntegrityChecks).toEqual(['/workflows/workflow-1/playwright/v1.mjs'])
    expect(workflowEvents.some((event) => event.type === 'fallback_used' && event.stepId === 'step-1')).toBe(true)
  })

  test('Given 自动化运行的脚本失败 When 运行失败 Then 将失败页面移交给当前 Browser Agent 并保留完整失败原因', async () => {
    scriptResult = 'failure'
    workflow = createReadyWorkflow(createVersion())

    await expect(runBrowserWorkflow({
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      workflowId: 'workflow-1',
      source: 'automation',
    })).rejects.toThrow('无法定位 Workflow 元素: step-1')

    expect(workflowStatuses.at(-1)).toMatchObject({
      state: 'error',
      run: {
        status: 'failed',
        error: '无法定位 Workflow 元素: step-1',
      },
    })
    expect(workflowFailureHandoffs).toEqual([{ sessionId: 'session-1', tabId: 'workflow-tab' }])
  })

  test('Given 用户运行的 Workflow 失败 When 运行结束 Then 将失败页面移交给当前 Browser Agent', async () => {
    scriptResult = 'failure'
    browserContext = { tabId: 'browser-tab' }
    workflow = createReadyWorkflow(createVersion())

    await expect(runBrowserWorkflow({
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      workflowId: 'workflow-1',
      source: 'user',
    })).rejects.toThrow('无法定位 Workflow 元素: step-1')

    expect(workflowFailureHandoffs).toEqual([{ sessionId: 'session-1', tabId: 'workflow-tab' }])
  })
})
