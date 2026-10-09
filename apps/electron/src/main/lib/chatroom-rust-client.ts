/** 聊天室 Agent 状态回传客户端：只允许访问本机 Rust 网关的五个冻结路由。 */

import { CHATROOM_MAX_DEPTH, isChatRoomAgentOutput } from '@copis/shared'
import type {
  ChatRoomAgentOutput,
  ChatRoomInvocationFailureCode,
  ChatRoomInvocationStatusQuery,
  ChatRoomInvocationStatusResult,
  ChatRoomLifecycleResult,
  ChatRoomLegacyTerminalProof,
  ChatRoomRustApi,
} from '@copis/shared'
import { getHttpApiInternalToken, HTTP_API_HOST, HTTP_API_PORT } from './http-api-server'
import { redactSensitiveLogValue } from './bridge-log-redaction'
import { computeChatRoomReplyDigest, normalizeChatRoomReplyOutput } from './chatroom-reply-digest'
import type { ChatRoomExecutionBindingInput } from './chatroom-execution-types'

const MAX_DELTA_BYTES = 16 * 1024
const MAX_TEXT_BYTES = 64 * 1024
const MAX_ERROR_RESPONSE_CHARS = 400
const MAX_ERROR_RESPONSE_BYTES = MAX_ERROR_RESPONSE_CHARS * 4 + 4
const MAX_SUCCESS_RESPONSE_BYTES = 8 * 1024
/** invocationId 还要作为 HTTP 路由组件，因此在 protocol 64 字节限制上采用 ASCII 路由安全形式。 */
const INVOCATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
const ABSOLUTE_PATH_PATTERN = /(?:[A-Za-z]:[\\/]|\/(?:Users|home|private|tmp|var|Volumes)\/)[^\s\n\r"']*/g

type FetchImplementation = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

/** Rust 回传所需的上下文只由 Main 协调器提供，不进入 Renderer。 */
export interface ChatRoomInvocationReportContext {
  roomId: string
  agentId: string
  deviceId: string
  clientMessageId: string
  traceId: string
  targetAgentId: string
  triggerMessageId: string
  depth: number
}

export interface HttpChatRoomRustApiClientOptions {
  /** 仅用于测试或本机端口配置；必须是 http://127.0.0.1 的地址。 */
  baseUrl?: string
  fetchImpl?: FetchImplementation
  getToken?: () => string | null | undefined
  getInvocationContext?: (invocationId: string) => ChatRoomInvocationReportContext | undefined
}

type ChatRoomReportApi = Pick<
  ChatRoomRustApi,
  'reportAccepted' | 'reportRunning' | 'reportDelta' | 'reportCompleted' | 'reportFailed' | 'queryInvocationStatus'
>

export class ChatRoomRustApiError extends Error {
  constructor(
    message: string,
    readonly outcome: 'Unknown' | 'Rejected',
    readonly code: string,
    readonly httpStatus?: number,
  ) {
    super(message)
    this.name = 'ChatRoomRustApiError'
  }
}

function resolveBaseUrl(baseUrl: string | undefined): string {
  const value = baseUrl?.trim() || `http://${HTTP_API_HOST}:${HTTP_API_PORT}`
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('Rust HTTP API 必须使用 loopback 地址')
  }
  if (
    url.protocol !== 'http:'
    || url.hostname !== HTTP_API_HOST
    || url.pathname !== '/'
    || url.username
    || url.password
    || url.search
    || url.hash
  ) {
    throw new Error('Rust HTTP API 必须使用 loopback 地址')
  }
  return url.origin
}

function assertInvocationId(value: string): string {
  if (typeof value !== 'string' || !INVOCATION_ID_PATTERN.test(value)) {
    throw new Error('invocationId 参数不正确')
  }
  return encodeURIComponent(value)
}

function assertDelta(value: string): string {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > MAX_DELTA_BYTES) {
    throw new Error('delta 参数过大')
  }
  assertRustText(value, MAX_DELTA_BYTES, 'delta 参数不正确')
  return value
}

