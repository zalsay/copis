import { Type } from 'typebox'
import type { AgentToolResult } from '@earendil-works/pi-agent-core'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'

type PiSdk = typeof import('@earendil-works/pi-coding-agent')
type FetchImplementation = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

const DEFAULT_HTTP_API_PORT = 51730
const WORKING_PAYMENT_ENDPOINT = '/api/working'

export type WorkingPaymentAction = 'packages.list' | 'order.create' | 'order.check'

export interface PiWorkingPaymentToolOptions {
  baseUrl?: string
  fetchImpl?: FetchImplementation
}

export interface WorkingPaymentToolInput {
  action: WorkingPaymentAction
  packageId?: number
  paymentId?: string
}

export class PiWorkingPaymentToolError extends Error {}

function resolveBaseUrl(value: string | undefined): string {
  if (value?.trim()) return value.replace(/\/$/, '')
  const configuredPort = Number.parseInt(process.env.COPIS_HTTP_API_PORT ?? '', 10)
  const port = Number.isSafeInteger(configuredPort) && configuredPort > 0 && configuredPort <= 65_535
    ? configuredPort
    : DEFAULT_HTTP_API_PORT
  return `http://127.0.0.1:${port}`
}

function toToolResult(payload: unknown): AgentToolResult<unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    details: payload,
  } as AgentToolResult<unknown>
}

export class PiWorkingPaymentToolClient {
  private readonly baseUrl: string
  private readonly fetchImpl: FetchImplementation

  constructor(options: PiWorkingPaymentToolOptions = {}) {
    this.baseUrl = resolveBaseUrl(options.baseUrl)
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  async execute(input: WorkingPaymentToolInput, signal?: AbortSignal): Promise<unknown> {
    const request = this.buildRequest(input)
    let response: Response
    try {
      response = await this.fetchImpl(`${this.baseUrl}${request.path}`, {
        method: request.method,
        signal,
        headers: request.body ? { 'Content-Type': 'application/json' } : undefined,
        body: request.body,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Copis 钻石服务不可用'
      throw new PiWorkingPaymentToolError(`Copis 钻石服务调用失败: ${message}`)
    }

    const text = await response.text()
    let payload: unknown
    try {
      payload = text ? JSON.parse(text) as unknown : undefined
    } catch {
      throw new PiWorkingPaymentToolError('Copis 钻石服务响应不是有效 JSON')
    }
    if (!response.ok) {
      const message = typeof payload === 'object' && payload !== null && 'error' in payload && typeof payload.error === 'string'
        ? payload.error
        : `Copis 钻石服务请求失败（${response.status}）`
      throw new PiWorkingPaymentToolError(message)
    }
    return payload
  }

  private buildRequest(input: WorkingPaymentToolInput): { method: 'GET' | 'POST'; path: string; body?: string } {
    if (input.action === 'packages.list') {
      return { method: 'GET', path: `${WORKING_PAYMENT_ENDPOINT}/diamond-packages` }
    }
    if (input.action === 'order.create') {
      if (!Number.isSafeInteger(input.packageId) || (input.packageId ?? 0) <= 0) {
        throw new PiWorkingPaymentToolError('创建 Copis 钻石订单需要有效的套餐 ID')
      }
      return {
        method: 'POST',
        path: `${WORKING_PAYMENT_ENDPOINT}/diamond-purchases`,
        body: JSON.stringify({ packageId: input.packageId }),
      }
    }
    const paymentId = input.paymentId?.trim()
    if (!paymentId) throw new PiWorkingPaymentToolError('查询 Copis 钻石订单需要有效的订单号')
    return {
      method: 'POST',
      path: `${WORKING_PAYMENT_ENDPOINT}/diamond-purchases/${encodeURIComponent(paymentId)}/check`,
      body: '{}',
    }
  }
}

export function buildPiWorkingPaymentTools(
  sdk: PiSdk,
  options: PiWorkingPaymentToolOptions = {},
): ToolDefinition[] {
  const client = new PiWorkingPaymentToolClient(options)
  const definition = sdk.defineTool({
    name: 'copis_working_payment',
    label: 'Copis 钻石购买',
    description: '查询 edu-api 的最新 Copis 钻石套餐，创建钱包支付会话，或由本地 Rust 服务查询已创建订单的支付与履约状态。',
    promptSnippet: '购买 Copis 钻石时，先用 packages.list 查询最新套餐；确认套餐并检查钱包就绪后调用 order.create。用户完成扫码支付后，仅使用 order.check 并传入 order.create 返回的 payment.payment_id；禁止直接调用 alipay_bot 的 payment.check 或 payment.ack。',
    parameters: Type.Object({
      action: Type.Union([Type.Literal('packages.list'), Type.Literal('order.create'), Type.Literal('order.check')]),
      packageId: Type.Optional(Type.Integer({ minimum: 1, description: '已由用户明确确认的 Copis 钻石套餐 ID。' })),
      paymentId: Type.Optional(Type.String({ minLength: 1, description: 'order.create 返回的 payment.payment_id，仅用于本地 Rust 受控查询。' })),
    }),
    async execute(_toolCallId, params, signal) {
      return toToolResult(await client.execute(params as WorkingPaymentToolInput, signal))
    },
  }) as unknown as ToolDefinition

  return [{ ...definition, executionMode: 'sequential' as const }]
}
