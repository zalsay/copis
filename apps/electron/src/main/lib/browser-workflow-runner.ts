import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import type {
  BrowserWorkflowRunInput,
  BrowserWorkflowRunSummary,
  BrowserWorkflowStatus,
} from '@copis/shared'
import {
  closeWorkflowWebTab,
  createWorkflowWebTab,
  getWebTabCdpTargetId,
  getWebTabLoadError,
  getWebTabState,
  setWorkflowWebTabVisible,
  subscribeWebTabCdpDetach,
  waitForWebTabLoad,
} from './web-tab-manager'
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
  getBrowserWorkflowArtifactDirectory,
  saveLatestBrowserWorkflowRun,
  writeBrowserWorkflowArtifact,
} from './browser-workflow-store'
import { getFunctionalModulePath } from './functional-module-manager'
import { getPlaywrightCdpEndpoint } from './playwright-cdp-endpoint'
import { resolvePlaywrightCoreEntrypoint } from './playwright-core-runtime'
import {
  assertBrowserWorkflowPlaywrightScriptIntegrity,
  getBrowserWorkflowPlaywrightVersionPath,
  writeBrowserWorkflowPlaywrightVersion,
} from './browser-workflow-playwright-script'
import {
  startBrowserWorkflowPlaywrightScript,
  type BrowserWorkflowPlaywrightScriptEvent,
  type BrowserWorkflowPlaywrightScriptSession,
} from './browser-workflow-playwright-executor'

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
  ownedTabId: string
  signal: AbortSignal
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
    if (definition.type === 'choice' && (!definition.options?.includes(String(value)))) throw new Error(`Workflow 变量选项无效: ${definition.key}`)
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
    const tick = (): void => {
      if (signal.aborted) {
        reject(new Error('Browser Workflow 已取消'))
        return
      }
      if (check()) {
        resolve()
        return
      }
      if (Date.now() >= deadline) {
        reject(new Error('等待页面加载超时'))
        return
      }
      setTimeout(tick, POLL_INTERVAL_MS)
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

function safeArtifactName(value: string): string | undefined {
  return /^[a-zA-Z0-9_.-]+$/.test(value) ? value : undefined
}

function collectScriptArtifacts(context: RunContext, names: string[]): void {
  const artifacts = names
    .map(safeArtifactName)
    .filter((name): name is string => Boolean(name))
    .map((name) => `artifacts/${context.run.runId}/${name}`)
  if (artifacts.length > 0) context.run.artifacts = [...new Set([...(context.run.artifacts ?? []), ...artifacts])]
}

function handleScriptEvent(
  context: RunContext,
  session: BrowserWorkflowPlaywrightScriptSession,
  event: BrowserWorkflowPlaywrightScriptEvent,
): void {
  const active = activeRuns.get(context.input.sessionId)
  if (!active) return
  if (event.type === 'step_started') {
    context.run.currentStepId = event.stepId
    appendStepEvent(context, 'step_started', event.stepId)
  } else if (event.type === 'step_completed') {
    appendStepEvent(context, 'step_completed', event.stepId)
  } else if (event.type === 'fallback_used') {
    appendFallbackEvent(context, event.stepId)
  } else if (event.type === 'waiting_user') {
    setWorkflowWebTabVisible(context.ownedTabId, true)
    active.resumeManual = (): void => {
      active.resumeManual = undefined
      session.send('continue_manual')
    }
    publishRun(context, 'waiting_user', event.message)
  } else if (event.type === 'paused') {
    active.resumeCdp = (): void => {
      active.resumeCdp = undefined
      session.send('resume_cdp')
    }
    publishRun(context, 'paused', event.message)
  } else if (event.type === 'resumed') {
    active.resumeCdp = undefined
    active.resumeManual = undefined
    setWorkflowWebTabVisible(context.ownedTabId, false)
    publishRun(context, 'running')
  } else if (event.type === 'artifacts') {
    collectScriptArtifacts(context, event.artifacts)
  }
}

async function writeMainFailureArtifact(context: RunContext, message: string): Promise<void> {
  if (context.run.artifacts?.length) return
  const tab = getWebTabState(context.ownedTabId)
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
  const path = writeBrowserWorkflowArtifact(
    context.input.workspaceId,
    context.input.workflowId,
    context.run.runId,
    'failure.json',
    JSON.stringify({ capturedAt: Date.now(), stepId: context.run.currentStepId, message, url }, null, 2),
  )
  if (path) context.run.artifacts = [path]
}

export function resolveNodeRuntimeEntrypoint(): string {
  const entrypoint = getFunctionalModulePath('node-runtime')
  if (!entrypoint) throw new Error('未找到已激活的 Node.js 运行环境，请重新准备必要组件')
  return entrypoint
}

async function runGeneratedScript(context: RunContext, targetId: string, variables: Record<string, string | number | boolean>): Promise<void> {
  const scriptPath = getBrowserWorkflowPlaywrightVersionPath(
    context.input.workspaceId,
    context.input.workflowId,
    context.workflow.version.version,
  )
  if (!existsSync(scriptPath)) writeBrowserWorkflowPlaywrightVersion(context.input.workspaceId, context.workflow.version)
  assertBrowserWorkflowPlaywrightScriptIntegrity(context.workflow.version, scriptPath)
  const artifactDirectory = getBrowserWorkflowArtifactDirectory(
    context.input.workspaceId,
    context.input.workflowId,
    context.run.runId,
  )
  let session: BrowserWorkflowPlaywrightScriptSession | undefined
  session = startBrowserWorkflowPlaywrightScript({
    nodeExecutable: resolveNodeRuntimeEntrypoint(),
    scriptPath,
    cdpEndpoint: await getPlaywrightCdpEndpoint(),
    targetId,
    playwrightCoreEntrypoint: resolvePlaywrightCoreEntrypoint(),
    artifactDirectory,
    variables,
    signal: context.signal,
    onEvent: (event) => {
      if (session) handleScriptEvent(context, session, event)
    },
  })
  const active = activeRuns.get(context.input.sessionId)
  if (!active) {
    session.cancel()
    throw new Error('Browser Workflow 运行状态已丢失')
  }
  let detachedReason: string | undefined
  const removeDetachListener = subscribeWebTabCdpDetach(context.ownedTabId, (reason) => {
    detachedReason = reason || '网页 CDP 会话已断开'
    if (context.run.status === 'running') publishRun(context, 'paused', detachedReason)
    active.resumeCdp = (): void => {
      detachedReason = undefined
      active.resumeCdp = undefined
      session?.send('resume_cdp')
      if (context.run.status === 'paused') publishRun(context, 'running')
    }
  })
  try {
    await session.promise
    if (detachedReason) throw new Error(detachedReason)
  } finally {
    removeDetachListener()
    active.resumeManual = undefined
    active.resumeCdp = undefined
  }
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
  const releaseProfileLease = acquireBrowserWorkflowProfileLease(workflowPartition, input.sessionId)
  const ownedTab = (() => {
    try {
      return createWorkflowWebTab({ url: workflow.version.start.url, partition: workflowPartition })
    } catch (error) {
      releaseProfileLease()
      throw error
    }
  })()
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
    ownedTabId: ownedTab.id,
    signal: controller.signal,
  }
  activeRuns.set(input.sessionId, { runId: run.runId, controller })
  publishRun(runContext, 'running')
  try {
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
    const targetId = await getWebTabCdpTargetId(ownedTab.id)
    await runGeneratedScript(runContext, targetId, variables)
    run.currentStepId = undefined
    publishRun(runContext, 'completed')
    return { ...run }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (controller.signal.aborted) {
      publishRun(runContext, 'cancelled', 'Workflow 已取消')
      return { ...run }
    }
    await writeMainFailureArtifact(runContext, message)
    try {
      handoffBrowserWorkflowFailure(input.sessionId, ownedTab.id)
    } catch (handoffError) {
      console.warn('[网页 Workflow] 移交失败页面给 Browser Agent 失败:', handoffError)
    }
    publishRun(runContext, 'failed', message)
    throw new Error(message)
  } finally {
    externalSignal?.removeEventListener('abort', abortFromExternal)
    setWorkflowWebTabVisible(ownedTab.id, false)
    closeWorkflowWebTab(ownedTab.id)
    releaseProfileLease()
    activeRuns.delete(input.sessionId)
  }
}

export function stopAllBrowserWorkflowRuns(): void {
  for (const active of activeRuns.values()) active.controller.abort()
}

export function continueBrowserWorkflowRun(sessionId: string): void {
  const active = activeRuns.get(sessionId)
  if (!active) throw new Error('当前没有正在运行的 Workflow')
  if (active.resumeManual) {
    active.resumeManual()
    return
  }
  if (active.resumeCdp) {
    active.resumeCdp()
    return
  }
  throw new Error('当前 Workflow 没有等待人工接管或 CDP 恢复')
}

export function stopBrowserWorkflowRun(sessionId: string): void {
  activeRuns.get(sessionId)?.controller.abort()
}
