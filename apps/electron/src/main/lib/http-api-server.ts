import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { WorkingApiClient } from './working-api-client'
import { getWorkingApiClient } from './working-api-service'
import { getTutorialContent } from './tutorial-service'
import { getSettings, updateSettings } from './settings-service'
import type { AppSettings } from '../../types'
import {
  COPIS_WORKING_CHANNEL_ID,
  COPIS_WORKING_EXPERT_MODEL_ID,
  COPIS_WORKING_FAST_MODEL_ID,
} from '@proma/shared'
import type {
  AgentMessage,
  AgentSendInput,
  AgentSessionMeta,
  AgentWorkspace,
  SDKMessage,
  WorkingFeedbackInput,
  WorkingLoginInput,
  WorkingPasswordResetInput,
  WorkingRegisterInput,
  WorkingSendVerificationCodeInput,
  WorkingVerifyPasswordResetCodeInput,
  WorkingWorkspaceInput,
  WorkingReceiveChannel,
} from '@proma/shared'

export const HTTP_API_HOST = '127.0.0.1'
export const HTTP_API_PORT = 51730

const MAX_REQUEST_BODY_BYTES = 2 * 1024 * 1024
const WEB_CLIENT_ORIGINS = new Set([
  'http://127.0.0.1:5174',
  'http://localhost:5174',
])

interface WorkingApiFacade {
  readonly baseUrl: string
  getToken(): string | null
  getCachedUser(): ReturnType<WorkingApiClient['getCachedUser']>
  login(input: WorkingLoginInput): ReturnType<WorkingApiClient['login']>
  register(input: WorkingRegisterInput): ReturnType<WorkingApiClient['register']>
  sendVerificationCode(input: WorkingSendVerificationCodeInput): ReturnType<WorkingApiClient['sendVerificationCode']>
  verifyPasswordResetCode(input: WorkingVerifyPasswordResetCodeInput): ReturnType<WorkingApiClient['verifyPasswordResetCode']>
  resetPassword(input: WorkingPasswordResetInput): ReturnType<WorkingApiClient['resetPassword']>
  logout(): void
  getCurrentUser(): ReturnType<WorkingApiClient['getCurrentUser']>
  listWorkspaces(): ReturnType<WorkingApiClient['listWorkspaces']>
  saveWorkspace(input: WorkingWorkspaceInput): ReturnType<WorkingApiClient['saveWorkspace']>
  listSessions(): ReturnType<WorkingApiClient['listSessions']>
  getSessionHistory(runId: string, sessionId?: string): ReturnType<WorkingApiClient['getSessionHistory']>
  listSkills(): ReturnType<WorkingApiClient['listSkills']>
  createFeedback(input: WorkingFeedbackInput): ReturnType<WorkingApiClient['createFeedback']>
  getSettingsSnapshot(): ReturnType<WorkingApiClient['getSettingsSnapshot']>
  checkIn(): ReturnType<WorkingApiClient['checkIn']>
  setReceiveChannel(channel: WorkingReceiveChannel): ReturnType<WorkingApiClient['setReceiveChannel']>
  listOrders(page?: number, pageSize?: number): ReturnType<WorkingApiClient['listOrders']>
  deleteOrder(orderId: number | string): ReturnType<WorkingApiClient['deleteOrder']>
}

interface HttpApiDependencies {
  getWorkingClient: () => WorkingApiFacade
  getAppSettings: () => AppSettings
  updateAppSettings: (updates: Partial<AppSettings>) => AppSettings
  getAgentApi?: () => Promise<AgentHttpFacade>
}

interface AgentHttpFacade {
  ensureDefaultWorkspace: () => AgentWorkspace
  listAgentWorkspaces: () => AgentWorkspace[]
  listAgentSessions: () => AgentSessionMeta[]
  getAgentSessionMeta: (id: string) => AgentSessionMeta | undefined
  clearAgentCompletionState: (id: string) => AgentSessionMeta
  createAgentSession: (
    title?: string,
    channelId?: string,
    workspaceId?: string,
    modelId?: string,
    agentRuntime?: 'claude' | 'pi',
  ) => AgentSessionMeta
  getAgentSessionSDKMessages: (id: string) => SDKMessage[]
  runAgentHeadless: (
    input: AgentSendInput,
    callbacks: {
      onError: (error: string) => void
      onComplete: (messages?: AgentMessage[]) => void
      onTitleUpdated: (title: string) => void
    },
  ) => Promise<void>
  stopAgent: (sessionId: string) => void
}

