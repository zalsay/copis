import { randomUUID } from 'node:crypto'
import type {
  BrowserWorkflowRunInput,
  BrowserWorkflowRunSummary,
  BrowserWorkflowStatus,
  WebTabState,
} from '@copis/shared'
import {
  acquireWebTabPagePort,
  closeWorkflowWebTab,
  createWorkflowWebTab,
  getWebTabLoadError,
  getWebTabState,
  navigateWebTab,
  setWorkflowWebTabVisible,
  subscribeWebTabLifecycle,
  subscribeWorkflowWebTabOpened,
  waitForWebTabLoad,
} from './web-tab-manager'
import type { BrowserPagePort } from './browser-page-port'
import {
  createBrowserWorkflowPageExecutor,
  type BrowserWorkflowPageRuntime,
} from './browser-workflow-page-executor'
import {
  getBrowserAgentContext,
  getBrowserAgentWorkspaceId,
  handoffBrowserWorkflowFailure,
  publishBrowserWorkflowStatus,
} from './browser-workflow-service'
import { registerAutomationWorkflowRun } from './automation-manager'
import { acquireBrowserWorkflowProfileLease } from './browser-workflow-profile-lease'
import {
  appendBrowserWorkflowRunEvent,
  getBrowserWorkflow,
  saveLatestBrowserWorkflowRun,
  writeBrowserWorkflowArtifact,
} from './browser-workflow-store'

interface ActiveRun {
  runId: string
  controller: AbortController
  resumeManual?: () => void
  resumeCdp?: () => void
}

interface RunContext {
  input: BrowserWorkflowRunInput
  workflow: ReturnType<typeof getBrowserWorkflow>
  run: BrowserWorkflowRunSummary
  signal: AbortSignal
}

interface TabAliasEntry {
  tabId: string
  port: BrowserPagePort
  detached: boolean
  detachReason?: string
  destroyed: boolean
  cleanupListeners: () => void
}

const activeRuns = new Map<string, ActiveRun>()
const DEFAULT_STEP_TIMEOUT_MS = 15_000
const POLL_INTERVAL_MS = 100

function validateWorkflowVariables(
  definitions: ReturnType<typeof getBrowserWorkflow>['version']['variables'],
  values: BrowserWorkflowRunInput['variables'],
): Record<string, string | number | boolean> {
  const provided = values ?? {}
  const resolved: Record<string, string | number | boolean> = {}
  for (const definition of definitions) {
    const value = provided[definition.key] ?? definition.defaultValue
    if (value === undefined) {
      if (definition.required) throw new Error(`缺少 Workflow 变量: ${definition.key}`)
      continue
    }
    if (definition.type === 'string' && typeof value !== 'string') throw new Error(`Workflow 变量类型错误: ${definition.key}`)
    if (definition.type === 'number' && typeof value !== 'number') throw new Error(`Workflow 变量类型错误: ${definition.key}`)
    if (definition.type === 'boolean' && typeof value !== 'boolean') throw new Error(`Workflow 变量类型错误: ${definition.key}`)
    if (definition.type === 'choice' && !definition.options?.includes(String(value))) throw new Error(`Workflow 变量选项无效: ${definition.key}`)
    resolved[definition.key] = value
  }
  for (const key of Object.keys(provided)) {
    if (!definitions.some((definition) => definition.key === key)) throw new Error(`未知 Workflow 变量: ${key}`)
  }
  return resolved
}

function ensureAllowedOrigin(url: string, allowedOrigins: string[], expectedOrigin = ''): void {
  let origin: string
  try {
    origin = new URL(url).origin
  } catch {
    throw new Error(`当前页面地址无效: ${url}`)
  }
  if (!allowedOrigins.includes(origin)) throw new Error(`页面 Origin 不在 Workflow 白名单内: ${origin}`)
  if (expectedOrigin && origin !== expectedOrigin) throw new Error(`页面 Origin 与步骤不匹配: ${origin}`)
}

function ensureTabLoaded(tabId: string): void {
  const error = getWebTabLoadError(tabId)
  if (error) throw new Error(`网页加载失败: ${error}`)
}

