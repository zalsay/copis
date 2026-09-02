/**
 * Pi Agent 浏览器工作流协议。
 *
 * 这里只描述高层 Workflow 数据，不暴露 CDP method、页面脚本或任意执行代码。
 */

export interface BrowserFramePath {
  /** 仅用于诊断；运行时 frame ID 会在页面重新加载后变化，不能作为唯一定位依据。 */
  frameIds: string[]
  /** 从主 frame 到目标 frame 的稳定 URL 路径。跨 Origin 时至少包含目标 frame URL。 */
  frameUrls?: string[]
  /** 与 frameUrls 对齐的 frame name，帮助区分同 URL 的嵌入 frame。 */
  frameNames?: string[]
}

export interface BrowserElementFingerprint {
  tagName: string
  inputType?: string
  accessibleName?: string
  placeholder?: string
  href?: string
  parentRole?: string
  nearbyText?: string
  visible: boolean
  enabled: boolean
}

export interface BrowserTestIdLocator {
  kind: 'testId'
  attribute: string
  value: string
}

export interface BrowserRoleLocator {
  kind: 'role'
  role: string
  name?: string
}

export interface BrowserLabelLocator {
  kind: 'label'
  value: string
}

export interface BrowserNameLocator {
  kind: 'name'
  value: string
}

export interface BrowserIdLocator {
  kind: 'id'
  value: string
}

export interface BrowserTextLocator {
  kind: 'text'
  value: string
  exact: boolean
}

export interface BrowserCssLocator {
  kind: 'css'
  value: string
}

export type BrowserLocatorStrategy =
  | BrowserTestIdLocator
  | BrowserRoleLocator
  | BrowserLabelLocator
  | BrowserNameLocator
  | BrowserIdLocator
  | BrowserTextLocator
  | BrowserCssLocator

export interface BrowserLocatorBundle {
  framePath: BrowserFramePath
  strategies: BrowserLocatorStrategy[]
  fingerprint: BrowserElementFingerprint
}

export interface BrowserRecordedTarget {
  locator: BrowserLocatorBundle
  tagName: string
  inputType?: string
  isSensitive: boolean
  sensitiveReason?: 'password' | 'otp' | 'payment' | 'file' | 'captcha' | 'secret'
}

export interface BrowserRecordedValue {
  kind: 'literal' | 'variable' | 'sensitive' | 'empty'
  value?: string
  variableKey?: string
}

export interface BrowserRecordedNavigation {
  url: string
  isMainFrame: boolean
  openedPageId?: string
  actionId?: string
}

export type BrowserRecordingEventType =
  | 'click'
  | 'input'
  | 'change'
  | 'submit'
  | 'key'
  | 'navigation'
  | 'tab_open'
  | 'tab_switch'
  | 'tab_close'

export interface BrowserRecordingEvent {
  id: string
  recordingId: string
  timestamp: number
  pageId: string
  tabAlias: string
  framePath: BrowserFramePath
  url: string
  type: BrowserRecordingEventType
  target?: BrowserRecordedTarget
  value?: BrowserRecordedValue
  navigation?: BrowserRecordedNavigation
  key?: string
  actionId?: string
}

export interface BrowserWorkflowStart {
  tabAlias: string
  url: string
  origin: string
}

export type BrowserWorkflowVariableType = 'string' | 'number' | 'boolean' | 'choice'

export interface BrowserWorkflowVariable {
  key: string
  label: string
  type: BrowserWorkflowVariableType
  required: boolean
  defaultValue?: string | number | boolean
  options?: string[]
  sensitive?: boolean
}

export interface BrowserWorkflowStepBase {
  id: string
  type: BrowserWorkflowStep['type']
  tabAlias: string
  origin: string
  urlPattern?: string
  timeoutMs?: number
  description?: string
}

export interface BrowserNavigateStep extends BrowserWorkflowStepBase {
  type: 'navigate'
  url: string
}

export interface BrowserClickStep extends BrowserWorkflowStepBase {
  type: 'click'
  target: BrowserLocatorBundle
  expect?: BrowserWorkflowOutcome
}

