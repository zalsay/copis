/**
 * 工作区 Skills 数据接口（Rust HTTP API）
 *
 * composer “/” 建议展示的可用 Skills 由 Rust 服务直接扫描工作区
 * `.agents/skills/` 目录返回，渲染层不再通过 Electron IPC 获取。
 */
import { RENDERER_HTTP_API_BASE_URL } from './http-api-base-url'
import { withHttpApiWebToken } from './http-api-web-token'

/** Rust HTTP API 返回的工作区可用 Skill 摘要 */
export interface WorkspaceSkillSummary {
  slug: string
  name: string
  description?: string
  enabled: boolean
}

const SKILLS_API_URL = RENDERER_HTTP_API_BASE_URL
const STARTUP_RETRY_COUNT = 20
const STARTUP_RETRY_DELAY_MS = 300

export class WorkspaceSkillsApiError extends Error {
  readonly status: number
  readonly code?: string

  constructor(message: string, status: number, code?: string) {
    super(message)
    this.name = 'WorkspaceSkillsApiError'
    this.status = status
    this.code = code
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function fetchWithStartupRetry(path: string, init: RequestInit): Promise<Response> {
  let lastError: unknown
  for (let attempt = 0; attempt < STARTUP_RETRY_COUNT; attempt += 1) {
    try {
      const response = await fetch(`${SKILLS_API_URL}${path}`, init)
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

async function request<T>(path: string): Promise<T> {
  const response = await fetchWithStartupRetry(path, withHttpApiWebToken({
    headers: {
      Accept: 'application/json',
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
      : `Skills 请求失败（${response.status}）`
    throw new WorkspaceSkillsApiError(
      message,
      response.status,
      typeof errorPayload.code === 'string' ? errorPayload.code : undefined,
    )
  }
  return payload as T
}

/** 读取工作区可用 Skills（Rust 直管 `.agents/skills/` 扫描） */
export function listWorkspaceSkills(workspaceSlug: string): Promise<WorkspaceSkillSummary[]> {
  const value = workspaceSlug.trim()
  if (!value) throw new Error('当前工作区不能为空')
  return request(`/api/workspaces/${encodeURIComponent(value)}/skills`)
}
