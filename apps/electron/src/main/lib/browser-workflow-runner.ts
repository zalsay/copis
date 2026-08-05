import { randomUUID } from 'node:crypto'
import type {
  BrowserLocatorBundle,
  BrowserWorkflowAssertCondition,
  BrowserWorkflowOutcome,
  BrowserWorkflowRunInput,
  BrowserWorkflowRunSummary,
  BrowserWorkflowStep,
  BrowserWorkflowValue,
  BrowserWorkflowVariable,
  BrowserWorkflowWaitCondition,
} from '@copis/shared'
import {
  closeWorkflowWebTab,
  createWorkflowWebTab,
  waitForWebTabLoad,
  getWebTabLoadError,
  getWebTabState,
  navigateWebTab,
  sendWebTabCdpCommandInternal,
  setWorkflowWebTabVisible,
  subscribeWebTabCdpDetach,
  subscribeWebTabLifecycle,
} from './web-tab-manager'
import {
  getBrowserAgentContext,
  getBrowserAgentWorkspaceId,
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

interface EvaluationResult {
  result?: {
    value?: unknown
  }
  exceptionDetails?: {
    text?: string
  }
}

interface RunContext {
  input: BrowserWorkflowRunInput
  workflow: ReturnType<typeof getBrowserWorkflow>
  run: BrowserWorkflowRunSummary
  tabs: Map<string, string>
  popupTabs: Map<string, string>
  cdpGates: Map<string, CdpGate>
  signal: AbortSignal
}

interface CdpGate {
  sessionId: string
  detachedReason?: string
  removeListener?: () => void
  onResume?: () => void
  resume?: () => void
  needsDomainEnable?: boolean
}

interface ActiveRun {
  runId: string
  controller: AbortController
  resumeManual?: () => void
  resumeCdp?: () => void
  rejectManual?: (error: Error) => void
  manualTabId?: string
}

const activeRuns = new Map<string, ActiveRun>()
const DEFAULT_STEP_TIMEOUT_MS = 15_000
const POLL_INTERVAL_MS = 150

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function resolveValue(
  value: BrowserWorkflowValue,
  variables: Record<string, string | number | boolean>,
  definitions: BrowserWorkflowVariable[],
): string {
  if (value.kind === 'literal') return value.value ?? ''
  const definition = definitions.find((item) => item.key === value.variableKey)
  const resolved = value.variableKey ? variables[value.variableKey] ?? definition?.defaultValue : undefined
  if (resolved === undefined) throw new Error(`缺少 Workflow 变量: ${value.variableKey ?? 'unknown'}`)
  return String(resolved)
}

function resolveWorkflowPartition(profileId: string): string {
  if (profileId === 'copis-web') return 'persist:copis-web'
  return `persist:copis-workflow-${profileId}`
}

function validateWorkflowVariables(
  definitions: BrowserWorkflowVariable[],
  values: Record<string, string | number | boolean> | undefined,
): void {
  const provided = values ?? {}
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
  }
  for (const key of Object.keys(provided)) {
    if (!definitions.some((definition) => definition.key === key)) throw new Error(`未知 Workflow 变量: ${key}`)
  }
}

function ensureTabLoaded(tabId: string): void {
  const error = getWebTabLoadError(tabId)
  if (error) throw new Error(`网页加载失败: ${error}`)
}

function ensureAllowedOrigin(url: string, allowedOrigins: string[], expectedOrigin: string): void {
  let origin: string
  try {
    origin = new URL(url).origin
  } catch {
    throw new Error(`当前页面地址无效: ${url}`)
  }
  if (!allowedOrigins.includes(origin)) throw new Error(`页面 Origin 不在 Workflow 白名单内: ${origin}`)
  if (expectedOrigin && origin !== expectedOrigin) throw new Error(`页面 Origin 与步骤不匹配: ${origin}`)
}

function locatorExpression(locator: BrowserLocatorBundle): string {
  return JSON.stringify(locator)
}