const defaultDependencies: HttpApiDependencies = {
  getWorkingClient: getWorkingApiClient,
  getAppSettings: getSettings,
  updateAppSettings: updateSettings,
}

let defaultAgentApiPromise: Promise<AgentHttpFacade> | null = null

/** 延迟加载 Agent 服务，避免仅访问健康检查时初始化 Electron Agent 运行时。 */
function getDefaultAgentApi(): Promise<AgentHttpFacade> {
  if (!defaultAgentApiPromise) {
    defaultAgentApiPromise = Promise.all([
      import('./agent-service'),
      import('./agent-session-manager'),
      import('./agent-workspace-manager'),
    ]).then(([agentService, sessionManager, workspaceManager]) => ({
      ensureDefaultWorkspace: workspaceManager.ensureDefaultWorkspace,
      listAgentWorkspaces: workspaceManager.listAgentWorkspaces,
      listAgentSessions: sessionManager.listAgentSessions,
      getAgentSessionMeta: sessionManager.getAgentSessionMeta,
      clearAgentCompletionState: (id: string) => {
        const current = sessionManager.getAgentSessionMeta(id)
        if (!current) throw new Error(`Agent session not found: ${id}`)
        const updates: Partial<AgentSessionMeta> = {}
        if (current.manualWorking) updates.manualWorking = false
        if (current.completedButUnconfirmed) updates.completedButUnconfirmed = false
        return Object.keys(updates).length > 0
          ? sessionManager.updateAgentSessionMeta(id, updates)
          : current
      },
      createAgentSession: sessionManager.createAgentSession,
      getAgentSessionSDKMessages: sessionManager.getAgentSessionSDKMessages,
      runAgentHeadless: agentService.runAgentHeadless,
      stopAgent: agentService.stopAgent,
    }))
  }
  return defaultAgentApiPromise
}

defaultDependencies.getAgentApi = getDefaultAgentApi

class HttpApiRequestError extends Error {
  readonly status: number
  readonly code: string

  constructor(message: string, status: number, code = 'bad_request') {
    super(message)
    this.name = 'HttpApiRequestError'
    this.status = status
    this.code = code
  }
}

let httpApiServer: Server | null = null

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireRecord(value: unknown, message = '请求体必须是 JSON 对象'): Record<string, unknown> {
  if (!isRecord(value)) throw new HttpApiRequestError(message, 400, 'invalid_request_body')
  return value
}

function requireString(record: Record<string, unknown>, key: string, message = `${key} 参数不正确`): string {
  const value = record[key]
  if (typeof value !== 'string' || !value.trim()) {
    throw new HttpApiRequestError(message, 400, 'invalid_request')
  }
  return value
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' && value.trim() ? value : undefined
}

function decodePathSegment(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    throw new HttpApiRequestError('URL 参数编码不正确', 400, 'invalid_path')
  }
}

function parsePage(value: string | null, fallback: number): number {
  if (!value) return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) throw new HttpApiRequestError('分页参数不正确', 400, 'invalid_pagination')
  return parsed
}

function getRequestOrigin(request: IncomingMessage): string | undefined {
  const origin = request.headers.origin
  return typeof origin === 'string' && origin ? origin : undefined
}

function setCorsHeaders(response: ServerResponse, origin?: string): void {
  response.setHeader('Vary', 'Origin')
  if (!origin || !WEB_CLIENT_ORIGINS.has(origin)) return
  response.setHeader('Access-Control-Allow-Origin', origin)
  response.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS')
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  response.setHeader('Access-Control-Max-Age', '600')
}

function sendJson(response: ServerResponse, status: number, payload: unknown, origin?: string): void {
  setCorsHeaders(response, origin)
  response.statusCode = status
  response.setHeader('Content-Type', 'application/json; charset=utf-8')
  response.end(JSON.stringify(payload))
}

function sendEmpty(response: ServerResponse, status: number, origin?: string): void {
  setCorsHeaders(response, origin)
  response.statusCode = status
  response.end()
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let totalBytes = 0
  let settled = false

  return new Promise((resolve, reject) => {
    request.on('data', (chunk: Buffer | string) => {
      if (settled) return
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      totalBytes += buffer.byteLength
      if (totalBytes > MAX_REQUEST_BODY_BYTES) {
        settled = true
        request.resume()
        reject(new HttpApiRequestError('请求体过大', 413, 'request_body_too_large'))
        return
      }
      chunks.push(buffer)
    })
    request.on('end', () => {
      if (settled) return
      settled = true
      if (chunks.length === 0) {
        resolve(undefined)
        return
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown)
      } catch {
        reject(new HttpApiRequestError('请求体不是有效的 JSON', 400, 'invalid_json'))
      }
    })
    request.on('error', (error: Error) => {
      if (settled) return
      settled = true
      reject(error)
    })
  })
}

