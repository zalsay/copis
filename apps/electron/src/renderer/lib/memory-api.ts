import type {
  MemoryCaptureInput,
  MemoryCaptureBatchInput,
  MemoryCaptureBatchResponse,
  MemoryCaptureResponse,
  MemoryContextInput,
  MemoryContextResponse,
  MemoryEntry,
  MemoryHistoryResponse,
  MemoryKindFilter,
  MemoryListResponse,
  MemoryMaintenanceState,
  MemoryRecallResponse,
  MemoryRevision,
  MemoryRewriteInput,
  MemoryRestoreInput,
  MemoryScopeFilter,
  MemoryStats,
} from '@copis/shared'
import { RENDERER_HTTP_API_BASE_URL } from './http-api-base-url'

const MEMORY_API_BASE_URL = RENDERER_HTTP_API_BASE_URL
const STARTUP_RETRY_COUNT = 20
const STARTUP_RETRY_DELAY_MS = 300

export interface MemoryListOptions {
  workspaceSlug?: string
  query?: string
  scope?: MemoryScopeFilter
  kind?: MemoryKindFilter
  includeArchived?: boolean
  limit?: number
}

export interface MemoryRecallOptions {
  workspaceSlug?: string
  query: string
  limit?: number
}

interface MemoryApiErrorPayload {
  error?: unknown
  code?: unknown
  current?: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isMemoryEntry(value: unknown): value is MemoryEntry {
  return isRecord(value) && typeof value.id === 'string' && typeof value.revision === 'number'
}

export class MemoryApiError extends Error {
  readonly status: number
  readonly code: string
  readonly payload: unknown
  readonly current?: MemoryEntry

  constructor(message: string, status: number, code: string, payload: unknown) {
    super(message)
    this.name = 'MemoryApiError'
    this.status = status
    this.code = code
    this.payload = payload
    const current = isRecord(payload) && isMemoryEntry(payload.current) ? payload.current : undefined
    if (current) this.current = current
  }
}

async function readPayload(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!text) return undefined
  try {
    return JSON.parse(text) as unknown
  } catch {
    return text
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt < STARTUP_RETRY_COUNT; attempt += 1) {
    try {
      const response = await fetch(`${MEMORY_API_BASE_URL}${path}`, {
        headers: { Accept: 'application/json', ...(init?.body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...init,
      })
      const payload = await readPayload(response)
      if (response.ok) return payload as T

      const errorPayload = isRecord(payload) ? payload as MemoryApiErrorPayload : undefined
      const message = typeof errorPayload?.error === 'string'
        ? errorPayload.error
        : `Memory API 请求失败（${response.status}）`
      const code = typeof errorPayload?.code === 'string' ? errorPayload.code : 'memory_api_error'
      throw new MemoryApiError(message, response.status, code, payload)
    } catch (error) {
      if (error instanceof MemoryApiError) throw error
      lastError = error
      if (attempt + 1 < STARTUP_RETRY_COUNT) {
        await new Promise<void>((resolve) => window.setTimeout(resolve, STARTUP_RETRY_DELAY_MS))
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Memory API 服务未启动')
}

function queryString(options: MemoryListOptions): string {
  const query = new URLSearchParams()
  if (options.workspaceSlug) query.set('workspaceSlug', options.workspaceSlug)
  if (options.query?.trim()) query.set('q', options.query.trim())
  if (options.scope && options.scope !== 'all') query.set('scope', options.scope)
  if (options.kind && options.kind !== 'all') query.set('kind', options.kind)
  if (options.includeArchived) query.set('includeArchived', 'true')
  if (options.limit !== undefined) query.set('limit', String(options.limit))
  const encoded = query.toString()
  return encoded ? `?${encoded}` : ''
}

export const memoryApi = {
  list(options: MemoryListOptions = {}): Promise<MemoryListResponse> {
    return request<MemoryListResponse>(`/api/memory${queryString(options)}`)
  },

  stats(workspaceSlug?: string): Promise<MemoryStats> {
    const query = workspaceSlug ? `?workspaceSlug=${encodeURIComponent(workspaceSlug)}` : ''
    return request<MemoryStats>(`/api/memory/stats${query}`)
  },

  get(id: string, workspaceSlug?: string): Promise<MemoryEntry> {
    const query = workspaceSlug ? `?workspaceSlug=${encodeURIComponent(workspaceSlug)}` : ''
    return request<MemoryEntry>(`/api/memory/${encodeURIComponent(id)}${query}`)
  },

  read(id: string, workspaceSlug?: string): Promise<MemoryEntry> {
    const query = workspaceSlug ? `?workspaceSlug=${encodeURIComponent(workspaceSlug)}` : ''
    return request<MemoryEntry>(`/api/memory/${encodeURIComponent(id)}/read${query}`)
  },

  capture(input: MemoryCaptureInput): Promise<MemoryCaptureResponse> {
    return request<MemoryCaptureResponse>('/api/memory', {
      method: 'POST',
      body: JSON.stringify(input),
    })
  },

  rewrite(id: string, input: MemoryRewriteInput): Promise<MemoryEntry> {
    return request<MemoryEntry>(`/api/memory/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    })
  },

  archive(id: string, workspaceSlug?: string): Promise<MemoryEntry> {
    const query = workspaceSlug ? `?workspaceSlug=${encodeURIComponent(workspaceSlug)}` : ''
    return request<MemoryEntry>(`/api/memory/${encodeURIComponent(id)}${query}`, { method: 'DELETE' })
  },

  history(id: string, workspaceSlug?: string): Promise<MemoryRevision[]> {
    const query = workspaceSlug ? `?workspaceSlug=${encodeURIComponent(workspaceSlug)}` : ''
    return request<MemoryHistoryResponse>(`/api/memory/${encodeURIComponent(id)}/history${query}`)
      .then((response) => response.revisions)
  },

  restore(id: string, input: MemoryRestoreInput): Promise<MemoryEntry> {
    return request<MemoryEntry>(`/api/memory/${encodeURIComponent(id)}/restore`, {
      method: 'POST',
      body: JSON.stringify(input),
    })
  },

  recall(options: MemoryRecallOptions): Promise<MemoryRecallResponse> {
    return request<MemoryRecallResponse>('/api/memory/recall', {
      method: 'POST',
      body: JSON.stringify(options),
    })
  },

  context(input: MemoryContextInput): Promise<MemoryContextResponse> {
    return request<MemoryContextResponse>('/api/memory/context', {
      method: 'POST',
      body: JSON.stringify(input),
    })
  },

  captureBatch(input: MemoryCaptureBatchInput): Promise<MemoryCaptureBatchResponse> {
    return request<MemoryCaptureBatchResponse>('/api/memory/capture-batch', {
      method: 'POST',
      body: JSON.stringify(input),
    })
  },

  maintenanceState(workspaceSlug: string): Promise<MemoryMaintenanceState> {
    return request<MemoryMaintenanceState>(`/api/memory/maintenance?workspaceSlug=${encodeURIComponent(workspaceSlug)}`)
  },
}