function buildElementScript(locator: BrowserLocatorBundle, action: string, value?: string): string {
  const locatorJson = locatorExpression(locator)
  const valueJson = JSON.stringify(value ?? '')
  return `(() => {
    const locator = ${locatorJson};
    const fingerprint = locator.fingerprint || {};
    const visible = (element) => !!(element && (element.offsetWidth || element.offsetHeight || element.getClientRects().length));
    const enabled = (element) => !(element instanceof HTMLButtonElement || element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement) || !element.disabled;
    const normalize = (value) => String(value || '').trim().replace(/\\s+/g, ' ');
    const nameOf = (element) => normalize(element.getAttribute('aria-label') || element.getAttribute('title') || element.innerText || element.textContent || '');
    const roleOf = (element) => element.getAttribute('role') || ({ BUTTON: 'button', A: 'link', SELECT: 'combobox', TEXTAREA: 'textbox' }[element.tagName] || (element.tagName === 'INPUT' ? 'textbox' : undefined));
    const all = () => Array.from(document.querySelectorAll('*'));
    const addUnique = (items, element) => {
      if (element && visible(element) && !items.includes(element)) items.push(element);
    };
    const strategyMatches = (strategy) => {
      const items = [];
      try {
        if (strategy.kind === 'testId') {
          document.querySelectorAll('[' + CSS.escape(strategy.attribute) + '="' + CSS.escape(strategy.value) + '"]').forEach((element) => addUnique(items, element));
        } else if (strategy.kind === 'id') {
          addUnique(items, document.getElementById(strategy.value));
        } else if (strategy.kind === 'name') {
          document.querySelectorAll('[name="' + CSS.escape(strategy.value) + '"]').forEach((element) => addUnique(items, element));
        } else if (strategy.kind === 'css') {
          document.querySelectorAll(strategy.value).forEach((element) => addUnique(items, element));
        } else if (strategy.kind === 'label') {
          all().filter((element) => element.tagName === 'LABEL' && normalize(element.innerText || element.textContent) === strategy.value).forEach((label) => {
            addUnique(items, label.control || (label.htmlFor ? document.getElementById(label.htmlFor) : label.querySelector('input,textarea,select')));
          });
        } else if (strategy.kind === 'role') {
          all().filter((element) => roleOf(element) === strategy.role && (!strategy.name || nameOf(element) === strategy.name || nameOf(element).includes(strategy.name))).forEach((element) => addUnique(items, element));
        } else if (strategy.kind === 'text') {
          all().filter((element) => strategy.exact ? nameOf(element) === strategy.value : nameOf(element).includes(strategy.value)).forEach((element) => addUnique(items, element));
        }
      } catch (_) {}
      return items;
    };
    const score = (element, strategyIndex) => {
      let result = Math.max(1, 8 - strategyIndex);
      if (fingerprint.tagName && element.tagName.toLowerCase() === fingerprint.tagName) result += 3;
      if (fingerprint.inputType && element.type === fingerprint.inputType) result += 2;
      if (fingerprint.accessibleName) {
        const actualName = nameOf(element);
        if (actualName === normalize(fingerprint.accessibleName)) result += 4;
        else if (actualName.includes(normalize(fingerprint.accessibleName))) result += 1;
      }
      if (fingerprint.placeholder && element.getAttribute('placeholder') === fingerprint.placeholder) result += 2;
      if (fingerprint.href && element.href === fingerprint.href) result += 3;
      if (fingerprint.parentRole && element.parentElement && roleOf(element.parentElement) === fingerprint.parentRole) result += 1;
      if (fingerprint.nearbyText && element.parentElement && normalize(element.parentElement.innerText || element.parentElement.textContent).includes(normalize(fingerprint.nearbyText))) result += 1;
      if (typeof fingerprint.enabled === 'boolean' && enabled(element) === fingerprint.enabled) result += 1;
      return result;
    };
    const candidates = new Map();
    (locator.strategies || []).forEach((strategy, strategyIndex) => {
      for (const element of strategyMatches(strategy)) {
        const current = candidates.get(element);
        const strategyName = strategy.kind + (strategy.value ? ':' + strategy.value : '');
        if (current) {
          current.score += score(element, strategyIndex);
          current.strategies.push(strategyName);
          current.strategyIndex = Math.min(current.strategyIndex, strategyIndex);
        } else {
          candidates.set(element, { element, score: score(element, strategyIndex), strategyIndex, strategies: [strategyName] });
        }
      }
    });
    const ranked = Array.from(candidates.values()).sort((left, right) => right.score - left.score);
    const best = ranked[0];
    const second = ranked[1];
    if (!best) return { ok: false, reason: 'not_found', candidateCount: 0 };
    if (best.score < 5 || (second && best.score - second.score < 2)) {
      return { ok: false, reason: second ? 'ambiguous' : 'low_confidence', candidateCount: ranked.length, bestScore: best.score, secondScore: second?.score };
    }
    const metadata = { ok: true, strategy: best.strategies[0], fallbackUsed: best.strategyIndex > 0, candidateCount: ranked.length, score: best.score };
    const actionName = ${JSON.stringify(action)};
    if (actionName === 'click') {
      best.element.scrollIntoView({ block: 'center', inline: 'center' });
      const rect = best.element.getBoundingClientRect();
      return { ...metadata, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    }
    if (actionName === 'fill' || actionName === 'press') {
      best.element.scrollIntoView({ block: 'center', inline: 'center' });
      best.element.focus();
      return metadata;
    }
    if (actionName === 'select') {
      if (!(best.element instanceof HTMLSelectElement)) return { ok: false, reason: 'not_a_select' };
      const optionIndex = Array.from(best.element.options).findIndex((option) => option.value === ${valueJson});
      if (optionIndex < 0) return { ok: false, reason: 'option_not_found' };
      best.element.scrollIntoView({ block: 'center', inline: 'center' });
      best.element.focus();
      return { ...metadata, optionIndex };
    }
    if (actionName === 'visible') return { ...metadata, visible: true };
    return metadata;
  })()`
}

async function waitForCdpResume(gate: CdpGate, signal?: AbortSignal): Promise<void> {
  if (!gate.detachedReason) return
  await new Promise<void>((resolve, reject) => {
    let settled = false
    const active = activeRuns.get(gate.sessionId)
    const cleanup = (): void => {
      signal?.removeEventListener('abort', onAbort)
      if (active?.resumeCdp === resume) active.resumeCdp = undefined
      if (gate.resume === resume) gate.resume = undefined
    }
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      if (error) reject(error)
      else resolve()
    }
    const onAbort = (): void => finish(new Error('Browser Workflow 已取消'))
    const resume = (): void => {
      gate.detachedReason = undefined
      finish()
    }
    gate.resume = resume
    if (active) active.resumeCdp = resume
    signal?.addEventListener('abort', onAbort, { once: true })
  })
  gate.onResume?.()
}