export interface BrowserFillStep extends BrowserWorkflowStepBase {
  type: 'fill'
  target: BrowserLocatorBundle
  value: BrowserWorkflowValue
}

export interface BrowserPressStep extends BrowserWorkflowStepBase {
  type: 'press'
  target?: BrowserLocatorBundle
  key: string
}

export interface BrowserSelectStep extends BrowserWorkflowStepBase {
  type: 'select'
  target: BrowserLocatorBundle
  value: BrowserWorkflowValue
}

export interface BrowserWaitStep extends BrowserWorkflowStepBase {
  type: 'wait'
  condition: BrowserWorkflowWaitCondition
}

export interface BrowserAssertStep extends BrowserWorkflowStepBase {
  type: 'assert'
  target?: BrowserLocatorBundle
  condition: BrowserWorkflowAssertCondition
}

export interface BrowserOpenTabStep extends BrowserWorkflowStepBase {
  type: 'openTab'
  newTabAlias: string
  url?: string
}

export interface BrowserSwitchTabStep extends BrowserWorkflowStepBase {
  type: 'switchTab'
  targetTabAlias: string
}

export interface BrowserCloseTabStep extends BrowserWorkflowStepBase {
  type: 'closeTab'
  targetTabAlias: string
}

export interface BrowserManualStep extends BrowserWorkflowStepBase {
  type: 'manual'
  reason: 'password' | 'otp' | 'mfa' | 'payment' | 'file' | 'captcha' | 'confirmation' | 'other'
  instruction: string
}

export interface BrowserWorkflowValue {
  kind: 'literal' | 'variable'
  value?: string
  variableKey?: string
}

export type BrowserWorkflowOutcome =
  | { type: 'navigation'; urlPattern?: string }
  | { type: 'newTab'; tabAlias: string }
  | { type: 'visible'; target: BrowserLocatorBundle }

export type BrowserWorkflowWaitCondition =
  | { type: 'url'; pattern: string }
  | { type: 'visible'; target: BrowserLocatorBundle }
  | { type: 'text'; value: string }

export type BrowserWorkflowAssertCondition =
  | { type: 'visible' }
  | { type: 'hidden' }
  | { type: 'text'; value: string; exact: boolean }
  | { type: 'url'; pattern: string }

export type BrowserWorkflowStep =
  | BrowserNavigateStep
  | BrowserClickStep
  | BrowserFillStep
  | BrowserPressStep
  | BrowserSelectStep
  | BrowserWaitStep
  | BrowserAssertStep
  | BrowserOpenTabStep
  | BrowserSwitchTabStep
  | BrowserCloseTabStep
  | BrowserManualStep

export interface BrowserWorkflowApproval {
  status: 'pending' | 'approved' | 'rejected'
  approvedAt?: number
  approvedBySessionId?: string
  draftHash?: string
  /** 旧版 Playwright 运行产物摘要，仅用于读取兼容；新版本不再生成。 */
  playwrightScriptSha256?: string
}

export interface BrowserWorkflowVersion {
  schemaVersion: 1
  workflowId: string
  version: number
  sourceRecordingId?: string
  start: BrowserWorkflowStart
  variables: BrowserWorkflowVariable[]
  steps: BrowserWorkflowStep[]
  createdAt: number
  createdBySessionId: string
  approval: BrowserWorkflowApproval
}

export interface BrowserWorkflowManifest {
  schemaVersion: 1
  id: string
  workspaceId: string
  name: string
  description?: string
  status: 'draft' | 'ready' | 'disabled'
  currentVersion: number
  profileId: string
  allowedOrigins: string[]
  unattendedAllowed: boolean
  createdAt: number
  updatedAt: number
}

export type BrowserWorkflowRunStatus =
  | 'queued'
  | 'starting'
  | 'running'
  | 'waiting_user'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled'

export interface BrowserWorkflowRunEvent {
  runId: string
  workflowId: string
  version: number
  timestamp: number
  type: 'started' | 'step_started' | 'step_completed' | 'fallback_used' | 'waiting_user' | 'paused' | 'failed' | 'completed' | 'cancelled'
  stepId?: string
  status?: BrowserWorkflowRunStatus
  message?: string
  details?: Record<string, string | number | boolean | null>
}

