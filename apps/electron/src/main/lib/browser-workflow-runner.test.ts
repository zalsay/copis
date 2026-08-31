import { beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import type {
  BrowserClickStep,
  BrowserCloseTabStep,
  BrowserManualStep,
  BrowserOpenTabStep,
  BrowserSwitchTabStep,
  BrowserWorkflowManifest,
  BrowserWorkflowRunEvent,
  BrowserWorkflowStatus,
  BrowserWorkflowVersion,
  WebTabState,
} from '@copis/shared'
import type { BrowserCdpMethod, BrowserCdpOwner, BrowserPagePort } from './browser-page-port'
import type { BrowserWorkflowPageStepInput, BrowserWorkflowPageStepResult } from './browser-workflow-page-executor'

mock.module('electron', () => ({
  app: {
    getPath: () => '/tmp/copis-test',
    isPackaged: false,
    commandLine: { appendSwitch: () => undefined },
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString(),
  },
}))

interface MockTabRecord {
  id: string
  url: string
  title: string
  isLoading: boolean
  partition?: string
  workflowOwned: boolean
}

interface MockPortRecord {
  tabId: string
  owner: BrowserCdpOwner
  generation: number
  released: boolean
  detachListeners: Set<(reason: string) => void>
  destroyListeners: Set<() => void>
}

// 追踪生命周期调用序列
const cleanupSequence: string[] = []
const createdTabs: MockTabRecord[] = []
const closedTabs: string[] = []
const visibleTabCalls: Array<{ tabId: string; visible: boolean }> = []
const acquiredPorts: Array<{ tabId: string; owner: BrowserCdpOwner; generation: number }> = []
const releasedPorts: Array<{ tabId: string; generation: number }> = []
const executedSteps: Array<{ stepId: string; type: string; tabId: string }> = []
const workflowEvents: BrowserWorkflowRunEvent[] = []
const workflowStatuses: BrowserWorkflowStatus[] = []
const workflowFailureHandoffs: Array<{ sessionId: string; tabId: string }> = []
const writtenArtifacts: Array<{ fileName: string; data: Uint8Array | string }> = []
const popupListeners = new Map<string, Set<(tab: WebTabState) => void>>()
const tabStore = new Map<string, MockTabRecord>()
const tabGenerations = new Map<string, number>()
const portStore = new Map<string, MockPortRecord[]>()

let tabIdCounter = 1
let browserContext: { tabId: string } | undefined
let workflow: { manifest: BrowserWorkflowManifest; version: BrowserWorkflowVersion }
let pageExecutorHook: ((input: BrowserWorkflowPageStepInput) => Promise<BrowserWorkflowPageStepResult> | BrowserWorkflowPageStepResult) | undefined
let screenshotBase64Data: string | undefined = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
let profileLeaseReleaseCalls = 0
let shouldThrowOnWriteArtifact = false
let acquirePortHook: ((tabId: string) => void) | undefined

function emitPopup(parentTabId: string, tab: WebTabState): void {
  const listeners = popupListeners.get(parentTabId)
  if (listeners) {
    for (const listener of Array.from(listeners)) {
      listener(tab)
    }
  }
}

function getLatestPortRecord(tabId: string): MockPortRecord | undefined {
  const records = portStore.get(tabId)
  return records ? records.at(-1) : undefined
}

function emitDetachOnTab(tabId: string, reason: string): void {
  const record = getLatestPortRecord(tabId)
  if (record && !record.released) {
    record.released = true
    for (const listener of Array.from(record.detachListeners)) {
      listener(reason)
    }
  }
}

function createMockPort(tabId: string, owner: BrowserCdpOwner): BrowserPagePort {
  const currentGen = (tabGenerations.get(tabId) ?? 0) + 1
  tabGenerations.set(tabId, currentGen)

  const record: MockPortRecord = {
    tabId,
    owner,
    generation: currentGen,
    released: false,
    detachListeners: new Set(),
    destroyListeners: new Set(),
  }
  let records = portStore.get(tabId)
  if (!records) {
    records = []
    portStore.set(tabId, records)
  }
  records.push(record)
  acquiredPorts.push({ tabId, owner, generation: currentGen })

  const port: BrowserPagePort = {
    tabId,
    owner,
    generation: currentGen,
    documentEpoch: currentGen,
    getSnapshot: () => {
      if (record.released) throw new Error('CDP lease 已失效')
      return {
        kind: 'untrusted_browser_page',
        instruction: '',
        url: tabStore.get(tabId)?.url ?? '',
        title: tabStore.get(tabId)?.title ?? '',
        text: '',
        elements: [],
        scrollX: 0,
        scrollY: 0,
        viewportWidth: 1280,
        viewportHeight: 800,
        documentWidth: 1280,
        documentHeight: 800,
      }
    },
    send: async (method: BrowserCdpMethod, _params?: Record<string, unknown>) => {
      if (record.released) throw new Error('CDP lease 已失效')
      if (method === 'Page.captureScreenshot') {
        if (screenshotBase64Data) {
          return { data: screenshotBase64Data }
        }
        throw new Error('Screenshot 失败')
      }
      return {}
    },
    onMessage: () => () => undefined,
    onDetached: (listener) => {
      record.detachListeners.add(listener)
      return () => record.detachListeners.delete(listener)
    },
    onDestroyed: (listener) => {
      record.destroyListeners.add(listener)
      return () => record.destroyListeners.delete(listener)
    },
    release: () => {
      if (!record.released) {
        record.released = true
        cleanupSequence.push('port:release')
        releasedPorts.push({ tabId, generation: currentGen })
      }
    },
  }
  return port
}

let waitForLoadHook: ((tabId: string) => void) | undefined

mock.module('./web-tab-manager', () => ({
  createWorkflowWebTab: (input: { url?: string; partition?: string } = {}) => {
    const id = `workflow-tab-${tabIdCounter++}`
    const record: MockTabRecord = {
      id,
      url: input.url ?? 'https://example.com/start',
      title: 'Workflow Tab',
      isLoading: false,
      partition: input.partition,
      workflowOwned: true,
    }
    tabStore.set(id, record)
    createdTabs.push(record)
    return {
      id: record.id,
      url: record.url,
      title: record.title,
      faviconUrl: null,
      isLoading: record.isLoading,
      isIncognito: false,
      canGoBack: false,
      canGoForward: false,
      canActivateIncognito: false,
    }
  },
  closeWorkflowWebTab: (tabId: string) => {
    const record = tabStore.get(tabId)
    if (record && record.workflowOwned) {
      cleanupSequence.push('tab:close')
      closedTabs.push(tabId)
      tabStore.delete(tabId)
    }
  },
  getWebTabState: (tabId: string) => {
    const record = tabStore.get(tabId)
    if (!record) return undefined
    return {
      id: record.id,
      url: record.url,
      title: record.title,
      faviconUrl: null,
      isLoading: record.isLoading,
      isIncognito: false,
      canGoBack: false,
      canGoForward: false,
      canActivateIncognito: false,
    }
  },
  getWebTabLoadError: () => undefined,
  setWorkflowWebTabVisible: (tabId: string, visible: boolean) => {
    visibleTabCalls.push({ tabId, visible })
  },
  waitForWebTabLoad: (tabId: string, _timeoutMs: number, signal?: AbortSignal) => {
    if (signal?.aborted) return Promise.reject(new Error('Browser Workflow 已取消'))
    waitForLoadHook?.(tabId)
    if (signal?.aborted) return Promise.reject(new Error('Browser Workflow 已取消'))
    return Promise.resolve()
  },
  navigateWebTab: (input: { tabId: string; url: string }) => {
    const record = tabStore.get(input.tabId)
    if (record) record.url = input.url
  },
  subscribeWorkflowWebTabOpened: (parentTabId: string, listener: (tab: WebTabState) => void) => {
    let set = popupListeners.get(parentTabId)
    if (!set) {
      set = new Set()
      popupListeners.set(parentTabId, set)
    }
    set.add(listener)
    return () => {
      const current = popupListeners.get(parentTabId)
      if (current) {
        current.delete(listener)
        if (current.size === 0) popupListeners.delete(parentTabId)
      }
    }
  },
  acquireWebTabPagePort: (tabId: string, owner: BrowserCdpOwner) => {
    acquirePortHook?.(tabId)
    return createMockPort(tabId, owner)
  },
}))

mock.module('./browser-workflow-page-executor', () => ({
  createBrowserWorkflowPageExecutor: (_runtime: unknown) => ({
    execute: async (input: BrowserWorkflowPageStepInput) => {
      executedSteps.push({ stepId: input.step.id, type: input.step.type, tabId: input.tabId })
      if (pageExecutorHook) {
        return pageExecutorHook(input)
      }
      return { fallbackUsed: false }
    },
  }),
}))

mock.module('./browser-workflow-service', () => ({
  getBrowserAgentContext: () => browserContext,
  getBrowserAgentWorkspaceId: () => (browserContext ? 'workspace-1' : undefined),
  handoffBrowserWorkflowFailure: (sessionId: string, tabId: string) => {
    workflowFailureHandoffs.push({ sessionId, tabId })
    const record = tabStore.get(tabId)
    if (record) {
      record.workflowOwned = false
    }
    return { tabId, url: record?.url ?? '', title: record?.title ?? '', incognito: false }
  },
  publishBrowserWorkflowStatus: (_sessionId: string, status: BrowserWorkflowStatus) => {
    workflowStatuses.push(status)
  },
}))

mock.module('./automation-manager', () => ({
  registerAutomationWorkflowRun: () => undefined,
}))

mock.module('./browser-workflow-profile-lease', () => ({
  acquireBrowserWorkflowProfileLease: () => {
    return () => {
      cleanupSequence.push('profile:release')
      profileLeaseReleaseCalls++
    }
  },
}))

let shouldThrowOnAppendEvent = false

mock.module('./browser-workflow-store', () => ({
  appendBrowserWorkflowRunEvent: (_workspaceId: string, _workflowId: string, event: BrowserWorkflowRunEvent) => {
    if (shouldThrowOnAppendEvent) {
      throw new Error('模拟初始化持久化异常')
    }
    workflowEvents.push(event)
  },
  getBrowserWorkflow: () => workflow,
  getBrowserWorkflowArtifactDirectory: () => '/workflows/workflow-1/artifacts/run-1',
  saveLatestBrowserWorkflowRun: () => undefined,
  writeBrowserWorkflowArtifact: (
    _workspaceId: string,
    _workflowId: string,
    runId: string,
    fileName: string,
    data: Uint8Array | string,
  ) => {
    if (shouldThrowOnWriteArtifact) {
      throw new Error('磁盘空间不足无法写入产物')
    }
    writtenArtifacts.push({ fileName, data })
    return `artifacts/${runId}/${fileName}`
  },
}))

let runBrowserWorkflow: typeof import('./browser-workflow-runner')['runBrowserWorkflow']
let continueBrowserWorkflowRun: typeof import('./browser-workflow-runner')['continueBrowserWorkflowRun']
let stopBrowserWorkflowRun: typeof import('./browser-workflow-runner')['stopBrowserWorkflowRun']

beforeAll(async () => {
  const runnerModule = await import('./browser-workflow-runner')
  runBrowserWorkflow = runnerModule.runBrowserWorkflow
  continueBrowserWorkflowRun = runnerModule.continueBrowserWorkflowRun
  stopBrowserWorkflowRun = runnerModule.stopBrowserWorkflowRun
})

beforeEach(() => {
  cleanupSequence.length = 0
  createdTabs.length = 0
  closedTabs.length = 0
  visibleTabCalls.length = 0
  acquiredPorts.length = 0
  releasedPorts.length = 0
  executedSteps.length = 0
  workflowEvents.length = 0
  workflowStatuses.length = 0
  workflowFailureHandoffs.length = 0
  writtenArtifacts.length = 0
  popupListeners.clear()
  tabStore.clear()
  tabGenerations.clear()
  portStore.clear()
  tabIdCounter = 1
  browserContext = undefined
  pageExecutorHook = undefined
  screenshotBase64Data = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
  profileLeaseReleaseCalls = 0
  shouldThrowOnWriteArtifact = false
  shouldThrowOnAppendEvent = false
  waitForLoadHook = undefined
  acquirePortHook = undefined
})

async function waitUntilStatus(
  predicate: (status: BrowserWorkflowStatus) => boolean,
  timeoutMs = 1500,
): Promise<BrowserWorkflowStatus> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const latest = workflowStatuses.at(-1)
    if (latest && predicate(latest)) {
      return latest
    }
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error(`等待状态超时: ${workflowStatuses.at(-1)?.state}`)
}