async function sendCdpCommand(
  tabId: string,
  method: string,
  params: Record<string, unknown> | undefined,
  signal?: AbortSignal,
  gate?: CdpGate,
): Promise<unknown> {
  while (true) {
    if (signal?.aborted) throw new Error('Browser Workflow 已取消')
    if (gate?.detachedReason) await waitForCdpResume(gate, signal)
    if (gate?.needsDomainEnable) {
      await sendCdpCommand(tabId, 'Runtime.enable', undefined, signal)
      await sendCdpCommand(tabId, 'Page.enable', undefined, signal)
      gate.needsDomainEnable = false
    }
    try {
      const value = await new Promise<unknown>((resolve, reject) => {
        let settled = false
        const timer = setTimeout(() => finish(new Error(`网页 CDP 命令超时: ${method}`)), 10_000)
        const onAbort = (): void => finish(new Error('Browser Workflow 已取消'))
        const cleanup = (): void => {
          clearTimeout(timer)
          signal?.removeEventListener('abort', onAbort)
        }
        const finish = (error: Error | undefined, result?: unknown): void => {
          if (settled) return
          settled = true
          cleanup()
          if (error) reject(error)
          else resolve(result)
        }
        signal?.addEventListener('abort', onAbort, { once: true })
        sendWebTabCdpCommandInternal({ tabId, method, params })
          .then((result) => finish(undefined, result))
          .catch((error: unknown) => finish(error instanceof Error ? error : new Error(String(error))))
      })
      if (gate?.detachedReason) {
        await waitForCdpResume(gate, signal)
        continue
      }
      return value
    } catch (error) {
      if (gate?.detachedReason) {
        await waitForCdpResume(gate, signal)
        continue
      }
      throw error
    }
  }
}

async function evaluate(
  tabId: string,
  expression: string,
  signal?: AbortSignal,
  gate?: CdpGate,
  executionContextId?: number,
): Promise<unknown> {
  const params: Record<string, unknown> = {
    expression,
    returnByValue: true,
    awaitPromise: true,
  }
  if (executionContextId !== undefined) params.contextId = executionContextId
  const response = await sendCdpCommand(tabId, 'Runtime.evaluate', params, signal, gate) as EvaluationResult
  if (response.exceptionDetails?.text) throw new Error(response.exceptionDetails.text)
  return response.result?.value
}

interface FrameCandidate {
  id: string
  urls: string[]
  names: string[]
}

function comparableFrameUrl(url: string): string {
  try {
    const parsed = new URL(url)
    parsed.username = ''
    parsed.password = ''
    parsed.search = ''
    parsed.hash = ''
    return parsed.toString()
  } catch {
    return url
  }
}

function collectFrameCandidates(node: unknown, parentUrls: string[], parentNames: string[], result: FrameCandidate[]): void {
  if (!isRecord(node) || !isRecord(node.frame)) return
  const frame = node.frame
  const id = typeof frame.id === 'string' ? frame.id : undefined
  const url = typeof frame.url === 'string' ? frame.url : ''
  const name = typeof frame.name === 'string' ? frame.name : ''
  const urls = [...parentUrls, url]
  const names = [...parentNames, name]
  if (id) result.push({ id, urls, names })
  if (Array.isArray(node.childFrames)) {
    for (const child of node.childFrames) collectFrameCandidates(child, urls, names, result)
  }
}

function framePathMatches(candidate: FrameCandidate, locator: BrowserLocatorBundle): boolean {
  const frameUrls = locator.framePath.frameUrls ?? []
  const frameNames = locator.framePath.frameNames ?? []
  const singleFrameUrl = frameUrls[0]
  const singleFrameName = frameNames[0]
  if (frameUrls.length === 0) return false
  const urlMatches = frameUrls.length === candidate.urls.length
    ? frameUrls.every((url, index) => comparableFrameUrl(url) === comparableFrameUrl(candidate.urls[index] ?? ''))
    : frameUrls.length === 1 && singleFrameUrl !== undefined && comparableFrameUrl(singleFrameUrl) === comparableFrameUrl(candidate.urls.at(-1) ?? '')
  if (!urlMatches) return false
  if (frameNames.length === 0) return true
  return frameNames.length === candidate.names.length
    ? frameNames.every((name, index) => name === (candidate.names[index] ?? ''))
    : frameNames.length === 1 && singleFrameName !== undefined && singleFrameName === (candidate.names.at(-1) ?? '')
}

async function resolveFrameOwnerOffset(
  tabId: string,
  frameId: string,
  signal?: AbortSignal,
  gate?: CdpGate,
): Promise<{ x: number; y: number }> {
  const owner = await sendCdpCommand(tabId, 'DOM.getFrameOwner', { frameId }, signal, gate)
  const backendNodeId = isRecord(owner) && typeof owner.backendNodeId === 'number' ? owner.backendNodeId : undefined
  if (backendNodeId === undefined) throw new Error(`无法定位 Workflow Frame 宿主元素: ${frameId}`)
  const box = await sendCdpCommand(tabId, 'DOM.getBoxModel', { backendNodeId }, signal, gate)
  const model = isRecord(box) && isRecord(box.model) ? box.model : undefined
  const content = model?.content
  if (!Array.isArray(content) || content.length < 2) throw new Error(`无法读取 Workflow Frame 宿主坐标: ${frameId}`)
  const coordinates = content.filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
  if (coordinates.length < 2) throw new Error(`Workflow Frame 宿主坐标无效: ${frameId}`)
  const xValues = coordinates.filter((_value, index) => index % 2 === 0)
  const yValues = coordinates.filter((_value, index) => index % 2 === 1)
  return { x: Math.min(...xValues), y: Math.min(...yValues) }
}

