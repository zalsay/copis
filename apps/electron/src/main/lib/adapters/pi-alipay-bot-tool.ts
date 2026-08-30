import { Type } from 'typebox'
import type { AgentToolResult } from '@earendil-works/pi-agent-core'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'

type PiSdk = typeof import('@earendil-works/pi-coding-agent')
type FetchImplementation = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

const DEFAULT_HTTP_API_PORT = 51730
const ALIPAY_BOT_ENDPOINT = '/api/internal/agent/alipay-bot'
const AGENT_FILE_TOKEN_HEADER = 'x-copis-agent-file-token'
export const PAYMENT_CAPABILITY_TOKEN_HEADER = 'x-copis-payment-capability'

export type PiAlipayBotCapabilityHeader = typeof AGENT_FILE_TOKEN_HEADER | typeof PAYMENT_CAPABILITY_TOKEN_HEADER

export type AlipayBotAction =
  | 'wallet.check'
  | 'wallet.apply'
  | 'wallet.bind'
  | 'wallet.close'
  | 'payment.start'
  | 'payment.check'
  | 'payment.ack'

export interface PiAlipayBotToolOptions {
  sessionId: string
  token?: string
  capabilityHeader?: PiAlipayBotCapabilityHeader
  baseUrl?: string
  fetchImpl?: FetchImplementation
}

export interface AlipayBotToolInput {
  action: AlipayBotAction
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

interface AlipayBotResponseError {
  error?: string
  code?: string
}

export class PiAlipayBotToolError extends Error {
  readonly code?: string

  constructor(message: string, code?: string) {
    super(message)
    this.name = 'PiAlipayBotToolError'
    this.code = code
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function resolveBaseUrl(value: string | undefined): string {
  if (value?.trim()) return value.replace(/\/$/, '')
  const configuredPort = Number.parseInt(process.env.COPIS_HTTP_API_PORT ?? '', 10)
  const port = Number.isSafeInteger(configuredPort) && configuredPort > 0 && configuredPort <= 65_535
    ? configuredPort
    : DEFAULT_HTTP_API_PORT
  return `http://127.0.0.1:${port}`
}

function requireToken(value: string | undefined, capabilityHeader: PiAlipayBotCapabilityHeader): string {
  const runtimeToken = capabilityHeader === PAYMENT_CAPABILITY_TOKEN_HEADER
    ? process.env.COPIS_PI_PAYMENT_CAPABILITY_TOKEN?.trim()
    : process.env.COPIS_PI_FILE_API_TOKEN?.trim()
  const token = value?.trim() || runtimeToken
  if (!token) throw new PiAlipayBotToolError('alipay-bot 会话能力令牌不可用')
  return token
}

function normalizeHeaders(value: unknown): Array<[string, string]> | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw new PiAlipayBotToolError('headers 必须是数组')
  const headers: Array<[string, string]> = []
  for (const item of value) {
    if (!isRecord(item) || typeof item.name !== 'string' || typeof item.value !== 'string') {
      throw new PiAlipayBotToolError('headers 条目格式不正确')
    }
    headers.push([item.name, item.value])
  }
  return headers
}

function buildRequestBody(input: AlipayBotToolInput, sessionId: string): Record<string, unknown> {
  const body: Record<string, unknown> = {
    sessionId,
    action: input.action,
  }
  const optionalFields: Array<[string, unknown]> = [
    ['agentName', input.agentName],
    ['bindCode', input.bindCode],
    ['paymentNeeded', input.paymentNeeded],
    ['resourceUrl', input.resourceUrl],
    ['method', input.method],
    ['data', input.data],
    ['intentSummary', input.intentSummary],
    ['tradeNo', input.tradeNo],
    ['outShakeNo', input.outShakeNo],
  ]
  for (const [key, value] of optionalFields) {
    if (value !== undefined) body[key] = value
  }
  const headers = normalizeHeaders(input.headers)
  if (headers) body.headers = headers
  return body
}

function toAgentToolResult(payload: unknown): AgentToolResult<unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    details: payload,
  } as AgentToolResult<unknown>
}