function waitFor(timeoutMs: number, check: () => boolean, signal: AbortSignal): Promise<void> {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined
    let settled = false

    const cleanup = (): void => {
      if (timer) {
        clearTimeout(timer)
        timer = undefined
      }
      signal.removeEventListener('abort', onAbort)
    }

    const onAbort = (): void => {
      if (settled) return
      settled = true
      cleanup()
      reject(new Error('Browser Workflow 已取消'))
    }

    if (signal.aborted) {
      onAbort()
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })

    const tick = (): void => {
      if (settled) return
      if (signal.aborted) {
        onAbort()
        return
      }
      if (check()) {
        settled = true
        cleanup()
        resolve()
        return
      }
      if (Date.now() >= deadline) {
        settled = true
        cleanup()
        reject(new Error('等待页面加载超时'))
        return
      }
      timer = setTimeout(tick, POLL_INTERVAL_MS)
    }
    tick()
  })
}

function getRunState(run: BrowserWorkflowRunSummary): BrowserWorkflowStatus['state'] {
  if (run.status === 'waiting_user') return 'waiting_user'
  if (run.status === 'paused') return 'paused_cdp_detached'
  if (run.status === 'completed' || run.status === 'cancelled') return 'idle'
  if (run.status === 'failed') return 'error'
  return 'running'
}

function publishRun(context: RunContext, status: BrowserWorkflowRunSummary['status'], message?: string): void {
  context.run.status = status
  if (status === 'completed' || status === 'failed' || status === 'cancelled') context.run.finishedAt = Date.now()
  if (status === 'waiting_user' || status === 'paused' || status === 'failed') context.run.error = message
  else if (status === 'running' || status === 'completed') context.run.error = undefined

  const eventType = status === 'completed'
    ? 'completed'
    : status === 'failed'
      ? 'failed'
      : status === 'cancelled'
        ? 'cancelled'
        : status === 'waiting_user'
          ? 'waiting_user'
          : status === 'paused'
            ? 'paused'
            : 'started'

  if (context.input.source === 'automation' && (status === 'completed' || status === 'failed' || status === 'cancelled')) {
    registerAutomationWorkflowRun({
      workflowId: context.input.workflowId,
      version: context.run.version,
      runId: context.run.runId,
      status,
    }, context.input.sessionId)
  }

  appendBrowserWorkflowRunEvent(context.input.workspaceId, context.input.workflowId, {
    runId: context.run.runId,
    workflowId: context.input.workflowId,
    version: context.run.version,
    timestamp: Date.now(),
    type: eventType,
    status,
    message,
  })

  saveLatestBrowserWorkflowRun(context.input.workspaceId, context.input.workflowId, context.run)

  publishBrowserWorkflowStatus(context.input.sessionId, {
    sessionId: context.input.sessionId,
    state: getRunState(context.run),
    run: { ...context.run },
  })
}

function appendStepEvent(context: RunContext, type: 'step_started' | 'step_completed', stepId: string): void {
  appendBrowserWorkflowRunEvent(context.input.workspaceId, context.input.workflowId, {
    runId: context.run.runId,
    workflowId: context.input.workflowId,
    version: context.run.version,
    timestamp: Date.now(),
    type,
    stepId,
    status: 'running',
  })
}

function appendFallbackEvent(context: RunContext, stepId: string): void {
  appendBrowserWorkflowRunEvent(context.input.workspaceId, context.input.workflowId, {
    runId: context.run.runId,
    workflowId: context.input.workflowId,
    version: context.run.version,
    timestamp: Date.now(),
    type: 'fallback_used',
    stepId,
    status: 'running',
    details: { fallbackUsed: true },
  })
}