function redactErrorText(value: string): string {
  const redacted = redactSensitiveLogValue(value)
  const text = typeof redacted === 'string' ? redacted : String(redacted)
  return text.replace(ABSOLUTE_PATH_PATTERN, '[本地路径已隐藏]')
}

/** 只从响应流读取有限字符，避免超大错误响应在主进程中无界展开。 */
async function readBoundedResponseText(response: Response): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) return ''
  const decoder = new TextDecoder()
  let text = ''
  let bytesRead = 0
  try {
    while (text.length < MAX_ERROR_RESPONSE_CHARS && bytesRead < MAX_ERROR_RESPONSE_BYTES) {
      const chunk = await reader.read()
      if (chunk.done) {
        text += decoder.decode()
        break
      }
      const remainingBytes = MAX_ERROR_RESPONSE_BYTES - bytesRead
      const value = chunk.value.byteLength <= remainingBytes
        ? chunk.value
        : chunk.value.slice(0, remainingBytes)
      bytesRead += value.byteLength
      text += decoder.decode(value, { stream: true })
      if (text.length >= MAX_ERROR_RESPONSE_CHARS) break
    }
    text += decoder.decode()
    return text.slice(0, MAX_ERROR_RESPONSE_CHARS)
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

const CHATROOM_FAILURE_CODES: ReadonlySet<ChatRoomInvocationFailureCode> = new Set([
  'room_not_found',
  'room_archived',
  'not_room_member',
  'share_code_invalid',
  'share_code_rate_limited',
  'agent_limit_reached',
  'agent_offline',
  'agent_busy',
  'invocation_duplicate',
  'invocation_depth_exceeded',
  'host_approval_timeout',
  'host_approval_denied',
  'attachment_not_ready',
  'attachment_forbidden',
  'realtime_reconnecting',
  'gateway_disconnected',
  'app_quit',
  'invalid_invocation',
  'invalid_output',
  'room_agent_not_found',
  'internal_error',
])

function isRustControl(character: string): boolean {
  const codePoint = character.codePointAt(0)
  if (codePoint === undefined) return false
  return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)
}

/** Rust 网关的 required_text 约束：非空、仅允许换行/回车/制表控制符、按 UTF-8 字节计长。 */
function assertRustText(
  value: unknown,
  maxBytes = MAX_TEXT_BYTES,
  errorMessage = '聊天室文本参数不正确',
): asserts value is string {
  if (
    typeof value !== 'string'
    || value.trim().length === 0
    || Buffer.byteLength(value, 'utf8') > maxBytes
    || Array.from(value).some((character) => (
      isRustControl(character) && character !== '\n' && character !== '\r' && character !== '\t'
    ))
  ) {
    throw new Error(errorMessage)
  }
}

function assertChatRoomAgentOutput(value: unknown): asserts value is ChatRoomAgentOutput {
  if (!isChatRoomAgentOutput(value)) throw new Error('聊天室输出参数不正确')
  assertRustText(value.text)
  if (
    value.mentionedAgentIds.some((id) => !isRustId(id, 64))
    || value.attachmentIds.some((id) => !isRustId(id, 64))
  ) {
    throw new Error('聊天室输出参数不正确')
  }
}

function assertFailureCode(value: unknown): asserts value is ChatRoomInvocationFailureCode {
  if (typeof value !== 'string' || !CHATROOM_FAILURE_CODES.has(value as ChatRoomInvocationFailureCode)) {
    throw new Error('failureCode 参数不正确')
  }
}