async function resolveFrameCandidate(
  tabId: string,
  locator: BrowserLocatorBundle,
  signal?: AbortSignal,
  gate?: CdpGate,
): Promise<FrameCandidate> {
  if ((locator.framePath.frameUrls?.length ?? 0) === 0) {
    throw new Error('Workflow 定位器缺少可复用的 Frame 路径，请重新录制该步骤')
  }
  const response = await sendCdpCommand(tabId, 'Page.getFrameTree', undefined, signal, gate)
  const candidates: FrameCandidate[] = []
  if (isRecord(response)) collectFrameCandidates(response.frameTree, [], [], candidates)
  const matches = candidates.filter((candidate) => framePathMatches(candidate, locator))
  if (matches.length === 0) throw new Error('Workflow 目标 Frame 不存在或地址已变化')
  if (matches.length > 1) throw new Error('Workflow 目标 Frame 不明确，已拒绝执行')
  const match = matches[0]
  if (!match) throw new Error('Workflow 目标 Frame 不存在或地址已变化')
  return match
}

async function evaluateLocator(
  tabId: string,
  locator: BrowserLocatorBundle,
  expression: string,
  signal?: AbortSignal,
  gate?: CdpGate,
): Promise<unknown> {
  if ((locator.framePath.frameUrls?.length ?? 0) === 0) return evaluate(tabId, expression, signal, gate)
  const frame = await resolveFrameCandidate(tabId, locator, signal, gate)
  const worldResult = await sendCdpCommand(tabId, 'Page.createIsolatedWorld', {
    frameId: frame.id,
    worldName: 'copis-browser-workflow-runner',
    grantUniversalAccess: false,
  }, signal, gate)
  const executionContextId = isRecord(worldResult) && typeof worldResult.executionContextId === 'number'
    ? worldResult.executionContextId
    : undefined
  if (executionContextId === undefined) throw new Error(`无法创建 Workflow Frame 执行环境: ${frame.id}`)
  const result = await evaluate(tabId, expression, signal, gate, executionContextId)
  if (!isRecord(result) || typeof result.x !== 'number' || typeof result.y !== 'number') return result
  const offset = await resolveFrameOwnerOffset(tabId, frame.id, signal, gate)
  return { ...result, x: result.x + offset.x, y: result.y + offset.y }
}

async function waitFor(
  timeoutMs: number,
  check: () => Promise<boolean>,
  signal?: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error('Browser Workflow 已取消')
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
  }
  throw new Error('等待页面条件超时')
}

async function captureFailureArtifacts(context: RunContext, tabId: string, message: string): Promise<string[]> {
  const artifacts: string[] = []
  const tab = getWebTabState(tabId)
  const safeUrl = (() => {
    try {
      const url = new URL(tab?.url ?? '')
      url.username = ''
      url.password = ''
      url.search = ''
      url.hash = ''
      return url.toString()
    } catch {
      return ''
    }
  })()
  const loadError = getWebTabLoadError(tabId)
  if (loadError) {
    const path = writeBrowserWorkflowArtifact(
      context.input.workspaceId,
      context.input.workflowId,
      context.run.runId,
      'failure.json',
      JSON.stringify({ capturedAt: Date.now(), stepId: context.run.currentStepId, message, url: safeUrl, loadError }, null, 2),
    )
    return path ? [path] : []
  }
  try {
    const screenshot = await sendCdpCommand(
      tabId,
      'Page.captureScreenshot',
      { format: 'png', fromSurface: true },
      context.signal,
      context.cdpGates.get(tabId),
    )
    if (isRecord(screenshot) && typeof screenshot.data === 'string') {
      const path = writeBrowserWorkflowArtifact(
        context.input.workspaceId,
        context.input.workflowId,
        context.run.runId,
        'failure.png',
        new Uint8Array(Buffer.from(screenshot.data, 'base64')),
      )
      if (path) artifacts.push(path)
    }
  } catch {
    // 页面已经销毁或 DevTools 已断开时，保留文本诊断即可。
  }
  try {
    const domText = await evaluate(tabId, `(() => {
      const root = document.documentElement.cloneNode(true);
      root.querySelectorAll('input, textarea, select').forEach((element) => {
        element.removeAttribute('value');
        element.textContent = '[REDACTED]';
      });
      return (root.textContent || '').replace(/\\s+/g, ' ').slice(0, 20000);
    })()`, context.signal, context.cdpGates.get(tabId))
    const path = writeBrowserWorkflowArtifact(
      context.input.workspaceId,
      context.input.workflowId,
      context.run.runId,
      'failure.json',
      JSON.stringify({ capturedAt: Date.now(), stepId: context.run.currentStepId, message, url: safeUrl, text: typeof domText === 'string' ? domText : '' }, null, 2),
    )
    if (path) artifacts.push(path)
  } catch {
    // 忽略页面诊断失败，不影响 Workflow 的失败结果。
  }
  return artifacts
}
function getRunState(run: BrowserWorkflowRunSummary): 'idle' | 'running' | 'waiting_user' | 'paused_cdp_detached' | 'error' {
  if (run.status === 'waiting_user') return 'waiting_user'
  if (run.status === 'paused') return 'paused_cdp_detached'
  if (run.status === 'completed' || run.status === 'cancelled') return 'idle'
  if (run.status === 'failed') return 'error'
  return 'running'
}

