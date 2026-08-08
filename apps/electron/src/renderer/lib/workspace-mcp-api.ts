/**
 * 工作区 MCP 数据接口（Rust HTTP API）
 *
 * mcp.json 的读取与保存由 Rust 服务直管；内置 MCP 列表/开关与连接测试
 * 走同一 Rust HTTP API（由业务桥转发到 Electron 侧）。渲染层不再通过
 * Electron IPC 访问 MCP 数据。
 */
import type { BuiltinMcpServerSummary, McpServerEntry, WorkspaceMcpConfig } from '@copis/shared'
import { RENDERER_HTTP_API_BASE_URL } from './http-api-base-url'
import { withHttpApiWebToken } from './http-api-web-token'

const MCP_API_URL = RENDERER_HTTP_API_BASE_URL
const STARTUP_RETRY_COUNT = 20
const STARTUP_RETRY_DELAY_MS = 300

export class WorkspaceMcpApiError extends Error {
  readonly status: number
  readonly code?: string

  constructor(message: string, status: number, code?: string) {
    super(message)
    this.name = 'WorkspaceMcpApiError'
    this.status = status
    this.code = code
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function encodeSlug(workspaceSlug: string): string {
  const value = workspaceSlug.trim()
  if (!value) throw new Error('当前工作区不能为空')
  return encodeURIComponent(value)
}

async function fetchWithStartupRetry(path: string, init: RequestInit): Promise<Response> {
  let lastError: unknown
  for (let attempt = 0; attempt < STARTUP_RETRY_COUNT; attempt += 1) {
    try {
      const response = await fetch(`${MCP_API_URL}${path}`, init)
      if (response.status < 500 || response.status > 504 || attempt + 1 >= STARTUP_RETRY_COUNT) {
        return response
      }
    } catch (error: unknown) {
      lastError = error
      if (attempt + 1 >= STARTUP_RETRY_COUNT) break
    }
    await new Promise<void>((resolve) => window.setTimeout(resolve, STARTUP_RETRY_DELAY_MS))
  }
  throw lastError instanceof Error ? lastError : new Error('Rust HTTP API 服务未启动')
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetchWithStartupRetry(path, withHttpApiWebToken({
    ...init,
    headers: {
      Accept: 'application/json',
      ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...init.headers,
    },
  }))
  const text = await response.text()
  let payload: unknown
  if (text) {
    try {
      payload = JSON.parse(text) as unknown
    } catch {
      payload = text
    }
  }
  if (!response.ok) {
    const errorPayload = isRecord(payload) ? payload : {}
    const message = typeof errorPayload.error === 'string'
      ? errorPayload.error
      : `MCP 请求失败（${response.status}）`
    throw new WorkspaceMcpApiError(
      message,
      response.status,
      typeof errorPayload.code === 'string' ? errorPayload.code : undefined,
    )
  }
  return payload as T
}

/** 读取工作区 MCP 配置（Rust 直管 mcp.json） */
export function getWorkspaceMcpConfig(workspaceSlug: string): Promise<WorkspaceMcpConfig> {
  return request(`/api/workspaces/${encodeSlug(workspaceSlug)}/mcp`)
}

/** 保存工作区 MCP 配置，返回规范化后的配置 */
export function saveWorkspaceMcpConfig(
  workspaceSlug: string,
  config: WorkspaceMcpConfig,
): Promise<WorkspaceMcpConfig> {
  return request(`/api/workspaces/${encodeSlug(workspaceSlug)}/mcp`, {
    method: 'PUT',
    body: JSON.stringify(config),
  })
}

/** 读取当前工作区可见的内置 MCP 列表 */
export function listBuiltinMcpServers(workspaceSlug: string): Promise<BuiltinMcpServerSummary[]> {
  return request(`/api/workspaces/${encodeSlug(workspaceSlug)}/mcp/builtin`)
}

/** 开启或关闭内置 MCP，返回更新后的内置 MCP 列表 */
export function setBuiltinMcpEnabled(
  workspaceSlug: string,
  id: string,
  enabled: boolean,
): Promise<BuiltinMcpServerSummary[]> {
  return request(`/api/workspaces/${encodeSlug(workspaceSlug)}/mcp/builtin/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ enabled }),
  })
}

/** 测试 MCP 服务器连接 */
export function testMcpServer(
  name: string,
  entry: McpServerEntry,
): Promise<{ success: boolean; message: string }> {
  return request('/api/mcp/test', {
    method: 'POST',
    body: JSON.stringify({ name, entry }),
  })
}
