import { extname } from 'node:path'
import type {
  EditOperations,
  ReadOperations,
  WriteOperations,
} from '@earendil-works/pi-coding-agent'

const DEFAULT_HTTP_API_PORT = 51730
const INTERNAL_TOKEN_HEADER = 'x-copis-internal-token'
type FetchImplementation = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export interface RustFileToolClientOptions {
  sessionId: string
  baseUrl?: string
  internalToken?: string
  fetchImpl?: FetchImplementation
}

export interface RustFileToolOperations {
  read: ReadOperations
  edit: EditOperations
  write: WriteOperations
}

interface RustFileReadResponse {
  contentBase64: string
  revision: string
}

interface RustFileWriteResponse {
  revision: string
}

interface RustFileErrorResponse {
  error?: string
  code?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function resolveBaseUrl(value: string | undefined): string {
  if (value?.trim()) return value.replace(/\/$/, '')
  const port = Number.parseInt(process.env.COPIS_HTTP_API_PORT ?? '', 10)
  const effectivePort = Number.isSafeInteger(port) && port > 0 && port <= 65_535
    ? port
    : DEFAULT_HTTP_API_PORT
  return `http://127.0.0.1:${effectivePort}`
}

function requireInternalToken(value: string | undefined): string {
  const token = value?.trim()
  if (!token) throw new Error('Rust 文件权限服务内部令牌不可用')
  return token
}

function imageMimeType(path: string): string | undefined {
  switch (extname(path).toLowerCase()) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.png':
      return 'image/png'
    case '.gif':
      return 'image/gif'
    case '.webp':
      return 'image/webp'
    case '.bmp':
      return 'image/bmp'
    default:
      return undefined
  }
}

class RustFileToolClient {
  private readonly revisions = new Map<string, string>()
  private readonly baseUrl: string
  private readonly internalToken: string
  private readonly fetchImpl: FetchImplementation

  constructor(private readonly options: RustFileToolClientOptions) {
    this.baseUrl = resolveBaseUrl(options.baseUrl)
    this.internalToken = requireInternalToken(options.internalToken ?? process.env.COPIS_HTTP_API_INTERNAL_TOKEN)
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  private async request<T>(
    action: 'access' | 'read' | 'write',
    method: 'POST' | 'PUT',
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T | undefined> {
    let response: Response
    try {
      response = await this.fetchImpl(`${this.baseUrl}/api/internal/agent/files/${action}`, {
        method,
        signal,
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          [INTERNAL_TOKEN_HEADER]: this.internalToken,
        },
        body: JSON.stringify({ sessionId: this.options.sessionId, ...body }),
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Rust 文件权限服务不可用'
      throw new Error(`文件操作失败: ${message}`)
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
      const details = isRecord(payload) ? payload as RustFileErrorResponse : undefined
      const code = details?.code ? ` (${details.code})` : ''
      throw new Error(`${details?.error ?? `文件操作被拒绝（${response.status}）`}${code}`)
    }
    return payload as T | undefined
  }

  async assertAccess(path: string, mode: 'read' | 'write' | 'readWrite'): Promise<void> {
    await this.request('access', 'POST', { path, mode })
  }

  async readFile(path: string): Promise<Buffer> {
    const result = await this.request<RustFileReadResponse>('read', 'POST', { path })
    if (!result || typeof result.contentBase64 !== 'string' || typeof result.revision !== 'string') {
      throw new Error('Rust 文件读取响应不正确')
    }
    this.revisions.set(path, result.revision)
    return Buffer.from(result.contentBase64, 'base64')
  }

  async writeFile(path: string, content: string): Promise<void> {
    const expectedRevision = this.revisions.get(path)
    const result = await this.request<RustFileWriteResponse>('write', 'PUT', {
      path,
      content,
      ...(expectedRevision ? { expectedRevision } : {}),
    })
    if (!result || typeof result.revision !== 'string') {
      throw new Error('Rust 文件写入响应不正确')
    }
    this.revisions.set(path, result.revision)
  }
}

/**
 * Pi 只拿到文件操作能力，不接收读写根或权限决策。Rust 根据服务端会话策略执行每次校验。
 */
export function createRustFileToolOperations(options: RustFileToolClientOptions): RustFileToolOperations {
  const client = new RustFileToolClient(options)
  return {
    read: {
      access: (path) => client.assertAccess(path, 'read'),
      readFile: (path) => client.readFile(path),
      detectImageMimeType: async (path) => imageMimeType(path),
    },
    edit: {
      access: (path) => client.assertAccess(path, 'readWrite'),
      readFile: (path) => client.readFile(path),
      writeFile: (path, content) => client.writeFile(path, content),
    },
    write: {
      // Rust 在 write 时创建父目录并重新校验真实路径，Pi 侧不能借 mkdir 绕过策略。
      mkdir: async () => {},
      writeFile: (path, content) => client.writeFile(path, content),
    },
  }
}