function getErrorResponse(error: unknown): { status: number; body: Record<string, unknown> } {
  if (error instanceof HttpApiRequestError) {
    return {
      status: error.status,
      body: { error: error.message, code: error.code },
    }
  }

  if (isRecord(error) && typeof error.status === 'number' && typeof error.message === 'string') {
    return {
      status: error.status >= 400 && error.status <= 599 ? error.status : 500,
      body: {
        error: error.message,
        ...(typeof error.code === 'string' ? { code: error.code } : {}),
      },
    }
  }

  const message = error instanceof Error ? error.message : 'HTTP API 请求失败'
  console.error('[HTTP API] 请求处理失败:', error)
  return {
    status: 500,
    body: { error: message, code: 'internal_error' },
  }
}

function sanitizeAppSettings(settings: AppSettings): Omit<AppSettings, 'voiceDictation'> {
  const { voiceDictation: _voiceDictation, ...safeSettings } = settings
  return safeSettings
}

function sanitizeAppSettingsUpdates(value: Record<string, unknown>): Partial<AppSettings> {
  const { voiceDictation: _voiceDictation, ...safeUpdates } = value
  return safeUpdates as Partial<AppSettings>
}

function makeAuthState(client: WorkingApiFacade): {
  authenticated: boolean
  user: ReturnType<WorkingApiFacade['getCachedUser']>
  backendUrl: string
} {
  return {
    authenticated: Boolean(client.getToken()),
    user: client.getCachedUser(),
    backendUrl: client.baseUrl,
  }
}

function getAgentApi(dependencies: HttpApiDependencies): Promise<AgentHttpFacade> {
  return dependencies.getAgentApi?.() ?? getDefaultAgentApi()
}

function getRequiredAgentSession(api: AgentHttpFacade, sessionId: string): AgentSessionMeta {
  const session = api.getAgentSessionMeta(sessionId)
  if (!session) {
    throw new HttpApiRequestError('Agent 会话不存在', 404, 'agent_session_not_found')
  }
  return session
}