/** 与 Rust protocol valid_id 和网关 valid_component 对齐，按 UTF-8 字节而非 JS 字符数计长。 */
function isRustId(value: string, maxBytes: number): boolean {
  if (
    value.length === 0
    || value.trim() !== value
    || Buffer.byteLength(value, 'utf8') > maxBytes
  ) return false
  return !Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0)
    return (
      (codePoint !== undefined && (
        codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f) || (codePoint >= 0xd800 && codePoint <= 0xdfff)
      ))
      || /\s/u.test(character)
      || character === '/' || character === '?' || character === '#' || character === '\\'
    )
  })
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function validateContext(value: unknown): ChatRoomInvocationReportContext {
  if (!isPlainRecord(value)) throw new Error('context_not_plain')
  const keys = Reflect.ownKeys(value)
  const expected = ['roomId', 'agentId', 'deviceId', 'clientMessageId', 'traceId', 'targetAgentId', 'triggerMessageId', 'depth']
  if (keys.length !== expected.length || keys.some((key) => typeof key !== 'string' || !expected.includes(key))) {
    throw new Error('context_keys_invalid')
  }
  for (const key of expected) {
    const component = value[key]
    if (key === 'depth') {
      if (typeof component !== 'number' || !Number.isSafeInteger(component) || component < 0 || component > CHATROOM_MAX_DEPTH) {
        throw new Error('context_component_invalid')
      }
      continue
    }
    const maxBytes = key === 'roomId' || key === 'agentId' ? 64 : 128
    if (typeof component !== 'string' || !isRustId(component, maxBytes)) {
      throw new Error('context_component_invalid')
    }
  }
  return {
    roomId: value.roomId as string,
    agentId: value.agentId as string,
    deviceId: value.deviceId as string,
    clientMessageId: value.clientMessageId as string,
    traceId: value.traceId as string,
    targetAgentId: value.targetAgentId as string,
    triggerMessageId: value.triggerMessageId as string,
    depth: value.depth as number,
  }
}

async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
  const reader = response.body?.getReader()
  if (!reader) throw new Error('response_empty')
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > maxBytes) throw new Error('response_too_large')
      chunks.push(value)
    }
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  if (!text) throw new Error('response_empty')
  return JSON.parse(text) as unknown
}

function exactObject(value: unknown, keys: readonly string[]): boolean {
  if (!isPlainRecord(value)) return false
  const actual = Reflect.ownKeys(value)
  return actual.length === keys.length && actual.every((key) => typeof key === 'string' && keys.includes(key))
}

function safeProtocolCode(value: unknown, fallback: string): string {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(value)) return fallback
  return value
}

function isRfc3339(value: string): boolean {
  if (value.length > 64) return false
  const match = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.\d+)?(Z|([+-])(\d\d):(\d\d))$/.exec(value)
  if (!match || !Number.isFinite(Date.parse(value))) return false
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , , offsetHourText, offsetMinuteText] = match
  const year = Number(yearText)
  const month = Number(monthText)
  const day = Number(dayText)
  const hour = Number(hourText)
  const minute = Number(minuteText)
  const second = Number(secondText)
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return false
  const date = new Date(0)
  date.setUTCFullYear(year, month - 1, day)
  date.setUTCHours(0, 0, 0, 0)
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return false
  if (offsetHourText !== undefined && (Number(offsetHourText) > 23 || Number(offsetMinuteText) > 59)) return false
  return true
}

function errorOutcome(status: number): 'Unknown' | 'Rejected' {
  if (status === 404 || status >= 500) return 'Unknown'
  return 'Rejected'
}