function publishRun(context: RunContext, status: BrowserWorkflowRunSummary['status'], message?: string): void {
  context.run.status = status
  if (status === 'completed' || status === 'failed' || status === 'cancelled') context.run.finishedAt = Date.now()
  if (status === 'waiting_user') context.run.error = message
  else if (status === 'paused') context.run.error = message
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

function trackCdpGate(context: RunContext, tabId: string): CdpGate {
  const existing = context.cdpGates.get(tabId)
  if (existing) return existing
  const gate: CdpGate = {
    sessionId: context.input.sessionId,
    onResume: () => {
      if (context.run.status === 'paused') publishRun(context, 'running')
    },
  }
  gate.removeListener = subscribeWebTabCdpDetach(tabId, (reason) => {
    gate.detachedReason = reason || '网页 CDP 会话已断开'
    gate.needsDomainEnable = true
    if (context.run.status === 'running') publishRun(context, 'paused', gate.detachedReason)
  })
  context.cdpGates.set(tabId, gate)
  return gate
}

function untrackCdpGate(context: RunContext, tabId: string): void {
  const gate = context.cdpGates.get(tabId)
  if (!gate) return
  gate.removeListener?.()
  context.cdpGates.delete(tabId)
}

function clearCdpGates(context: RunContext): void {
  for (const tabId of context.cdpGates.keys()) untrackCdpGate(context, tabId)
}

async function assertCondition(
  tabId: string,
  target: BrowserLocatorBundle | undefined,
  condition: BrowserWorkflowAssertCondition,
  expectedOrigin: string,
  signal?: AbortSignal,
  gate?: CdpGate,
): Promise<boolean> {
  const tab = getWebTabState(tabId)
  if (!tab) return false
  ensureAllowedOrigin(tab.url, [expectedOrigin], expectedOrigin)
  if (condition.type === 'url') return new RegExp(condition.pattern).test(tab.url)
  if (condition.type === 'visible') {
    if (!target) return false
    const result = await evaluateLocator(tabId, target, buildElementScript(target, 'visible'), signal, gate)
    return isRecord(result) && result.ok === true
  }
  if (condition.type === 'hidden') {
    if (!target) return false
    const result = await evaluateLocator(tabId, target, buildElementScript(target, 'visible'), signal, gate)
    return !isRecord(result) || result.ok !== true
  }
  if (condition.type === 'text') {
    const result = await evaluate(tabId, `(() => ${JSON.stringify(condition.value)} ? document.body.innerText || document.body.textContent || '' : '')()`, signal, gate)
    const text = typeof result === 'string' ? result : ''
    return condition.exact ? text.trim() === condition.value : text.includes(condition.value)
  }
  ensureAllowedOrigin(tab.url, [expectedOrigin], expectedOrigin)
  return false
}

async function waitCondition(
  tabId: string,
  condition: BrowserWorkflowWaitCondition,
  timeoutMs: number,
  expectedOrigin: string,
  signal: AbortSignal,
  gate?: CdpGate,
): Promise<void> {
  await waitFor(timeoutMs, async () => {
    const tab = getWebTabState(tabId)
    if (!tab) return false
    ensureAllowedOrigin(tab.url, [expectedOrigin], expectedOrigin)
    if (condition.type === 'url') return new RegExp(condition.pattern).test(tab.url)
    if (condition.type === 'text') {
      const result = await evaluate(tabId, 'document.body ? (document.body.innerText || document.body.textContent || "") : ""', signal, gate)
      return typeof result === 'string' && result.includes(condition.value)
    }
    const result = await evaluateLocator(tabId, condition.target, buildElementScript(condition.target, 'visible'), signal, gate)
    ensureAllowedOrigin(tab.url, [expectedOrigin], expectedOrigin)
    return isRecord(result) && result.ok === true
  }, signal)
}

async function waitForManualStep(context: RunContext, step: Extract<BrowserWorkflowStep, { type: 'manual' }>, tabId: string): Promise<void> {
  const active = activeRuns.get(context.input.sessionId)
  if (!active) throw new Error('Browser Workflow 运行状态已丢失')
  ensureAllowedOrigin(
    getWebTabState(tabId)?.url ?? '',
    context.workflow.manifest.allowedOrigins,
    step.origin,
  )
  setWorkflowWebTabVisible(tabId, true)
  publishRun(context, 'waiting_user', step.instruction)

  await new Promise<void>((resolve, reject) => {
    let settled = false
    const removeLifecycleListener = subscribeWebTabLifecycle((event) => {
      if (event.type === 'closed' && event.tabId === tabId) {
        active.rejectManual?.(new Error(`人工接管页签已关闭: ${step.tabAlias}`))
      }
    })
    const cleanup = (): void => {
      removeLifecycleListener()
      context.signal.removeEventListener('abort', onAbort)
      active.resumeManual = undefined
      active.rejectManual = undefined
      active.manualTabId = undefined
    }
    const onAbort = (): void => {
      if (settled) return
      settled = true
      cleanup()
      setWorkflowWebTabVisible(tabId, false)
      reject(new Error('Browser Workflow 已取消'))
    }
    active.manualTabId = tabId
    active.resumeManual = (): void => {
      if (settled) return
      settled = true
      cleanup()
      try {
        const current = getWebTabState(tabId)
        if (!current) throw new Error(`人工接管页签已关闭: ${step.tabAlias}`)
        ensureAllowedOrigin(current.url, context.workflow.manifest.allowedOrigins, step.origin)
        setWorkflowWebTabVisible(tabId, false)
        publishRun(context, 'running')
        resolve()
      } catch (error) {
        setWorkflowWebTabVisible(tabId, false)
        reject(error)
      }
    }
    active.rejectManual = (error: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      setWorkflowWebTabVisible(tabId, false)
      reject(error)
    }
    context.signal.addEventListener('abort', onAbort, { once: true })
  })
}

async function executeClickStep(
  context: RunContext,
  step: Extract<BrowserWorkflowStep, { type: 'click' }>,
  tabId: string,
): Promise<void> {
  const createdTabIds: string[] = []
  let navigationUrl: string | undefined
  let navigationError: Error | undefined
  const claimedTabIds = new Set<string>()
  const removeLifecycleListener = subscribeWebTabLifecycle((event) => {
    if (event.type === 'created' && event.workflowOwned && event.openerTabId === tabId) {
      createdTabIds.push(event.tabId)
    }
    if (event.type === 'navigated' && event.workflowOwned && event.tabId === tabId) {
      try {
        ensureAllowedOrigin(event.url ?? '', context.workflow.manifest.allowedOrigins, '')
        navigationUrl = event.url
      } catch (error) {
        navigationError = error instanceof Error ? error : new Error(String(error))
      }
    }
  })
  try {
    const result = requireElementResult(
      await evaluateLocator(tabId, step.target, buildElementScript(step.target, 'click'), context.signal, context.cdpGates.get(tabId)),
      step.id,
    )
    appendFallbackEvent(context, step.id, result)
    await dispatchMouseClick(tabId, requireClickPoint(result, step.id), context.signal, context.cdpGates.get(tabId))
    const outcome: BrowserWorkflowOutcome | undefined = step.expect
    if (!outcome) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      return
    }
    const timeoutMs = step.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS
    if (outcome.type === 'newTab') {
      await waitFor(timeoutMs, async () => createdTabIds.length > 0, context.signal)
      const newTabId = createdTabIds[0]
      if (!newTabId) throw new Error(`Workflow 新页签没有返回有效页签 ID: ${outcome.tabAlias}`)
      if (createdTabIds.length > 1) {
        for (const extraTabId of createdTabIds.slice(1)) closeWorkflowWebTab(extraTabId)
      }
      const newTab = getWebTabState(newTabId)
      if (!newTab) throw new Error(`Workflow 新页签创建后立即关闭: ${outcome.tabAlias}`)
      ensureAllowedOrigin(newTab.url, context.workflow.manifest.allowedOrigins, '')
      trackCdpGate(context, newTabId)
      await waitForWebTabLoad(newTabId, timeoutMs, context.signal)
      ensureTabLoaded(newTabId)
      context.tabs.set(outcome.tabAlias, newTabId)
      context.popupTabs.set(outcome.tabAlias, newTabId)
      claimedTabIds.add(newTabId)
      return
    }
    if (outcome.type === 'navigation') {
      await waitFor(timeoutMs, async () => {
        if (navigationError) throw navigationError
        if (!navigationUrl) return false
        return !outcome.urlPattern || new RegExp(outcome.urlPattern).test(navigationUrl)
      }, context.signal)
      await waitForWebTabLoad(tabId, timeoutMs, context.signal)
      ensureTabLoaded(tabId)
      const settled = getWebTabState(tabId)
      if (!settled) throw new Error(`Workflow 点击后的页签已关闭: ${step.id}`)
      ensureAllowedOrigin(settled.url, context.workflow.manifest.allowedOrigins, '')
      return
    }
    await waitFor(timeoutMs, async () => {
      const visibleResult = await evaluateLocator(tabId, outcome.target, buildElementScript(outcome.target, 'visible'), context.signal, context.cdpGates.get(tabId))
      const resolved = requireElementResult(visibleResult, `${step.id}:expect.visible`)
      appendFallbackEvent(context, step.id, resolved)
      return true
    }, context.signal)
  } finally {
    removeLifecycleListener()
    for (const createdTabId of createdTabIds) {
      if (!claimedTabIds.has(createdTabId)) closeWorkflowWebTab(createdTabId)
    }
  }
}