function createReadyWorkflow(version: BrowserWorkflowVersion): {
  manifest: BrowserWorkflowManifest
  version: BrowserWorkflowVersion
} {
  return {
    manifest: {
      schemaVersion: 1,
      id: version.workflowId,
      workspaceId: 'workspace-1',
      name: '自动化流程',
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

function createBasicVersion(): BrowserWorkflowVersion {
  return {
    schemaVersion: 1,
    workflowId: 'workflow-1',
    version: 1,
    start: { tabAlias: 'main', url: 'https://example.com/dashboard', origin: 'https://example.com' },
    variables: [],
    steps: [
      {
        id: 'step-1',
        type: 'click',
        tabAlias: 'main',
        origin: 'https://example.com',
        target: {
          framePath: { frameIds: [] },
          strategies: [{ kind: 'role', role: 'link', name: '账户' }],
          fingerprint: { tagName: 'a', accessibleName: '账户', visible: true, enabled: true },
        },
      } satisfies BrowserClickStep,
    ],
    createdAt: 1,
    createdBySessionId: 'session-1',
    approval: { status: 'approved' },
  }
}

describe('Browser Workflow Runner (确定性 CDP 主进程编排)', () => {
  test('Given 已批准 Workflow When 运行 Then 创建 workflow-owned 起始页、获取 workflow lease 并通过 page executor 逐步执行', async () => {
    workflow = createReadyWorkflow(createBasicVersion())
    pageExecutorHook = async (input) => {
      if (input.step.id === 'step-1') {
        return { fallbackUsed: true }
      }
      return { fallbackUsed: false }
    }

    const summary = await runBrowserWorkflow({
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      workflowId: 'workflow-1',
      source: 'automation',
    })

    expect(summary.status).toBe('completed')
    expect(createdTabs[0]).toMatchObject({
      id: 'workflow-tab-1',
      url: 'https://example.com/dashboard',
      partition: 'persist:copis-web',
    })
    expect(acquiredPorts).toEqual([{ tabId: 'workflow-tab-1', owner: 'workflow', generation: 1 }])
    expect(executedSteps).toEqual([{ stepId: 'step-1', type: 'click', tabId: 'workflow-tab-1' }])
    expect(releasedPorts).toEqual([{ tabId: 'workflow-tab-1', generation: 1 }])
    expect(closedTabs).toEqual(['workflow-tab-1'])
    expect(profileLeaseReleaseCalls).toBe(1)

    // 事件校验
    expect(workflowEvents.some((e) => e.type === 'step_started' && e.stepId === 'step-1')).toBe(true)
    expect(workflowEvents.some((e) => e.type === 'fallback_used' && e.stepId === 'step-1')).toBe(true)
    expect(workflowEvents.some((e) => e.type === 'step_completed' && e.stepId === 'step-1')).toBe(true)
    expect(workflowEvents.some((e) => e.type === 'completed')).toBe(true)
  })

  test('Given openTab/switchTab/closeTab 步骤 When 运行 Then alias 只指向 workflow-owned 页签并按关闭及完成清理', async () => {
    const version: BrowserWorkflowVersion = {
      schemaVersion: 1,
      workflowId: 'workflow-1',
      version: 1,
      start: { tabAlias: 'main', url: 'https://example.com/start', origin: 'https://example.com' },
      variables: [],
      steps: [
        {
          id: 'step-open',
          type: 'openTab',
          tabAlias: 'main',
          newTabAlias: 'details',
          url: 'https://example.com/details',
          origin: 'https://example.com',
        } satisfies BrowserOpenTabStep,
        {
          id: 'step-click-details',
          type: 'click',
          tabAlias: 'details',
          origin: 'https://example.com',
          target: {
            framePath: { frameIds: [] },
            strategies: [{ kind: 'id', value: 'btn' }],
            fingerprint: { tagName: 'button', accessibleName: '确定', visible: true, enabled: true },
          },
        } satisfies BrowserClickStep,
        {
          id: 'step-switch-main',
          type: 'switchTab',
          tabAlias: 'details',
          targetTabAlias: 'main',
          origin: 'https://example.com',
        } satisfies BrowserSwitchTabStep,
        {
          id: 'step-close-details',
          type: 'closeTab',
          tabAlias: 'main',
          targetTabAlias: 'details',
          origin: 'https://example.com',
        } satisfies BrowserCloseTabStep,
      ],
      createdAt: 1,
      createdBySessionId: 'session-1',
      approval: { status: 'approved' },
    }
    workflow = createReadyWorkflow(version)

    const summary = await runBrowserWorkflow({
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      workflowId: 'workflow-1',
      source: 'automation',
    })

    expect(summary.status).toBe('completed')
    expect(createdTabs.length).toBe(2)
    expect(createdTabs[1]?.url).toBe('https://example.com/details')
    expect(executedSteps).toEqual([{ stepId: 'step-click-details', type: 'click', tabId: 'workflow-tab-2' }])
    // details tab was closed in step-close-details, main tab closed on finish
    expect(closedTabs).toEqual(['workflow-tab-2', 'workflow-tab-1'])
  })

  test('Given openTab 重复别名或访问未知/关闭后别名 When 运行 Then 抛出错误并中止', async () => {
    const versionDuplicate: BrowserWorkflowVersion = {
      schemaVersion: 1,
      workflowId: 'workflow-1',
      version: 1,
      start: { tabAlias: 'main', url: 'https://example.com/start', origin: 'https://example.com' },
      variables: [],
      steps: [
        {
          id: 'step-open-dup',
          type: 'openTab',
          tabAlias: 'main',
          newTabAlias: 'main', // duplicate of start alias
          origin: 'https://example.com',
        } satisfies BrowserOpenTabStep,
      ],
      createdAt: 1,
      createdBySessionId: 'session-1',
      approval: { status: 'approved' },
    }
    workflow = createReadyWorkflow(versionDuplicate)

    await expect(
      runBrowserWorkflow({
        workspaceId: 'workspace-1',
        sessionId: 'session-1',
        workflowId: 'workflow-1',
        source: 'automation',
      }),
    ).rejects.toThrow('页签别名')
  })

  test('Given openTab 源 alias 不存在 When 运行 Then 在创建任何新页签前抛出找不到 alias', async () => {
    const version: BrowserWorkflowVersion = {
      schemaVersion: 1,
      workflowId: 'workflow-1',
      version: 1,
      start: { tabAlias: 'main', url: 'https://example.com/start', origin: 'https://example.com' },
      variables: [],
      steps: [
        {
          id: 'step-open-invalid-src',
          type: 'openTab',
          tabAlias: 'unknown-tab',
          newTabAlias: 'details',
          url: 'https://example.com/details',
          origin: 'https://example.com',
        } satisfies BrowserOpenTabStep,
      ],
      createdAt: 1,
      createdBySessionId: 'session-1',
      approval: { status: 'approved' },
    }
    workflow = createReadyWorkflow(version)

    await expect(
      runBrowserWorkflow({
        workspaceId: 'workspace-1',
        sessionId: 'session-1',
        workflowId: 'workflow-1',
        source: 'automation',
      }),
    ).rejects.toThrow('找不到页签别名: unknown-tab')

    // 确认只创建了起始页，未创建任何新页签
    expect(createdTabs.length).toBe(1)
  })

  test('Given openTab 源页签已处于 detached 状态 When 运行 Then 先 paused，continue 后仅创建一个新页签并完成', async () => {
    const version: BrowserWorkflowVersion = {
      schemaVersion: 1,
      workflowId: 'workflow-1',
      version: 1,
      start: { tabAlias: 'main', url: 'https://example.com/start', origin: 'https://example.com' },
      variables: [],
      steps: [
        {
          id: 'step-open',
          type: 'openTab',
          tabAlias: 'main',
          newTabAlias: 'details',
          url: 'https://example.com/details',
          origin: 'https://example.com',
        } satisfies BrowserOpenTabStep,
      ],
      createdAt: 1,
      createdBySessionId: 'session-1',
      approval: { status: 'approved' },
    }
    workflow = createReadyWorkflow(version)

    let initialLoadDone = false
    waitForLoadHook = (tabId) => {
      if (tabId === 'workflow-tab-1' && !initialLoadDone) {
        initialLoadDone = true
        emitDetachOnTab('workflow-tab-1', 'openTab 执行前源页签断开')
      }
    }

    const runPromise = runBrowserWorkflow({
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      workflowId: 'workflow-1',
      source: 'automation',
    })

    await waitUntilStatus((s) => s.state === 'paused_cdp_detached')
    continueBrowserWorkflowRun('session-1')

    const summary = await runPromise
    expect(summary.status).toBe('completed')
    // 总共创建 2 个页签（起始页 + 1 个 details 页签），没有重复创建
    expect(createdTabs.length).toBe(2)
  })

  // === 修复轮次 4 Item B: openTab 中途 detach 回滚与延迟 commit ===
  test('Given openTab 创建新页签后 waitForLoad 期间源页签触发 detach When pause 并 continue Then 回滚未完成页签并重试成功，无重复 alias 且仅保留一个成功页签', async () => {
    const version: BrowserWorkflowVersion = {
      schemaVersion: 1,
      workflowId: 'workflow-1',
      version: 1,
      start: { tabAlias: 'main', url: 'https://example.com/start', origin: 'https://example.com' },
      variables: [],
      steps: [
        {
          id: 'step-open',
          type: 'openTab',
          tabAlias: 'main',
          newTabAlias: 'details',
          url: 'https://example.com/details',
          origin: 'https://example.com',
        } satisfies BrowserOpenTabStep,
        {
          id: 'step-click-details',
          type: 'click',
          tabAlias: 'details',
          origin: 'https://example.com',
          target: {
            framePath: { frameIds: [] },
            strategies: [{ kind: 'id', value: 'btn' }],
            fingerprint: { tagName: 'button', accessibleName: '确定', visible: true, enabled: true },
          },
        } satisfies BrowserClickStep,
      ],
      createdAt: 1,
      createdBySessionId: 'session-1',
      approval: { status: 'approved' },
    }
    workflow = createReadyWorkflow(version)

    let openTabAttempts = 0
    waitForLoadHook = (tabId) => {
      if (tabId.startsWith('workflow-tab-') && tabId !== 'workflow-tab-1') {
        openTabAttempts++
        if (openTabAttempts === 1) {
          // 在第二次新页签 waitForLoad 期间触发源页签 workflow-tab-1 detach
          emitDetachOnTab('workflow-tab-1', 'openTab load 期间源页签断开')
        }
      }
    }

    const runPromise = runBrowserWorkflow({
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      workflowId: 'workflow-1',
      source: 'automation',
    })

    await waitUntilStatus((s) => s.state === 'paused_cdp_detached')
    continueBrowserWorkflowRun('session-1')

    const summary = await runPromise
    expect(summary.status).toBe('completed')
    expect(openTabAttempts).toBe(2)
    // 首次未完成的新页签 (workflow-tab-2) 必须已被关闭清理
    expect(closedTabs).toContain('workflow-tab-2')
    // 最终执行了 details 上的 click
    expect(executedSteps).toEqual([{ stepId: 'step-click-details', type: 'click', tabId: 'workflow-tab-3' }])
  })

  test('Given click.expect.newTab When click 执行 Then 监听父页签 popup、获取新 lease 并注册 alias', async () => {
    const version: BrowserWorkflowVersion = {
      schemaVersion: 1,
      workflowId: 'workflow-1',
      version: 1,
      start: { tabAlias: 'main', url: 'https://example.com/start', origin: 'https://example.com' },
      variables: [],
      steps: [
        {
          id: 'step-click-popup',
          type: 'click',
          tabAlias: 'main',
          origin: 'https://example.com',
          target: {
            framePath: { frameIds: [] },
            strategies: [{ kind: 'id', value: 'popup-btn' }],
            fingerprint: { tagName: 'a', accessibleName: '弹窗', visible: true, enabled: true },
          },
          expect: {
            type: 'newTab',
            tabAlias: 'popupTab',
          },
        } satisfies BrowserClickStep,
        {
          id: 'step-click-in-popup',
          type: 'click',
          tabAlias: 'popupTab',
          origin: 'https://example.com',
          target: {
            framePath: { frameIds: [] },
            strategies: [{ kind: 'id', value: 'inner-btn' }],
            fingerprint: { tagName: 'button', accessibleName: '提交', visible: true, enabled: true },
          },
        } satisfies BrowserClickStep,
      ],
      createdAt: 1,
      createdBySessionId: 'session-1',
      approval: { status: 'approved' },
    }
    workflow = createReadyWorkflow(version)

    pageExecutorHook = async (input) => {
      if (input.step.id === 'step-click-popup') {
        // 模拟由父 tab workflow-tab-1 弹出的新页签
        const popupRecord: MockTabRecord = {
          id: 'workflow-tab-2',
          url: 'https://example.com/popup',
          title: 'Popup Page',
          isLoading: false,
          partition: 'persist:copis-web',
          workflowOwned: true,
        }
        tabStore.set(popupRecord.id, popupRecord)
        createdTabs.push(popupRecord)
        emitPopup('workflow-tab-1', {
          id: popupRecord.id,
          url: popupRecord.url,
          title: popupRecord.title,
          faviconUrl: null,
          isLoading: false,
          isIncognito: false,
          canGoBack: false,
          canGoForward: false,
          canActivateIncognito: false,
        })
      }
      return { fallbackUsed: false }
    }

    const summary = await runBrowserWorkflow({
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      workflowId: 'workflow-1',
      source: 'automation',
    })

    expect(summary.status).toBe('completed')
    expect(executedSteps).toEqual([
      { stepId: 'step-click-popup', type: 'click', tabId: 'workflow-tab-1' },
      { stepId: 'step-click-in-popup', type: 'click', tabId: 'workflow-tab-2' },
    ])
    expect(acquiredPorts.some((p) => p.tabId === 'workflow-tab-2' && p.owner === 'workflow')).toBe(true)
  })

  test('Given click.expect.newTab When popup 来自其他父页签 Then 不登记并超时失败', async () => {
    const version: BrowserWorkflowVersion = {
      schemaVersion: 1,
      workflowId: 'workflow-1',
      version: 1,
      start: { tabAlias: 'main', url: 'https://example.com/start', origin: 'https://example.com' },
      variables: [],
      steps: [
        {
          id: 'step-click-popup',
          type: 'click',
          tabAlias: 'main',
          origin: 'https://example.com',
          timeoutMs: 300,
          target: {
            framePath: { frameIds: [] },
            strategies: [{ kind: 'id', value: 'popup-btn' }],
            fingerprint: { tagName: 'a', accessibleName: '弹窗', visible: true, enabled: true },
          },
          expect: {
            type: 'newTab',
            tabAlias: 'popupTab',
          },
        } satisfies BrowserClickStep,
      ],
      createdAt: 1,
      createdBySessionId: 'session-1',
      approval: { status: 'approved' },
    }
    workflow = createReadyWorkflow(version)

    pageExecutorHook = async () => {
      // 模拟普通页签或错误父页签发出的 popup
      emitPopup('other-parent-tab', {
        id: 'unrelated-tab',
        url: 'https://example.com/unrelated',
        title: 'Unrelated',
        faviconUrl: null,
        isLoading: false,
        isIncognito: false,
        canGoBack: false,
        canGoForward: false,
        canActivateIncognito: false,
      })
      return { fallbackUsed: false }
    }

    await expect(
      runBrowserWorkflow({
        workspaceId: 'workspace-1',
        sessionId: 'session-1',
        workflowId: 'workflow-1',
        source: 'automation',
      }),
    ).rejects.toThrow(/新页签|超时/)

    // 确认超时后 listener 已清理
    expect(popupListeners.get('workflow-tab-1')).toBeUndefined()
  })

  test('Given click.expect.newTab 且 executor 挂起等待 When popup 超时 Then 中止 executor 并清理所有监听器且稳定抛出超时错误', async () => {
    const version: BrowserWorkflowVersion = {
      schemaVersion: 1,
      workflowId: 'workflow-1',
      version: 1,
      start: { tabAlias: 'main', url: 'https://example.com/start', origin: 'https://example.com' },
      variables: [],
      steps: [
        {
          id: 'step-click-popup',
          type: 'click',
          tabAlias: 'main',
          origin: 'https://example.com',
          timeoutMs: 50,
          target: {
            framePath: { frameIds: [] },
            strategies: [{ kind: 'id', value: 'popup-btn' }],
            fingerprint: { tagName: 'a', accessibleName: '弹窗', visible: true, enabled: true },
          },
          expect: {
            type: 'newTab',
            tabAlias: 'popupTab',
          },
        } satisfies BrowserClickStep,
      ],
      createdAt: 1,
      createdBySessionId: 'session-1',
      approval: { status: 'approved' },
    }
    workflow = createReadyWorkflow(version)

    let executorSignalAborted = false
    pageExecutorHook = async (input) => {
      return new Promise<BrowserWorkflowPageStepResult>((_, reject) => {
        input.signal.addEventListener('abort', () => {
          executorSignalAborted = true
          reject(new Error('Browser Workflow 已取消'))
        })
      })
    }

    await expect(
      runBrowserWorkflow({
        workspaceId: 'workspace-1',
        sessionId: 'session-1',
        workflowId: 'workflow-1',
        source: 'automation',
      }),
    ).rejects.toThrow('Workflow 新页签等待超时')

    expect(executorSignalAborted).toBe(true)
    expect(popupListeners.get('workflow-tab-1')).toBeUndefined()
  })

  // === 修复轮次 4 Item C: Popup 外部 abort & 不等待永不 settle 的 executor ===
  test('Given click.expect.newTab 且 executor 返回永不 settle 的 Promise When 外部 controller abort Then run 在短时间内以 cancelled 结束且零 unhandled rejection', async () => {
    const version: BrowserWorkflowVersion = {
      schemaVersion: 1,
      workflowId: 'workflow-1',
      version: 1,
      start: { tabAlias: 'main', url: 'https://example.com/start', origin: 'https://example.com' },
      variables: [],
      steps: [
        {
          id: 'step-click-popup',
          type: 'click',
          tabAlias: 'main',
          origin: 'https://example.com',
          timeoutMs: 10_000,
          target: {
            framePath: { frameIds: [] },
            strategies: [{ kind: 'id', value: 'popup-btn' }],
            fingerprint: { tagName: 'a', accessibleName: '弹窗', visible: true, enabled: true },
          },
          expect: {
            type: 'newTab',
            tabAlias: 'popupTab',
          },
        } satisfies BrowserClickStep,
      ],
      createdAt: 1,
      createdBySessionId: 'session-1',
      approval: { status: 'approved' },
    }
    workflow = createReadyWorkflow(version)

    let executorStartedResolve: (() => void) | undefined
    const executorStartedPromise = new Promise<void>((r) => {
      executorStartedResolve = r
    })

    pageExecutorHook = async () => {
      executorStartedResolve?.()
      // 返回永不 settle 的 Promise
      return new Promise<BrowserWorkflowPageStepResult>(() => {})
    }

    const controller = new AbortController()
    const startTime = Date.now()
    const runPromise = runBrowserWorkflow(
      {
        workspaceId: 'workspace-1',
        sessionId: 'session-1',
        workflowId: 'workflow-1',
        source: 'automation',
      },
      controller.signal,
    )

    await executorStartedPromise
    controller.abort()

    const summary = await runPromise
    const elapsed = Date.now() - startTime

    expect(summary.status).toBe('cancelled')
    expect(elapsed).toBeLessThan(500)
    expect(popupListeners.get('workflow-tab-1')).toBeUndefined()
  })

  test('Given click.expect.newTab 成功且 newTab 已登记 When parent 随后触发 detach Then step 成功完成且不重复点击或报错，未来使用 parent 时才 pause/reacquire', async () => {
    const version: BrowserWorkflowVersion = {
      schemaVersion: 1,
      workflowId: 'workflow-1',
      version: 1,
      start: { tabAlias: 'main', url: 'https://example.com/start', origin: 'https://example.com' },
      variables: [],
      steps: [
        {
          id: 'step-click-popup',
          type: 'click',
          tabAlias: 'main',
          origin: 'https://example.com',
          target: {
            framePath: { frameIds: [] },
            strategies: [{ kind: 'id', value: 'popup-btn' }],
            fingerprint: { tagName: 'a', accessibleName: '弹窗', visible: true, enabled: true },
          },
          expect: {
            type: 'newTab',
            tabAlias: 'popupTab',
          },
        } satisfies BrowserClickStep,
        {
          id: 'step-click-in-popup',
          type: 'click',
          tabAlias: 'popupTab',
          origin: 'https://example.com',
          target: {
            framePath: { frameIds: [] },
            strategies: [{ kind: 'id', value: 'inner-btn' }],
            fingerprint: { tagName: 'button', accessibleName: '提交', visible: true, enabled: true },
          },
        } satisfies BrowserClickStep,
        {
          id: 'step-click-main-again',
          type: 'click',
          tabAlias: 'main',
          origin: 'https://example.com',
          target: {
            framePath: { frameIds: [] },
            strategies: [{ kind: 'id', value: 'main-refresh' }],
            fingerprint: { tagName: 'button', accessibleName: '刷新', visible: true, enabled: true },
          },
        } satisfies BrowserClickStep,
      ],
      createdAt: 1,
      createdBySessionId: 'session-1',
      approval: { status: 'approved' },
    }
    workflow = createReadyWorkflow(version)

    pageExecutorHook = async (input) => {
      if (input.step.id === 'step-click-popup') {
        const popupRecord: MockTabRecord = {
          id: 'workflow-tab-2',
          url: 'https://example.com/popup',
          title: 'Popup Page',
          isLoading: false,
          partition: 'persist:copis-web',
          workflowOwned: true,
        }
        tabStore.set(popupRecord.id, popupRecord)
        createdTabs.push(popupRecord)
        emitPopup('workflow-tab-1', {
          id: popupRecord.id,
          url: popupRecord.url,
          title: popupRecord.title,
          faviconUrl: null,
          isLoading: false,
          isIncognito: false,
          canGoBack: false,
          canGoForward: false,
          canActivateIncognito: false,
        })
      } else if (input.step.id === 'step-click-in-popup') {
        // popupTab 执行时，父页签 workflow-tab-1 触发 detach
        emitDetachOnTab('workflow-tab-1', '父页签在弹窗后断开')
      }
      return { fallbackUsed: false }
    }

    const runPromise = runBrowserWorkflow({
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      workflowId: 'workflow-1',
      source: 'automation',
    })

    // step-click-popup 与 step-click-in-popup 顺利执行，直到 step-click-main-again 发现 main detach 并 pause
    await waitUntilStatus((s) => s.state === 'paused_cdp_detached')
    continueBrowserWorkflowRun('session-1')

    const summary = await runPromise
    expect(summary.status).toBe('completed')
    // click-popup 仅执行一次，没有被重复点击，main 重新 acquire 后完成
    expect(executedSteps).toEqual([
      { stepId: 'step-click-popup', type: 'click', tabId: 'workflow-tab-1' },
      { stepId: 'step-click-in-popup', type: 'click', tabId: 'workflow-tab-2' },
      { stepId: 'step-click-main-again', type: 'click', tabId: 'workflow-tab-1' },
    ])
  })

  test('Given click.expect.newTab 在 outcome 完成前 parent 触发 detach When pause 并 continue Then 回滚未完成 popup 并在重试时成功', async () => {
    const version: BrowserWorkflowVersion = {
      schemaVersion: 1,
      workflowId: 'workflow-1',
      version: 1,
      start: { tabAlias: 'main', url: 'https://example.com/start', origin: 'https://example.com' },
      variables: [],
      steps: [
        {
          id: 'step-click-popup',
          type: 'click',
          tabAlias: 'main',
          origin: 'https://example.com',
          target: {
            framePath: { frameIds: [] },
            strategies: [{ kind: 'id', value: 'popup-btn' }],
            fingerprint: { tagName: 'a', accessibleName: '弹窗', visible: true, enabled: true },
          },
          expect: {
            type: 'newTab',
            tabAlias: 'popupTab',
          },
        } satisfies BrowserClickStep,
      ],
      createdAt: 1,
      createdBySessionId: 'session-1',
      approval: { status: 'approved' },
    }
    workflow = createReadyWorkflow(version)

    let clickAttempts = 0
    pageExecutorHook = async (input) => {
      if (input.step.id === 'step-click-popup') {
        clickAttempts++
        const popupRecord: MockTabRecord = {
          id: `workflow-tab-${clickAttempts + 1}`,
          url: 'https://example.com/popup',
          title: 'Popup Page',
          isLoading: false,
          partition: 'persist:copis-web',
          workflowOwned: true,
        }
        tabStore.set(popupRecord.id, popupRecord)
        createdTabs.push(popupRecord)
        emitPopup('workflow-tab-1', {
          id: popupRecord.id,
          url: popupRecord.url,
          title: popupRecord.title,
          faviconUrl: null,
          isLoading: false,
          isIncognito: false,
          canGoBack: false,
          canGoForward: false,
          canActivateIncognito: false,
        })

        if (clickAttempts === 1) {
          // 首次在 click 阶段 detach
          emitDetachOnTab('workflow-tab-1', 'click 执行中 parent detach')
          throw new Error('CDP lease 已失效')
        }
      }
      return { fallbackUsed: false }
    }

    const runPromise = runBrowserWorkflow({
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      workflowId: 'workflow-1',
      source: 'automation',
    })

    await waitUntilStatus((s) => s.state === 'paused_cdp_detached')
    continueBrowserWorkflowRun('session-1')

    const summary = await runPromise
    expect(summary.status).toBe('completed')
    expect(clickAttempts).toBe(2)
    // 首次失败的 popup 被关闭清理，重试成功的新 popup 正常存在
    expect(closedTabs).toContain('workflow-tab-2')
  })

  test('Given click 触发 popup 后 pageExecutor 发生错误 When 步骤失败 Then popup 被立即清理且不遗留孤儿页签', async () => {
    const version: BrowserWorkflowVersion = {
      schemaVersion: 1,
      workflowId: 'workflow-1',
      version: 1,
      start: { tabAlias: 'main', url: 'https://example.com/start', origin: 'https://example.com' },
      variables: [],
      steps: [
        {
          id: 'step-click-fail',
          type: 'click',
          tabAlias: 'main',
          origin: 'https://example.com',
          target: {
            framePath: { frameIds: [] },
            strategies: [{ kind: 'id', value: 'popup-btn' }],
            fingerprint: { tagName: 'a', accessibleName: '弹窗', visible: true, enabled: true },
          },
          expect: {
            type: 'newTab',
            tabAlias: 'popupTab',
          },
        } satisfies BrowserClickStep,
      ],
      createdAt: 1,
      createdBySessionId: 'session-1',
      approval: { status: 'approved' },
    }
    workflow = createReadyWorkflow(version)

    pageExecutorHook = async () => {
      // 弹窗出现
      const popupRecord: MockTabRecord = {
        id: 'workflow-tab-2',
        url: 'https://example.com/popup',
        title: 'Popup Page',
        isLoading: false,
        partition: 'persist:copis-web',
        workflowOwned: true,
      }
      tabStore.set(popupRecord.id, popupRecord)
      createdTabs.push(popupRecord)
      emitPopup('workflow-tab-1', {
        id: popupRecord.id,
        url: popupRecord.url,
        title: popupRecord.title,
        faviconUrl: null,
        isLoading: false,
        isIncognito: false,
        canGoBack: false,
        canGoForward: false,
        canActivateIncognito: false,
      })
      // 但随后点击执行抛错
      throw new Error('点击后页面抛出未知异常')
    }

    await expect(
      runBrowserWorkflow({
        workspaceId: 'workspace-1',
        sessionId: 'session-1',
        workflowId: 'workflow-1',
        source: 'automation',
      }),
    ).rejects.toThrow('点击后页面抛出未知异常')

    // 确认弹窗已被关闭清理，未成为孤儿
    expect(closedTabs).toContain('workflow-tab-2')
  })

  test('Given manual 步骤 When 执行 Then 显示页签并发布 waiting_user，continue 后隐藏并继续', async () => {
    const version: BrowserWorkflowVersion = {
      schemaVersion: 1,
      workflowId: 'workflow-1',
      version: 1,
      start: { tabAlias: 'main', url: 'https://example.com/start', origin: 'https://example.com' },
      variables: [],
      steps: [
        {
          id: 'step-manual',
          type: 'manual',
          tabAlias: 'main',
          origin: 'https://example.com',
          reason: 'captcha',
          instruction: '请手动完成验证码',
        } satisfies BrowserManualStep,
        {
          id: 'step-after-manual',
          type: 'click',
          tabAlias: 'main',
          origin: 'https://example.com',
          target: {
            framePath: { frameIds: [] },
            strategies: [{ kind: 'id', value: 'submit' }],
            fingerprint: { tagName: 'button', accessibleName: '提交', visible: true, enabled: true },
          },
        } satisfies BrowserClickStep,
      ],
      createdAt: 1,
      createdBySessionId: 'session-1',
      approval: { status: 'approved' },
    }
    workflow = createReadyWorkflow(version)

    const runPromise = runBrowserWorkflow({
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      workflowId: 'workflow-1',
      source: 'automation',
    })

    // 等待进入 waiting_user 状态
    await waitUntilStatus((s) => s.state === 'waiting_user')
    expect(visibleTabCalls).toContainEqual({ tabId: 'workflow-tab-1', visible: true })

    // 用户在 UI 点击继续
    continueBrowserWorkflowRun('session-1')

    const summary = await runPromise
    expect(summary.status).toBe('completed')
    expect(visibleTabCalls).toContainEqual({ tabId: 'workflow-tab-1', visible: false })
    expect(executedSteps).toEqual([{ stepId: 'step-after-manual', type: 'click', tabId: 'workflow-tab-1' }])
  })

  test('Given manual 步骤处于 waiting_user 时触发 CDP detach When 用户首次 continue Then 重新 acquire 并恢复到 manual waiting_user，二次 continue 后完成 manual 步骤', async () => {
    const version: BrowserWorkflowVersion = {
      schemaVersion: 1,
      workflowId: 'workflow-1',
      version: 1,
      start: { tabAlias: 'main', url: 'https://example.com/start', origin: 'https://example.com' },
      variables: [],
      steps: [
        {
          id: 'step-manual',
          type: 'manual',
          tabAlias: 'main',
          origin: 'https://example.com',
          reason: 'captcha',
          instruction: '请手动完成验证码',
        } satisfies BrowserManualStep,
        {
          id: 'step-after-manual',
          type: 'click',
          tabAlias: 'main',
          origin: 'https://example.com',
          target: {
            framePath: { frameIds: [] },
            strategies: [{ kind: 'id', value: 'submit' }],
            fingerprint: { tagName: 'button', accessibleName: '提交', visible: true, enabled: true },
          },
        } satisfies BrowserClickStep,
      ],
      createdAt: 1,
      createdBySessionId: 'session-1',
      approval: { status: 'approved' },
    }
    workflow = createReadyWorkflow(version)

    const runPromise = runBrowserWorkflow({
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      workflowId: 'workflow-1',
      source: 'automation',
    })

    // 1. 等待进入 manual 的 waiting_user 状态
    await waitUntilStatus((s) => s.state === 'waiting_user')

    // 2. 在人工等待期间触发 CDP detach
    emitDetachOnTab('workflow-tab-1', '人工操作时 DevTools 开启')

    // 3. 等待 runner 进入 paused_cdp_detached
    await waitUntilStatus((s) => s.state === 'paused_cdp_detached')

    // 4. 用户首次 continue：恢复 CDP 会话并重新回到 manual 步骤
    continueBrowserWorkflowRun('session-1')

    // 5. runner 重新 acquire workflow port 并再次进入 waiting_user
    await waitUntilStatus((s) => s.state === 'waiting_user')
    expect(acquiredPorts).toEqual([
      { tabId: 'workflow-tab-1', owner: 'workflow', generation: 1 },
      { tabId: 'workflow-tab-1', owner: 'workflow', generation: 2 },
    ])

    // 6. 二次 continue：完成人工操作
    continueBrowserWorkflowRun('session-1')

    const summary = await runPromise
    expect(summary.status).toBe('completed')
    expect(executedSteps).toEqual([{ stepId: 'step-after-manual', type: 'click', tabId: 'workflow-tab-1' }])
  })

  test('Given manual 步骤等待中 When stopBrowserWorkflowRun Then 立即解除等待、清理 resumeManual 并以 cancelled 结束', async () => {
    const version: BrowserWorkflowVersion = {
      schemaVersion: 1,
      workflowId: 'workflow-1',
      version: 1,
      start: { tabAlias: 'main', url: 'https://example.com/start', origin: 'https://example.com' },
      variables: [],
      steps: [
        {
          id: 'step-manual',
          type: 'manual',
          tabAlias: 'main',
          origin: 'https://example.com',
          reason: 'otp',
          instruction: '请输入短信验证码',
        } satisfies BrowserManualStep,
      ],
      createdAt: 1,
      createdBySessionId: 'session-1',
      approval: { status: 'approved' },
    }
    workflow = createReadyWorkflow(version)

    const runPromise = runBrowserWorkflow({
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      workflowId: 'workflow-1',
      source: 'automation',
    })

    await waitUntilStatus((s) => s.state === 'waiting_user')

    stopBrowserWorkflowRun('session-1')

    const summary = await runPromise
    expect(summary.status).toBe('cancelled')
    expect(closedTabs).toEqual(['workflow-tab-1'])

    // 确认 stop 后再次调用 continue 不会触发残留 handler
    expect(() => continueBrowserWorkflowRun('session-1')).toThrow('当前没有正在运行的 Workflow')
  })

  test('Given 步骤之间发生 CDP detach When 下一步执行前已处于 detach 状态 Then 自动暂停并发布 paused，continue 后重新 acquire 并重试', async () => {
    const version: BrowserWorkflowVersion = {
      schemaVersion: 1,
      workflowId: 'workflow-1',
      version: 1,
      start: { tabAlias: 'main', url: 'https://example.com/start', origin: 'https://example.com' },
      variables: [],
      steps: [
        {
          id: 'step-1',
          type: 'click',
          tabAlias: 'main',
          origin: 'https://example.com',
          target: {
            framePath: { frameIds: [] },
            strategies: [{ kind: 'id', value: 'b1' }],
            fingerprint: { tagName: 'button', accessibleName: '步骤1', visible: true, enabled: true },
          },
        } satisfies BrowserClickStep,
        {
          id: 'step-2',
          type: 'click',
          tabAlias: 'main',
          origin: 'https://example.com',
          target: {
            framePath: { frameIds: [] },
            strategies: [{ kind: 'id', value: 'b2' }],
            fingerprint: { tagName: 'button', accessibleName: '步骤2', visible: true, enabled: true },
          },
        } satisfies BrowserClickStep,
      ],
      createdAt: 1,
      createdBySessionId: 'session-1',
      approval: { status: 'approved' },
    }
    workflow = createReadyWorkflow(version)

    let step1Attempts = 0
    pageExecutorHook = async (input) => {
      if (input.step.id === 'step-1') {
        step1Attempts++
        if (step1Attempts === 1) {
          // step-1 完成瞬间触发 detach
          emitDetachOnTab('workflow-tab-1', '步骤间隙发生断开')
        }
        return { fallbackUsed: false }
      }
      return { fallbackUsed: false }
    }

    const runPromise = runBrowserWorkflow({
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      workflowId: 'workflow-1',
      source: 'automation',
    })

    // 等待 step-1 重试发现 detach 并进入 paused
    await waitUntilStatus((s) => s.state === 'paused_cdp_detached')

    continueBrowserWorkflowRun('session-1')

    const summary = await runPromise
    expect(summary.status).toBe('completed')
    expect(executedSteps).toEqual([
      { stepId: 'step-1', type: 'click', tabId: 'workflow-tab-1' },
      { stepId: 'step-1', type: 'click', tabId: 'workflow-tab-1' },
      { stepId: 'step-2', type: 'click', tabId: 'workflow-tab-1' },
    ])
    expect(acquiredPorts.length).toBe(2)
  })

  test('Given 步骤执行中 CDP detach When 触发 detach Then 暂停并发布 paused，continue 后重新 acquire port 重试该步骤', async () => {
    workflow = createReadyWorkflow(createBasicVersion())

    let attempts = 0
    pageExecutorHook = async (input) => {
      attempts++
      if (attempts === 1) {
        emitDetachOnTab(input.tabId, 'DevTools 抢占')
        throw new Error('CDP lease 已失效')
      }
      return { fallbackUsed: false }
    }

    const runPromise = runBrowserWorkflow({
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      workflowId: 'workflow-1',
      source: 'automation',
    })

    // 等待进入 paused 状态
    await waitUntilStatus((s) => s.state === 'paused_cdp_detached')

    // 用户点击继续恢复
    continueBrowserWorkflowRun('session-1')

    const summary = await runPromise
    expect(summary.status).toBe('completed')
    expect(attempts).toBe(2)
    // 验证第二次尝试时使用了重新 acquire 的 port (generation: 2)
    expect(acquiredPorts).toEqual([
      { tabId: 'workflow-tab-1', owner: 'workflow', generation: 1 },
      { tabId: 'workflow-tab-1', owner: 'workflow', generation: 2 },
    ])
  })

  test('Given 步骤执行中页签被 destroyed When 发生 Then 立即失败且不无限等待', async () => {
    workflow = createReadyWorkflow(createBasicVersion())

    pageExecutorHook = async (input) => {
      const portRec = getLatestPortRecord(input.tabId)
      tabStore.delete(input.tabId) // tab destroyed
      for (const listener of portRec?.destroyListeners ?? []) {
        listener()
      }
      throw new Error('网页页签已销毁')
    }

    await expect(
      runBrowserWorkflow({
        workspaceId: 'workspace-1',
        sessionId: 'session-1',
        workflowId: 'workflow-1',
        source: 'automation',
      }),
    ).rejects.toThrow(/销毁/)

    expect(workflowStatuses.at(-1)?.state).toBe('error')
  })

  test('Given 步骤执行失败且 writeBrowserWorkflowArtifact 抛出异常 When 失败处理 Then 捕获 artifact 异常，保留原始失败信息并继续完成 failure handoff', async () => {
    workflow = createReadyWorkflow(createBasicVersion())
    tabStore.set('browser-tab', {
      id: 'browser-tab',
      url: 'https://example.com/existing',
      title: 'Existing Tab',
      isLoading: false,
      workflowOwned: false,
    })
    browserContext = { tabId: 'browser-tab' }

    shouldThrowOnWriteArtifact = true
    pageExecutorHook = async () => {
      throw new Error('定位元素失败: #custom-button')
    }

    const warnSpy = mock(() => {})
    const originalWarn = console.warn
    console.warn = warnSpy

    try {
      await expect(
        runBrowserWorkflow({
          workspaceId: 'workspace-1',
          sessionId: 'session-1',
          workflowId: 'workflow-1',
          source: 'automation',
        }),
      ).rejects.toThrow('定位元素失败: #custom-button')

      // handoff 仍正常完成
      expect(workflowFailureHandoffs).toEqual([{ sessionId: 'session-1', tabId: 'workflow-tab-1' }])
      expect(closedTabs).not.toContain('workflow-tab-1')
      expect(warnSpy).toHaveBeenCalled()
    } finally {
      console.warn = originalWarn
    }
  })

  test('Given 初始化阶段 publishRun 抛错 When 运行 Then 资源全部清理且 activeRuns 释放，下次运行不报正在运行', async () => {
    workflow = createReadyWorkflow(createBasicVersion())

    shouldThrowOnAppendEvent = true

    await expect(
      runBrowserWorkflow({
        workspaceId: 'workspace-1',
        sessionId: 'session-1',
        workflowId: 'workflow-1',
        source: 'automation',
      }),
    ).rejects.toThrow('模拟初始化持久化异常')

    // 验证资源清理与失败移交
    expect(profileLeaseReleaseCalls).toBe(1)
    expect(releasedPorts.length).toBeGreaterThan(0)
    expect(workflowFailureHandoffs).toEqual([{ sessionId: 'session-1', tabId: 'workflow-tab-1' }])

    // 恢复持久化正常
    shouldThrowOnAppendEvent = false

    // 再次运行同一 session 不应报“正在运行”
    const secondRun = await runBrowserWorkflow({
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      workflowId: 'workflow-1',
      source: 'automation',
    })
    expect(secondRun.status).toBe('completed')
  })

  test('Given 多步骤在多个页签间操作 When 后续步骤失败 Then failure handoff 准确移交当前步骤所属的页签而非前序页签', async () => {
    const version: BrowserWorkflowVersion = {
      schemaVersion: 1,
      workflowId: 'workflow-1',
      version: 1,
      start: { tabAlias: 'main', url: 'https://example.com/start', origin: 'https://example.com' },
      variables: [],
      steps: [
        {
          id: 'step-open',
          type: 'openTab',
          tabAlias: 'main',
          newTabAlias: 'details',
          url: 'https://example.com/details',
          origin: 'https://example.com',
        } satisfies BrowserOpenTabStep,
        {
          id: 'step-switch-main',
          type: 'switchTab',
          tabAlias: 'details',
          targetTabAlias: 'main',
          origin: 'https://example.com',
        } satisfies BrowserSwitchTabStep,
        {
          id: 'step-click-main-fail',
          type: 'click',
          tabAlias: 'main',
          origin: 'https://example.com',
          target: {
            framePath: { frameIds: [] },
            strategies: [{ kind: 'id', value: 'main-btn' }],
            fingerprint: { tagName: 'button', accessibleName: '主按钮', visible: true, enabled: true },
          },
        } satisfies BrowserClickStep,
      ],
      createdAt: 1,
      createdBySessionId: 'session-1',
      approval: { status: 'approved' },
    }
    workflow = createReadyWorkflow(version)

    pageExecutorHook = async (input) => {
      if (input.step.id === 'step-click-main-fail') {
        throw new Error('main 页面点击失败')
      }
      return { fallbackUsed: false }
    }

    await expect(
      runBrowserWorkflow({
        workspaceId: 'workspace-1',
        sessionId: 'session-1',
        workflowId: 'workflow-1',
        source: 'automation',
      }),
    ).rejects.toThrow('main 页面点击失败')

    // 移交的是当前步骤所在的 workflow-tab-1 (main)，而非 openTab 创建的 workflow-tab-2 (details)
    expect(workflowFailureHandoffs).toEqual([{ sessionId: 'session-1', tabId: 'workflow-tab-1' }])
    // 未提升的 details 页签被关闭
    expect(closedTabs).toContain('workflow-tab-2')
    // 提升的 main 页签不被关闭
    expect(closedTabs).not.toContain('workflow-tab-1')
  })

  test('Given switchTab 目标页签已销毁 When 执行 switchTab Then 立即抛错失败', async () => {
    const version: BrowserWorkflowVersion = {
      schemaVersion: 1,
      workflowId: 'workflow-1',
      version: 1,
      start: { tabAlias: 'main', url: 'https://example.com/start', origin: 'https://example.com' },
      variables: [],
      steps: [
        {
          id: 'step-open',
          type: 'openTab',
          tabAlias: 'main',
          newTabAlias: 'details',
          url: 'https://example.com/details',
          origin: 'https://example.com',
        } satisfies BrowserOpenTabStep,
        {
          id: 'step-click-details',
          type: 'click',
          tabAlias: 'details',
          origin: 'https://example.com',
          target: {
            framePath: { frameIds: [] },
            strategies: [{ kind: 'id', value: 'btn' }],
            fingerprint: { tagName: 'button', accessibleName: '操作', visible: true, enabled: true },
          },
        } satisfies BrowserClickStep,
        {
          id: 'step-switch-destroyed',
          type: 'switchTab',
          tabAlias: 'details',
          targetTabAlias: 'main',
          origin: 'https://example.com',
        } satisfies BrowserSwitchTabStep,
      ],
      createdAt: 1,
      createdBySessionId: 'session-1',
      approval: { status: 'approved' },
    }
    workflow = createReadyWorkflow(version)

    pageExecutorHook = async (input) => {
      if (input.step.id === 'step-click-details') {
        tabStore.delete('workflow-tab-1') // main 页签在后台被销毁
        const mainPort = getLatestPortRecord('workflow-tab-1')
        for (const listener of mainPort?.destroyListeners ?? []) {
          listener()
        }
      }
      return { fallbackUsed: false }
    }

    await expect(
      runBrowserWorkflow({
        workspaceId: 'workspace-1',
        sessionId: 'session-1',
        workflowId: 'workflow-1',
        source: 'automation',
      }),
    ).rejects.toThrow(/销毁/)
  })

  test('Given Workflow abort When step 正在执行 Then 先 abort step，再 release ports，再 close tabs，最后 release profile lease', async () => {
    workflow = createReadyWorkflow(createBasicVersion())

    let stepStartedResolve: (() => void) | undefined
    const stepStartedPromise = new Promise<void>((r) => {
      stepStartedResolve = r
    })

    pageExecutorHook = async (input) => {
      stepStartedResolve?.()
      await new Promise((_, reject) => {
        input.signal.addEventListener('abort', () => {
          cleanupSequence.push('step:abort')
          reject(new Error('Browser Workflow 已取消'))
        })
      })
      return { fallbackUsed: false }
    }

    const controller = new AbortController()
    const runPromise = runBrowserWorkflow(
      {
        workspaceId: 'workspace-1',
        sessionId: 'session-1',
        workflowId: 'workflow-1',
        source: 'automation',
      },
      controller.signal,
    )

    // 等待步骤真正开始执行（无固定 sleep）
    await stepStartedPromise
    controller.abort()

    const summary = await runPromise
    expect(summary.status).toBe('cancelled')

    // 校验清理顺序：step:abort -> port:release -> tab:close -> profile:release
    expect(cleanupSequence).toEqual(['step:abort', 'port:release', 'tab:close', 'profile:release'])
  })

  // === 修复项 1: closeTab targetTabAlias === tabAlias 主动关闭自身 ===
  test('Given closeTab 步骤关闭自身别名 (targetTabAlias === tabAlias) When 作为步骤执行 Then step_completed 且 run completed，不触发 failure handoff', async () => {
    const version: BrowserWorkflowVersion = {
      schemaVersion: 1,
      workflowId: 'workflow-1',
      version: 1,
      start: { tabAlias: 'main', url: 'https://example.com/start', origin: 'https://example.com' },
      variables: [],
      steps: [
        {
          id: 'step-open',
          type: 'openTab',
          tabAlias: 'main',
          newTabAlias: 'details',
          url: 'https://example.com/details',
          origin: 'https://example.com',
        } satisfies BrowserOpenTabStep,
        {
          id: 'step-close-self',
          type: 'closeTab',
          tabAlias: 'details',
          targetTabAlias: 'details', // 关闭自身
          origin: 'https://example.com',
        } satisfies BrowserCloseTabStep,
      ],
      createdAt: 1,
      createdBySessionId: 'session-1',
      approval: { status: 'approved' },
    }
    workflow = createReadyWorkflow(version)

    const summary = await runBrowserWorkflow({
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      workflowId: 'workflow-1',
      source: 'automation',
    })

    expect(summary.status).toBe('completed')
    expect(workflowFailureHandoffs).toHaveLength(0)
    expect(workflowEvents.some((e) => e.type === 'step_completed' && e.stepId === 'step-close-self')).toBe(true)
    expect(workflowEvents.some((e) => e.type === 'completed')).toBe(true)
    expect(closedTabs).toEqual(['workflow-tab-2', 'workflow-tab-1'])
  })

  // === 修复项 3: waitFor 事件驱动 abort 快速响应 ===
  test('Given 页面 Origin waitFor 轮询等待中 When stopBrowserWorkflowRun 触发 Then 立即响应 abort 取消且无残留定时器', async () => {
    const version: BrowserWorkflowVersion = {
      schemaVersion: 1,
      workflowId: 'workflow-1',
      version: 1,
      start: { tabAlias: 'main', url: 'https://example.com/start', origin: 'https://example.com' },
      variables: [],
      steps: [],
      createdAt: 1,
      createdBySessionId: 'session-1',
      approval: { status: 'approved' },
    }
    workflow = createReadyWorkflow(version)

    // 让起始页面的 isLoading 保持 true，迫使 waitFor 持续轮询
    waitForLoadHook = (tabId: string) => {
      const record = tabStore.get(tabId)
      if (record) record.isLoading = true
    }

    let runSettled = false
    const runPromise = runBrowserWorkflow({
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      workflowId: 'workflow-1',
      source: 'automation',
    }).then((res) => {
      runSettled = true
      return res
    })

    // 在轮询期间立即 stop
    await new Promise((r) => setTimeout(r, 5))
    stopBrowserWorkflowRun('session-1')

    const result = await runPromise
    expect(result.status).toBe('cancelled')
    expect(runSettled).toBe(true)
    expect(workflowEvents.some((e) => e.type === 'cancelled')).toBe(true)
  })

  // === 修复项 5 (额外核实项): openTab outcome committed 后源页签 detach 不重试 openTab ===
  test('Given openTab 已完成 load 与 alias 注册后源页签触发 detach When 步骤完成 Then 不重复重试 openTab，后续使用源页签时才 pause/reacquire', async () => {
    const version: BrowserWorkflowVersion = {
      schemaVersion: 1,
      workflowId: 'workflow-1',
      version: 1,
      start: { tabAlias: 'main', url: 'https://example.com/start', origin: 'https://example.com' },
      variables: [],
      steps: [
        {
          id: 'step-open',
          type: 'openTab',
          tabAlias: 'main',
          newTabAlias: 'sub',
          url: 'https://example.com/sub',
          origin: 'https://example.com',
        } satisfies BrowserOpenTabStep,
        {
          id: 'step-click-sub',
          type: 'click',
          tabAlias: 'sub',
          origin: 'https://example.com',
          target: {
            framePath: { frameIds: [] },
            strategies: [{ kind: 'id', value: 'sub-btn' }],
            fingerprint: { tagName: 'button', accessibleName: '子页按钮', visible: true, enabled: true },
          },
        } satisfies BrowserClickStep,
        {
          id: 'step-switch-main',
          type: 'switchTab',
          tabAlias: 'sub',
          targetTabAlias: 'main',
          origin: 'https://example.com',
        } satisfies BrowserSwitchTabStep,
        {
          id: 'step-click-main',
          type: 'click',
          tabAlias: 'main',
          origin: 'https://example.com',
          target: {
            framePath: { frameIds: [] },
            strategies: [{ kind: 'id', value: 'main-btn' }],
            fingerprint: { tagName: 'button', accessibleName: '主页按钮', visible: true, enabled: true },
          },
        } satisfies BrowserClickStep,
      ],
      createdAt: 1,
      createdBySessionId: 'session-1',
      approval: { status: 'approved' },
    }
    workflow = createReadyWorkflow(version)

    // 在 openTab 为新页签 (workflow-tab-2) 获取 port / commit 期间，让源页签 (workflow-tab-1) 发生 detach
    acquirePortHook = (tabId: string) => {
      if (tabId === 'workflow-tab-2') {
        emitDetachOnTab('workflow-tab-1', '主页签在 openTab 期间断开')
      }
    }

    const runPromise = runBrowserWorkflow({
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      workflowId: 'workflow-1',
      source: 'automation',
    })

    // 等待 step-open 与 step-click-sub 完成，并停在 step-switch-main / step-click-main pause 处
    await new Promise((r) => setTimeout(r, 30))

    expect(workflowStatuses.at(-1)?.state).toBe('paused_cdp_detached')
    expect(createdTabs.length).toBe(2) // openTab 仅创建了 1 个新页签（总共 2 个）
    expect(executedSteps.map((s) => s.stepId)).toEqual(['step-click-sub'])

    // continue 恢复 main 页签
    continueBrowserWorkflowRun('session-1')
    const summary = await runPromise

    expect(summary.status).toBe('completed')
    expect(executedSteps.map((s) => s.stepId)).toEqual(['step-click-sub', 'step-click-main'])
  })
})
