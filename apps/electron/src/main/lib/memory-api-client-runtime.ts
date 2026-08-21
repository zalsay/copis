import {
  COPIS_HTTP_API_DEVELOPMENT_PORT,
  COPIS_HTTP_API_PRODUCTION_PORT,
} from '@copis/shared/config'
import type {
  MemoryCaptureBatchInput,
  MemoryCaptureBatchResponse,
  MemoryCaptureResponse,
  MemoryContextInput,
  MemoryContextResponse,
  MemoryEntry,
  MemoryExportInput,
  MemoryExportResponse,
  MemoryMaintenanceApplyInput,
  MemoryMaintenanceApplyResponse,
  MemoryMaintenanceState,
  MemoryListResponse,
  MemoryRecallInput,
  MemoryRecallResponse,
} from '@copis/shared'

export interface MemoryAgentCaptureInput {
  workspaceSlug: string
  kind: MemoryCaptureResponse['entry']['kind']
  title: string
  content: string
  tags?: string[]
}

export interface MemoryAgentRewriteInput {
  workspaceSlug: string
  title?: string
  content?: string
  tags?: string[]
  expectedRevision: number
}

export interface MemoryAgentListInput {
  workspaceSlug?: string
  includeArchived?: boolean
  limit?: number
}

interface MemoryApiErrorPayload {
  error?: unknown
  code?: unknown
  current?: unknown
}

export interface MemoryApiClient {
  list(input?: MemoryAgentListInput, signal?: AbortSignal): Promise<MemoryListResponse>
  export(input: MemoryExportInput, signal?: AbortSignal): Promise<MemoryExportResponse>
  context(input: MemoryContextInput, signal?: AbortSignal): Promise<MemoryContextResponse>
  recall(input: MemoryRecallInput, signal?: AbortSignal): Promise<MemoryRecallResponse>
  read(id: string, workspaceSlug?: string, signal?: AbortSignal): Promise<MemoryEntry>
  capture(input: MemoryAgentCaptureInput, signal?: AbortSignal): Promise<MemoryCaptureResponse>
  captureBatch(input: MemoryCaptureBatchInput, signal?: AbortSignal): Promise<MemoryCaptureBatchResponse>
  rewrite(id: string, input: MemoryAgentRewriteInput, signal?: AbortSignal): Promise<MemoryEntry>
  maintenanceState(workspaceSlug: string, signal?: AbortSignal): Promise<MemoryMaintenanceState>
  applyMaintenance(input: MemoryMaintenanceApplyInput, signal?: AbortSignal): Promise<MemoryMaintenanceApplyResponse>
}

export class MemoryApiClientError extends Error {
  readonly status: number
  readonly code: string
  readonly payload: unknown
  readonly current?: MemoryEntry

  constructor(message: string, status: number, code: string, payload: unknown) {
    super(message)
    this.name = 'MemoryApiClientError'
    this.status = status
    this.code = code
    this.payload = payload
    const current = isRecord(payload) && isMemoryEntry(payload.current) ? payload.current : undefined
    if (current) this.current = current
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isMemoryEntry(value: unknown): value is MemoryEntry {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.revision === 'number'
    && typeof value.content === 'string'
}

/** 解析不依赖 Electron 的本地 Memory API 地址，供 Bun Worker 使用。 */
export function resolveMemoryApiBaseUrl(options: {
  configuredPort?: string
  isPackaged?: boolean
} = {}): string {
  const configuredPort = options.configuredPort ?? process.env.COPIS_HTTP_API_PORT
  const hasConfiguredPort = configuredPort?.trim().length !== 0
  const isPackaged = options.isPackaged
    ?? (process.env.COPIS_PACKAGED === '1' || (!hasConfiguredPort && process.env.COPIS_DEV !== '1'))
  const parsedPort = Number(configuredPort?.trim())
  const port = isPackaged
    ? COPIS_HTTP_API_PRODUCTION_PORT
    : Number.isInteger(parsedPort) && parsedPort >= 1 && parsedPort <= 65535
      ? parsedPort
      : COPIS_HTTP_API_DEVELOPMENT_PORT
  return `http://127.0.0.1:${port}`
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

export function createMemoryApiClient(baseUrl: string): MemoryApiClient {
  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    let response: Response
    try {
      response = await fetch(`${baseUrl}${path}`, init)
    } catch (error) {
      throw new MemoryApiClientError(
        error instanceof Error ? error.message : 'Memory API 服务不可用',
        503,
        'memory_service_unavailable',
        undefined,
      )
    }

    const payload = await readPayload(response)
    if (response.ok) return payload as T

    const errorPayload = isRecord(payload) ? payload as MemoryApiErrorPayload : undefined
    const message = typeof errorPayload?.error === 'string'
      ? errorPayload.error
      : `Memory API 请求失败（${response.status}）`
    const code = typeof errorPayload?.code === 'string' ? errorPayload.code : 'memory_api_error'
    throw new MemoryApiClientError(message, response.status, code, payload)
  }

  function jsonRequest<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
    return request<T>(path, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    })
  }

