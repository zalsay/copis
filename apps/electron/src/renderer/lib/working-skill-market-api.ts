import type { SkillMeta, WorkingExpertSkillMarketItem } from '@copis/shared'
import { RENDERER_HTTP_API_BASE_URL } from './http-api-base-url'
import { withHttpApiWebToken } from './http-api-web-token'

const WORKING_HTTP_API_URL = RENDERER_HTTP_API_BASE_URL
const STARTUP_RETRY_COUNT = 20
const STARTUP_RETRY_DELAY_MS = 300

export class WorkingSkillMarketApiError extends Error {
  readonly status: number
  readonly code?: string

  constructor(message: string, status: number, code?: string) {
    super(message)
    this.name = 'WorkingSkillMarketApiError'
    this.status = status
    this.code = code
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function encodeWorkspaceQuery(workspaceSlug: string): string {
  const value = workspaceSlug.trim()
  if (!value) throw new Error('当前工作区不能为空')
  return `workspaceSlug=${encodeURIComponent(value)}`
}

async function fetchWithStartupRetry(path: string, init: RequestInit): Promise<Response> {
  let lastError: unknown
  for (let attempt = 0; attempt < STARTUP_RETRY_COUNT; attempt += 1) {
    try {
      const response = await fetch(`${WORKING_HTTP_API_URL}${path}`, init)
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
      : `技能市场请求失败（${response.status}）`
    throw new WorkingSkillMarketApiError(
      message,
      response.status,
      typeof errorPayload.code === 'string' ? errorPayload.code : undefined,
    )
  }
  return payload as T
}

function normalizeMarketItem(value: unknown): WorkingExpertSkillMarketItem {
  if (!isRecord(value)) throw new Error('技能市场返回项格式不正确')
  const id = value.id
  if ((typeof id !== 'string' && typeof id !== 'number') || !String(id).trim()) {
    throw new Error('技能市场返回项缺少 ID')
  }
  if (typeof value.slug !== 'string' || !value.slug.trim()) {
    throw new Error('技能市场返回项缺少 slug')
  }
  return value as unknown as WorkingExpertSkillMarketItem
}

function legacyStringField(value: WorkingExpertSkillMarketItem, camelKey: string, snakeKey: string): string | undefined {
  const record = value as unknown as Record<string, unknown>
  const candidate = record[camelKey] ?? record[snakeKey]
  return typeof candidate === 'string' && candidate.trim() ? candidate.trim() : undefined
}

/** 将当前工作区已安装的市场 Skill 映射为 Agent 技能列表项。 */
export function mapInstalledMarketSkills(items: WorkingExpertSkillMarketItem[]): SkillMeta[] {
  return items.flatMap((item) => {
    if (item.localInstalled !== true) return []

    const slug = item.slug.trim()
    const name = item.name.trim()
    const latestVersion = item.version.trim()
    if (!slug || !name || !latestVersion) return []

    const localVersion = item.localVersion?.trim() || latestVersion
    const sourceProvider = legacyStringField(item, 'sourceProvider', 'source_provider') ?? 'platform'
    const installedAt = legacyStringField(item, 'installedAt', 'installed_at') ?? ''
    const category = item.category.trim()

    return [{
      slug,
      name,
      description: item.description,
      ...(category ? { group: category } : {}),
      version: localVersion,
      enabled: true,
      ...(localVersion !== latestVersion ? { hasUpdate: true } : {}),
      marketSource: {
        id: item.id,
        slug,
        version: latestVersion,
        sourceProvider,
        installedAt,
      },
    }]
  })
}

export async function listWorkingSkillMarket(workspaceSlug: string): Promise<WorkingExpertSkillMarketItem[]> {
  const payload = await request<unknown>(`/api/working/skill-market?${encodeWorkspaceQuery(workspaceSlug)}`)
  if (!Array.isArray(payload)) throw new Error('技能市场响应格式不正确')
  return payload.map(normalizeMarketItem)
}

export async function installWorkingSkill(workspaceSlug: string, skillId: number | string): Promise<void> {
  const id = String(skillId).trim()
  if (!id) throw new Error('技能市场 ID 不能为空')
  await request<unknown>(
    `/api/working/skill-market/${encodeURIComponent(id)}/install?${encodeWorkspaceQuery(workspaceSlug)}`,
    { method: 'POST', body: '{}' },
  )
}

export async function uninstallWorkingSkill(workspaceSlug: string, skillId: number | string): Promise<void> {
  const id = String(skillId).trim()
  if (!id) throw new Error('技能市场 ID 不能为空')
  await request<unknown>(
    `/api/working/skill-market/${encodeURIComponent(id)}/install?${encodeWorkspaceQuery(workspaceSlug)}`,
    { method: 'DELETE' },
  )
}