interface ElementResolutionResult {
  fallbackUsed: boolean
  x?: number
  y?: number
  optionIndex?: number
}

function requireElementResult(value: unknown, stepId: string): ElementResolutionResult {
  if (!isRecord(value) || value.ok !== true) {
    const reason = isRecord(value) && typeof value.reason === 'string' ? value.reason : 'not_found'
    if (reason === 'ambiguous') throw new Error(`AMBIGUOUS_TARGET: 无法唯一确定 Workflow 元素: ${stepId}`)
    if (reason === 'low_confidence') throw new Error(`LOW_CONFIDENCE_TARGET: Workflow 元素匹配置信度不足: ${stepId}`)
    throw new Error(`无法定位 Workflow 元素: ${stepId}`)
  }
  const fallbackUsed = value.fallbackUsed === true
  const x = typeof value.x === 'number' && Number.isFinite(value.x) ? value.x : undefined
  const y = typeof value.y === 'number' && Number.isFinite(value.y) ? value.y : undefined
  const optionIndex = typeof value.optionIndex === 'number' && Number.isInteger(value.optionIndex) && value.optionIndex >= 0 ? value.optionIndex : undefined
  return { fallbackUsed, x, y, optionIndex }
}

function requireClickPoint(result: ElementResolutionResult, stepId: string): { x: number; y: number } {
  if (result.x === undefined || result.y === undefined) throw new Error(`Workflow 元素没有可用点击坐标: ${stepId}`)
  return { x: result.x, y: result.y }
}