function validateStatusQuery(value: unknown): ChatRoomInvocationStatusQuery {
  if (!isPlainRecord(value) || !exactObject(value, [
    'roomId', 'invocationId', 'deviceId', 'traceId', 'targetAgentId', 'triggerMessageId', 'depth',
    'expectedStatus', 'failureCode', 'clientMessageId', 'replyDigest',
  ])) throw new Error('聊天室状态查询上下文不可用')
  const ids: Array<[unknown, number]> = [
    [value.roomId, 64], [value.invocationId, 128], [value.deviceId, 128], [value.traceId, 128],
    [value.targetAgentId, 128], [value.triggerMessageId, 128],
  ]
  if (ids.some(([id, limit]) => typeof id !== 'string' || !isRustId(id, limit))
    || typeof value.depth !== 'number' || !Number.isSafeInteger(value.depth) || value.depth < 0 || value.depth > CHATROOM_MAX_DEPTH) {
    throw new Error('聊天室状态查询上下文不可用')
  }
  if (value.expectedStatus === 'completed') {
    if (value.failureCode !== '' || typeof value.clientMessageId !== 'string' || !isRustId(value.clientMessageId, 128)
      || typeof value.replyDigest !== 'string' || !/^[0-9a-f]{64}$/.test(value.replyDigest)) {
      throw new Error('聊天室状态查询上下文不可用')
    }
  } else if (value.expectedStatus === 'failed') {
    try { assertFailureCode(value.failureCode) } catch { throw new Error('聊天室状态查询上下文不可用') }
    if (value.clientMessageId !== '' || value.replyDigest !== '') throw new Error('聊天室状态查询上下文不可用')
  } else {
    throw new Error('聊天室状态查询上下文不可用')
  }
  return value as unknown as ChatRoomInvocationStatusQuery
}

/**
 * 实现 Agent 状态回传及 Task 10 生命周期 lease release 的 loopback 协议。
 */
export class HttpChatRoomRustApiClient implements ChatRoomReportApi {
  private readonly baseUrl: string
  private readonly fetchImpl: FetchImplementation
  private readonly getToken: () => string | null | undefined
  private readonly getInvocationContext?: (invocationId: string) => ChatRoomInvocationReportContext | undefined

  constructor(options: HttpChatRoomRustApiClientOptions = {}) {
    this.baseUrl = resolveBaseUrl(options.baseUrl)
    this.fetchImpl = options.fetchImpl ?? fetch
    this.getToken = options.getToken ?? getHttpApiInternalToken
    this.getInvocationContext = options.getInvocationContext
  }