export class PiAlipayBotToolClient {
  private readonly baseUrl: string
  private readonly configuredToken?: string
  private readonly capabilityHeader: PiAlipayBotCapabilityHeader
  private readonly fetchImpl: FetchImplementation

  constructor(private readonly options: PiAlipayBotToolOptions) {
    if (!options.sessionId.trim()) throw new PiAlipayBotToolError('alipay-bot 缺少 Agent 会话 ID')
    this.baseUrl = resolveBaseUrl(options.baseUrl)
    this.capabilityHeader = options.capabilityHeader ?? AGENT_FILE_TOKEN_HEADER
    this.configuredToken = options.token?.trim()
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  async execute(input: AlipayBotToolInput, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const token = requireToken(this.configuredToken, this.capabilityHeader)
    let response: Response
    try {
      response = await this.fetchImpl(`${this.baseUrl}${ALIPAY_BOT_ENDPOINT}`, {
        method: 'POST',
        signal,
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          [this.capabilityHeader]: token,
        },
        body: JSON.stringify(buildRequestBody(input, this.options.sessionId)),
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'alipay-bot 本地能力不可用'
      throw new PiAlipayBotToolError(`alipay-bot 调用失败: ${message}`)
    }

    const responseText = await response.text()
    let payload: unknown
    try {
      payload = responseText ? JSON.parse(responseText) as unknown : undefined
    } catch {
      throw new PiAlipayBotToolError('alipay-bot 响应不是有效 JSON')
    }
    if (!response.ok) {
      const details = isRecord(payload) ? payload as AlipayBotResponseError : undefined
      throw new PiAlipayBotToolError(
        details?.error ?? `alipay-bot 能力调用被拒绝（${response.status}）`,
        details?.code,
      )
    }
    if (!isRecord(payload)) throw new PiAlipayBotToolError('alipay-bot 响应格式不正确')
    return payload
  }
}

export function buildPiAlipayBotTools(
  sdk: PiSdk,
  options: PiAlipayBotToolOptions,
): ToolDefinition[] {
  const client = new PiAlipayBotToolClient(options)
  const definitions = [
    sdk.defineTool({
      name: 'alipay_bot',
      label: '支付宝支付',
      description: '通过 Rust capability 调用受控的 alipay-bot，处理钱包开通、支付宝支付和支付状态查询。不得执行 shell。',
      promptSnippet: '使用 alipay_bot 处理支付宝钱包和付费资源支付，不要直接执行 shell。',
      parameters: Type.Object({
        action: Type.String({
          enum: [
            'wallet.check',
            'wallet.apply',
            'wallet.bind',
            'wallet.close',
            'payment.start',
            'payment.check',
            'payment.ack',
          ],
          description: '支付宝操作类型',
        }),
        agentName: Type.Optional(Type.String({ description: '申请钱包时显示的 Agent 名称。' })),
        bindCode: Type.Optional(Type.String({ description: '用户从支付宝授权页提供的绑定码。' })),
        paymentNeeded: Type.Optional(Type.String({ description: '卖家 402 响应的 Payment-Needed 内容。' })),
        resourceUrl: Type.Optional(Type.String({ description: '需要支付的资源 URL。' })),
        method: Type.Optional(Type.String({
          enum: ['GET', 'POST'],
          description: '请求方法',
        })),
        data: Type.Optional(Type.String({ description: '支付资源请求体。' })),
        headers: Type.Optional(Type.Array(Type.Object({
          name: Type.String({ description: '请求头名称。' }),
          value: Type.String({ description: '请求头值。' }),
        }))),
        intentSummary: Type.Optional(Type.String({ description: '支付意图摘要。' })),
        tradeNo: Type.Optional(Type.String({ description: '支付宝交易号。' })),
        outShakeNo: Type.Optional(Type.String({ description: '支付查询单号。' })),
      }),
      async execute(_toolCallId, params, signal) {
        return toAgentToolResult(await client.execute(params as AlipayBotToolInput, signal))
      },
    }),
  ] as unknown as ToolDefinition[]

  return definitions.map((tool) => ({
    ...tool,
    executionMode: 'sequential' as const,
  }))
}