function requireSelectOption(result: ElementResolutionResult, stepId: string): number {
  if (result.optionIndex === undefined) throw new Error(`Workflow 下拉选项不可用: ${stepId}`)
  return result.optionIndex
}

function appendFallbackEvent(context: RunContext, stepId: string, result: ElementResolutionResult): void {
  if (!result.fallbackUsed) return
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

async function dispatchMouseClick(tabId: string, point: { x: number; y: number }, signal: AbortSignal, gate?: CdpGate): Promise<void> {
  await sendCdpCommand(tabId, 'Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: point.x,
    y: point.y,
    button: 'left',
    clickCount: 1,
  }, signal, gate)
  await sendCdpCommand(tabId, 'Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: point.x,
    y: point.y,
    button: 'left',
    clickCount: 1,
  }, signal, gate)
}

async function dispatchFillText(tabId: string, value: string, signal: AbortSignal, gate?: CdpGate): Promise<void> {
  const isMac = process.platform === 'darwin'
  const modifier = isMac ? 'Meta' : 'Control'
  const modifierCode = isMac ? 'MetaLeft' : 'ControlLeft'
  const modifierMask = isMac ? 4 : 2
  await sendCdpCommand(tabId, 'Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: modifier,
    code: modifierCode,
    modifiers: modifierMask,
  }, signal, gate)
  await sendCdpCommand(tabId, 'Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'a',
    code: 'KeyA',
    modifiers: modifierMask,
  }, signal, gate)
  await sendCdpCommand(tabId, 'Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'a',
    code: 'KeyA',
    modifiers: modifierMask,
  }, signal, gate)
  await sendCdpCommand(tabId, 'Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: modifier,
    code: modifierCode,
  }, signal, gate)
  await sendCdpCommand(tabId, 'Input.insertText', { text: value }, signal, gate)
}

async function dispatchSelectOption(tabId: string, optionIndex: number, signal: AbortSignal, gate?: CdpGate): Promise<void> {
  await dispatchKeyPress(tabId, 'Home', signal, gate)
  for (let index = 0; index < optionIndex; index += 1) {
    await dispatchKeyPress(tabId, 'ArrowDown', signal, gate)
  }
  await dispatchKeyPress(tabId, 'Enter', signal, gate)
}

async function dispatchKeyPress(tabId: string, key: string, signal: AbortSignal, gate?: CdpGate): Promise<void> {
  const params: Record<string, unknown> = {
    key,
    code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
  }
  if (key.length === 1) params.text = key
  await sendCdpCommand(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', ...params }, signal, gate)
  await sendCdpCommand(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...params }, signal, gate)
}

