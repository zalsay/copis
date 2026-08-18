import type {
  AgentStreamPayload,
  AgentThinkingLevel,
  CopisPermissionMode,
  MemoryPolicy,
  CodexOAuthCredentials,
  ProviderType,
  SDKMessage,
  XaiOAuthCredentials,
} from '@copis/shared'
import type { AgentRuntimeEnv } from './agent-runtime-env'

export interface PiWorkerQueryConfig {
  sessionId: string
  prompt: string
  model?: string
  cwd?: string
  apiKey: string
  baseUrl?: string
  provider: ProviderType
  channelId?: string
  channelName?: string
  maxTurns?: number
  permissionMode: CopisPermissionMode
  systemPrompt: string
  resumeSessionId?: string
  piAgentDir: string
  piSessionDir: string
  thinkingLevel?: AgentThinkingLevel
  maxBudgetUsd?: number
  additionalDirectories?: string[]
  additionalSkillPaths?: string[]
  /** 当前用户输入显式引用的 Skill slug。 */
  skillMentions?: string[]
  workspaceSlug?: string
  memoryPolicy?: MemoryPolicy
  proxyUrl?: string
  transport?: 'sse' | 'websocket' | 'websocket-cached'
  httpIdleTimeoutMs?: number
  websocketConnectTimeoutMs?: number
  runtimeEnv?: AgentRuntimeEnv
  compactRequest?: boolean
  codexFastMode?: boolean
  codexOAuthCredentials?: CodexOAuthCredentials
  xaiOAuthCredentials?: XaiOAuthCredentials
  openAIThinkingLevel?: AgentThinkingLevel
  retryRunStartedAt?: number
  /**
   * 仅由 Electron 传给 Rust 的会话文件授权策略。Rust 启动 Worker 前会移除它，
   * Pi 只能使用固定的文件操作端点，不能读取或修改策略。
   */
  fileAccessPolicy?: PiWorkerFileAccessPolicy
  useRustFileApi?: boolean
  browserPageControl?: PiWorkerBrowserCapability
  automationControl?: PiWorkerAutomationCapability
  triggeredBy?: 'user' | 'automation' | 'delegation'
  workspaceId?: string
  sourceAutomationId?: string
  automationEnabled?: boolean
}

export const BROWSER_AGENT_TOOL_NAMES = [
  'BrowserPageObserve',
  'BrowserPageClick',
  'BrowserPageType',
  'BrowserPageSelect',
  'BrowserPagePress',
  'BrowserPageUpload',
  'BrowserPageScroll',
  'BrowserPageNavigate',
  'BrowserPageOpenTab',
  'BrowserWorkflowRecord',
  'BrowserWorkflowRecordingGet',
  'BrowserWorkflowDraft',
  'BrowserWorkflowSave',
  'BrowserWorkflowRepair',
  'BrowserWorkflowList',
  'BrowserWorkflowGet',
  'BrowserWorkflowRun',
  'BrowserWorkflowStop',
] as const

export type BrowserAgentToolName = (typeof BROWSER_AGENT_TOOL_NAMES)[number]

export interface PiWorkerBrowserCapability {
  endpoint: '/api/internal/agent/browser-tool'
  token: string
}

export interface PiWorkerAutomationCapability {
  endpoint: '/api/internal/agent/automation-tool'
  token: string
}

export interface BrowserAgentToolRequest {
  sessionId: string
  capabilityToken: string
  toolCallId: string
  toolName: BrowserAgentToolName
  toolInput: Record<string, unknown>
}

export interface PiWorkerFileAccessPolicy {
  readRoots: string[]
  readFiles: string[]
  writeRoots: string[]
  browserSessionRoot?: string
  permissionMode: CopisPermissionMode
  advancedAuthorization?: boolean
}

export interface PiWorkerRunConfig {
  sessionId: string
  query: PiWorkerQueryConfig
}

export interface PiWorkerQueueConfig {
  sessionId: string
  userMessage: string
  uuid: string
  interrupt?: boolean
  skillMentions?: string[]
}

export const PI_PAYMENT_WORKER_ACTIONS = [
  'wallet.check',
  'wallet.apply',
  'wallet.bind',
  'payment.start',
  'payment.check',
] as const

export type PiPaymentWorkerAction = (typeof PI_PAYMENT_WORKER_ACTIONS)[number]

export interface PiPaymentWorkerRequest {
  action: PiPaymentWorkerAction
  agentName?: string
  bindCode?: string
  paymentNeeded?: string
  resourceUrl?: string
  method?: 'GET' | 'POST'
  data?: string
  headers?: Array<{ name: string; value: string }>
  intentSummary?: string
  tradeNo?: string
  outShakeNo?: string
}

