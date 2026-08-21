import type { Automation, AutomationRun, CreateAutomationInput, UpdateAutomationInput } from '@copis/shared'
import { COPIS_HTTP_API_HOST, resolveCopisHttpApiPort } from '@copis/shared/config'

interface AutomationApiErrorPayload {
  error?: unknown
  code?: unknown
}

export class AutomationApiClientError extends Error {
  readonly status: number
  readonly code: string

  constructor(message: string, status: number, code: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function readPayload(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!text) return undefined
  try { return JSON.parse(text) as unknown } catch { return text }
}

export interface AutomationApiClient {
  list(): Promise<Automation[]>
  get(id: string): Promise<Automation | undefined>
  create(input: CreateAutomationInput): Promise<Automation>
  update(input: UpdateAutomationInput): Promise<Automation | undefined>
  delete(id: string): Promise<boolean>
  appendRun(id: string, run: AutomationRun): Promise<Automation>
  setNextRunAt(id: string, nextRunAt: number): Promise<void>
  setLastSessionId(id: string, sessionId: string): Promise<void>
  runNow(id: string): Promise<boolean>
}

function resolveAutomationApiBaseUrl(): string {
  const port = resolveCopisHttpApiPort({
    configuredPort: process.env.COPIS_HTTP_API_PORT,
    isPackaged: process.env.COPIS_PACKAGED === '1',
  })
  return `http://${COPIS_HTTP_API_HOST}:${port}`
}

const STARTUP_RETRY_COUNT = 20
const STARTUP_RETRY_DELAY_MS = 250

export function createAutomationApiClient(
  baseUrl: string | undefined = undefined,
  options: { retryCount?: number; retryDelayMs?: number } = {},
): AutomationApiClient {
  const retryCount = options.retryCount ?? STARTUP_RETRY_COUNT
  const retryDelayMs = options.retryDelayMs ?? STARTUP_RETRY_DELAY_MS
  const resolveBaseUrl = (): string => baseUrl?.trim().replace(/\/$/, '') || resolveAutomationApiBaseUrl()

  async function requestOnce<T>(path: string, init?: RequestInit): Promise<T> {
    let response: Response
    try {
      response = await fetch(`${resolveBaseUrl()}${path}`, init)
    } catch (error) {
      throw new AutomationApiClientError(error instanceof Error ? error.message : '定时任务 API 服务不可用', 503, 'automation_service_unavailable')
    }
    const payload = await readPayload(response)
    if (response.ok) return payload as T
    const record = isRecord(payload) ? payload as AutomationApiErrorPayload : undefined
    const message = typeof record?.error === 'string' ? record.error : `定时任务 API 请求失败（${response.status}）`
    const code = typeof record?.code === 'string' ? record.code : 'automation_api_error'
    throw new AutomationApiClientError(message, response.status, code)
  }

  async function request<T>(path: string, init?: RequestInit, retryOnUnavailable = false): Promise<T> {
    if (!retryOnUnavailable) return requestOnce(path, init)

    let lastError: unknown
    for (let attempt = 0; attempt <= retryCount; attempt += 1) {
      try {
        return await requestOnce(path, init)
      } catch (error) {
        const retryable = error instanceof AutomationApiClientError && error.code === 'automation_service_unavailable'
        if (!retryable || attempt >= retryCount) throw error
        lastError = error
        await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, retryDelayMs))
      }
    }
    throw lastError
  }

  function jsonRequest<T>(path: string, method: 'POST' | 'PATCH', body: unknown): Promise<T> {
    return request<T>(path, {
      method,
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  return {
    list: () => request<Automation[]>('/api/automations', undefined, true),
    async get(id) {
      try { return await request<Automation>(`/api/automations/${encodeURIComponent(id)}`) } catch (error) {
        if (error instanceof AutomationApiClientError && error.status === 404) return undefined
        throw error
      }
    },
    create: (input) => jsonRequest<Automation>('/api/automations', 'POST', input),
    async update(input) {
      try { return await jsonRequest<Automation>(`/api/automations/${encodeURIComponent(input.id)}`, 'PATCH', input) } catch (error) {
        if (error instanceof AutomationApiClientError && error.status === 404) return undefined
        throw error
      }
    },
    async delete(id) {
      const result = await request<{ deleted: boolean }>(`/api/automations/${encodeURIComponent(id)}`, { method: 'DELETE' })
      return result.deleted
    },
    appendRun: (id, run) => jsonRequest<Automation>(`/api/automations/${encodeURIComponent(id)}/runs`, 'POST', run),
    async setNextRunAt(id, nextRunAt) {
      await jsonRequest(`/api/automations/${encodeURIComponent(id)}/next-run`, 'POST', { nextRunAt })
    },
    async setLastSessionId(id, sessionId) {
      await jsonRequest(`/api/automations/${encodeURIComponent(id)}/last-session`, 'POST', { sessionId })
    },
    async runNow(id) {
      const response = await jsonRequest<{ started?: unknown }>(`/api/automations/${encodeURIComponent(id)}/run`, 'POST', {})
      return response.started === true
    },
  }
}

export const runtimeAutomationApiClient = createAutomationApiClient()