async function writeFailureArtifacts(
  context: RunContext,
  activePort: BrowserPagePort | undefined,
  activeTabId: string | undefined,
  message: string,
): Promise<void> {
  const artifactList: string[] = []

  // 尽力截取 failure.png
  if (activePort && activeTabId && getWebTabState(activeTabId)) {
    try {
      const result = (await activePort.send('Page.captureScreenshot', { format: 'png' })) as { data?: string }
      if (result?.data) {
        const buffer = Buffer.from(result.data, 'base64')
        const pngPath = writeBrowserWorkflowArtifact(
          context.input.workspaceId,
          context.input.workflowId,
          context.run.runId,
          'failure.png',
          new Uint8Array(buffer),
        )
        if (pngPath) artifactList.push(pngPath)
      }
    } catch (err) {
      console.warn('[网页 Workflow] 截取失败页面截图失败:', err)
    }
  }

  // 尽力生成脱敏 failure.json（去除 username、password、search 与 hash）
  try {
    const tab = activeTabId ? getWebTabState(activeTabId) : undefined
    const url = (() => {
      try {
        const parsed = new URL(tab?.url ?? '')
        parsed.username = ''
        parsed.password = ''
        parsed.search = ''
        parsed.hash = ''
        return parsed.toString()
      } catch {
        return ''
      }
    })()

    const jsonPath = writeBrowserWorkflowArtifact(
      context.input.workspaceId,
      context.input.workflowId,
      context.run.runId,
      'failure.json',
      JSON.stringify(
        {
          capturedAt: Date.now(),
          stepId: context.run.currentStepId,
          message,
          url,
        },
        null,
        2,
      ),
    )
    if (jsonPath) artifactList.push(jsonPath)
  } catch (err) {
    console.warn('[网页 Workflow] 写入 failure.json 失败:', err)
  }

  if (artifactList.length > 0) {
    context.run.artifacts = [...new Set([...(context.run.artifacts ?? []), ...artifactList])]
  }
}

function registerTabAlias(
  alias: string,
  tabId: string,
  port: BrowserPagePort,
  onDetached: (alias: string, reason: string) => void,
  onDestroyed: (alias: string) => void,
): TabAliasEntry {
  let entry: TabAliasEntry
  const removeDetach = port.onDetached((reason) => {
    entry.detached = true
    entry.detachReason = reason || '网页 CDP 会话已断开'
    onDetached(alias, entry.detachReason)
  })
  const removeDestroy = port.onDestroyed(() => {
    entry.destroyed = true
    onDestroyed(alias)
  })
  entry = {
    tabId,
    port,
    detached: false,
    destroyed: false,
    cleanupListeners: () => {
      removeDetach()
      removeDestroy()
    },
  }
  return entry
}

async function handleTabDetachedPauseAndReacquire(
  tabAlias: string,
  entry: TabAliasEntry,
  runContext: RunContext,
  activeEntry: ActiveRun,
  controller: AbortController,
  tabAliases: Map<string, TabAliasEntry>,
  allPorts: BrowserPagePort[],
  onTabDetached: (alias: string, reason: string) => void,
  onDestroyed: (alias: string) => void,
): Promise<TabAliasEntry> {
  if (entry.destroyed || !getWebTabState(entry.tabId)) {
    entry.destroyed = true
    onDestroyed(tabAlias)
    throw new Error(`网页页签已销毁: ${entry.tabId}`)
  }

  publishRun(runContext, 'paused', entry.detachReason || '网页 CDP 会话已断开')

  await new Promise<void>((resolve, reject) => {
    let settled = false
    let removeLifecycleSub: (() => void) | undefined

    const cleanup = (): void => {
      if (settled) return
      settled = true
      controller.signal.removeEventListener('abort', onAbort)
      removeLifecycleSub?.()
      removeLifecycleSub = undefined
      activeEntry.resumeCdp = undefined
    }

    const onAbort = (): void => {
      cleanup()
      reject(new Error('Browser Workflow 已取消'))
    }

    const onTabClosed = (): void => {
      entry.destroyed = true
      onDestroyed(tabAlias)
      cleanup()
      reject(new Error(`网页页签已销毁: ${entry.tabId}`))
    }

    if (controller.signal.aborted) {
      onAbort()
      return
    }

    if (entry.destroyed || !getWebTabState(entry.tabId)) {
      onTabClosed()
      return
    }

    controller.signal.addEventListener('abort', onAbort, { once: true })

    const lifecycleSub = subscribeWebTabLifecycle((event) => {
      if (event.type === 'closed' && event.tabId === entry.tabId) {
        onTabClosed()
      }
    })
    if (settled) lifecycleSub()
    else removeLifecycleSub = lifecycleSub

    activeEntry.resumeCdp = (): void => {
      if (entry.destroyed || !getWebTabState(entry.tabId)) {
        onTabClosed()
        return
      }
      cleanup()
      resolve()
    }
  })

  entry.cleanupListeners()

  if (entry.destroyed || !getWebTabState(entry.tabId)) {
    entry.destroyed = true
    onDestroyed(tabAlias)
    throw new Error(`网页页签已销毁: ${entry.tabId}`)
  }

  const freshPort = acquireWebTabPagePort(entry.tabId, 'workflow')
  allPorts.push(freshPort)
  const newEntry = registerTabAlias(tabAlias, entry.tabId, freshPort, onTabDetached, onDestroyed)
  tabAliases.set(tabAlias, newEntry)
  publishRun(runContext, 'running')
  return newEntry
}