async function executeStep(context: RunContext, step: BrowserWorkflowStep): Promise<void> {
  if (context.signal.aborted) throw new Error('Browser Workflow 已取消')
  const timeoutMs = step.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS
  const tabId = context.tabs.get(step.tabAlias)
  if (step.type === 'openTab') {
    const popupTabId = context.popupTabs.get(step.newTabAlias)
    if (popupTabId) {
      context.popupTabs.delete(step.newTabAlias)
      const popupTab = getWebTabState(popupTabId)
      if (!popupTab) throw new Error(`弹出页签已关闭: ${step.newTabAlias}`)
      ensureTabLoaded(popupTabId)
      ensureAllowedOrigin(popupTab.url, context.workflow.manifest.allowedOrigins, step.origin)
      trackCdpGate(context, popupTabId)
      return
    }
    if (context.tabs.has(step.newTabAlias)) throw new Error(`Workflow 页签别名重复: ${step.newTabAlias}`)
    const created = createWorkflowWebTab(step.url ? { url: step.url } : {})
    context.tabs.set(step.newTabAlias, created.id)
    trackCdpGate(context, created.id)
    if (step.url) {
      await waitForWebTabLoad(created.id, timeoutMs, context.signal)
      const current = getWebTabState(created.id)
      if (!current) throw new Error(`页签已关闭: ${step.newTabAlias}`)
      ensureTabLoaded(created.id)
      ensureAllowedOrigin(current.url, context.workflow.manifest.allowedOrigins, step.origin)
    }
    return
  }
  if (!tabId) throw new Error(`找不到页签别名: ${step.tabAlias}`)
  const tab = getWebTabState(tabId)
  if (!tab) throw new Error(`页签已关闭: ${step.tabAlias}`)
  if (step.type !== 'navigate') ensureAllowedOrigin(tab.url, context.workflow.manifest.allowedOrigins, step.origin)
  const variables = context.input.variables ?? {}

  if (step.type === 'navigate') {
    ensureAllowedOrigin(step.url, context.workflow.manifest.allowedOrigins, step.origin)
    navigateWebTab({ tabId, url: step.url })
    await waitForWebTabLoad(tabId, timeoutMs, context.signal)
    await waitFor(timeoutMs, async () => {
      const next = getWebTabState(tabId)
      ensureTabLoaded(tabId)
      return Boolean(next && !next.isLoading && new RegExp(step.urlPattern ?? step.url).test(next.url))
    }, context.signal)
    return
  }
  if (step.type === 'click') {
    await executeClickStep(context, step, tabId)
    return
  }
  if (step.type === 'fill' || step.type === 'press' || step.type === 'select') {
    const value = 'value' in step ? resolveValue(step.value, variables, context.workflow.version.variables) : undefined
    if (step.type === 'press' && !step.target) {
      const focused = await evaluate(tabId, '(() => { const element = document.activeElement; if (!element) return { ok: false, reason: \'not_found\' }; element.focus(); return { ok: true }; })()', context.signal, context.cdpGates.get(tabId))
      if (!isRecord(focused) || focused.ok !== true) throw new Error(`无法定位 Workflow 当前焦点元素: ${step.id}`)
    } else if (step.target) {
      const action = step.type === 'fill' ? 'fill' : step.type === 'press' ? 'press' : 'select'
      const result = requireElementResult(await evaluateLocator(tabId, step.target, buildElementScript(step.target, action, value), context.signal, context.cdpGates.get(tabId)), step.id)
      appendFallbackEvent(context, step.id, result)
      if (step.type === 'fill') await dispatchFillText(tabId, value ?? '', context.signal, context.cdpGates.get(tabId))
      if (step.type === 'select') await dispatchSelectOption(tabId, requireSelectOption(result, step.id), context.signal, context.cdpGates.get(tabId))
    } else {
      throw new Error(`Workflow 步骤缺少目标元素: ${step.id}`)
    }
    if (step.type === 'press') await dispatchKeyPress(tabId, step.key, context.signal, context.cdpGates.get(tabId))
    return
  }
  if (step.type === 'wait') {
    await waitCondition(tabId, step.condition, timeoutMs, step.origin, context.signal, context.cdpGates.get(tabId))
    return
  }
  if (step.type === 'assert') {
    await waitFor(timeoutMs, () => assertCondition(tabId, step.target, step.condition, step.origin, context.signal, context.cdpGates.get(tabId)), context.signal)
    return
  }
  if (step.type === 'switchTab') {
    const nextTabId = context.tabs.get(step.targetTabAlias)
    if (!nextTabId || !getWebTabState(nextTabId)) throw new Error(`找不到目标页签别名: ${step.targetTabAlias}`)
    return
  }
  if (step.type === 'closeTab') {
    const targetTabId = context.tabs.get(step.targetTabAlias)
    if (!targetTabId) throw new Error(`找不到目标页签别名: ${step.targetTabAlias}`)
    closeWorkflowWebTab(targetTabId)
    untrackCdpGate(context, targetTabId)
    context.tabs.delete(step.targetTabAlias)
    context.popupTabs.delete(step.targetTabAlias)
    return
  }
  if (step.type === 'manual') {
    await waitForManualStep(context, step, tabId)
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
  validateWorkflowVariables(workflow.version.variables, input.variables)
  const context = getBrowserAgentContext(input.sessionId)
  const boundWorkspaceId = getBrowserAgentWorkspaceId(input.sessionId)
  if (context && boundWorkspaceId !== input.workspaceId) {
    throw new Error('Browser Agent 会话工作区与 Workflow 工作区不一致')
  }
  if (input.source === 'user' && !context) throw new Error('Browser Agent 尚未绑定网页页签')
  if (context && !getWebTabState(context.tabId)) throw new Error('当前网页页签不存在')
  const startOrigin = new URL(workflow.version.start.url).origin
  if (!workflow.manifest.allowedOrigins.includes(startOrigin)) {
    throw new Error(`Workflow 起始页面不在允许的 Origin 范围内: ${startOrigin}`)
  }
  const workflowPartition = resolveWorkflowPartition(workflow.manifest.profileId)
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
    tabs: new Map([[workflow.version.start.tabAlias, ownedTab.id]]),
    popupTabs: new Map(),
    cdpGates: new Map(),
    signal: controller.signal,
  }
  trackCdpGate(runContext, ownedTab.id)
  activeRuns.set(input.sessionId, { runId: run.runId, controller })
  publishRun(runContext, 'running')
  try {
    await waitForWebTabLoad(ownedTab.id, DEFAULT_STEP_TIMEOUT_MS, controller.signal)
    await waitFor(DEFAULT_STEP_TIMEOUT_MS, async () => {
      const startTab = getWebTabState(ownedTab.id)
      ensureTabLoaded(ownedTab.id)
      if (!startTab || startTab.isLoading) return false
      try {
        return workflow.manifest.allowedOrigins.includes(new URL(startTab.url).origin)
      } catch {
        return false
      }
    }, controller.signal)
    for (const step of workflow.version.steps) {
      run.currentStepId = step.id
      appendBrowserWorkflowRunEvent(input.workspaceId, input.workflowId, {
        runId: run.runId,
        workflowId: input.workflowId,
        version: run.version,
        timestamp: Date.now(),
        type: 'step_started',
        stepId: step.id,
        status: 'running',
      })
      await executeStep(runContext, step)
      appendBrowserWorkflowRunEvent(input.workspaceId, input.workflowId, {
        runId: run.runId,
        workflowId: input.workflowId,
        version: run.version,
        timestamp: Date.now(),
        type: 'step_completed',
        stepId: step.id,
        status: 'running',
      })
    }
    run.currentStepId = undefined
    publishRun(runContext, 'completed')
    return { ...run }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (controller.signal.aborted) {
      publishRun(runContext, 'cancelled', 'Workflow 已取消')
      return { ...run }
    }
    run.artifacts = await captureFailureArtifacts(
      runContext,
      runContext.tabs.get(workflow.version.steps.find((step) => step.id === run.currentStepId)?.tabAlias ?? workflow.version.start.tabAlias) ?? ownedTab.id,
      message,
    )
    publishRun(runContext, 'failed', message)
    throw new Error(message)
  } finally {
    externalSignal?.removeEventListener('abort', abortFromExternal)
    clearCdpGates(runContext)
    for (const tabId of new Set(runContext.tabs.values())) closeWorkflowWebTab(tabId)
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
  const active = activeRuns.get(sessionId)
  if (active) active.controller.abort()
}
