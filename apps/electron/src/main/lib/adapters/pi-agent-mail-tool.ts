import { Type } from 'typebox'
import type { AgentToolResult } from '@earendil-works/pi-agent-core'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { AgentMailAction, AgentMailRequest } from '@copis/shared'

type PiSdk = typeof import('@earendil-works/pi-coding-agent')
type FetchImplementation = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

const DEFAULT_HTTP_API_PORT = 51730
const AGENT_MAIL_ENDPOINT = '/api/internal/agent/agent-mail'
const AGENT_FILE_TOKEN_HEADER = 'x-copis-agent-file-token'

export interface PiAgentMailToolOptions {
  sessionId: string
  token?: string
  baseUrl?: string
  fetchImpl?: FetchImplementation
}

export class PiAgentMailToolError extends Error {
  readonly code?: string

  constructor(message: string, code?: string) {
    super(message)
    this.name = 'PiAgentMailToolError'
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

function requireToken(value: string | undefined): string {
  const token = value?.trim() || process.env.COPIS_PI_FILE_API_TOKEN?.trim()
  if (!token) throw new PiAgentMailToolError('agent-mail 会话能力令牌不可用')
  return token
}

function toAgentToolResult(payload: unknown): AgentToolResult<Record<string, unknown>> {
  return {
    content: [{
      type: 'text',
      text: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2),
    }],
    details: isRecord(payload) ? payload : { raw: payload },
  }
}

export class PiAgentMailToolClient {
  private readonly baseUrl: string
  private readonly fetchImpl: FetchImplementation

  constructor(private readonly options: PiAgentMailToolOptions) {
    this.baseUrl = resolveBaseUrl(options.baseUrl)
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  async execute(input: AgentMailRequest, signal?: AbortSignal): Promise<unknown> {
    if (!this.options.sessionId.trim()) throw new PiAgentMailToolError('agent-mail 缺少 Agent 会话 ID')
    const token = requireToken(this.options.token)
    const url = `${this.baseUrl}${AGENT_MAIL_ENDPOINT}`

    let response: Response
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        signal,
        headers: {
          'Content-Type': 'application/json',
          [AGENT_FILE_TOKEN_HEADER]: token,
        },
        body: JSON.stringify({
          ...input,
          sessionId: this.options.sessionId,
        }),
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'agent-mail 本地能力不可用'
      throw new PiAgentMailToolError(`agent-mail 调用失败: ${message}`)
    }

    const responseText = await response.text()
    let payload: unknown
    try {
      payload = responseText ? JSON.parse(responseText) as unknown : undefined
    } catch {
      throw new PiAgentMailToolError('agent-mail 响应不是有效 JSON')
    }
    if (!response.ok) {
      const details = isRecord(payload) && isRecord(payload.error)
        ? (payload.error as { message?: string; code?: string })
        : undefined
      throw new PiAgentMailToolError(
        details?.message ?? `agent-mail 能力调用被拒绝（${response.status}）`,
        details?.code,
      )
    }
    return payload
  }
}

export function buildPiAgentMailTools(
  sdk: PiSdk,
  options: PiAgentMailToolOptions,
): ToolDefinition[] {
  const client = new PiAgentMailToolClient(options)
  const definitions = [
    sdk.defineTool({
      name: 'agent_mail',
      label: 'Agent 邮箱',
      description: '通过 Rust HTTP API 调用受控的 agently-cli 处理 QQ 邮箱授权、邮件读取、搜索、发送、回复与附件管理。不得执行 shell。',
      promptSnippet: '使用 agent_mail 处理邮件收发、搜索与阅读，不要直接执行 shell。',
      parameters: Type.Object({
        action: Type.Union([
          Type.Literal('auth.status'),
          Type.Literal('auth.login'),
          Type.Literal('auth.logout'),
          Type.Literal('me'),
          Type.Literal('message.list'),
          Type.Literal('message.read'),
          Type.Literal('message.search'),
          Type.Literal('message.send'),
          Type.Literal('message.reply'),
          Type.Literal('message.forward'),
          Type.Literal('message.trash'),
          Type.Literal('message.delete'),
          Type.Literal('attachment.download'),
          Type.Literal('attachment.upload'),
        ]),
        id: Type.Optional(Type.String({ description: '邮件 ID (msg_xxx)。' })),
        query: Type.Optional(Type.String({ description: '搜索关键词。' })),
        dir: Type.Optional(Type.Union([
          Type.Literal('inbox'),
          Type.Literal('sent'),
          Type.Literal('trash'),
          Type.Literal('spam'),
        ])),
        limit: Type.Optional(Type.Number({ description: '每页条数。' })),
        cursor: Type.Optional(Type.String({ description: '分页游标。' })),
        after: Type.Optional(Type.String({ description: '起始时间过滤。' })),
        before: Type.Optional(Type.String({ description: '截止时间过滤。' })),
        hasAttachments: Type.Optional(Type.Boolean({ description: '是否只筛选包含附件的邮件。' })),
        isUnread: Type.Optional(Type.Boolean({ description: '是否只筛选未读邮件。' })),
        to: Type.Optional(Type.Array(Type.String(), { description: '收件人列表。' })),
        cc: Type.Optional(Type.Array(Type.String(), { description: '抄送人列表。' })),
        bcc: Type.Optional(Type.Array(Type.String(), { description: '密送人列表。' })),
        subject: Type.Optional(Type.String({ description: '邮件主题。' })),
        body: Type.Optional(Type.String({ description: '邮件正文内容。' })),
        bodyFile: Type.Optional(Type.String({ description: '邮件正文文件路径。' })),
        attachments: Type.Optional(Type.Array(Type.String(), { description: '附件路径列表。' })),
        replyAll: Type.Optional(Type.Boolean({ description: '是否回复全部。' })),
        includeAttachments: Type.Optional(Type.Boolean({ description: '转发时是否携带原附件。' })),
        confirmed: Type.Optional(Type.Boolean({ description: '用户已明确授权时传递 true 免除二次确认。' })),
        confirmationToken: Type.Optional(Type.String({ description: '两阶段确认令牌 (ctk_xxx)。' })),
        all: Type.Optional(Type.Boolean({ description: '清空垃圾箱时传递 true。' })),
        file: Type.Optional(Type.String({ description: '上传的本地文件路径。' })),
        msgId: Type.Optional(Type.String({ description: '附件所属邮件 ID。' })),
        attId: Type.Optional(Type.String({ description: '附件 ID (att_xxx)。' })),
        outputDir: Type.Optional(Type.String({ description: '附件下载保存目录。' })),
      }),
      async execute(_toolCallId, params, signal) {
        return toAgentToolResult(await client.execute(params as AgentMailRequest, signal))
      },
    }),
  ] as unknown as ToolDefinition[]

  return definitions.map((tool) => ({
    ...tool,
    executionMode: 'sequential' as const,
  }))
}