async function handleAgentRequest(
  request: IncomingMessage,
  url: URL,
  segments: string[],
  dependencies: HttpApiDependencies,
): Promise<{ status: number; body: unknown }> {
  const api = await getAgentApi(dependencies)
  const method = request.method ?? 'GET'
  const body = method === 'GET' || method === 'DELETE' ? undefined : await readJsonBody(request)
  const bodyRecord = body === undefined ? undefined : requireRecord(body)
  const resource = segments[2]
  const action = segments[3]
  const sessionAction = segments[4]

  if (resource === 'bootstrap' && method === 'GET') {
    const defaultWorkspace = api.ensureDefaultWorkspace()
    const workspaces = api.listAgentWorkspaces()
    const settings = dependencies.getAppSettings()
    const workspace = workspaces.find((item) => item.id === settings.agentWorkspaceId) ?? defaultWorkspace
    return {
      status: 200,
      body: {
        workspace,
        workspaces,
        channelId: COPIS_WORKING_CHANNEL_ID,
        modelId: COPIS_WORKING_FAST_MODEL_ID,
        allowWorkspaceWrite: workspace.allowWorkspaceWrite === true,
      },
    }
  }

  if (resource === 'workspaces' && method === 'GET') {
    api.ensureDefaultWorkspace()
    return { status: 200, body: api.listAgentWorkspaces() }
  }

  if (resource === 'sessions' && action === undefined && method === 'GET') {
    return { status: 200, body: api.listAgentSessions() }
  }

  if (resource === 'sessions' && action === undefined && method === 'POST') {
    const defaultWorkspace = api.ensureDefaultWorkspace()
    const workspaceId = optionalString(bodyRecord ?? {}, 'workspaceId') ?? defaultWorkspace.id
    const workspace = api.listAgentWorkspaces().find((item) => item.id === workspaceId)
    if (!workspace) {
      throw new HttpApiRequestError('Agent 项目不存在', 404, 'agent_workspace_not_found')
    }

    const requestedModelId = optionalString(bodyRecord ?? {}, 'modelId')
    const modelId = requestedModelId === COPIS_WORKING_EXPERT_MODEL_ID
      ? COPIS_WORKING_EXPERT_MODEL_ID
      : COPIS_WORKING_FAST_MODEL_ID
    const session = api.createAgentSession(
      optionalString(bodyRecord ?? {}, 'title'),
      COPIS_WORKING_CHANNEL_ID,
      workspace.id,
      modelId,
      'pi',
    )
    return { status: 201, body: session }
  }

  if (resource !== 'sessions' || action === undefined) {
    throw new HttpApiRequestError('Agent API 路径不存在', 404, 'not_found')
  }

  const sessionId = decodePathSegment(action)
  const session = getRequiredAgentSession(api, sessionId)

  if (sessionAction === 'messages' && method === 'GET') {
    return {
      status: 200,
      body: {
        session,
        messages: api.getAgentSessionSDKMessages(sessionId),
      },
    }
  }

  if (sessionAction === 'clear-completion-state' && method === 'POST') {
    return { status: 200, body: api.clearAgentCompletionState(sessionId) }
  }

  if (sessionAction === 'messages' && method === 'POST') {
    const userMessage = requireString(bodyRecord ?? {}, 'userMessage', 'Agent 消息不能为空')
    const startedAt = Date.now()
    let runError: string | undefined
    const requestedModelId = optionalString(bodyRecord ?? {}, 'modelId')
    const modelId = requestedModelId === COPIS_WORKING_EXPERT_MODEL_ID
      ? COPIS_WORKING_EXPERT_MODEL_ID
      : requestedModelId === COPIS_WORKING_FAST_MODEL_ID
        ? COPIS_WORKING_FAST_MODEL_ID
        : session.modelId ?? COPIS_WORKING_FAST_MODEL_ID
    const workingMode = modelId === COPIS_WORKING_EXPERT_MODEL_ID ? 'expert' : 'fast'

    const input: AgentSendInput = {
      sessionId,
      userMessage,
      rawUserMessage: userMessage,
      channelId: session.channelId ?? COPIS_WORKING_CHANNEL_ID,
      modelId,
      agentRuntime: 'pi',
      workspaceId: session.workspaceId,
      workingMode,
      permissionModeOverride: 'bypassPermissions',
      startedAt,
      triggeredBy: 'user',
    }

    await api.runAgentHeadless(input, {
      onError: (error) => {
        runError = error
      },
      onComplete: () => {
        // 完整消息从本地 JSONL 重新读取，确保响应与桌面端历史回放一致。
      },
      onTitleUpdated: () => {
        // 标题更新由 Agent 会话索引持久化处理。
      },
    })

    if (runError) {
      throw new HttpApiRequestError(runError, 422, 'agent_run_failed')
    }

    return {
      status: 200,
      body: {
        session: api.getAgentSessionMeta(sessionId),
        messages: api.getAgentSessionSDKMessages(sessionId),
      },
    }
  }

  if (sessionAction === 'stop' && method === 'POST') {
    api.stopAgent(sessionId)
    return { status: 204, body: undefined }
  }

  throw new HttpApiRequestError('Agent API 路径不存在', 404, 'not_found')
}

