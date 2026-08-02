import type {
  WorkingLoginInput,
  WorkingLoginResult,
  WorkingSessionHistory,
  WorkingSessionSummary,
  WorkingSkill,
  WorkingUser,
  WorkingWorkspace,
  WorkingWorkspaceInput,
} from '@proma/shared'
import type { WorkingTokenStore } from './working-auth-store'

export const DEFAULT_COPIS_BACKEND_URL = 'http://127.0.0.1:9000/module/edu-api'

export interface WorkingApiClientOptions {
  baseUrl?: string
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>
  tokenStore: WorkingTokenStore
}

export class WorkingApiError extends Error {
  readonly status: number
  readonly code?: string
  readonly payload?: unknown

  constructor(message: string, status: number, code?: string, payload?: unknown) {
    super(message)
    this.name = 'WorkingApiError'
    this.status = status
    this.code = code
    this.payload = payload
  }
}

function resolveBackendUrl(value?: string): string {
  const raw = value?.trim() || process.env.COPIS_BACKEND_URL?.trim() || DEFAULT_COPIS_BACKEND_URL
  const normalized = raw.replace(/\/+$/, '')
  let parsed: URL
  try {
    parsed = new URL(normalized)
  } catch {
    throw new Error('COPIS_BACKEND_URL 不是有效的 URL')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('COPIS_BACKEND_URL 只支持 http 或 https')
  }
  return normalized
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function unwrapData<T>(payload: unknown): T {
  if (isRecord(payload) && Object.prototype.hasOwnProperty.call(payload, 'data')) {
    return payload.data as T
  }
  return payload as T
}

function errorMessage(payload: unknown, fallback: string): { message: string; code?: string } {
  if (!isRecord(payload)) return { message: fallback }
  const message = typeof payload.error === 'string'
    ? payload.error
    : typeof payload.message === 'string'
      ? payload.message
      : fallback
  const code = typeof payload.code === 'string' ? payload.code : undefined
  return { message, code }
}

function normalizeWorkspace(value: unknown): WorkingWorkspace {
  const item = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  return {
    id: item.id as number | string,
    workspacePath: String(item.workspace_path ?? item.workspacePath ?? ''),
    pcId: String(item.pc_id ?? item.pcId ?? ''),
    workspaceType: item.workspace_type === 'cloud' || item.workspaceType === 'cloud' ? 'cloud' : 'local',
    isDefault: Boolean(item.is_default ?? item.isDefault),
    allowWorkspaceWrite: Boolean(item.allow_workspace_write ?? item.allowWorkspaceWrite),
    updatedAt: typeof (item.updated_at ?? item.updatedAt) === 'string'
      ? String(item.updated_at ?? item.updatedAt)
      : undefined,
  }
}

function normalizeSession(value: unknown): WorkingSessionSummary {
  const item = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  return {
    ...item,
    runId: String(item.run_id ?? item.runId ?? ''),
    sessionId: item.session_id == null && item.sessionId == null ? undefined : String(item.session_id ?? item.sessionId),
    title: item.title == null ? undefined : String(item.title),
    status: item.status == null ? undefined : String(item.status),
    finalText: item.final_text == null && item.finalText == null ? undefined : String(item.final_text ?? item.finalText),
    updatedAt: item.updated_at == null && item.updatedAt == null ? undefined : String(item.updated_at ?? item.updatedAt),
  }
}

function normalizeHistory(value: unknown): WorkingSessionHistory {
  const item = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  return {
    ...item,
    runId: String(item.run_id ?? item.runId ?? ''),
    sessionId: item.session_id == null && item.sessionId == null ? undefined : String(item.session_id ?? item.sessionId),
    jsonl: item.jsonl == null ? undefined : String(item.jsonl),
  }
}

function normalizeSkill(value: unknown): WorkingSkill {
  const item = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  return {
    ...item,
    slug: String(item.slug ?? ''),
    name: String(item.name ?? item.slug ?? ''),
    description: item.description == null ? undefined : String(item.description),
    version: item.version == null ? undefined : String(item.version),
    instructions: item.instructions == null ? undefined : String(item.instructions),
    downloadUrl: item.download_url == null && item.downloadUrl == null ? undefined : String(item.download_url ?? item.downloadUrl),
    sha256: item.sha256 == null ? undefined : String(item.sha256),
    size: typeof item.size === 'number' ? item.size : undefined,
  }
}

export class WorkingApiClient {
  readonly baseUrl: string
  private readonly fetchImpl: (input: string, init?: RequestInit) => Promise<Response>
  private readonly tokenStore: WorkingTokenStore

  constructor(options: WorkingApiClientOptions) {
    this.baseUrl = resolveBackendUrl(options.baseUrl)
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init))
    this.tokenStore = options.tokenStore
  }

  getToken(): string | null {
    return this.tokenStore.getToken()
  }

  getCachedUser(): WorkingUser | null {
    return this.tokenStore.getUser()
  }

  clearAuth(): void {
    this.tokenStore.clear()
  }

  async login(input: WorkingLoginInput): Promise<WorkingLoginResult> {
    const email = input.email.trim()
    if (!email || !input.password) throw new Error('请输入邮箱和密码')

    const result = await this.request<WorkingLoginResult>('/api/auth/login', {
      method: 'POST',
      auth: false,
      body: JSON.stringify({ email, password: input.password }),
    })
    if (!result || typeof result.token !== 'string' || result.token.length === 0) {
      throw new WorkingApiError('登录响应缺少 token', 200, 'invalid_login_response', result)
    }

    this.tokenStore.save(result.token, result.user ?? null)
    try {
      const user = await this.getCurrentUser()
      return { ...result, user }
    } catch (error) {
      if (error instanceof WorkingApiError && error.status === 401) {
        this.tokenStore.clear()
        throw error
      }
      this.tokenStore.save(result.token, result.user ?? null)
      return result
    }
  }

  logout(): void {
    this.tokenStore.clear()
  }

  async getCurrentUser(): Promise<WorkingUser> {
    const user = await this.request<WorkingUser>('/api/users/me')
    if (!user || (typeof user !== 'object')) {
      throw new WorkingApiError('当前账号响应格式不正确', 200, 'invalid_user_response', user)
    }
    const token = this.tokenStore.getToken()
    if (token) this.tokenStore.save(token, user)
    return user
  }

  async listWorkspaces(): Promise<WorkingWorkspace[]> {
    const data = await this.request<unknown>('/api/working/workspaces')
    if (!Array.isArray(data)) throw new WorkingApiError('工作区响应格式不正确', 200, 'invalid_workspaces_response', data)
    return data.map(normalizeWorkspace)
  }

  async saveWorkspace(input: WorkingWorkspaceInput): Promise<WorkingWorkspace> {
    const workspacePath = input.workspacePath.trim()
    if (!workspacePath) throw new Error('工作区路径不能为空')
    const data = await this.request<unknown>('/api/working/workspaces', {
      method: 'POST',
      body: JSON.stringify({
        workspace_path: workspacePath,
        pc_id: input.pcId?.trim() ?? '',
        workspace_type: input.workspaceType ?? 'local',
        allow_workspace_write: input.allowWorkspaceWrite ?? true,
      }),
    })
    return normalizeWorkspace(data)
  }

  async listSessions(): Promise<WorkingSessionSummary[]> {
    const data = await this.request<unknown>('/api/working/sessions')
    if (!Array.isArray(data)) throw new WorkingApiError('Working 历史响应格式不正确', 200, 'invalid_sessions_response', data)
    return data.map(normalizeSession)
  }

  async getSessionHistory(runId: string, sessionId?: string): Promise<WorkingSessionHistory> {
    const cleanRunId = runId.trim()
    if (!cleanRunId) throw new Error('runId 不能为空')
    const query = sessionId?.trim() ? `?session_id=${encodeURIComponent(sessionId.trim())}` : ''
    const data = await this.request<unknown>(`/api/working/sessions/${encodeURIComponent(cleanRunId)}/history${query}`)
    return normalizeHistory(data)
  }

  async listSkills(): Promise<WorkingSkill[]> {
    const data = await this.request<unknown>('/api/working/expert-skills/runtime')
    if (!Array.isArray(data)) throw new WorkingApiError('技能响应格式不正确', 200, 'invalid_skills_response', data)
    return data.map(normalizeSkill)
  }

  private async request<T>(path: string, options: RequestInit & { auth?: boolean } = {}): Promise<T> {
    const { auth = true, ...requestInit } = options
    const headers = new Headers(requestInit.headers)
    headers.set('Accept', 'application/json')
    if (requestInit.body !== undefined) headers.set('Content-Type', 'application/json')
    if (auth) {
      const token = this.tokenStore.getToken()
      if (!token) throw new WorkingApiError('请先登录 Copis Working', 401, 'unauthorized')
      headers.set('Authorization', `Bearer ${token}`)
    }

    let response: Response
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`, {
        ...requestInit,
        headers,
      })
    } catch (error) {
      throw new WorkingApiError(error instanceof Error ? error.message : '无法连接 Working 后端', 0, 'network_error', error)
    }

    const text = await response.text()
    let payload: unknown = null
    if (text.trim()) {
      try {
        payload = JSON.parse(text) as unknown
      } catch {
        payload = text
      }
    }
    if (!response.ok) {
      if (response.status === 401) this.tokenStore.clear()
      const detail = errorMessage(payload, `Working 后端请求失败（HTTP ${response.status}）`)
      throw new WorkingApiError(detail.message, response.status, detail.code, payload)
    }
    return unwrapData<T>(payload)
  }
}