export interface PiPaymentWorkerConfig {
  sessionId: string
  request: PiPaymentWorkerRequest
}

export type AgentRpcWorkerCommand =
  | { type: 'run'; requestId: string; config: PiWorkerRunConfig }
  | { type: 'stop'; sessionId: string }
  | { type: 'set_permission_mode'; sessionId: string; mode: CopisPermissionMode }
  | { type: 'queue'; requestId: string; config: PiWorkerQueueConfig }
  | { type: 'payment'; requestId: string; config: PiPaymentWorkerConfig }

export type AgentRpcWorkerFrame =
  | { type: 'event'; sessionId: string; payload: AgentStreamPayload }
  | {
    type: 'meta'
    sessionId: string
    sdkSessionId?: string
    piSessionFile?: string
    piEntryBindings?: Record<string, string>
  }
  | { type: 'error'; sessionId: string; error: string }
  | {
    type: 'complete'
    sessionId: string
    sdkMessages?: SDKMessage[]
    stoppedByUser: boolean
    startedAt?: number
    resultSubtype?: string
    resultErrors?: string[]
  }
  | { type: 'payment_result'; sessionId: string; requestId: string; result: Record<string, unknown> }
  | { type: 'credential'; sessionId: string; channelId: string; provider: 'openai-codex' | 'xai'; credentials: CodexOAuthCredentials | XaiOAuthCredentials }
  | { type: 'fatal'; sessionId?: string; error: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function isBoundedNonBlankString(value: unknown, maxLength = 512): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength
}

function isBrowserAgentToolName(value: unknown): value is BrowserAgentToolName {
  return typeof value === 'string' && (BROWSER_AGENT_TOOL_NAMES as readonly string[]).includes(value)
}

function isPiPaymentWorkerAction(value: unknown): value is PiPaymentWorkerAction {
  return typeof value === 'string' && (PI_PAYMENT_WORKER_ACTIONS as readonly string[]).includes(value)
}

function isBoundedText(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength
}

function hasOnlyKeys(value: Record<string, unknown>, allowedKeys: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowedKeys.includes(key))
}

export function parsePiPaymentWorkerRequest(value: unknown): PiPaymentWorkerRequest | undefined {
  if (!isPlainRecord(value) || !isPiPaymentWorkerAction(value.action)) return undefined
  const request = value as Record<string, unknown>
  const scalarFields: Array<[keyof Omit<PiPaymentWorkerRequest, 'action' | 'headers' | 'method'>, number]> = [
    ['agentName', 128],
    ['bindCode', 4 * 1024],
    ['paymentNeeded', 1024 * 1024],
    ['resourceUrl', 8 * 1024],
    ['data', 1024 * 1024],
    ['intentSummary', 4 * 1024],
    ['tradeNo', 512],
    ['outShakeNo', 512],
  ]
  for (const [key, maxLength] of scalarFields) {
    if (request[key] !== undefined && !isBoundedText(request[key], maxLength)) return undefined
  }
  if (request.method !== undefined && request.method !== 'GET' && request.method !== 'POST') return undefined
  if (request.headers !== undefined && (!Array.isArray(request.headers)
    || request.headers.length > 64
    || !request.headers.every((header) => isPlainRecord(header)
      && hasOnlyKeys(header, ['name', 'value'])
      && isBoundedText(header.name, 256)
      && isBoundedText(header.value, 8 * 1024)))) {
    return undefined
  }

  const allowedByAction: Record<PiPaymentWorkerAction, readonly string[]> = {
    'wallet.check': ['action'],
    'wallet.apply': ['action', 'agentName'],
    'wallet.bind': ['action', 'bindCode'],
    'payment.start': ['action', 'paymentNeeded', 'resourceUrl', 'method', 'data', 'headers', 'intentSummary'],
    'payment.check': ['action', 'tradeNo', 'outShakeNo', 'resourceUrl', 'method', 'data', 'headers'],
  }
  if (!hasOnlyKeys(request, allowedByAction[value.action])) return undefined
  return request as unknown as PiPaymentWorkerRequest
}

export function parsePiWorkerBrowserCapability(value: unknown): PiWorkerBrowserCapability | undefined {
  if (!isPlainRecord(value)) return undefined
  const keys = Object.keys(value).sort()
  if (keys.length !== 2 || keys[0] !== 'endpoint' || keys[1] !== 'token') return undefined
  if (value.endpoint !== '/api/internal/agent/browser-tool') return undefined
  if (!isBoundedNonBlankString(value.token)) return undefined
  return { endpoint: value.endpoint, token: value.token }
}