async function handleWorkingRequest(
  request: IncomingMessage,
  url: URL,
  segments: string[],
  dependencies: HttpApiDependencies,
): Promise<{ status: number; body: unknown }> {
  const client = dependencies.getWorkingClient()
  const method = request.method ?? 'GET'
  const body = method === 'GET' || method === 'DELETE' ? undefined : await readJsonBody(request)
  const bodyRecord = body === undefined ? undefined : requireRecord(body)
  const resource = segments[2]
  const action = segments[3]

  if (resource === 'config' && method === 'GET') {
    return { status: 200, body: { backendUrl: client.baseUrl } }
  }

  if (resource === 'auth-state' && method === 'GET') {
    return { status: 200, body: makeAuthState(client) }
  }

  if (resource === 'login' && method === 'POST') {
    const input: WorkingLoginInput = {
      email: requireString(bodyRecord ?? {}, 'email', '登录邮箱不正确'),
      password: requireString(bodyRecord ?? {}, 'password', '登录密码不正确'),
    }
    const result = await client.login(input)
    return {
      status: 200,
      body: {
        authenticated: true,
        user: result.user ?? client.getCachedUser(),
        backendUrl: client.baseUrl,
      },
    }
  }

  if (resource === 'register' && method === 'POST') {
    const input: WorkingRegisterInput = {
      email: requireString(bodyRecord ?? {}, 'email', '注册邮箱不正确'),
      password: requireString(bodyRecord ?? {}, 'password', '注册密码不正确'),
      ...(optionalString(bodyRecord ?? {}, 'nickname') ? { nickname: optionalString(bodyRecord ?? {}, 'nickname') } : {}),
      ...(optionalString(bodyRecord ?? {}, 'invitationCode') ? { invitationCode: optionalString(bodyRecord ?? {}, 'invitationCode') } : {}),
      ...(optionalString(bodyRecord ?? {}, 'verificationCode') ? { verificationCode: optionalString(bodyRecord ?? {}, 'verificationCode') } : {}),
    }
    return { status: 200, body: await client.register(input) }
  }

  if (resource === 'send-verification-code' && method === 'POST') {
    const purpose = optionalString(bodyRecord ?? {}, 'purpose')
    if (purpose !== undefined && purpose !== 'register' && purpose !== 'password_reset') {
      throw new HttpApiRequestError('验证码用途不正确', 400, 'invalid_purpose')
    }
    const input: WorkingSendVerificationCodeInput = {
      email: requireString(bodyRecord ?? {}, 'email', '验证码邮箱不正确'),
      ...(purpose ? { purpose } : {}),
    }
    await client.sendVerificationCode(input)
    return { status: 204, body: undefined }
  }

  if (resource === 'verify-password-reset-code' && method === 'POST') {
    const input: WorkingVerifyPasswordResetCodeInput = {
      email: requireString(bodyRecord ?? {}, 'email', '验证码邮箱不正确'),
      code: requireString(bodyRecord ?? {}, 'code', '验证码不正确'),
    }
    return { status: 200, body: await client.verifyPasswordResetCode(input) }
  }

  if (resource === 'reset-password' && method === 'POST') {
    const input: WorkingPasswordResetInput = {
      email: requireString(bodyRecord ?? {}, 'email', '重置邮箱不正确'),
      resetToken: requireString(bodyRecord ?? {}, 'resetToken', '重置凭证不正确'),
      password: requireString(bodyRecord ?? {}, 'password', '新密码不正确'),
    }
    await client.resetPassword(input)
    return { status: 204, body: undefined }
  }

  if (resource === 'logout' && method === 'POST') {
    client.logout()
    return { status: 200, body: makeAuthState(client) }
  }

  if (resource === 'current-user' && method === 'GET') {
    return { status: 200, body: await client.getCurrentUser() }
  }

  if (resource === 'workspaces' && method === 'GET') {
    return { status: 200, body: await client.listWorkspaces() }
  }

  if (resource === 'workspaces' && method === 'POST') {
    const workspaceType = optionalString(bodyRecord ?? {}, 'workspaceType')
    if (workspaceType !== undefined && workspaceType !== 'local' && workspaceType !== 'cloud') {
      throw new HttpApiRequestError('工作区类型不正确', 400, 'invalid_workspace_type')
    }
    const input: WorkingWorkspaceInput = {
      workspacePath: requireString(bodyRecord ?? {}, 'workspacePath', '工作区路径不正确'),
      ...(optionalString(bodyRecord ?? {}, 'pcId') ? { pcId: optionalString(bodyRecord ?? {}, 'pcId') } : {}),
      ...(workspaceType ? { workspaceType } : {}),
      ...(typeof bodyRecord?.allowWorkspaceWrite === 'boolean' ? { allowWorkspaceWrite: bodyRecord.allowWorkspaceWrite } : {}),
    }
    return { status: 200, body: await client.saveWorkspace(input) }
  }

  if (resource === 'sessions' && method === 'GET' && action === undefined) {
    return { status: 200, body: await client.listSessions() }
  }

  if (resource === 'sessions' && segments[4] === 'history' && method === 'GET') {
    const runId = decodePathSegment(segments[3] ?? '')
    const sessionId = url.searchParams.get('sessionId') ?? url.searchParams.get('session_id') ?? undefined
    return { status: 200, body: await client.getSessionHistory(runId, sessionId) }
  }

  if (resource === 'skills' && method === 'GET') {
    return { status: 200, body: await client.listSkills() }
  }

  if (resource === 'feedback' && method === 'POST') {
    const input = bodyRecord as unknown as WorkingFeedbackInput
    for (const key of ['pageKey', 'feedbackType', 'severity', 'title', 'description', 'route']) {
      requireString(bodyRecord ?? {}, key, `反馈 ${key} 参数不正确`)
    }
    return { status: 200, body: await client.createFeedback(input) }
  }

  if (resource === 'settings' && method === 'GET') {
    return { status: 200, body: await client.getSettingsSnapshot() }
  }

  if (resource === 'check-in' && method === 'POST') {
    return { status: 200, body: await client.checkIn() }
  }

  if (resource === 'receive-channel' && method === 'PUT') {
    const channel = bodyRecord?.channel
    if (channel !== 'weixin' && channel !== 'feishu') {
      throw new HttpApiRequestError('消息接收方式不正确', 400, 'invalid_receive_channel')
    }
    return { status: 200, body: await client.setReceiveChannel(channel) }
  }

  if (resource === 'orders' && method === 'GET') {
    return {
      status: 200,
      body: await client.listOrders(
        parsePage(url.searchParams.get('page'), 1),
        parsePage(url.searchParams.get('pageSize') ?? url.searchParams.get('page_size'), 20),
      ),
    }
  }

  if (resource === 'orders' && method === 'DELETE' && action !== undefined) {
    await client.deleteOrder(decodePathSegment(action))
    return { status: 204, body: undefined }
  }

  throw new HttpApiRequestError('Working API 路径不存在', 404, 'not_found')
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  dependencies: HttpApiDependencies,
): Promise<void> {
  const origin = getRequestOrigin(request)
  setCorsHeaders(response, origin)

  if (origin && !WEB_CLIENT_ORIGINS.has(origin)) {
    sendJson(response, 403, { error: '不允许的请求来源', code: 'origin_not_allowed' }, origin)
    return
  }

  if (request.method === 'OPTIONS') {
    sendEmpty(response, 204, origin)
    return
  }

  let url: URL
  try {
    url = new URL(request.url ?? '/', `http://${HTTP_API_HOST}:${HTTP_API_PORT}`)
  } catch {
    sendJson(response, 400, { error: '请求 URL 不正确', code: 'invalid_url' }, origin)
    return
  }

  try {
    if (url.pathname === '/api/health' && request.method === 'GET') {
      sendJson(response, 200, {
        ok: true,
        service: 'copis-http-api',
        port: HTTP_API_PORT,
      }, origin)
      return
    }

    if (url.pathname === '/api/settings' && request.method === 'GET') {
      sendJson(response, 200, sanitizeAppSettings(dependencies.getAppSettings()), origin)
      return
    }

    if (url.pathname === '/api/settings' && (request.method === 'PATCH' || request.method === 'PUT')) {
      const body = requireRecord(await readJsonBody(request))
      const updated = dependencies.updateAppSettings(sanitizeAppSettingsUpdates(body))
      sendJson(response, 200, sanitizeAppSettings(updated), origin)
      return
    }

    if (url.pathname === '/api/tutorial' && request.method === 'GET') {
      sendJson(response, 200, { content: getTutorialContent() }, origin)
      return
    }

    const segments = url.pathname.split('/').filter(Boolean)
    if (segments[0] !== 'api') {
      throw new HttpApiRequestError('HTTP API 路径不存在', 404, 'not_found')
    }

    const result = segments[1] === 'agent'
      ? await handleAgentRequest(request, url, segments, dependencies)
      : segments[1] === 'working'
        ? await handleWorkingRequest(request, url, segments, dependencies)
        : (() => { throw new HttpApiRequestError('HTTP API 路径不存在', 404, 'not_found') })()
    if (result.status === 204) {
      sendEmpty(response, 204, origin)
    } else {
      sendJson(response, result.status, result.body, origin)
    }
  } catch (error: unknown) {
    const result = getErrorResponse(error)
    sendJson(response, result.status, result.body, origin)
  }
}

export function createHttpApiServer(dependencies: HttpApiDependencies = defaultDependencies): Server {
  return createServer((request, response) => {
    void handleRequest(request, response, dependencies)
  })
}

export function startHttpApiServer(): void {
  if (httpApiServer) return

  const server = createHttpApiServer()
  httpApiServer = server
  server.once('error', (error: NodeJS.ErrnoException) => {
    if (httpApiServer === server) httpApiServer = null
    console.error(`[HTTP API] 启动失败（${HTTP_API_HOST}:${HTTP_API_PORT}）:`, error.message)
  })
  server.listen(HTTP_API_PORT, HTTP_API_HOST, () => {
    console.log(`[HTTP API] 已启动：http://${HTTP_API_HOST}:${HTTP_API_PORT}`)
  })
}

export function stopHttpApiServer(): Promise<void> {
  const server = httpApiServer
  if (!server) return Promise.resolve()
  httpApiServer = null
  return new Promise((resolve) => {
    server.close(() => resolve())
  })
}
