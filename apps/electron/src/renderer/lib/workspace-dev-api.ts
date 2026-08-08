/** 工作区项目开发服务（Rust HTTP API） */
import { RENDERER_HTTP_API_BASE_URL } from './http-api-base-url'
import { withHttpApiWebToken } from './http-api-web-token'

export interface WorkspaceDevProject {
  projectPath: string
  name: string
  kind: 'vite'
  port?: number
  status: 'running' | 'stopped'
  url?: string
}

interface WorkspaceDevErrorPayload {
  error?: string
  code?: string
}

export class WorkspaceDevApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message)
  }
}

function isErrorPayload(value: unknown): value is WorkspaceDevErrorPayload {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function encodeWorkspaceSlug(workspaceSlug: string): string {
  const value = workspaceSlug.trim()
  if (!value) throw new Error('当前工作区不能为空')
  return encodeURIComponent(value)
}

async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`${RENDERER_HTTP_API_BASE_URL}${path}`, withHttpApiWebToken({
    method,
    headers: {
      Accept: 'application/json',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }))
  const text = await response.text()
  let payload: unknown
  try {
    payload = text ? JSON.parse(text) as unknown : undefined
  } catch {
    payload = undefined
  }
  if (!response.ok) {
    const error = isErrorPayload(payload) ? payload : {}
    throw new WorkspaceDevApiError(
      error.error ?? `项目开发服务请求失败（${response.status}）`,
      response.status,
      error.code,
    )
  }
  return payload as T
}

export function listWorkspaceDevProjects(workspaceSlug: string): Promise<WorkspaceDevProject[]> {
  return request(`/api/workspaces/${encodeWorkspaceSlug(workspaceSlug)}/dev-projects`)
}

export function startWorkspaceDevProject(workspaceSlug: string, projectPath: string): Promise<WorkspaceDevProject> {
  return request(`/api/workspaces/${encodeWorkspaceSlug(workspaceSlug)}/dev-projects/start`, 'POST', { projectPath })
}

export function stopWorkspaceDevProject(workspaceSlug: string, projectPath: string): Promise<WorkspaceDevProject> {
  return request(`/api/workspaces/${encodeWorkspaceSlug(workspaceSlug)}/dev-projects/stop`, 'POST', { projectPath })
}