export function parsePiWorkerAutomationCapability(value: unknown): PiWorkerAutomationCapability | undefined {
  if (!isPlainRecord(value)) return undefined
  const keys = Object.keys(value).sort()
  if (keys.length !== 2 || keys[0] !== 'endpoint' || keys[1] !== 'token') return undefined
  if (value.endpoint !== '/api/internal/agent/automation-tool' || !isBoundedNonBlankString(value.token)) return undefined
  return { endpoint: value.endpoint, token: value.token }
}

export function parseBrowserAgentToolRequest(value: unknown): BrowserAgentToolRequest | undefined {
  if (!isPlainRecord(value)) return undefined
  const keys = Object.keys(value).sort()
  if (keys.join(',') !== 'capabilityToken,sessionId,toolCallId,toolInput,toolName') return undefined
  if (!isBoundedNonBlankString(value.sessionId)
    || !isBoundedNonBlankString(value.capabilityToken)
    || !isBoundedNonBlankString(value.toolCallId)
    || !isBrowserAgentToolName(value.toolName)
    || !isPlainRecord(value.toolInput)) {
    return undefined
  }
  return {
    sessionId: value.sessionId,
    capabilityToken: value.capabilityToken,
    toolCallId: value.toolCallId,
    toolName: value.toolName,
    toolInput: value.toolInput,
  }
}

function isWorkerFrameType(value: unknown): value is AgentRpcWorkerFrame['type'] {
  return value === 'event'
    || value === 'meta'
    || value === 'error'
    || value === 'complete'
    || value === 'payment_result'
    || value === 'credential'
    || value === 'fatal'
}

export function serializeWorkerCommand(command: AgentRpcWorkerCommand): string {
  return `${JSON.stringify(command)}\n`
}

export function parseWorkerCommand(line: string): AgentRpcWorkerCommand | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(line) as unknown
  } catch {
    return undefined
  }
  if (!isRecord(parsed) || (parsed.type !== 'run' && parsed.type !== 'stop' && parsed.type !== 'set_permission_mode' && parsed.type !== 'queue' && parsed.type !== 'payment')) return undefined
  if (parsed.type === 'stop') {
    return typeof parsed.sessionId === 'string' && parsed.sessionId.length > 0
      ? { type: 'stop', sessionId: parsed.sessionId }
      : undefined
  }
  if (parsed.type === 'set_permission_mode') {
    return typeof parsed.sessionId === 'string'
      && parsed.sessionId.length > 0
      && (parsed.mode === 'bypassPermissions' || parsed.mode === 'plan')
      ? { type: 'set_permission_mode', sessionId: parsed.sessionId, mode: parsed.mode }
      : undefined
  }
  if (typeof parsed.requestId !== 'string' || parsed.requestId.length === 0 || !isRecord(parsed.config)) return undefined
  const config = parsed.config
  if (parsed.type === 'payment') {
    if (!isBoundedNonBlankString(config.sessionId) || !parsePiPaymentWorkerRequest(config.request)) return undefined
    return {
      type: 'payment',
      requestId: parsed.requestId,
      config: {
        sessionId: config.sessionId,
        request: parsePiPaymentWorkerRequest(config.request)!,
      },
    }
  }
  if (parsed.type === 'queue') {
    if (typeof config.sessionId !== 'string' || config.sessionId.length === 0) return undefined
    if (typeof config.userMessage !== 'string' || config.userMessage.length === 0) return undefined
    if (typeof config.uuid !== 'string' || config.uuid.length === 0) return undefined
    if (config.interrupt !== undefined && typeof config.interrupt !== 'boolean') return undefined
    if (config.skillMentions !== undefined && (
      !Array.isArray(config.skillMentions)
      || !config.skillMentions.every((value) => typeof value === 'string' && value.trim().length > 0)
    )) return undefined
  } else {
    if (typeof config.sessionId !== 'string' || config.sessionId.length === 0 || !isPlainRecord(config.query)) return undefined
    if (config.query.sessionId !== config.sessionId) return undefined
    if (config.query.browserPageControl !== undefined && !parsePiWorkerBrowserCapability(config.query.browserPageControl)) return undefined
    if (config.query.automationControl !== undefined && !parsePiWorkerAutomationCapability(config.query.automationControl)) return undefined
  }
  return parsed as unknown as AgentRpcWorkerCommand
}

export function parseWorkerFrame(line: string): AgentRpcWorkerFrame | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(line) as unknown
  } catch {
    return undefined
  }
  if (!isRecord(parsed) || !isWorkerFrameType(parsed.type)) return undefined
  return parsed as unknown as AgentRpcWorkerFrame
}

export function parseAgentSseData(chunk: string): AgentRpcWorkerFrame | undefined {
  const dataLines = chunk
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).trimStart())
  if (dataLines.length === 0) return undefined
  return parseWorkerFrame(dataLines.join('\n'))
}