  private async post(path: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<void> {
    const token = this.getToken()
    if (typeof token !== 'string' || token.trim().length === 0) {
      throw new Error('Rust HTTP API 尚未启动')
    }

    let response: Response
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'X-Copis-Internal-Token': token,
        },
        body: JSON.stringify(body),
        signal,
      })
    } catch (error) {
      const safeError = redactErrorText(error instanceof Error ? error.message : String(error))
      throw new Error(`Rust 聊天室 API 不可用：${safeError}`)
    }

    if (!response.ok) {
      const rawBody = await readBoundedResponseText(response)
      const body = redactErrorText(rawBody)
      throw new Error(`Rust 聊天室 API 请求失败（${response.status}）：${body}`)
    }
  }

  async bindExecution(input: ChatRoomExecutionBindingInput): Promise<boolean> {
    assertInvocationId(input.invocation.invocationId)
    for (const value of [input.invocation.roomId, input.targetAgentId, input.sessionId, input.workerRunId]) {
      if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) return false
    }
    const { clientGeneration, socketGeneration, authEpoch } = input.gatewayOrigin
    if (![clientGeneration, socketGeneration].every((value) => Number.isSafeInteger(value) && value > 0)
      || !Number.isSafeInteger(authEpoch) || authEpoch < 0) return false
    try {
      await this.post('/api/internal/chatrooms/execution-bindings/bind', {
        roomId: input.invocation.roomId,
        invocationId: input.invocation.invocationId,
        targetAgentId: input.targetAgentId,
        sessionId: input.sessionId,
        workerRunId: input.workerRunId,
        origin: input.gatewayOrigin,
      })
      return true
    } catch { return false }
  }

  async releaseExecution(input: ChatRoomExecutionBindingInput): Promise<boolean> {
    try {
      await this.post('/api/internal/chatrooms/execution-bindings/release', {
        roomId: input.invocation.roomId,
        invocationId: input.invocation.invocationId,
        targetAgentId: input.targetAgentId,
        sessionId: input.sessionId,
        workerRunId: input.workerRunId,
        origin: input.gatewayOrigin,
      })
      return true
    } catch { return false }
  }

  private async postLifecycle(
    path: string,
    body: Record<string, unknown>,
    context: ChatRoomInvocationReportContext,
    command: ChatRoomLifecycleResult['command'],
    signal?: AbortSignal,
    expectedTerminalProof?: ChatRoomLegacyTerminalProof,
  ): Promise<ChatRoomLifecycleResult> {
    const token = this.getToken()
    if (typeof token !== 'string' || token.trim().length === 0) {
      throw new ChatRoomRustApiError('Rust HTTP API 尚未启动', 'Unknown', 'internal_token_unavailable')
    }
    let response: Response
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'X-Copis-Internal-Token': token,
        },
        body: JSON.stringify(body),
        signal,
      })
    } catch {
      throw new ChatRoomRustApiError('Rust 聊天室生命周期确认不可用', 'Unknown', 'transport_unknown')
    }
    if (!response.ok) {
      const rawBody = await readBoundedResponseText(response)
      let code = `http_${response.status}`
      try { code = safeProtocolCode((JSON.parse(rawBody) as { code?: unknown }).code, code) } catch { /* HTTP 状态仍足以分类；错误体不向调用方暴露。 */ }
      const outcome = errorOutcome(response.status)
      const safeBody = redactErrorText(rawBody)
      throw new ChatRoomRustApiError(
        `${outcome === 'Unknown' ? 'Rust 聊天室生命周期状态尚未确认' : 'Rust 聊天室生命周期请求已拒绝'}：${safeBody}`,
        outcome,
        code,
        response.status,
      )
    }

    let value: unknown
    try { value = await readBoundedJson(response, MAX_SUCCESS_RESPONSE_BYTES) } catch {
      throw new ChatRoomRustApiError('Rust 聊天室生命周期确认格式不正确', 'Rejected', 'invalid_lifecycle_proof', response.status)
    }
    const common = ['outcome', 'mode', 'source', 'roomId', 'invocationId', 'command', 'status', 'generation']
    if (!isPlainRecord(value)
      || value.roomId !== context.roomId
      || value.invocationId !== body.invocationId
      || value.command !== command
      || typeof value.status !== 'string'
      || (command === 'agent.accepted'
        ? !['accepted', 'running'].includes(value.status)
        : value.status !== command.slice('agent.'.length))
      || typeof value.generation !== 'number' || !Number.isSafeInteger(value.generation) || value.generation <= 0) {
      throw new ChatRoomRustApiError('Rust 聊天室生命周期确认不匹配', 'Rejected', 'lifecycle_proof_mismatch', response.status)
    }

    if (value.outcome === 'confirmed' && value.mode === 'legacy' && value.source === 'server-event') {
      if (command === 'agent.accepted' && exactObject(value, common)) {
        return value as unknown as ChatRoomLifecycleResult
      }
      if (command === 'agent.completed' || command === 'agent.failed') {
        if (exactObject(value, common)) {
          throw new ChatRoomRustApiError('旧版聊天室终态事件没有可验证结果 proof', 'Unknown', 'legacy_terminal_proof_unavailable', response.status)
        }
        const terminalProof = value.terminalProof
        const validProof = expectedTerminalProof?.kind === 'matched-server-event-v1'
          && isPlainRecord(terminalProof)
          && exactObject(value, [...common, 'terminalProof'])
          && (command === 'agent.completed'
            ? exactObject(terminalProof, ['kind', 'replyClientMessageId', 'replyDigest'])
              && terminalProof.kind === expectedTerminalProof.kind
              && 'replyClientMessageId' in expectedTerminalProof
              && terminalProof.replyClientMessageId === expectedTerminalProof.replyClientMessageId
              && terminalProof.replyDigest === expectedTerminalProof.replyDigest
            : exactObject(terminalProof, ['kind', 'failureCode'])
              && terminalProof.kind === expectedTerminalProof.kind
              && 'failureCode' in expectedTerminalProof
              && terminalProof.failureCode === expectedTerminalProof.failureCode)
        if (validProof) return value as unknown as ChatRoomLifecycleResult
      }
    }
    if (value.outcome === 'confirmed' && value.mode === 'invocation-ack-v1' && value.source === 'private-ack'
      && exactObject(value, [...common, 'confirmed', 'requestId'])
      && value.confirmed === true && typeof value.requestId === 'string' && isRustId(value.requestId, 128)) {
      return value as unknown as ChatRoomLifecycleResult
    }
    if (command === 'agent.running' && value.outcome === 'advisory' && value.mode === 'legacy'
      && value.source === 'accepted-event+local-advisory' && value.status === 'running'
      && exactObject(value, common)) {
      return value as unknown as ChatRoomLifecycleResult
    }
    throw new ChatRoomRustApiError('Rust 聊天室生命周期确认来源或模式不匹配', 'Rejected', 'lifecycle_proof_mismatch', response.status)
  }

  private async requestStatus(query: ChatRoomInvocationStatusQuery, signal?: AbortSignal): Promise<ChatRoomInvocationStatusResult> {
    const token = this.getToken()
    if (typeof token !== 'string' || token.trim().length === 0) {
      throw new ChatRoomRustApiError('Rust HTTP API 尚未启动', 'Unknown', 'internal_token_unavailable')
    }
    let response: Response
    try {
      response = await this.fetchImpl(
        `${this.baseUrl}/api/internal/chatrooms/rooms/${encodeURIComponent(query.roomId)}/invocations/${encodeURIComponent(query.invocationId)}/status`,
        {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            'X-Copis-Internal-Token': token,
          },
          body: JSON.stringify(query),
          signal,
        },
      )
    } catch {
      return { outcome: 'Unknown', roomId: query.roomId, invocationId: query.invocationId, traceId: query.traceId, generation: 0 }
    }
    if (!response.ok) {
      const rawBody = await readBoundedResponseText(response)
      let code = `http_${response.status}`
      try { code = safeProtocolCode((JSON.parse(rawBody) as { code?: unknown }).code, code) } catch { /* 忽略不可信错误文本。 */ }
      const outcome = errorOutcome(response.status)
      return { outcome, roomId: query.roomId, invocationId: query.invocationId, traceId: query.traceId, generation: 0 }
    }
    let value: unknown
    try { value = await readBoundedJson(response, MAX_SUCCESS_RESPONSE_BYTES) } catch {
      return { outcome: 'Rejected', roomId: query.roomId, invocationId: query.invocationId, traceId: query.traceId, generation: 0 }
    }
    if (!isPlainRecord(value) || value.roomId !== query.roomId || value.invocationId !== query.invocationId
      || value.traceId !== query.traceId || typeof value.generation !== 'number'
      || !Number.isSafeInteger(value.generation) || value.generation < 0) {
      return { outcome: 'Rejected', roomId: query.roomId, invocationId: query.invocationId, traceId: query.traceId, generation: 0 }
    }
    const base = { roomId: query.roomId, invocationId: query.invocationId, traceId: query.traceId, generation: value.generation }
    if (value.outcome === 'Unknown' && exactObject(value, ['outcome', 'roomId', 'invocationId', 'traceId', 'generation'])) {
      return { outcome: 'Unknown', ...base }
    }
    if (value.outcome === 'Rejected' && exactObject(value, ['outcome', 'roomId', 'invocationId', 'traceId', 'generation'])) {
      return { outcome: 'Rejected', ...base }
    }
    if (value.outcome === 'Confirmed' && value.mode === 'legacy' && value.source === 'server-event') {
      const legacyCommon = ['outcome', 'roomId', 'invocationId', 'traceId', 'generation', 'status', 'mode', 'source']
      if (value.generation <= 0 || value.status !== query.expectedStatus) return { outcome: 'Rejected', ...base }
      if (exactObject(value, legacyCommon)) return { outcome: 'Unknown', ...base }
      if (!exactObject(value, [...legacyCommon, 'terminalProof']) || !isPlainRecord(value.terminalProof)) {
        return { outcome: 'Rejected', ...base }
      }
      const proof = value.terminalProof
      if (query.expectedStatus === 'completed') {
        if (!exactObject(proof, ['kind', 'replyClientMessageId', 'replyDigest'])
          || proof.kind !== 'matched-server-event-v1'
          || typeof proof.replyClientMessageId !== 'string' || !isRustId(proof.replyClientMessageId, 128)
          || proof.replyClientMessageId !== query.clientMessageId
          || typeof proof.replyDigest !== 'string' || !/^[0-9a-f]{64}$/.test(proof.replyDigest)
          || proof.replyDigest !== query.replyDigest) {
          return { outcome: 'Rejected', ...base }
        }
        return {
          outcome: 'Confirmed', ...base, status: 'completed', mode: 'legacy', source: 'server-event',
          terminalProof: {
            kind: 'matched-server-event-v1',
            replyClientMessageId: query.clientMessageId,
            replyDigest: query.replyDigest,
          },
        }
      }
      if (!exactObject(proof, ['kind', 'failureCode'])
        || proof.kind !== 'matched-server-event-v1'
        || proof.failureCode !== query.failureCode) {
        return { outcome: 'Rejected', ...base }
      }
      return {
        outcome: 'Confirmed', ...base, status: 'failed', mode: 'legacy', source: 'server-event',
        terminalProof: { kind: 'matched-server-event-v1', failureCode: query.failureCode as ChatRoomInvocationFailureCode },
      }
    }
    if (value.outcome !== 'Confirmed' || value.status !== query.expectedStatus || typeof value.finishedAt !== 'string'
      || !isRfc3339(value.finishedAt)) {
      return { outcome: 'Rejected', ...base }
    }
    if (query.expectedStatus === 'completed') {
      if (Object.prototype.hasOwnProperty.call(value, 'mode')
        || !exactObject(value, ['outcome', 'roomId', 'invocationId', 'traceId', 'status', 'generation', 'finishedAt', 'replyMessageId', 'replyClientMessageId', 'replyDigest'])
        || typeof value.replyMessageId !== 'string' || !isRustId(value.replyMessageId, 128)
        || value.replyClientMessageId !== query.clientMessageId || value.replyDigest !== query.replyDigest) {
        return { outcome: 'Rejected', ...base }
      }
      return {
        outcome: 'Confirmed', ...base, status: 'completed', finishedAt: value.finishedAt,
        replyMessageId: value.replyMessageId, replyClientMessageId: query.clientMessageId, replyDigest: query.replyDigest,
      }
    }
    if (Object.prototype.hasOwnProperty.call(value, 'mode')
      || !exactObject(value, ['outcome', 'roomId', 'invocationId', 'traceId', 'status', 'generation', 'finishedAt', 'failureCode'])
      || value.failureCode !== query.failureCode) {
      return { outcome: 'Rejected', ...base }
    }
    return { outcome: 'Confirmed', ...base, status: 'failed', finishedAt: value.finishedAt, failureCode: query.failureCode as ChatRoomInvocationFailureCode }
  }

  private resolveContext(invocationId: string): ChatRoomInvocationReportContext {
    if (!this.getInvocationContext) throw new Error('聊天室回传上下文不可用')
    try {
      return validateContext(this.getInvocationContext(invocationId))
    } catch {
      throw new Error('聊天室回传上下文不可用')
    }
  }

  async reportAccepted(input: Parameters<ChatRoomReportApi['reportAccepted']>[0], options?: { signal?: AbortSignal }): Promise<ChatRoomLifecycleResult> {
    const invocationId = assertInvocationId(input.invocationId)
    const context = this.resolveContext(input.invocationId)
    return this.postLifecycle(`/api/internal/chatrooms/invocations/${invocationId}/accepted`, {
      roomId: context.roomId,
      invocationId: input.invocationId,
      agentId: context.agentId,
      deviceId: context.deviceId,
    }, context, 'agent.accepted', options?.signal)
  }

  async reportRunning(input: Parameters<ChatRoomReportApi['reportRunning']>[0], options?: { signal?: AbortSignal }): Promise<ChatRoomLifecycleResult> {
    const invocationId = assertInvocationId(input.invocationId)
    const context = this.resolveContext(input.invocationId)
    return this.postLifecycle(`/api/internal/chatrooms/invocations/${invocationId}/running`, {
      roomId: context.roomId,
      invocationId: input.invocationId,
    }, context, 'agent.running', options?.signal)
  }

  async reportDelta(input: Parameters<ChatRoomReportApi['reportDelta']>[0]): Promise<void> {
    const invocationId = assertInvocationId(input.invocationId)
    const context = this.resolveContext(input.invocationId)
    const delta = assertDelta(input.delta)
    await this.post(`/api/internal/chatrooms/invocations/${invocationId}/delta`, {
      roomId: context.roomId,
      invocationId: input.invocationId,
      delta,
    })
  }

  async reportCompleted(input: Parameters<ChatRoomReportApi['reportCompleted']>[0], options?: { signal?: AbortSignal }): Promise<ChatRoomLifecycleResult> {
    const invocationId = assertInvocationId(input.invocationId)
    const context = this.resolveContext(input.invocationId)
    assertChatRoomAgentOutput((input as { output: unknown }).output)
    const output = normalizeChatRoomReplyOutput(input.output)
    const replyDigest = computeChatRoomReplyDigest({ ...output, clientMessageId: context.clientMessageId })
    return this.postLifecycle(`/api/internal/chatrooms/invocations/${invocationId}/completed`, {
      roomId: context.roomId,
      invocationId: input.invocationId,
      content: output.text,
      mentionAgentIds: output.mentionedAgentIds,
      attachmentIds: output.attachmentIds,
      clientMessageId: context.clientMessageId,
    }, context, 'agent.completed', options?.signal, {
      kind: 'matched-server-event-v1',
      replyClientMessageId: context.clientMessageId,
      replyDigest,
    })
  }

  async reportFailed(input: Parameters<ChatRoomReportApi['reportFailed']>[0], options?: { signal?: AbortSignal }): Promise<ChatRoomLifecycleResult> {
    const invocationId = assertInvocationId(input.invocationId)
    const context = this.resolveContext(input.invocationId)
    assertFailureCode((input as { code: unknown }).code)
    assertRustText((input as { message: unknown }).message)
    return this.postLifecycle(`/api/internal/chatrooms/invocations/${invocationId}/failed`, {
      roomId: context.roomId,
      invocationId: input.invocationId,
      failureCode: input.code,
      message: input.message,
    }, context, 'agent.failed', options?.signal, {
      kind: 'matched-server-event-v1',
      failureCode: input.code,
    })
  }

  async queryInvocationStatus(input: ChatRoomInvocationStatusQuery, options?: { signal?: AbortSignal }): Promise<ChatRoomInvocationStatusResult> {
    const query = validateStatusQuery(input)
    return this.requestStatus(query, options?.signal)
  }

  async releaseAgentLeases(input: { roomAgentIds: string[]; reason: 'logout' | 'gateway_disconnected' | 'app_quit'; leases?: Array<{ roomId: string; roomAgentId: string }>; deviceId?: string }): Promise<void> {
    if (!Array.isArray(input.roomAgentIds) || input.roomAgentIds.length > 3 || input.roomAgentIds.length === 0) throw new Error('lease 参数不正确')
    if (!input.deviceId || !Array.isArray(input.leases) || input.leases.length !== input.roomAgentIds.length) throw new Error('lease 上下文不可用')
    await this.post('/api/internal/chatrooms/agents/leases/release', { deviceId: input.deviceId, leases: input.leases })
  }
}