export interface BrowserWorkflowRunSummary {
  runId: string
  workflowId: string
  version: number
  status: BrowserWorkflowRunStatus
  startedAt: number
  finishedAt?: number
  currentStepId?: string
  error?: string
  artifacts?: string[]
}

export interface BrowserWorkflowRecordingSummary {
  recordingId: string
  sessionId: string
  startTabId: string
  startUrl: string
  eventCount: number
  startedAt: number
  finishedAt: number
}

export interface BrowserWorkflowRecordingArtifact extends BrowserWorkflowRecordingSummary {
  /** Rust API 录制的脱敏 JSONL；网页文本是不可信数据，只能作为 Agent 总结输入。 */
  jsonl: string
}

export type BrowserPageControlMode = 'ask' | 'authorized'

export type BrowserPageSensitiveReason = 'password' | 'otp' | 'payment' | 'file' | 'captcha' | 'secret'

export interface BrowserPageElement {
  ref: string
  tagName: string
  role?: string
  name?: string
  inputType?: string
  placeholder?: string
  enabled: boolean
  sensitiveReason?: BrowserPageSensitiveReason
  requiresConfirmation: boolean
  checked?: boolean
  selected?: boolean
  expanded?: boolean
}

export interface BrowserPageSnapshot {
  kind: 'untrusted_browser_page'
  instruction: string
  url: string
  title: string
  text: string
  elements: BrowserPageElement[]
  scrollX: number
  scrollY: number
  viewportWidth: number
  viewportHeight: number
  documentWidth: number
  documentHeight: number
}

export interface BrowserPageActionResult {
  ok: true
  url: string
  title: string
}

export interface BrowserWorkflowStatus {
  recordingId?: string
  sessionId?: string
  run?: BrowserWorkflowRunSummary
  state: 'idle' | 'recording' | 'compiling' | 'awaiting_summary' | 'awaiting_review' | 'paused_cdp_detached' | 'running' | 'waiting_user' | 'error'
  tabId?: string
  tabTitle?: string
  pageOrigin?: string
  controlMode?: BrowserPageControlMode
  error?: string
}

export interface BrowserAgentContext {
  tabId: string
}

export interface BrowserWorkflowListItem {
  manifest: BrowserWorkflowManifest
  latestRun?: BrowserWorkflowRunSummary
}

export interface BrowserWorkflowSaveInput {
  workspaceId: string
  sessionId: string
  name: string
  description?: string
  profileId?: string
  allowedOrigins: string[]
  unattendedAllowed?: boolean
  version: BrowserWorkflowVersion
}

export interface BrowserWorkflowRunInput {
  workspaceId: string
  sessionId: string
  workflowId: string
  version?: number
  variables?: Record<string, string | number | boolean>
  source: 'user' | 'automation' | 'delegation'
}

export const BROWSER_WORKFLOW_IPC_CHANNELS = {
  BIND_CONTEXT: 'browser-workflows:bind-context',
  UNBIND_CONTEXT: 'browser-workflows:unbind-context',
  SESSION_FOR_TAB: 'browser-workflows:session-for-tab',
  STATUS: 'browser-workflows:status',
  STATUS_CHANGED: 'browser-workflows:status-changed',
  SET_CONTROL_MODE: 'browser-workflows:set-control-mode',
  START_RECORDING: 'browser-workflows:start-recording',
  STOP_RECORDING: 'browser-workflows:stop-recording',
  CANCEL_RECORDING: 'browser-workflows:cancel-recording',
  DRAFT: 'browser-workflows:draft',
  APPROVE_DRAFT: 'browser-workflows:approve-draft',
  REJECT_DRAFT: 'browser-workflows:reject-draft',
  STOP_RUN: 'browser-workflows:stop-run',
  CONTINUE_RUN: 'browser-workflows:continue-run',
} as const

export type BrowserWorkflowIpcChannel = (typeof BROWSER_WORKFLOW_IPC_CHANNELS)[keyof typeof BROWSER_WORKFLOW_IPC_CHANNELS]