export async function runBrowserWorkflow(input: BrowserWorkflowRunInput, externalSignal?: AbortSignal): Promise<BrowserWorkflowRunSummary> {
  const activeRun = activeRuns.get(input.sessionId)
  if (activeRun) throw new Error(`当前 Browser Workflow 正在运行: ${activeRun.runId}`)

  const workflow = getBrowserWorkflow(input.workspaceId, input.workflowId, input.version)
  if (workflow.manifest.status !== 'ready' || workflow.version.approval.status !== 'approved') {
    throw new Error('只有已批准的 Browser Workflow 才能运行')
  }
  if (input.source !== 'user' && !workflow.manifest.unattendedAllowed) {
    throw new Error('此 Workflow 未允许无人值守运行')
  }

  const variables = validateWorkflowVariables(workflow.version.variables, input.variables)
  const context = getBrowserAgentContext(input.sessionId)
  const boundWorkspaceId = getBrowserAgentWorkspaceId(input.sessionId)
  if (context && boundWorkspaceId !== input.workspaceId) throw new Error('AI浏览器会话工作区与 Workflow 工作区不一致')
  if (input.source === 'user' && !context) throw new Error('AI浏览器尚未绑定网页页签')
  if (context && !getWebTabState(context.tabId)) throw new Error('当前网页页签不存在')

  const startOrigin = new URL(workflow.version.start.url).origin
  if (!workflow.manifest.allowedOrigins.includes(startOrigin)) {
    throw new Error(`Workflow 起始页面不在允许的 Origin 范围内: ${startOrigin}`)
  }

  // Workflow 一律复用用户网页的登录态；profileId 只保留为清单兼容字段。
  const workflowPartition = 'persist:copis-web'
  let releaseProfileLease: (() => void) | undefined
  const createdTabIds: string[] = []
  const promotedTabIds = new Set<string>()
  const allPorts: BrowserPagePort[] = []
  const tabAliases = new Map<string, TabAliasEntry>()
  const closedAliases = new Set<string>()

  let activeTabAlias = workflow.version.start.tabAlias
  let currentStepTargetAlias = workflow.version.start.tabAlias
  let currentStepAbortController: AbortController | undefined

  const run: BrowserWorkflowRunSummary = {
    runId: randomUUID(),
    workflowId: input.workflowId,
    version: workflow.version.version,
    status: 'starting',
    startedAt: Date.now(),
  }

  const controller = new AbortController()
  const abortFromExternal = (): void => controller.abort()
  if (externalSignal?.aborted) controller.abort()
  else externalSignal?.addEventListener('abort', abortFromExternal, { once: true })

  const runContext: RunContext = {
    input,
    workflow,
    run,
    signal: controller.signal,
  }

  const activeEntry: ActiveRun = { runId: run.runId, controller }
  activeRuns.set(input.sessionId, activeEntry)

  const onTabDetached = (alias: string, _reason: string): void => {
    if (alias === activeTabAlias || currentStepTargetAlias === alias) {
      currentStepAbortController?.abort()
    }
  }

  const onTabDestroyed = (alias: string): void => {
    if (alias === activeTabAlias || currentStepTargetAlias === alias) {
      currentStepAbortController?.abort()
    }
  }

  const pageRuntime: BrowserWorkflowPageRuntime = {
    getTab: (tabId: string) => {
      const tab = getWebTabState(tabId)
      if (!tab) return undefined
      return {
        id: tab.id,
        url: tab.url,
        title: tab.title,
        isLoading: tab.isLoading,
      }
    },
    navigate: (tabId: string, url: string) => {
      navigateWebTab({ tabId, url })
    },
    waitForLoad: (tabId: string, timeoutMs: number, signal: AbortSignal) => {
      return waitForWebTabLoad(tabId, timeoutMs, signal)
    },
  }
  const pageExecutor = createBrowserWorkflowPageExecutor(pageRuntime)

  try {
    releaseProfileLease = acquireBrowserWorkflowProfileLease(workflowPartition, input.sessionId)

    const ownedTab = createWorkflowWebTab({ url: workflow.version.start.url, partition: workflowPartition })
    createdTabIds.push(ownedTab.id)

    const startPort = acquireWebTabPagePort(ownedTab.id, 'workflow')
    allPorts.push(startPort)

    const startAliasEntry = registerTabAlias(workflow.version.start.tabAlias, ownedTab.id, startPort, onTabDetached, onTabDestroyed)
    tabAliases.set(workflow.version.start.tabAlias, startAliasEntry)

    publishRun(runContext, 'running')

    await waitForWebTabLoad(ownedTab.id, DEFAULT_STEP_TIMEOUT_MS, controller.signal)
    await waitFor(DEFAULT_STEP_TIMEOUT_MS, () => {
      const tab = getWebTabState(ownedTab.id)
      ensureTabLoaded(ownedTab.id)
      if (!tab || tab.isLoading) return false
      try {
        ensureAllowedOrigin(tab.url, workflow.manifest.allowedOrigins, '')
        return true
      } catch {
        return false
      }
    }, controller.signal)

    for (const step of workflow.version.steps) {
      if (controller.signal.aborted) {
        throw new Error('Browser Workflow 已取消')
      }

      run.currentStepId = step.id
      appendStepEvent(runContext, 'step_started', step.id)

      currentStepTargetAlias = step.tabAlias
      activeTabAlias = currentStepTargetAlias

      let stepCompleted = false
      while (!stepCompleted) {
        if (controller.signal.aborted) {
          throw new Error('Browser Workflow 已取消')
        }

        let openTabCommitted = false

        // 校验步骤源 alias（所有步骤包括 openTab 均需校验源 tabAlias）
        let currentTabEntry = tabAliases.get(step.tabAlias)
        if (!currentTabEntry || closedAliases.has(step.tabAlias)) {
          throw new Error(`找不到页签别名: ${step.tabAlias}`)
        }
        if (currentTabEntry.destroyed || !getWebTabState(currentTabEntry.tabId)) {
          throw new Error(`网页页签已销毁: ${currentTabEntry.tabId}`)
        }
        if (currentTabEntry.detached) {
          currentTabEntry = await handleTabDetachedPauseAndReacquire(
            step.tabAlias,
            currentTabEntry,
            runContext,
            activeEntry,
            controller,
            tabAliases,
            allPorts,
            onTabDetached,
            onTabDestroyed,
          )
          continue
        }

        if (step.type === 'openTab') {
          if (tabAliases.has(step.newTabAlias) || closedAliases.has(step.newTabAlias)) {
            throw new Error(`重复的页签别名: ${step.newTabAlias}`)
          }
        }

        const stepController = new AbortController()
        currentStepAbortController = stepController

        const onParentAbort = (): void => stepController.abort()
        controller.signal.addEventListener('abort', onParentAbort)

        try {
          if (step.type === 'openTab') {
            if (step.url) {
              ensureAllowedOrigin(step.url, workflow.manifest.allowedOrigins, step.origin)
            }
            const newTab = createWorkflowWebTab({ url: step.url, partition: workflowPartition })
            createdTabIds.push(newTab.id)

            let tabCommitted = false
            let newPort: BrowserPagePort | undefined
            let newEntry: TabAliasEntry | undefined

            try {
              if (step.url) {
                await waitForWebTabLoad(newTab.id, step.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS, stepController.signal)
              }
              newPort = acquireWebTabPagePort(newTab.id, 'workflow')
              allPorts.push(newPort)
              newEntry = registerTabAlias(step.newTabAlias, newTab.id, newPort, onTabDetached, onTabDestroyed)
              tabAliases.set(step.newTabAlias, newEntry)
              activeTabAlias = step.newTabAlias
              tabCommitted = true
              openTabCommitted = true
            } finally {
              if (!tabCommitted) {
                if (newEntry) {
                  newEntry.cleanupListeners()
                  tabAliases.delete(step.newTabAlias)
                }
                if (newPort) {
                  try {
                    newPort.release()
                  } catch {}
                }
                if (!promotedTabIds.has(newTab.id)) {
                  try {
                    setWorkflowWebTabVisible(newTab.id, false)
                    closeWorkflowWebTab(newTab.id)
                  } catch {}
                }
              }
            }
          } else if (step.type === 'switchTab') {
            const target = tabAliases.get(step.targetTabAlias)
            if (!target || closedAliases.has(step.targetTabAlias)) {
              throw new Error(`找不到页签别名: ${step.targetTabAlias}`)
            }
            const targetTab = getWebTabState(target.tabId)
            if (!targetTab) {
              throw new Error(`网页页签已销毁: ${target.tabId}`)
            }
            activeTabAlias = step.targetTabAlias
            ensureAllowedOrigin(targetTab.url, workflow.manifest.allowedOrigins, step.origin)
          } else if (step.type === 'closeTab') {
            const target = tabAliases.get(step.targetTabAlias)
            if (!target || closedAliases.has(step.targetTabAlias)) {
              throw new Error(`找不到页签别名: ${step.targetTabAlias}`)
            }
            target.cleanupListeners()
            target.port.release()
            closeWorkflowWebTab(target.tabId)
            closedAliases.add(step.targetTabAlias)
            tabAliases.delete(step.targetTabAlias)
            activeTabAlias = step.tabAlias
          } else if (step.type === 'manual') {
            const entry = currentTabEntry
            setWorkflowWebTabVisible(entry.tabId, true)
            try {
              await new Promise<void>((resolve, reject) => {
                const onAbort = (): void => {
                  stepController.signal.removeEventListener('abort', onAbort)
                  activeEntry.resumeManual = undefined
                  reject(new Error('Browser Workflow 已取消'))
                }
                stepController.signal.addEventListener('abort', onAbort)
                activeEntry.resumeManual = (): void => {
                  stepController.signal.removeEventListener('abort', onAbort)
                  activeEntry.resumeManual = undefined
                  resolve()
                }
                publishRun(runContext, 'waiting_user', step.instruction)
              })
            } finally {
              activeEntry.resumeManual = undefined
              setWorkflowWebTabVisible(entry.tabId, false)
            }
            const currentTab = getWebTabState(entry.tabId)
            if (!currentTab) {
              throw new Error(`网页页签已销毁: ${entry.tabId}`)
            }
            ensureAllowedOrigin(currentTab.url, workflow.manifest.allowedOrigins, step.origin)
            publishRun(runContext, 'running')
          } else {
            // 页面级操作（navigate、click、fill、press、select、wait、assert）
            const entry = currentTabEntry

            if (step.type === 'click' && step.expect?.type === 'newTab') {
              const expectedAlias = step.expect.tabAlias
              if (tabAliases.has(expectedAlias) || closedAliases.has(expectedAlias)) {
                throw new Error(`重复的页签别名: ${expectedAlias}`)
              }

              const stepTimeoutMs = step.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS
              const collectedPopups: WebTabState[] = []
              let popupResolve: ((tab: WebTabState) => void) | undefined
              const popupPromise = new Promise<WebTabState>((resolve) => {
                popupResolve = resolve
              })

              const removePopupSub = subscribeWorkflowWebTabOpened(entry.tabId, (popupTab) => {
                if (!createdTabIds.includes(popupTab.id)) {
                  createdTabIds.push(popupTab.id)
                }
                collectedPopups.push(popupTab)
                popupResolve?.(popupTab)
              })

              let timeoutFired = false
              let timeoutTimer: NodeJS.Timeout | undefined
              const timeoutPromise = new Promise<never>((_, reject) => {
                timeoutTimer = setTimeout(() => {
                  timeoutFired = true
                  stepController.abort()
                  reject(new Error('Workflow 新页签等待超时'))
                }, stepTimeoutMs)
              })
              timeoutPromise.catch(() => {})

              const abortPromise = new Promise<never>((_, reject) => {
                if (stepController.signal.aborted) {
                  reject(new Error('Browser Workflow 已取消'))
                  return
                }
                stepController.signal.addEventListener('abort', () => {
                  if (timeoutFired) {
                    return
                  }
                  reject(new Error('Browser Workflow 已取消'))
                }, { once: true })
              })
              abortPromise.catch(() => {})

              let executionSucceeded = false
              try {
                const executorPromise = pageExecutor.execute({
                  step,
                  tabId: entry.tabId,
                  port: entry.port,
                  allowedOrigins: workflow.manifest.allowedOrigins,
                  variables,
                  signal: stepController.signal,
                })
                executorPromise.catch(() => {})

                const [pageStepResult, newTabState] = await Promise.race([
                  Promise.all([executorPromise, popupPromise]),
                  timeoutPromise,
                  abortPromise,
                ])

                if (pageStepResult.fallbackUsed) {
                  appendFallbackEvent(runContext, step.id)
                }

                const liveTabState = getWebTabState(newTabState.id)
                if (!liveTabState) {
                  throw new Error(`Workflow 弹出的新页签已销毁: ${newTabState.id}`)
                }

                await waitForWebTabLoad(newTabState.id, stepTimeoutMs, stepController.signal)
                const afterLoadTabState = getWebTabState(newTabState.id)
                if (!afterLoadTabState) {
                  throw new Error(`Workflow 弹出的新页签已销毁: ${newTabState.id}`)
                }
                ensureAllowedOrigin(afterLoadTabState.url, workflow.manifest.allowedOrigins, '')

                const newPort = acquireWebTabPagePort(newTabState.id, 'workflow')
                allPorts.push(newPort)
                const newEntry = registerTabAlias(expectedAlias, newTabState.id, newPort, onTabDetached, onTabDestroyed)
                tabAliases.set(expectedAlias, newEntry)
                activeTabAlias = expectedAlias
                executionSucceeded = true
              } catch (popupErr) {
                if (timeoutFired) {
                  throw new Error('Workflow 新页签等待超时')
                }
                throw popupErr
              } finally {
                if (timeoutTimer) clearTimeout(timeoutTimer)
                removePopupSub()

                if (!executionSucceeded) {
                  stepController.abort()
                  for (const popup of collectedPopups) {
                    if (!promotedTabIds.has(popup.id)) {
                      try {
                        setWorkflowWebTabVisible(popup.id, false)
                        closeWorkflowWebTab(popup.id)
                      } catch {}
                    }
                  }
                }
              }
            } else {
              const pageStepResult = await pageExecutor.execute({
                step,
                tabId: entry.tabId,
                port: entry.port,
                allowedOrigins: workflow.manifest.allowedOrigins,
                variables,
                signal: stepController.signal,
              })
              if (pageStepResult.fallbackUsed) {
                appendFallbackEvent(runContext, step.id)
              }
            }
          }

          // 步骤 resolve 瞬间与 detach / destroy 的竞态守护
          if (step.type === 'click' && step.expect?.type === 'newTab') {
            // popup 已成功确认，本步骤已完成，即使父页签在 resolve 边界 detach 也无需重试 popup
          } else if (step.type === 'openTab' && openTabCommitted) {
            // openTab 已成功提交新页签别名，本步骤已完成，源页签若处于 detach 状态留待后续实际使用源页签时恢复
          } else if (step.type === 'closeTab') {
            // closeTab 为主动关闭操作，无需对已关闭页签做存活守护
          } else if (currentTabEntry) {
            if (currentTabEntry.destroyed || !getWebTabState(currentTabEntry.tabId)) {
              throw new Error(`网页页签已销毁: ${currentTabEntry.tabId}`)
            }
            if (currentTabEntry.detached) {
              throw new Error(`CDP 已断开: ${currentTabEntry.detachReason || '网页 CDP 会话已断开'}`)
            }
          }

          appendStepEvent(runContext, 'step_completed', step.id)
          stepCompleted = true
        } catch (error) {
          if (controller.signal.aborted) {
            throw new Error('Browser Workflow 已取消')
          }
          if (currentTabEntry && (currentTabEntry.destroyed || !getWebTabState(currentTabEntry.tabId))) {
            throw new Error(`网页页签已销毁: ${currentTabEntry.tabId}`)
          }
          if (currentTabEntry && currentTabEntry.detached) {
            await handleTabDetachedPauseAndReacquire(
              step.tabAlias,
              currentTabEntry,
              runContext,
              activeEntry,
              controller,
              tabAliases,
              allPorts,
              onTabDetached,
              onTabDestroyed,
            )
            continue
          }
          throw error
        } finally {
          currentStepAbortController = undefined
          controller.signal.removeEventListener('abort', onParentAbort)
        }
      }
    }

    if (controller.signal.aborted) {
      throw new Error('Browser Workflow 已取消')
    }

    run.currentStepId = undefined
    publishRun(runContext, 'completed')
    return { ...run }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (controller.signal.aborted) {
      try {
        publishRun(runContext, 'cancelled', 'Workflow 已取消')
      } catch {}
      return { ...run }
    }

    const currentEntry = tabAliases.get(activeTabAlias)
    const currentActiveTabId = currentEntry?.tabId ?? createdTabIds.at(-1)
    const currentActivePort = currentEntry?.port

    await writeFailureArtifacts(runContext, currentActivePort, currentActiveTabId, message)

    if (currentActiveTabId) {
      try {
        handoffBrowserWorkflowFailure(input.sessionId, currentActiveTabId)
        promotedTabIds.add(currentActiveTabId)
      } catch (handoffError) {
        console.warn('[网页 Workflow] 移交失败页面给 Browser Agent 失败:', handoffError)
      }
    }

    try {
      publishRun(runContext, 'failed', message)
    } catch {}
    throw new Error(message)
  } finally {
    externalSignal?.removeEventListener('abort', abortFromExternal)
    activeEntry.resumeManual = undefined
    activeEntry.resumeCdp = undefined
    activeRuns.delete(input.sessionId)

    // 释放所有已建立的 tab alias 监听
    for (const entry of tabAliases.values()) {
      try {
        entry.cleanupListeners()
      } catch {}
    }

    // 释放所有已申请的 workflow ports
    for (const port of allPorts) {
      try {
        port.release()
      } catch {
        // 忽略重复或已释放错误
      }
    }

    // 逆创建顺序关闭非 promoted 的 workflow-owned 页签
    for (let i = createdTabIds.length - 1; i >= 0; i--) {
      const tabId = createdTabIds[i]
      if (tabId && !promotedTabIds.has(tabId)) {
        try {
          setWorkflowWebTabVisible(tabId, false)
          closeWorkflowWebTab(tabId)
        } catch {
          // 忽略关闭异常
        }
      }
    }

    // 释放 profile lease
    if (releaseProfileLease) {
      try {
        releaseProfileLease()
      } catch {}
    }
  }
}

export function stopAllBrowserWorkflowRuns(): void {
  for (const active of activeRuns.values()) {
    active.resumeManual = undefined
    active.resumeCdp = undefined
    active.controller.abort()
  }
}

export function continueBrowserWorkflowRun(sessionId: string): void {
  const active = activeRuns.get(sessionId)
  if (!active) throw new Error('当前没有正在运行的 Workflow')
  if (active.resumeCdp) {
    active.resumeCdp()
    return
  }
  if (active.resumeManual) {
    active.resumeManual()
    return
  }
  throw new Error('当前 Workflow 没有等待人工接管或 CDP 恢复')
}

export function stopBrowserWorkflowRun(sessionId: string): void {
  const active = activeRuns.get(sessionId)
  if (active) {
    active.resumeManual = undefined
    active.resumeCdp = undefined
    active.controller.abort()
  }
}