  function memoryEntryPath(id: string, suffix: string, workspaceSlug?: string): string {
    const query = workspaceSlug ? `?workspaceSlug=${encodeURIComponent(workspaceSlug)}` : ''
    return `/api/memory/${encodeURIComponent(id)}${suffix}${query}`
  }

  return {
    list(input: MemoryAgentListInput = {}, signal?: AbortSignal): Promise<MemoryListResponse> {
      const query = new URLSearchParams()
      if (input.workspaceSlug) query.set('workspaceSlug', input.workspaceSlug)
      if (input.includeArchived) query.set('includeArchived', 'true')
      if (input.limit !== undefined) query.set('limit', String(input.limit))
      const encoded = query.toString()
      return request<MemoryListResponse>(`/api/memory${encoded ? `?${encoded}` : ''}`, { signal })
    },

    export(input: MemoryExportInput, signal?: AbortSignal): Promise<MemoryExportResponse> {
      return jsonRequest<MemoryExportResponse>('/api/memory/export', input, signal)
    },

    context(input: MemoryContextInput, signal?: AbortSignal): Promise<MemoryContextResponse> {
      return jsonRequest<MemoryContextResponse>('/api/memory/context', input, signal)
    },

    recall(input: MemoryRecallInput, signal?: AbortSignal): Promise<MemoryRecallResponse> {
      return jsonRequest<MemoryRecallResponse>('/api/memory/recall', input, signal)
    },

    read(id: string, workspaceSlug?: string, signal?: AbortSignal): Promise<MemoryEntry> {
      return request<MemoryEntry>(memoryEntryPath(id, '/read', workspaceSlug), { signal })
    },

    capture(input: MemoryAgentCaptureInput, signal?: AbortSignal): Promise<MemoryCaptureResponse> {
      return jsonRequest<MemoryCaptureResponse>('/api/memory/capture', input, signal)
    },

    captureBatch(input: MemoryCaptureBatchInput, signal?: AbortSignal): Promise<MemoryCaptureBatchResponse> {
      console.log(
        `[Memory API] capture-batch 开始 base_url=${baseUrl}, `
          + `workspace=${input.workspaceSlug}, items=${input.items.length}`,
      )
      return jsonRequest<MemoryCaptureBatchResponse>('/api/memory/capture-batch', input, signal)
        .then((response) => {
          console.log(
            `[Memory API] capture-batch 完成 workspace=${input.workspaceSlug}, `
              + `added=${response.added}, deduplicated=${response.deduplicated}`,
          )
          return response
        })
        .catch((error) => {
          console.warn(
            `[Memory API] capture-batch 失败 workspace=${input.workspaceSlug}, `
              + `items=${input.items.length}:`,
            error,
          )
          throw error
        })
    },

    rewrite(id: string, input: MemoryAgentRewriteInput, signal?: AbortSignal): Promise<MemoryEntry> {
      return request<MemoryEntry>(memoryEntryPath(id, '/rewrite'), {
        method: 'PATCH',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
        signal,
      })
    },

    maintenanceState(workspaceSlug: string, signal?: AbortSignal): Promise<MemoryMaintenanceState> {
      return request<MemoryMaintenanceState>(`/api/memory/maintenance?workspaceSlug=${encodeURIComponent(workspaceSlug)}`, { signal })
    },

    applyMaintenance(input: MemoryMaintenanceApplyInput, signal?: AbortSignal): Promise<MemoryMaintenanceApplyResponse> {
      return jsonRequest<MemoryMaintenanceApplyResponse>('/api/memory/maintenance/apply', input, signal)
    },
  }
}

export const runtimeMemoryApiClient = createMemoryApiClient(resolveMemoryApiBaseUrl())
