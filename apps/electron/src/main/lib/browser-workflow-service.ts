import { createHash, randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import type {
  BrowserAgentContext,
  BrowserFramePath,
  BrowserPageControlMode,
  BrowserRecordedTarget,
  BrowserRecordedValue,
  BrowserRecordingEvent,
  BrowserWorkflowManifest,
  BrowserWorkflowRecordingArtifact,
  BrowserWorkflowRecordingSummary,
  BrowserWorkflowStatus,
  BrowserWorkflowVersion,
} from '@copis/shared'
import type { BrowserPageAuthorizationMap } from '../../types'
import {
  authorizeBrowserPageOrigin,
  normalizeBrowserPageOrigin,
  resolveBrowserPageControlState,
} from './browser-page-control-policy'
import { getAgentSessionMeta, updateAgentSessionMeta } from './agent-session-manager'
import {
  getAgentWorkspace,
  ensureAgentWorkspaceBrowserSessionPath,
  getAgentWorkspaceWritableRoot,
  getProjectFilesPath,
  getWorkspaceAttachedDirectories,
  getWorkspaceAttachedFiles,
} from './agent-workspace-manager'
import { getAgentSessionWorkspacePath } from './config-paths'
import { isPathWithinAuthorizedRoots, realpathOrResolve } from './file-access-policy'
import { getSettings, updateSettings } from './settings-service'
import {
  getBrowserWorkflow,
  promoteBrowserWorkflowDraftMarkdown,
  saveBrowserWorkflow,
  writeBrowserWorkflowDraftMarkdown,
} from './browser-workflow-store'
import { assertBrowserWorkflowVersion } from './browser-workflow-schema'
import {
  appendRustBrowserRecordingEvent,
  cancelRustBrowserRecording,
  finishRustBrowserRecording,
  readRustBrowserRecording,
  releaseRustBrowserRecording,
  startRustBrowserRecording,
} from './rust-browser-recording-client'
import {
  createWebTab,
  getWebTabState,
  promoteWorkflowWebTab,
  acquireWebTabPagePort,
  subscribeWebTabLifecycle,
} from './web-tab-manager'
import type { BrowserCdpMethod, BrowserPagePort } from './browser-page-port'
import {
  revokeBrowserAgentWorkerCapability,
  updateBrowserAgentWorkerCapabilityTabId,
} from './browser-agent-worker-capability'

interface BrowserAgentBinding {
  sessionId: string
  workspaceId: string
  workspaceSlug: string
  ownerWebContentsId?: number
  context: BrowserAgentContext
  authorizedOrigins: Set<string>
  cdpPort: BrowserPagePort
}

interface RecordingPayload {
  type: 'click' | 'input' | 'change' | 'submit' | 'key'
  nonce?: string
  url?: string
  target?: BrowserRecordedTarget
  value?: BrowserRecordedValue
  key?: string
}

interface RecordingPage {
  tabId: string
  tabAlias: string
  origin: string
  cdpPort: BrowserPagePort
  removeCdpListener: () => void
  removeCdpDetachListener: () => void
  removeCdpDestroyedListener: () => void
  scriptId?: string
  worldName?: string
  released?: boolean
}

interface ActiveRecording {
  recordingId: string
  recordingDirectory: string
  nonce: string
  sessionId: string
  workspaceId: string
  workspaceSlug: string
  startTabId: string
  startUrl: string
  activeTabId: string
  eventCount: number
  appendChain: Promise<void>
  storageError?: string
  pages: Map<string, RecordingPage>
  startedAt: number
  nextAliasIndex: number
  removeLifecycleListener: () => void
  pendingAction?: PendingRecordedAction
}

interface FinishedRecording extends BrowserWorkflowRecordingSummary {
  workspaceId: string
  workspaceSlug: string
  startTabId: string
  startUrl: string
  observedTypes: Set<string>
  observedOrigins: Set<string>
}

interface RecordingWaiter {
  resolve: (summary: BrowserWorkflowRecordingSummary) => void
  reject: (error: Error) => void
}
interface CdpFrameInfo {
  id?: string
  parentId?: string
  url?: string
}

interface CdpBindingCalledParams {
  name?: string
  payload?: string
}

interface CdpFrameNavigatedParams {
  frame?: CdpFrameInfo
}

interface CdpScriptIdentifier {
  identifier?: string
}

interface PendingRecordedAction {
  actionId: string
  tabId: string
  timestamp: number
}

const recordingWaiters = new Map<string, RecordingWaiter>()
const recordingStops = new Map<string, Promise<BrowserWorkflowRecordingSummary>>()

export function waitForBrowserWorkflowRecording(sessionId: string): Promise<BrowserWorkflowRecordingSummary> {
  if (recordings.has(sessionId)) {
    return new Promise((resolve, reject) => {
      recordingWaiters.set(sessionId, { resolve, reject })
    })
  }
  const finished = finishedRecordings.get(sessionId)
  if (finished) return Promise.resolve(finished)
  return Promise.reject(new Error('当前没有正在进行的网页操作录制'))
}

function resolveRecordingWaiter(sessionId: string, summary: BrowserWorkflowRecordingSummary): void {
  const waiter = recordingWaiters.get(sessionId)
  if (!waiter) return
  recordingWaiters.delete(sessionId)
  waiter.resolve(summary)
}

function rejectRecordingWaiter(sessionId: string, error: Error): void {
  const waiter = recordingWaiters.get(sessionId)
  if (!waiter) return
  recordingWaiters.delete(sessionId)
  waiter.reject(error)
}

const RECORDING_BINDING = '__copisBrowserWorkflowRecord'


const RECORDING_SOURCE = `(() => {
  if (window.__copisWorkflowRecorderInstalled) return true;
  window.__copisWorkflowRecorderInstalled = true;
  const send = (data) => {
    try {
      if (typeof window.${RECORDING_BINDING} === 'function') {
        window.${RECORDING_BINDING}(JSON.stringify({ ...data, nonce: '__COPIS_RECORDING_NONCE__' }));
      }
    } catch (_) {}
  };
  const text = (element) => (element.innerText || element.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 160);
  const role = (element) => element.getAttribute('role') || ({ BUTTON: 'button', A: 'link', SELECT: 'combobox', TEXTAREA: 'textbox' }[element.tagName] || (element.tagName === 'INPUT' ? 'textbox' : undefined));
  const css = (element) => {
    if (element.id) return '#' + CSS.escape(element.id);
    const parts = [];
    let current = element;
    for (let index = 0; current && index < 4; index += 1) {
      let part = current.tagName.toLowerCase();
      if (current.classList.length) part += '.' + Array.from(current.classList).slice(0, 2).map((name) => CSS.escape(name)).join('.');
      const parent = current.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter((item) => item.tagName === current.tagName);
        if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(current) + 1) + ')';
      }
      parts.unshift(part);
      current = parent;
    }
    return parts.join(' > ');
  };
  const framePath = () => {
    if (window === window.parent) return { frameIds: [] };
    const frameUrls = [];
    const frameNames = [];
    let current = window;
    for (let depth = 0; depth < 8; depth += 1) {
      try {
        frameUrls.unshift(String(current.location.href).slice(0, 2048));
        frameNames.unshift(String(current.name || '').slice(0, 256));
      } catch (_) {
        break;
      }
      const parent = current.parent;
      if (parent === current) break;
      current = parent;
    }
    return { frameIds: [], frameUrls, frameNames };
  };
  const target = (node) => {
    const element = node instanceof Element ? node : node && node.parentElement;
    if (!element) return undefined;
    const inputType = element instanceof HTMLInputElement ? (element.type || 'text').toLowerCase() : undefined;
    const fieldName = element.getAttribute('name') || '';
    const fieldId = element.id || '';
    const sensitiveReason = inputType === 'file'
      ? 'file'
      : inputType === 'password'
        ? 'password'
        : /(password|passwd)/i.test(fieldName + ' ' + fieldId)
        ? 'password'
        : /(otp|verification|verify|auth|code)/i.test(fieldName + ' ' + fieldId)
          ? 'otp'
          : /(card|credit|cvv|cvc|payment|bank)/i.test(fieldName + ' ' + fieldId)
            ? 'payment'
            : /(captcha|challenge)/i.test(fieldName + ' ' + fieldId)
            ? 'captcha'
            : /(secret|token|key)/i.test(fieldName + ' ' + fieldId)
              ? 'secret'
              : undefined;
    const sensitive = Boolean(sensitiveReason);
    const strategies = [];
    const testId = element.getAttribute('data-testid') || element.getAttribute('data-test-id') || element.getAttribute('data-qa');
    if (testId) {
      const attribute = element.hasAttribute('data-qa')
        ? 'data-qa'
        : element.hasAttribute('data-testid')
          ? 'data-testid'
          : 'data-test-id'
      strategies.push({ kind: 'testId', attribute, value: testId })
    };
    const elementRole = role(element);
    const accessibleName = element.getAttribute('aria-label') || element.getAttribute('aria-labelledby') || element.getAttribute('title') || text(element).slice(0, 100);
    if (elementRole) strategies.push({ kind: 'role', role: elementRole, name: accessibleName || undefined });
    const label = element.labels && element.labels[0] ? text(element.labels[0]) : '';
    if (label) strategies.push({ kind: 'label', value: label });
    if (fieldName) strategies.push({ kind: 'name', value: fieldName });
    if (fieldId) strategies.push({ kind: 'id', value: fieldId });
    if (accessibleName) strategies.push({ kind: 'text', value: accessibleName, exact: true });
    strategies.push({ kind: 'css', value: css(element) });
    return {
      locator: {
        framePath: framePath(),
        strategies,
        fingerprint: {
          tagName: element.tagName.toLowerCase(),
          inputType,
          accessibleName: accessibleName || undefined,
          placeholder: element.getAttribute('placeholder') || undefined,
          href: element instanceof HTMLAnchorElement ? element.href : undefined,
          parentRole: element.parentElement ? role(element.parentElement) : undefined,
          nearbyText: element.parentElement ? text(element.parentElement) : undefined,
          visible: !!(element.offsetWidth || element.offsetHeight || element.getClientRects().length),
          enabled: !(element instanceof HTMLButtonElement || element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement) || !element.disabled,
        },
      },
      tagName: element.tagName.toLowerCase(),
      inputType,
      isSensitive: sensitive,
      sensitiveReason,
    };
  };
  const value = (element) => {
    const info = target(element);
    if (!info) return undefined;
    return info.isSensitive ? { kind: 'sensitive' } : { kind: 'empty' };
  };
  document.addEventListener('click', (event) => { if (!event.isTrusted) return; send({ type: 'click', url: location.href, target: target(event.target) }); }, true);
  document.addEventListener('input', (event) => { if (!event.isTrusted) return; send({ type: 'input', url: location.href, target: target(event.target), value: value(event.target) }); }, true);
  document.addEventListener('change', (event) => { if (!event.isTrusted) return; send({ type: 'change', url: location.href, target: target(event.target), value: value(event.target) }); }, true);
  document.addEventListener('submit', (event) => { if (!event.isTrusted) return; send({ type: 'submit', url: location.href, target: target(event.target) }); }, true);
  document.addEventListener('keydown', (event) => {
    if (!event.isTrusted) return;
    if (event.key === 'Enter' || event.key === 'Tab') send({ type: 'key', url: location.href, target: target(event.target), key: event.key });
  }, true);
  return true;
})()`

const statuses = new Map<string, BrowserWorkflowStatus>()
const bindings = new Map<string, BrowserAgentBinding>()
const recordings = new Map<string, ActiveRecording>()
let activeRecordingSessionId: string | undefined
const drafts = new Map<string, BrowserWorkflowVersion>()
const finishedRecordings = new Map<string, FinishedRecording>()
const listeners = new Set<(sessionId: string, status: BrowserWorkflowStatus) => void>()

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeBrowserPageAuthorizations(value: unknown): BrowserPageAuthorizationMap {
  if (!isRecord(value)) return {}
  const normalized: BrowserPageAuthorizationMap = {}
  for (const [sessionId, urls] of Object.entries(value)) {
    if (!sessionId || !Array.isArray(urls)) continue
    const normalizedUrls = urls
      .filter((url): url is string => typeof url === 'string')
      .map((url) => normalizeBrowserPageOrigin(url))
      .filter((url, index, allUrls) => url !== '' && allUrls.indexOf(url) === index)
    if (normalizedUrls.length > 0) normalized[sessionId] = normalizedUrls
  }
  return normalized
}

function loadBrowserPageAuthorizations(sessionId: string): Set<string> {
  const settings = getSettings()
  const authorizations = normalizeBrowserPageAuthorizations(settings.browserPageAuthorizations)
  if (settings.browserPageAuthorizations !== undefined
    && JSON.stringify(settings.browserPageAuthorizations) !== JSON.stringify(authorizations)) {
    updateSettings({ browserPageAuthorizations: authorizations })
  }
  return new Set(authorizations[sessionId] ?? [])
}

function persistBrowserPageAuthorizations(sessionId: string, authorizedOrigins: Set<string>): void {
  const authorizations = normalizeBrowserPageAuthorizations(getSettings().browserPageAuthorizations)
  const origins = [...authorizedOrigins]
    .map((origin) => normalizeBrowserPageOrigin(origin))
    .filter((origin, index, allOrigins) => origin !== '' && allOrigins.indexOf(origin) === index)
  if (origins.length > 0) {
    authorizations[sessionId] = origins
  } else {
    delete authorizations[sessionId]
  }
  updateSettings({ browserPageAuthorizations: authorizations })
}

function sanitizeWorkflowUrl(url: string): string {
  try {
    const parsed = new URL(url)
    parsed.username = ''
    parsed.password = ''
    for (const key of [...parsed.searchParams.keys()]) {
      if (/(token|secret|password|passwd|authorization|auth|otp|code|key|signature|sig)/i.test(key)) parsed.searchParams.delete(key)
    }
    if (/(token|secret|password|passwd|authorization|auth|otp|code|key|signature|sig)/i.test(parsed.hash)) parsed.hash = ''
    return parsed.toString()
  } catch {
    return ''
  }
}

export function sanitizeBrowserWorkflowUrl(url: string): string {
  return sanitizeWorkflowUrl(url)
}

function parsePayload(value: string | undefined): RecordingPayload | undefined {
  if (!value || value.length > 128 * 1024) return undefined
  try {
    const parsed: unknown = JSON.parse(value)
    if (!isRecord(parsed) || !['click', 'input', 'change', 'submit', 'key'].includes(String(parsed.type)) || typeof parsed.nonce !== 'string') return undefined
    return parsed as unknown as RecordingPayload
  } catch {
    return undefined
  }
}

function emitStatus(sessionId: string, status: BrowserWorkflowStatus): void {
  const next = withBrowserPageControlState(sessionId, status)
  statuses.set(sessionId, next)
  for (const listener of Array.from(listeners)) {
    try {
      listener(sessionId, next)
    } catch (error) {
      console.warn('[网页 Workflow] 状态监听器执行失败:', error)
    }
  }
}

function currentStatus(sessionId: string): BrowserWorkflowStatus {
  return withBrowserPageControlState(sessionId, statuses.get(sessionId) ?? { sessionId, state: 'idle' })
}

/** Composer 高级授权仅对用户主会话的内嵌网页控制生效。 */
export function isBrowserPageAdvancedAuthorizationEnabled(sessionId: string): boolean {
  const session = getAgentSessionMeta(sessionId)
  return session?.advancedAuthorization === true
    && !session?.sourceAutomationId
    && !session?.sourceDelegationId
}

function withBrowserPageControlState(
  sessionId: string,
  status: BrowserWorkflowStatus,
): BrowserWorkflowStatus {
  const binding = bindings.get(sessionId)
  const tab = binding ? getWebTabState(binding.context.tabId) : undefined
  if (!binding || !tab) return status
  const pageOrigin = normalizeBrowserPageOrigin(tab.url)
  const authorizedOrigin = pageOrigin && binding.authorizedOrigins.has(pageOrigin) ? pageOrigin : undefined
  const control = resolveBrowserPageControlState(tab.url, authorizedOrigin)
  return {
    ...status,
    tabId: tab.id,
    tabTitle: tab.title,
    pageOrigin: control.pageOrigin,
    controlMode: isBrowserPageAdvancedAuthorizationEnabled(sessionId) ? 'authorized' : control.mode,
  }
}

function normalizeFramePath(value: BrowserFramePath | undefined): BrowserFramePath {
  if (!value) return { frameIds: [] }
  const frameUrls = Array.isArray(value.frameUrls)
    ? value.frameUrls.map((url) => sanitizeWorkflowUrl(url)).filter(Boolean)
    : []
  const frameNames = Array.isArray(value.frameNames)
    ? value.frameNames.filter((name) => typeof name === 'string').map((name) => name.slice(0, 256))
    : []
  return {
    frameIds: [],
    ...(frameUrls.length > 0 ? { frameUrls } : {}),
    ...(frameNames.length > 0 ? { frameNames } : {}),
  }
}

function getTargetOrigin(target: BrowserRecordedTarget | undefined): BrowserRecordedTarget | undefined {
  if (!target || !target.locator || !target.locator.fingerprint) return undefined
  const fingerprint = { ...target.locator.fingerprint }
  if (fingerprint.href) {
    const href = sanitizeWorkflowUrl(fingerprint.href)
    if (href) fingerprint.href = href
    else delete fingerprint.href
  }
  return {
    ...target,
    locator: {
      ...target.locator,
      framePath: normalizeFramePath(target.locator.framePath),
      fingerprint,
    },
  }
}

function normalizePayload(payload: RecordingPayload, recording: ActiveRecording, page: RecordingPage): BrowserRecordingEvent | undefined {
  if (payload.nonce !== recording.nonce) return undefined
  const url = sanitizeWorkflowUrl(payload.url || getWebTabState(page.tabId)?.url || '')
  const target = getTargetOrigin(payload.target)
  if (!url || !normalizeBrowserPageOrigin(url)) return undefined
  const value = payload.value
    ? payload.value.kind === 'sensitive'
      ? { kind: 'sensitive' as const }
      : { kind: 'empty' as const }
    : undefined
  return {
    id: randomUUID(),
    recordingId: recording.recordingId,
    timestamp: Date.now(),
    pageId: page.tabId,
    tabAlias: page.tabAlias,
    framePath: target?.locator.framePath ?? { frameIds: [] },
    url,
    type: payload.type,
    actionId: actionIdForEvent(recording, page, payload.type),
    target,
    value,
    key: payload.key,
  }
}

function queueRecordingEvent(recording: ActiveRecording, event: BrowserRecordingEvent): void {
  // 提供给 Agent 的日志只保留稳定 tab alias，不能把运行时页签 ID 带出录制边界。
  const navigation = event.navigation
    ? { url: event.navigation.url, isMainFrame: event.navigation.isMainFrame }
    : undefined
  const persistedEvent: BrowserRecordingEvent = {
    ...event,
    pageId: event.tabAlias,
    ...(navigation ? { navigation } : {}),
  }
  recording.appendChain = recording.appendChain.then(async () => {
    await appendRustBrowserRecordingEvent(recording, persistedEvent)
    recording.eventCount += 1
  }).catch((error: unknown) => {
    recording.storageError = error instanceof Error ? error.message : String(error)
    emitStatus(recording.sessionId, {
      ...currentStatus(recording.sessionId),
      state: 'error',
      error: recording.storageError,
    })
  })
}

function handleBindingEvent(recording: ActiveRecording, page: RecordingPage, params: Record<string, unknown>): void {
  const called = params as unknown as CdpBindingCalledParams
  const payload = parsePayload(called.payload)
  if (!payload) return
  const event = normalizePayload(payload, recording, page)
  if (!event) return
  queueRecordingEvent(recording, event)
}

function handleNavigationEvent(recording: ActiveRecording, page: RecordingPage, params: Record<string, unknown>): void {
  const data = params as unknown as CdpFrameNavigatedParams
  const frame = data.frame
  if (!frame || frame.parentId || !frame.url || !normalizeBrowserPageOrigin(frame.url)) return
  queueRecordingEvent(recording, {
    id: randomUUID(),
    recordingId: recording.recordingId,
    timestamp: Date.now(),
    pageId: page.tabId,
    tabAlias: page.tabAlias,
    framePath: { frameIds: [] },
    url: sanitizeWorkflowUrl(frame.url),
    type: 'navigation',
    actionId: navigationActionId(recording, page),
    navigation: { url: sanitizeWorkflowUrl(frame.url), isMainFrame: true },
  })
}

async function installRecorder(page: RecordingPage, recording: ActiveRecording): Promise<void> {
  await page.cdpPort.send('Runtime.enable')
  await page.cdpPort.send('Page.enable')
  const frameTreeResult = await page.cdpPort.send('Page.getFrameTree')
  const frameTree = isRecord(frameTreeResult) && isRecord(frameTreeResult.frameTree) ? frameTreeResult.frameTree : undefined
  const frame = frameTree && isRecord(frameTree.frame) ? frameTree.frame : undefined
  const frameId = frame && typeof frame.id === 'string' ? frame.id : undefined
  if (!frameId) throw new Error('无法获取网页主 Frame')

  const worldName = `copis-browser-workflow-${recording.recordingId}`
  page.worldName = worldName
  const worldResult = await page.cdpPort.send('Page.createIsolatedWorld', {
    frameId,
    worldName,
    grantUniversalAccess: false,
  })
  const executionContextId = isRecord(worldResult) && typeof worldResult.executionContextId === 'number'
    ? worldResult.executionContextId
    : undefined
  if (executionContextId === undefined) throw new Error('无法创建网页录制隔离环境')

  const source = RECORDING_SOURCE.replaceAll('__COPIS_RECORDING_NONCE__', recording.nonce)
  await page.cdpPort.send('Runtime.addBinding', {
    name: RECORDING_BINDING,
    executionContextName: worldName,
  })
  const result = await page.cdpPort.send('Page.addScriptToEvaluateOnNewDocument', {
    source,
    worldName,
  })
  if (isRecord(result) && typeof result.identifier === 'string') page.scriptId = result.identifier
  await page.cdpPort.send('Runtime.evaluate', {
    expression: source,
    contextId: executionContextId,
    returnByValue: true,
  })
}

async function removeRecorder(page: RecordingPage): Promise<void> {
  page.removeCdpListener()
  page.removeCdpDetachListener()
  page.removeCdpDestroyedListener()
  try {
    if (page.scriptId) {
      await page.cdpPort.send('Page.removeScriptToEvaluateOnNewDocument', {
        identifier: page.scriptId,
      }).catch(() => undefined)
    }
    await page.cdpPort.send('Runtime.removeBinding', {
      name: RECORDING_BINDING,
    }).catch(() => undefined)
  } finally {
    if (!page.released) {
      page.released = true
      page.cdpPort.release()
    }
  }
}

function actionIdForEvent(recording: ActiveRecording, page: RecordingPage, type: RecordingPayload['type']): string | undefined {
  const now = Date.now()
  if (type === 'click') {
    const actionId = randomUUID()
    recording.pendingAction = { actionId, tabId: page.tabId, timestamp: now }
    return actionId
  }
  const pending = recording.pendingAction
  if (!pending || pending.tabId !== page.tabId || now - pending.timestamp > 3_000) return undefined
  if (type === 'submit' || type === 'key') return pending.actionId
  return undefined
}

function navigationActionId(recording: ActiveRecording, page: RecordingPage): string | undefined {
  const pending = recording.pendingAction
  if (!pending || pending.tabId !== page.tabId || Date.now() - pending.timestamp > 5_000) return undefined
  return pending.actionId
}

function recordLifecycleEvent(recording: ActiveRecording, page: RecordingPage, type: 'tab_open' | 'tab_switch' | 'tab_close'): void {
  const url = sanitizeWorkflowUrl(getWebTabState(page.tabId)?.url || `https://${page.origin}/`)
  const pending = type === 'tab_open' ? recording.pendingAction : undefined
  queueRecordingEvent(recording, {
    id: randomUUID(),
    recordingId: recording.recordingId,
    timestamp: Date.now(),
    pageId: page.tabId,
    tabAlias: page.tabAlias,
    framePath: { frameIds: [] },
    url,
    type,
    actionId: pending && Date.now() - pending.timestamp <= 3_000 ? pending.actionId : undefined,
    navigation: type === 'tab_open' ? { url, isMainFrame: true, openedPageId: page.tabId } : undefined,
  })
}

function attachRecordingPage(recording: ActiveRecording, tabId: string, tabAlias: string): RecordingPage {
  const tab = getWebTabState(tabId)
  if (!tab) throw new Error(`网页页签不存在: ${tabId}`)
  const activeUrl = getWebTabState(recording.activeTabId)?.url
  const origin = normalizeBrowserPageOrigin(tab.url) || (activeUrl ? normalizeBrowserPageOrigin(activeUrl) : undefined)
  if (!origin) throw new Error(`网页页签不是 HTTP(S): ${tabId}`)
  const cdpPort = acquireWebTabPagePort(tabId, 'recording')
  const page: RecordingPage = {
    tabId,
    tabAlias,
    origin,
    cdpPort,
    removeCdpListener: () => undefined,
    removeCdpDetachListener: () => undefined,
    removeCdpDestroyedListener: () => undefined,
  }
  page.removeCdpListener = cdpPort.onMessage((method, params) => {
    if (method === 'Runtime.bindingCalled') handleBindingEvent(recording, page, params)
    if (method === 'Page.frameNavigated') handleNavigationEvent(recording, page, params)
  })
  page.removeCdpDetachListener = cdpPort.onDetached((reason) => {
    emitStatus(recording.sessionId, {
      ...currentStatus(recording.sessionId),
      tabId,
      state: 'paused_cdp_detached',
      error: `网页 CDP 会话已断开：${reason || '未知原因'}`,
    })
  })
  page.removeCdpDestroyedListener = cdpPort.onDestroyed(() => {
    // 页面销毁后由生命周期监听器负责处理
  })
  recording.pages.set(tabId, page)
  return page
}

async function installRecordingPage(recording: ActiveRecording, page: RecordingPage): Promise<void> {
  try {
    await installRecorder(page, recording)
  } catch (error) {
    recording.pages.delete(page.tabId)
    await removeRecorder(page).catch(() => {
      if (!page.released) {
        page.released = true
        page.cdpPort.release()
      }
    })
    throw error
  }
}

/** WebContentsView 重建后重挂载录制注入；页签 ID 和 Worker capability 保持不变。 */
async function remountRecordingPage(recording: ActiveRecording, previousPage: RecordingPage): Promise<void> {
  recording.pages.delete(previousPage.tabId)
  await removeRecorder(previousPage).catch(() => undefined)

  try {
    const page = attachRecordingPage(recording, previousPage.tabId, previousPage.tabAlias)
    await installRecordingPage(recording, page)
    emitStatus(recording.sessionId, {
      ...currentStatus(recording.sessionId),
      tabId: page.tabId,
      state: 'recording',
      error: undefined,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    emitStatus(recording.sessionId, {
      ...currentStatus(recording.sessionId),
      tabId: previousPage.tabId,
      state: 'paused_cdp_detached',
      error: `网页页签重建后录制注入失败：${message}`,
    })
  }
}

function assertBindingOwner(sessionId: string, ownerWebContentsId: number): BrowserAgentBinding {
  const binding = bindings.get(sessionId)
  if (!binding) throw new Error('AI浏览器页面上下文不存在')
  if (binding.ownerWebContentsId !== ownerWebContentsId) {
    throw new Error('Browser Workflow session 不属于当前渲染进程')
  }
  return binding
}

export function assertBrowserWorkflowSessionOwner(sessionId: string, ownerWebContentsId: number): void {
  assertBindingOwner(sessionId, ownerWebContentsId)
}

function nextTabAlias(recording: ActiveRecording): string {
  const alias = `tab-${recording.nextAliasIndex}`
  recording.nextAliasIndex += 1
  return alias
}

function calculateDraftHash(version: BrowserWorkflowVersion): string {
  const payload = { ...version, approval: { status: 'pending' as const } }
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex')
}

function assertDraftHash(version: BrowserWorkflowVersion): void {
  const expected = calculateDraftHash(version)
  if (!version.approval.draftHash || version.approval.draftHash !== expected) {
    throw new Error('Browser Workflow 草稿已变化，需要重新提炼并审核')
  }
}

export function bindBrowserAgentContext(
  sessionId: string,
  context: BrowserAgentContext,
  ownerWebContentsId?: number,
  options: { preserveWorkerCapability?: boolean } = {},
): BrowserWorkflowStatus {
  // 1. 前置准备与校验全部在 acquire 前完成
  const session = getAgentSessionMeta(sessionId)
  if (!session) throw new Error('AI浏览器会话不存在')
  if (!session.workspaceId) throw new Error('AI浏览器会话必须绑定工作区')
  const workspace = getAgentWorkspace(session.workspaceId)
  if (!workspace) throw new Error('AI浏览器工作区不存在')
  const tab = getWebTabState(context.tabId)
  if (!tab) throw new Error('网页页签不存在')
  if (!normalizeBrowserPageOrigin(tab.url)) throw new Error('只有 HTTP(S) 网页可以绑定 AI浏览器')
  const previousBinding = bindings.get(sessionId)
  if (
    previousBinding
    && ownerWebContentsId !== undefined
    && previousBinding.ownerWebContentsId !== undefined
    && previousBinding.ownerWebContentsId !== ownerWebContentsId
  ) {
    throw new Error('Browser Workflow session 已绑定到其它渲染进程')
  }
  const authorizedOrigins = loadBrowserPageAuthorizations(sessionId)

  // 2. 申请新 Port，并提供安全的回滚机制
  let newPort: BrowserPagePort | undefined
  try {
    newPort = acquireWebTabPagePort(context.tabId, 'agent')

    if (session.permissionMode !== 'bypassPermissions') {
      // AI浏览器的网页控制授权由 Browser Page 工具负责，不继承工作区只读会话的 plan 模式。
      updateAgentSessionMeta(sessionId, { permissionMode: 'bypassPermissions' })
    }

    const nextBinding: BrowserAgentBinding = {
      sessionId,
      workspaceId: session.workspaceId,
      workspaceSlug: workspace.slug,
      ownerWebContentsId: ownerWebContentsId ?? previousBinding?.ownerWebContentsId,
      context,
      authorizedOrigins,
      cdpPort: newPort,
    }

    // 3. 只有在新 binding 安装成功后，才提交并替换 bindings 映射
    bindings.set(sessionId, nextBinding)
  } catch (error) {
    if (newPort) {
      try {
        newPort.release()
      } catch {
        // 隔离 release 异常
      }
    }
    throw error
  }

  // 4. 提交成功后处理副作用并释放旧 port
  if (previousBinding && previousBinding.context.tabId !== context.tabId) {
    if (!options.preserveWorkerCapability) {
      revokeBrowserAgentWorkerCapability(sessionId)
    }
  }

  if (previousBinding) {
    try {
      previousBinding.cdpPort.release()
    } catch {
      // 隔离旧 port release 异常
    }
  }

  const status = { ...currentStatus(sessionId), sessionId, tabId: tab.id, tabTitle: tab.title }
  emitStatus(sessionId, status)
  return status
}

export function unbindBrowserAgentContext(sessionId: string, ownerWebContentsId?: number): void {
  if (ownerWebContentsId !== undefined) assertBindingOwner(sessionId, ownerWebContentsId)
  revokeBrowserAgentWorkerCapability(sessionId)
  const recording = recordings.get(sessionId)
  if (recording) void cancelBrowserWorkflowRecording(sessionId)
  const previousBinding = bindings.get(sessionId)
  bindings.delete(sessionId)
  if (previousBinding) {
    previousBinding.cdpPort.release()
  }
  emitStatus(sessionId, { sessionId, state: 'idle' })
}

const ALLOWED_BROWSER_CDP_METHODS = new Set<BrowserCdpMethod>([
  'DOM.setFileInputFiles',
  'Input.dispatchKeyEvent',
  'Input.dispatchMouseEvent',
  'Input.insertText',
  'Page.addScriptToEvaluateOnNewDocument',
  'Page.captureScreenshot',
  'Page.createIsolatedWorld',
  'Page.enable',
  'Page.getFrameTree',
  'Page.handleJavaScriptDialog',
  'Page.removeScriptToEvaluateOnNewDocument',
  'Runtime.addBinding',
  'Runtime.enable',
  'Runtime.evaluate',
  'Runtime.releaseObject',
  'Runtime.removeBinding',
])

function isBrowserCdpMethod(method: string): method is BrowserCdpMethod {
  return ALLOWED_BROWSER_CDP_METHODS.has(method as BrowserCdpMethod)
}

/** 仅供主进程内部页面控制服务使用的受控指令发送函数，按 bound tab 查找 port。 */
export async function sendBrowserPageControlCdpCommand(input: {
  tabId: string
  method: string
  params?: Record<string, unknown>
}): Promise<unknown> {
  if (!isBrowserCdpMethod(input.method)) {
    throw new Error(`不支持的 CDP 指令: ${input.method}`)
  }

  let targetBinding: BrowserAgentBinding | undefined
  for (const binding of bindings.values()) {
    if (binding.context.tabId === input.tabId) {
      targetBinding = binding
      break
    }
  }

  if (!targetBinding) {
    throw new Error(`页签未绑定到有效的 AI 浏览器会话: ${input.tabId}`)
  }

  return targetBinding.cdpPort.send(input.method, input.params)
}

export function getBrowserAgentContext(sessionId: string): BrowserAgentContext | undefined {
  const binding = bindings.get(sessionId)
  return binding && getWebTabState(binding.context.tabId) ? binding.context : undefined
}

/** 将上传路径收敛到当前 Agent 已获授权读取的工作区文件。 */
export function resolveBrowserPageUploadPaths(sessionId: string, paths: string[]): string[] {
  const binding = bindings.get(sessionId)
  const session = getAgentSessionMeta(sessionId)
  const workspace = binding ? getAgentWorkspace(binding.workspaceId) : undefined
  if (!binding || !session || !workspace) throw new Error('AI浏览器页面上下文不存在')

  const writableRoot = getAgentWorkspaceWritableRoot(workspace)
  const authorizedRoots = [
    getProjectFilesPath(workspace.slug),
    writableRoot,
    getAgentSessionWorkspacePath(workspace.slug, sessionId),
    ...(session.attachedDirectories ?? []),
    ...getWorkspaceAttachedDirectories(workspace.slug),
  ]
  const authorizedFiles = new Set([
    ...(session.attachedFiles ?? []),
    ...getWorkspaceAttachedFiles(workspace.slug),
  ].map((path) => realpathOrResolve(path)))
  const resolvedPaths = paths.map((path) => isAbsolute(path) ? resolve(path) : resolve(writableRoot, path))

  for (const path of resolvedPaths) {
    let isFile = false
    try {
      isFile = statSync(path).isFile()
    } catch {
      // 后续使用统一的授权错误，避免向页面泄露本地路径是否存在。
    }
    const resolvedPath = realpathOrResolve(path)
    if (!isFile || (
      !isPathWithinAuthorizedRoots(path, authorizedRoots)
      && !authorizedFiles.has(resolvedPath)
    )) {
      throw new Error('上传文件必须位于当前 Agent 工作区或已附加文件范围内')
    }
  }
  return Array.from(new Set(resolvedPaths.map((path) => realpathOrResolve(path))))
}

/** 根据当前网页页签恢复已绑定的 AI浏览器会话。 */
export function getBrowserAgentSessionIdForTab(tabId: string): string | undefined {
  for (const binding of bindings.values()) {
    if (binding.context.tabId === tabId) return binding.sessionId
  }
  return undefined
}

export interface BrowserPageOpenTabResult {
  tabId: string
  url: string
  title: string
  incognito: boolean
}

/** 打开新的用户网页页签，并把当前 AI浏览器会话绑定到新页签。 */
export function openBrowserAgentTab(sessionId: string, url: string, incognito = false): BrowserPageOpenTabResult {
  const snapshot = createWebTab({ url, activate: true, incognito })
  const tabId = snapshot.activeTabId
  if (!tabId) throw new Error('新网页页签创建失败')
  const tab = getWebTabState(tabId)
  if (!tab || !normalizeBrowserPageOrigin(tab.url)) {
    throw new Error('只有 HTTP(S) 网页可以绑定 AI浏览器')
  }
  bindBrowserAgentContext(sessionId, { tabId }, undefined, { preserveWorkerCapability: true })
  updateBrowserAgentWorkerCapabilityTabId(sessionId, tabId)
  return { tabId, url: sanitizeBrowserWorkflowUrl(tab.url), title: tab.title, incognito: tab.isIncognito === true }
}

/** Workflow 运行失败时，将专用页面移交给当前 Browser Agent 重新分析。 */
export function handoffBrowserWorkflowFailure(sessionId: string, tabId: string): BrowserPageOpenTabResult {
  const tab = promoteWorkflowWebTab(tabId)
  bindBrowserAgentContext(sessionId, { tabId: tab.id }, undefined, { preserveWorkerCapability: true })
  updateBrowserAgentWorkerCapabilityTabId(sessionId, tab.id)
  return { tabId: tab.id, url: sanitizeBrowserWorkflowUrl(tab.url), title: tab.title, incognito: tab.isIncognito === true }
}

export function getBrowserPageControlMode(sessionId: string): BrowserPageControlMode {
  return currentStatus(sessionId).controlMode ?? 'ask'
}

export function setBrowserPageControlMode(
  sessionId: string,
  mode: BrowserPageControlMode,
): BrowserWorkflowStatus {
  const binding = bindings.get(sessionId)
  if (!binding) throw new Error('AI浏览器页面上下文不存在')
  const tab = getWebTabState(binding.context.tabId)
  if (!tab) throw new Error('当前网页页签不存在')
  const authorizedOrigins = new Set(binding.authorizedOrigins)
  if (mode === 'authorized') {
    authorizedOrigins.add(authorizeBrowserPageOrigin(tab.url))
  } else {
    const pageOrigin = normalizeBrowserPageOrigin(tab.url)
    if (pageOrigin) authorizedOrigins.delete(pageOrigin)
  }
  persistBrowserPageAuthorizations(sessionId, authorizedOrigins)
  binding.authorizedOrigins = authorizedOrigins
  const status = currentStatus(sessionId)
  emitStatus(sessionId, status)
  return currentStatus(sessionId)
}

export function getBrowserAgentWorkspaceId(sessionId: string): string | undefined {
  return bindings.get(sessionId)?.workspaceId
}

export function getBrowserWorkflowStatus(sessionId: string): BrowserWorkflowStatus {
  return currentStatus(sessionId)
}

/** Composer 授权状态变化后，向已绑定网页的订阅者发布最新页面控制状态。 */
export function refreshBrowserWorkflowStatus(sessionId: string): BrowserWorkflowStatus | undefined {
  if (!bindings.has(sessionId)) return undefined
  const status = currentStatus(sessionId)
  emitStatus(sessionId, status)
  return status
}

export function subscribeBrowserWorkflowStatus(
  listener: (sessionId: string, status: BrowserWorkflowStatus) => void,
): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export async function startBrowserWorkflowRecording(sessionId: string): Promise<BrowserWorkflowStatus> {
  if (recordings.has(sessionId)) return currentStatus(sessionId)
  if (activeRecordingSessionId && activeRecordingSessionId !== sessionId) {
    throw new Error('已有其他会话正在记录网页操作')
  }
  const binding = bindings.get(sessionId)
  if (!binding) throw new Error('AI浏览器尚未绑定网页页签')
  const workspace = getAgentWorkspace(binding.workspaceId)
  if (!workspace) throw new Error('AI浏览器工作区不存在')
  const tab = getWebTabState(binding.context.tabId)
  if (!tab || !normalizeBrowserPageOrigin(tab.url)) throw new Error('当前页签不是可录制的 HTTP(S) 网页')
  const recording: ActiveRecording = {
    recordingId: randomUUID(),
    recordingDirectory: ensureAgentWorkspaceBrowserSessionPath(workspace, sessionId),
    nonce: randomUUID(),
    sessionId,
    workspaceId: binding.workspaceId,
    workspaceSlug: binding.workspaceSlug,
    startTabId: tab.id,
    startUrl: sanitizeWorkflowUrl(tab.url),
    activeTabId: tab.id,
    eventCount: 0,
    appendChain: Promise.resolve(),
    pages: new Map(),
    removeLifecycleListener: () => undefined,
    startedAt: Date.now(),
    nextAliasIndex: 2,
  }
  const previousFinished = finishedRecordings.get(sessionId)
  finishedRecordings.delete(sessionId)
  if (previousFinished) {
    await releaseRustBrowserRecording(previousFinished).catch((error: unknown) => {
      console.warn('[网页 Workflow] 释放上一份 Rust 录制 JSONL 失败:', error)
    })
  }
  activeRecordingSessionId = sessionId
  try {
    await startRustBrowserRecording({
      recordingId: recording.recordingId,
      recordingDirectory: recording.recordingDirectory,
      sessionId: recording.sessionId,
      workspaceSlug: recording.workspaceSlug,
      startTabAlias: 'main',
      startUrl: recording.startUrl,
      startedAt: recording.startedAt,
    })
  } catch (error) {
    activeRecordingSessionId = undefined
    throw error
  }
  try {
    const page = attachRecordingPage(recording, tab.id, 'main')
    recording.removeLifecycleListener = subscribeWebTabLifecycle((event) => {
      if (!recordings.has(sessionId)) return
      if (event.type === 'created' && !recording.pages.has(event.tabId)) {
        if (!event.openerTabId || !recording.pages.has(event.openerTabId)) return
        const createdTab = event.snapshot.tabs.find((item) => item.id === event.tabId)
        if (!createdTab) return
        const createdOrigin = normalizeBrowserPageOrigin(createdTab.url) || normalizeBrowserPageOrigin(getWebTabState(recording.activeTabId)?.url || '')
        if (!createdOrigin) return
        const newPage = attachRecordingPage(recording, event.tabId, nextTabAlias(recording))
        recordLifecycleEvent(recording, newPage, 'tab_open')
        void installRecordingPage(recording, newPage).catch((error: unknown) => {
          console.warn('[网页 Workflow] 新页签录制注入失败:', error)
        })
      } else if (event.type === 'recreated') {
        const recreatedPage = recording.pages.get(event.tabId)
        if (!recreatedPage) return
        void remountRecordingPage(recording, recreatedPage)
      } else if (event.type === 'activated') {
        const activatedPage = recording.pages.get(event.tabId)
        if (activatedPage && event.tabId !== recording.activeTabId) {
          recordLifecycleEvent(recording, activatedPage, 'tab_switch')
          recording.activeTabId = event.tabId
        }
      } else if (event.type === 'closed') {
        const closedPage = recording.pages.get(event.tabId)
        if (!closedPage) return
        recordLifecycleEvent(recording, closedPage, 'tab_close')
        if (event.tabId === recording.startTabId) {
          void stopBrowserWorkflowRecording(sessionId).catch((error: unknown) => {
            console.warn('[网页 Workflow] 根页签关闭后结束录制失败:', error)
          })
          return
        }
        void removeRecorder(closedPage)
        recording.pages.delete(event.tabId)
      }
    })
    recordings.set(sessionId, recording)
    emitStatus(sessionId, {
      sessionId,
      recordingId: recording.recordingId,
      tabId: tab.id,
      tabTitle: tab.title,
      state: 'recording',
    })
    await installRecordingPage(recording, page)
    return currentStatus(sessionId)
  } catch (error) {
    recordings.delete(sessionId)
    if (activeRecordingSessionId === sessionId) activeRecordingSessionId = undefined
    recording.removeLifecycleListener()
    for (const item of recording.pages.values()) void removeRecorder(item)
    await cancelRustBrowserRecording(recording).catch((cancelError: unknown) => {
      console.warn('[网页 Workflow] 初始化失败后取消 Rust 录制 JSONL 失败:', cancelError)
    })
    const message = error instanceof Error ? error.message : String(error)
    emitStatus(sessionId, { sessionId, tabId: tab.id, tabTitle: tab.title, state: 'error', error: message })
    throw error
  }
}

export async function stopBrowserWorkflowRecording(sessionId: string): Promise<BrowserWorkflowRecordingSummary> {
  const existing = recordingStops.get(sessionId)
  if (existing) return existing
  const operation = stopBrowserWorkflowRecordingInternal(sessionId)
  recordingStops.set(sessionId, operation)
  try {
    return await operation
  } finally {
    if (recordingStops.get(sessionId) === operation) recordingStops.delete(sessionId)
  }
}

async function stopBrowserWorkflowRecordingInternal(sessionId: string): Promise<BrowserWorkflowRecordingSummary> {
  const recording = recordings.get(sessionId)
  if (!recording) {
    const finished = finishedRecordings.get(sessionId)
    if (finished) {
      return {
        recordingId: finished.recordingId,
        sessionId: finished.sessionId,
        startTabId: finished.startTabId,
        startUrl: finished.startUrl,
        eventCount: finished.eventCount,
        startedAt: finished.startedAt,
        finishedAt: finished.finishedAt,
      }
    }
    throw new Error('当前没有正在进行的网页操作录制')
  }
  emitStatus(sessionId, { ...currentStatus(sessionId), state: 'compiling' })
  recordings.delete(sessionId)
  if (activeRecordingSessionId === sessionId) activeRecordingSessionId = undefined
  recording.removeLifecycleListener()
  for (const page of recording.pages.values()) await removeRecorder(page)
  try {
    await recording.appendChain
    if (recording.storageError) throw new Error(recording.storageError)
    await finishRustBrowserRecording(recording)
    const finishedJsonl = await readRustBrowserRecording(recording)
    const observed = inspectRecordingJsonl(finishedJsonl)
    const finishedAt = Date.now()
    const summary: BrowserWorkflowRecordingSummary = {
      recordingId: recording.recordingId,
      sessionId: recording.sessionId,
      startTabId: recording.startTabId,
      startUrl: recording.startUrl,
      eventCount: recording.eventCount,
      startedAt: recording.startedAt,
      finishedAt,
    }
    finishedRecordings.set(sessionId, {
      ...summary,
      workspaceId: recording.workspaceId,
      workspaceSlug: recording.workspaceSlug,
      observedTypes: observed.types,
      observedOrigins: observed.origins,
    })
    emitStatus(sessionId, {
      sessionId,
      recordingId: recording.recordingId,
      tabId: recording.startTabId,
      state: 'awaiting_summary',
    })
    resolveRecordingWaiter(sessionId, summary)
    return summary
  } catch (error) {
    await cancelRustBrowserRecording(recording).catch((cancelError: unknown) => {
      console.warn('[网页 Workflow] 停止失败后取消 Rust 录制 JSONL 失败:', cancelError)
    })
    const message = error instanceof Error ? error.message : String(error)
    rejectRecordingWaiter(sessionId, new Error(message))
    emitStatus(sessionId, { sessionId, recordingId: recording.recordingId, tabId: recording.startTabId, state: 'error', error: message })
    throw error
  }
}

function inspectRecordingJsonl(jsonl: string): { types: Set<string>; origins: Set<string> } {
  const types = new Set<string>()
  const origins = new Set<string>()
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue
    try {
      const value: unknown = JSON.parse(line)
      if (!isRecord(value)) continue
      if (typeof value.type === 'string') types.add(value.type)
      if (typeof value.url === 'string') {
        const origin = normalizeBrowserPageOrigin(value.url)
        if (origin) origins.add(origin)
      }
      if (typeof value.startUrl === 'string') {
        const origin = normalizeBrowserPageOrigin(value.startUrl)
        if (origin) origins.add(origin)
      }
    } catch {
      throw new Error('Rust 录制 JSONL 包含无法解析的事件')
    }
  }
  return { types, origins }
}

function validateDraftAgainstRecording(version: BrowserWorkflowVersion, recording: FinishedRecording): void {
  if (!recording.observedOrigins.has(version.start.origin)) throw new Error('Workflow 起始 Origin 不在录制观察范围内')
  for (const step of version.steps) {
    if (!recording.observedOrigins.has(step.origin)) throw new Error(`Workflow step Origin 不在录制观察范围内：${step.origin}`)
    const requiredEvents = step.type === 'fill' || step.type === 'select'
      ? ['input', 'change']
      : step.type === 'manual'
        ? ['input', 'change']
        : step.type === 'press'
          ? ['key']
          : step.type === 'navigate'
            ? ['navigation']
            : step.type === 'openTab'
              ? ['tab_open']
              : step.type === 'switchTab'
                ? ['tab_switch']
                : step.type === 'closeTab'
                  ? ['tab_close']
                  : step.type === 'click'
                    ? ['click']
                    : []
    if (requiredEvents.length > 0 && !requiredEvents.some((eventType) => recording.observedTypes.has(eventType))) {
      throw new Error(`Workflow step ${step.type} 没有对应的录制操作证据`)
    }
  }
}

export async function getBrowserWorkflowRecording(sessionId: string): Promise<BrowserWorkflowRecordingArtifact> {
  const finished = finishedRecordings.get(sessionId)
  if (!finished) throw new Error('当前没有已完成的网页操作 JSONL')
  const jsonl = await readRustBrowserRecording(finished)
  return {
    recordingId: finished.recordingId,
    sessionId: finished.sessionId,
    startTabId: finished.startTabId,
    startUrl: finished.startUrl,
    eventCount: finished.eventCount,
    startedAt: finished.startedAt,
    finishedAt: finished.finishedAt,
    jsonl,
  }
}

export async function cancelBrowserWorkflowRecording(sessionId: string): Promise<void> {
  const recording = recordings.get(sessionId)
  if (!recording) return
  recordings.delete(sessionId)
  if (activeRecordingSessionId === sessionId) activeRecordingSessionId = undefined
  recording.removeLifecycleListener()
  for (const page of recording.pages.values()) await removeRecorder(page)
  await recording.appendChain
  await cancelRustBrowserRecording(recording).catch((error: unknown) => {
    console.warn('[网页 Workflow] 取消 Rust 录制 JSONL 失败:', error)
  })
  rejectRecordingWaiter(sessionId, new Error('网页操作录制已取消'))
  emitStatus(sessionId, { sessionId, recordingId: recording.recordingId, tabId: recording.startTabId, state: 'idle' })
}

export function getBrowserWorkflowDraft(sessionId: string): BrowserWorkflowVersion | undefined {
  const draft = drafts.get(sessionId)
  return draft ? structuredClone(draft) : undefined
}

export function publishBrowserWorkflowStatus(sessionId: string, status: BrowserWorkflowStatus): void {
  emitStatus(sessionId, status)
}

export function submitBrowserWorkflowDraft(sessionId: string, value: unknown): BrowserWorkflowVersion {
  const finished = finishedRecordings.get(sessionId)
  if (!finished) throw new Error('当前没有可提炼的网页操作录制')
  const session = getAgentSessionMeta(sessionId)
  if (!session?.workspaceId || session.workspaceId !== finished.workspaceId) {
    throw new Error('网页录制与当前 Agent 工作区不一致')
  }
  if (!isRecord(value)) throw new Error('Workflow 草稿必须是 JSON 对象')
  if (typeof value.sourceRecordingId === 'string' && value.sourceRecordingId !== finished.recordingId) {
    throw new Error('Workflow 草稿引用了不同的录制')
  }
  if (typeof value.createdBySessionId === 'string' && value.createdBySessionId !== sessionId) {
    throw new Error('Workflow 草稿创建会话不匹配')
  }
  const candidate = assertBrowserWorkflowVersion({
    ...value,
    workflowId: randomUUID(),
    version: 1,
    sourceRecordingId: finished.recordingId,
    createdAt: Date.now(),
    createdBySessionId: sessionId,
    approval: { status: 'pending' },
  })
  validateDraftAgainstRecording(candidate, finished)
  candidate.approval = { ...candidate.approval, draftHash: calculateDraftHash(candidate) }
  writeBrowserWorkflowDraftMarkdown(session.workspaceId, candidate)
  drafts.set(sessionId, candidate)
  emitStatus(sessionId, {
    sessionId,
    recordingId: finished.recordingId,
    tabId: finished.startTabId,
    state: 'awaiting_review',
  })
  return structuredClone(candidate)
}

export function submitBrowserWorkflowRepairDraft(
  sessionId: string,
  workflowId: string,
  versionNumber: number | undefined,
  stepId: string | undefined,
  value: unknown,
): BrowserWorkflowVersion {
  const session = getAgentSessionMeta(sessionId)
  if (!session?.workspaceId) throw new Error('Browser Workflow 会话没有绑定工作区')
  const current = getBrowserWorkflow(session.workspaceId, workflowId, versionNumber)
  if (stepId && !current.version.steps.some((step) => step.id === stepId)) {
    throw new Error(`修复目标步骤不存在: ${stepId}`)
  }
  if (!isRecord(value)) throw new Error('修复草稿必须是 BrowserWorkflowVersion JSON 对象')
  const candidate = assertBrowserWorkflowVersion({
    ...value,
    workflowId: current.manifest.id,
    version: current.version.version + 1,
    sourceRecordingId: current.version.sourceRecordingId,
    createdAt: Date.now(),
    createdBySessionId: sessionId,
    approval: { status: 'pending' },
  })
  const allowedOrigins = new Set(current.manifest.allowedOrigins)
  if (!allowedOrigins.has(candidate.start.origin) || candidate.steps.some((step) => !allowedOrigins.has(step.origin))) {
    throw new Error('修复草稿包含未批准的 Origin，请先扩展 Origin 并重新审核')
  }
  candidate.approval = { ...candidate.approval, draftHash: calculateDraftHash(candidate) }
  writeBrowserWorkflowDraftMarkdown(session.workspaceId, candidate)
  drafts.set(sessionId, candidate)
  emitStatus(sessionId, {
    sessionId,
    state: 'awaiting_review',
    error: `Workflow ${workflowId} 的修复草稿待审核${stepId ? `（步骤 ${stepId}）` : ''}`,
  })
  return structuredClone(candidate)
}

export function approveBrowserWorkflowDraft(
  sessionId: string,
  name: string,
  description?: string,
  unattendedAllowed = false,
  approvalSource: 'ui' | 'agent' = 'agent',
): BrowserWorkflowManifest {
  const draft = drafts.get(sessionId)
  if (!draft) throw new Error('当前没有待审核的 Browser Workflow 草稿')
  assertDraftHash(draft)
  const session = getAgentSessionMeta(sessionId)
  if (!session?.workspaceId) throw new Error('Browser Workflow 会话没有绑定工作区')
  if (unattendedAllowed && approvalSource !== 'ui') {
    throw new Error('无人值守权限必须由 AI浏览器审核面板明确授予')
  }
  const approvedVersion: BrowserWorkflowVersion = {
    ...draft,
    approval: {
      ...draft.approval,
      status: 'approved',
      approvedAt: Date.now(),
      approvedBySessionId: sessionId,
    },
  }
  const allowedOrigins = [...new Set([
    draft.start.origin,
    ...draft.steps.map((step) => step.origin),
  ])].filter(Boolean)
  const manifest = saveBrowserWorkflow({
    workspaceId: session.workspaceId,
    sessionId,
    name: name.trim() || '网页操作 Workflow',
    description,
    allowedOrigins,
    unattendedAllowed,
    version: approvedVersion,
  })
  promoteBrowserWorkflowDraftMarkdown(session.workspaceId, manifest.id)
  drafts.delete(sessionId)
  const finished = finishedRecordings.get(sessionId)
  finishedRecordings.delete(sessionId)
  if (finished) {
    void releaseRustBrowserRecording(finished).catch((error: unknown) => {
      console.warn('[网页 Workflow] 保存 Workflow 后释放 Rust 录制 JSONL 失败:', error)
    })
  }
  emitStatus(sessionId, { ...currentStatus(sessionId), state: 'idle' })
  return manifest
}

export function rejectBrowserWorkflowDraft(sessionId: string): void {
  if (!drafts.has(sessionId)) throw new Error('当前没有待审核的 Browser Workflow 草稿')
  drafts.delete(sessionId)
  const finished = finishedRecordings.get(sessionId)
  emitStatus(sessionId, {
    sessionId,
    recordingId: finished?.recordingId,
    tabId: finished?.startTabId,
    state: finished ? 'awaiting_summary' : 'idle',
  })
}

export function stopAllBrowserWorkflowRecordings(): void {
  for (const sessionId of recordings.keys()) void cancelBrowserWorkflowRecording(sessionId)
}

export function clearBrowserWorkflowSession(sessionId: string): void {
  void cancelBrowserWorkflowRecording(sessionId)
  drafts.delete(sessionId)
  const finished = finishedRecordings.get(sessionId)
  finishedRecordings.delete(sessionId)
  if (finished) {
    void releaseRustBrowserRecording(finished).catch((error: unknown) => {
      console.warn('[网页 Workflow] 清理会话时释放 Rust 录制 JSONL 失败:', error)
    })
  }
  const previousBinding = bindings.get(sessionId)
  bindings.delete(sessionId)
  if (previousBinding) {
    try {
      previousBinding.cdpPort.release()
    } catch {
      // 隔离释放异常
    }
  }
  statuses.delete(sessionId)
}
