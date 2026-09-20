/** 聊天室 Agent 状态回传客户端：只允许访问本机 Rust 网关的五个冻结路由。 */

import type {
  ChatRoomRustApi,
} from '@copis/shared'
import { getHttpApiInternalToken, HTTP_API_HOST, HTTP_API_PORT } from './http-api-server'
import { redactSensitiveLogValue } from './bridge-log-redaction'

const MAX_DELTA_BYTES = 16 * 1024
const MAX_ERROR_RESPONSE_CHARS = 400
const MAX_ERROR_RESPONSE_BYTES = MAX_ERROR_RESPONSE_CHARS * 4 + 4
const INVOCATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const ABSOLUTE_PATH_PATTERN = /(?:[A-Za-z]:[\\/]|\/(?:Users|home|private|tmp|var|Volumes)\/)[^\s\n\r"']*/g

type FetchImplementation = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

/** Rust 回传所需的上下文只由 Main 协调器提供，不进入 Renderer。 */
export interface ChatRoomInvocationReportContext {
  roomId: string
  agentId: string
  deviceId: string
  clientMessageId: string
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
  'reportAccepted' | 'reportRunning' | 'reportDelta' | 'reportCompleted' | 'reportFailed'
>

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
  if (value.trim().length === 0) throw new Error('delta 参数不正确')
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

const SAFE_COMPONENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function validateContext(value: unknown): ChatRoomInvocationReportContext {
  if (!isPlainRecord(value)) throw new Error('context_not_plain')
  const keys = Reflect.ownKeys(value)
  const expected = ['roomId', 'agentId', 'deviceId', 'clientMessageId']
  if (keys.length !== expected.length || keys.some((key) => typeof key !== 'string' || !expected.includes(key))) {
    throw new Error('context_keys_invalid')
  }
  for (const key of expected) {
    const component = value[key]
    if (typeof component !== 'string' || !SAFE_COMPONENT_PATTERN.test(component)) {
      throw new Error('context_component_invalid')
    }
  }
  return {
    roomId: value.roomId as string,
    agentId: value.agentId as string,
    deviceId: value.deviceId as string,
    clientMessageId: value.clientMessageId as string,
  }
}

/**
 * 只实现 Task 7 冻结的五个回传方法。
 * `releaseAgentLeases` 没有对应的 Phase 2 loopback 路由，由 Task 10 生命周期适配层负责。
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

  private async post(path: string, body: Record<string, unknown>): Promise<void> {
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

  private resolveContext(invocationId: string): ChatRoomInvocationReportContext {
    if (!this.getInvocationContext) throw new Error('聊天室回传上下文不可用')
    try {
      return validateContext(this.getInvocationContext(invocationId))
    } catch {
      throw new Error('聊天室回传上下文不可用')
    }
  }

  async reportAccepted(input: Parameters<ChatRoomReportApi['reportAccepted']>[0]): Promise<void> {
    const invocationId = assertInvocationId(input.invocationId)
    const context = this.resolveContext(input.invocationId)
    await this.post(`/api/internal/chatrooms/invocations/${invocationId}/accepted`, {
      roomId: context.roomId,
      invocationId: input.invocationId,
      agentId: context.agentId,
      deviceId: context.deviceId,
    })
  }

  async reportRunning(input: Parameters<ChatRoomReportApi['reportRunning']>[0]): Promise<void> {
    const invocationId = assertInvocationId(input.invocationId)
    const context = this.resolveContext(input.invocationId)
    await this.post(`/api/internal/chatrooms/invocations/${invocationId}/running`, {
      roomId: context.roomId,
      invocationId: input.invocationId,
    })
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

  async reportCompleted(input: Parameters<ChatRoomReportApi['reportCompleted']>[0]): Promise<void> {
    const invocationId = assertInvocationId(input.invocationId)
    const context = this.resolveContext(input.invocationId)
    await this.post(`/api/internal/chatrooms/invocations/${invocationId}/completed`, {
      roomId: context.roomId,
      invocationId: input.invocationId,
      content: input.output.text,
      mentionAgentIds: input.output.mentionedAgentIds,
      attachmentIds: input.output.attachmentIds,
      clientMessageId: context.clientMessageId,
    })
  }

  async reportFailed(input: Parameters<ChatRoomReportApi['reportFailed']>[0]): Promise<void> {
    const invocationId = assertInvocationId(input.invocationId)
    const context = this.resolveContext(input.invocationId)
    await this.post(`/api/internal/chatrooms/invocations/${invocationId}/failed`, {
      roomId: context.roomId,
      invocationId: input.invocationId,
      failureCode: input.code,
      message: input.message,
    })
  }
}
