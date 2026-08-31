import type {
  FileApiErrorCode,
  FileApiPathRequest,
  FileApiReadTextResponse,
  FileApiWriteTextRequest,
  FileApiWriteTextResponse,
} from '@copis/shared'
import { RENDERER_HTTP_API_BASE_URL } from './http-api-base-url'
import { withHttpApiWebToken } from './http-api-web-token'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFileApiErrorCode(value: unknown): value is FileApiErrorCode {
  return value === 'invalid_request'
    || value === 'invalid_json'
    || value === 'path_not_allowed'
    || value === 'path_not_found'
    || value === 'path_type_mismatch'
    || value === 'file_name_invalid'
    || value === 'name_conflict'
    || value === 'write_conflict'
    || value === 'file_too_large'
    || value === 'directory_too_large'
    || value === 'server_unavailable'
    || value === 'file_api_unauthorized'
    || value === 'internal_error'
}

export class FileApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: FileApiErrorCode,
  ) {
    super(message)
    this.name = 'FileApiError'
  }
}

export class FileApiClient {
  private baseUrl = RENDERER_HTTP_API_BASE_URL

  // 浏览器原生 fetch 依赖 Window 的调用上下文，不能作为未绑定方法直接调用。
  constructor(private readonly fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis)) {}

  setBaseUrl(baseUrl: string): void {
    this.baseUrl = baseUrl.replace(/\/$/, '')
  }

  async readText(input: FileApiPathRequest): Promise<FileApiReadTextResponse> {
    return this.request('/api/files/read-text', 'POST', input)
  }

  async writeText(input: FileApiWriteTextRequest): Promise<FileApiWriteTextResponse> {
    return this.request('/api/files/text', 'PUT', input)
  }

  private async request<T>(path: string, method: 'POST' | 'PUT', body: unknown): Promise<T> {
    let response: Response
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, withHttpApiWebToken({
        method,
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }))
    } catch (error) {
      const message = error instanceof Error ? error.message : '文件 API 服务不可用'
      throw new FileApiError(message, 503, 'server_unavailable')
    }

    const text = await response.text()
    let payload: unknown
    if (text) {
      try {
        payload = JSON.parse(text) as unknown
      } catch {
        payload = undefined
      }
    }
    if (!response.ok) {
      const message = isRecord(payload) && typeof payload.error === 'string'
        ? payload.error
        : `文件 API 请求失败（${response.status}）`
      const code = isRecord(payload) && isFileApiErrorCode(payload.code)
        ? payload.code
        : 'internal_error'
      throw new FileApiError(message, response.status, code)
    }
    if (!isRecord(payload)) throw new FileApiError('文件 API 响应不正确', 502, 'internal_error')
    return payload as T
  }
}

export const fileApiClient = new FileApiClient()
