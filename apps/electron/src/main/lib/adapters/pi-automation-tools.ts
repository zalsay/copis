import { Type, type TSchema } from 'typebox'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { AgentToolResult } from '@earendil-works/pi-agent-core'
import type { PiWorkerAutomationCapability } from '../agent-rpc-protocol'

type PiSdk = typeof import('@earendil-works/pi-coding-agent')
type FetchImplementation = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

const DEFAULT_HTTP_API_PORT = 51730

export interface PiAutomationToolOptions {
  sessionId: string
  capability: PiWorkerAutomationCapability
  baseUrl?: string
  fetchImpl?: FetchImplementation
}

interface ToolDescriptor {
  name: string
  label: string
  description: string
  action: 'list' | 'get' | 'create' | 'update' | 'delete'
  parameters: TSchema
  toInput: (value: Record<string, unknown>) => Record<string, unknown>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function resolveBaseUrl(value: string | undefined): string {
  if (value?.trim()) return value.replace(/\/$/, '')
  const port = Number.parseInt(process.env.COPIS_HTTP_API_PORT ?? '', 10)
  return `http://127.0.0.1:${Number.isSafeInteger(port) && port > 0 && port <= 65_535 ? port : DEFAULT_HTTP_API_PORT}`
}

function result(value: unknown): AgentToolResult<unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    details: value,
  } as AgentToolResult<unknown>
}

const scheduleFields = {
  scheduleType: Type.String({
    enum: ['interval', 'daily', 'weekly', 'monthly', 'once'],
    description: '定时任务周期类型',
  }),
  intervalMinutes: Type.Optional(Type.Number()),
  timeOfDay: Type.Optional(Type.String()),
  dayOfWeek: Type.Optional(Type.Number()),
  dayOfMonth: Type.Optional(Type.Number()),
  scheduledAt: Type.Optional(Type.Number()),
  maxRuns: Type.Optional(Type.Number()),
  active: Type.Optional(Type.Boolean()),
  sessionMode: Type.Optional(Type.String({
    enum: ['daily', 'reuse'],
    description: '会话模式',
  })),
}

const descriptors: ToolDescriptor[] = [
  {
    name: 'mcp__automation__list_automations', label: '列出定时任务', action: 'list',
    description: '列出 Copis 持久化定时任务，用于检查现有任务、运行状态与失败记录。',
    parameters: Type.Object({}), toInput: () => ({}),
  },
  {
    name: 'mcp__automation__get_automation', label: '查看定时任务', action: 'get',
    description: '读取单个定时任务详情；自动任务运行中可省略 id 读取当前任务。',
    parameters: Type.Object({ id: Type.Optional(Type.String()) }), toInput: (value) => value,
  },
  {
    name: 'mcp__automation__create_automation', label: '创建定时任务', action: 'create',
    description: '创建 Copis 持久化定时任务。纯提醒或当前回合即可完成的任务不应创建；自动任务运行中禁止递归创建。',
    parameters: Type.Object({ name: Type.String(), prompt: Type.String(), ...scheduleFields }), toInput: (value) => value,
  },
  {
    name: 'mcp__automation__update_automation', label: '修改定时任务', action: 'update',
    description: '修改现有 Copis 定时任务的名称、提示词、频率或启用状态。',
    parameters: Type.Object({ id: Type.Optional(Type.String()), name: Type.Optional(Type.String()), prompt: Type.Optional(Type.String()), ...scheduleFields }),
    toInput: ({ id, ...changes }) => ({ id, changes }),
  },
  {
    name: 'mcp__automation__delete_automation', label: '删除定时任务', action: 'delete',
    description: '仅在用户明确要求时删除 Copis 定时任务。',
    parameters: Type.Object({ id: Type.String() }), toInput: (value) => value,
  },
]

export function buildPiAutomationTools(sdk: PiSdk, options: PiAutomationToolOptions): ToolDefinition[] {
  if (options.capability.endpoint !== '/api/internal/agent/automation-tool' || !options.capability.token.trim()) {
    throw new Error('定时任务 capability 不正确')
  }
  const baseUrl = resolveBaseUrl(options.baseUrl)
  const fetchImpl = options.fetchImpl ?? fetch
  return descriptors.map((descriptor) => sdk.defineTool({
    name: descriptor.name,
    label: descriptor.label,
    description: descriptor.description,
    parameters: descriptor.parameters,
    async execute(_toolCallId: string, params: unknown, signal?: AbortSignal) {
      if (!isRecord(params)) throw new Error('定时任务工具参数必须是对象')
      const response = await fetchImpl(`${baseUrl}${options.capability.endpoint}`, {
        method: 'POST', signal,
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: options.sessionId,
          capabilityToken: options.capability.token,
          action: descriptor.action,
          input: descriptor.toInput(params),
        }),
      })
      const text = await response.text()
      let payload: unknown
      try { payload = text ? JSON.parse(text) as unknown : undefined } catch { payload = text }
      if (!response.ok) {
        const message = isRecord(payload) && typeof payload.error === 'string'
          ? payload.error
          : `定时任务工具调用失败（${response.status}）`
        throw new Error(message)
      }
      return result(payload)
    },
  }) as unknown as ToolDefinition)
}
