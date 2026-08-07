import { app } from 'electron'
import type { WorkingApiClient } from './working-api-client'
import { getWorkingApiClient } from './working-api-service'
import { getSettings, updateSettings } from './settings-service'
import {
  finalizeAgentRpcRun,
  parseAgentRpcInput,
  parseAgentRpcQueueInput,
  persistAgentRpcCredential,
  persistAgentRpcMessage,
  persistAgentRpcMeta,
  prepareAgentRpcQueue,
  prepareAgentRpcRun,
} from './agent-rpc-service'
import { parseBrowserAgentToolRequest, parseWorkerFrame } from './agent-rpc-protocol'
import type { BrowserAgentToolRequest } from './agent-rpc-protocol'
import type { BrowserAgentToolResult } from './browser-agent-tool-service'
import { redactSensitiveLogValue, shortLogId } from './bridge-log-redaction'
import type { AppSettings } from '../../types'
import {
  COPIS_WORKING_CHANNEL_ID,
  COPIS_WORKING_EXPERT_MODEL_ID,
  COPIS_WORKING_FAST_MODEL_ID,
} from '@copis/shared'
import { resolveCopisHttpApiPort } from '@copis/shared/config'
import type {
  AgentMessage,
  AgentRuntime,
  AgentSendInput,
  AgentSessionMeta,
  AgentWorkspace,
  FileApiContext,
  FileApiReadTextResponse,
  FileApiWriteTextRequest,
  FileApiWriteTextResponse,
  SDKMessage,
  WorkingFeedbackInput,
  WorkingLoginInput,
  WorkingPasswordResetInput,
  WorkingRegisterInput,
  WorkingSendVerificationCodeInput,
  WorkingVerifyPasswordResetCodeInput,
  WorkingWorkspaceInput,
  WorkingReceiveChannel,
} from '@copis/shared'
import { fileService } from './file-service'
import { getAgentWorkspace, getAgentWorkspaceWritableRoot } from './agent-workspace-manager'
import type { ExpertTeamNodeSnapshot, ExpertTeamRunResult, ExpertTeamRunSnapshot } from './expert-team-runner'

export const HTTP_API_HOST = '127.0.0.1'
export const HTTP_API_PORT = resolveCopisHttpApiPort({
  configuredPort: process.env.COPIS_HTTP_API_PORT,
  isPackaged: app.isPackaged === true,
})
export const MAX_REQUEST_BODY_BYTES = 2 * 1024 * 1024

export interface HttpApiRequest {
  readonly method: string
  readonly path: string
  readonly body?: string
}

export interface HttpApiResponse {
  readonly status: number
  readonly body?: unknown
}

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

export interface HttpApiDependencies {
  getWorkingClient: () => WorkingApiFacade
  getAppSettings: () => AppSettings
  updateAppSettings: (updates: Partial<AppSettings>) => AppSettings
  getAgentApi?: () => Promise<AgentHttpFacade>
  getFileApi?: () => FileHttpFacade | Promise<FileHttpFacade>
  getBrowserAgentToolApi?: () => BrowserAgentToolHttpApi | Promise<BrowserAgentToolHttpApi>
  /** Rust bridge dispatch 使用的主进程专家团队入口。 */
  dispatchExpertTeam?: (snapshot: ExpertTeamRunSnapshot, workspaceRoot: string) => Promise<ExpertTeamRunResult>
}

export interface BrowserAgentToolHttpApi {
  executeWorker(input: BrowserAgentToolRequest): Promise<BrowserAgentToolResult>
}

export interface AgentHttpFacade {
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
    agentRuntime?: AgentRuntime,
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
  stopAgent: (sessionId: string) => Promise<void>
}

export interface FileHttpFacade {
  readText: (input: { path: string } & FileApiContext) => FileApiReadTextResponse
  writeText: (input: FileApiWriteTextRequest) => FileApiWriteTextResponse
}

const defaultDependencies: HttpApiDependencies = {
  getWorkingClient: getWorkingApiClient,
  getAppSettings: getSettings,
  updateAppSettings: updateSettings,
  getFileApi: () => fileService,
}

let defaultAgentApiPromise: Promise<AgentHttpFacade> | null = null
let defaultBrowserAgentToolApiPromise: Promise<BrowserAgentToolHttpApi> | null = null

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

function getDefaultBrowserAgentToolApi(): Promise<BrowserAgentToolHttpApi> {
  if (!defaultBrowserAgentToolApiPromise) {
    defaultBrowserAgentToolApiPromise = import('./browser-agent-tool-service').then(({ browserAgentToolService }) => browserAgentToolService)
  }
  return defaultBrowserAgentToolApiPromise
}

defaultDependencies.getBrowserAgentToolApi = getDefaultBrowserAgentToolApi

defaultDependencies.dispatchExpertTeam = async (snapshot, workspaceRoot) => {
  const [{ ExpertTeamRunner }, { HttpExpertTeamRustApiClient }] = await Promise.all([
    import('./expert-team-runner'),
    import('./expert-team-rust-client'),
  ])
  return new ExpertTeamRunner({
    workspaceRoot,
    rustApi: new HttpExpertTeamRustApiClient(),
  }).run(snapshot)
}

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

function sendError(error: unknown): HttpApiResponse {
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
  console.error('[HTTP API] 请求处理失败:', redactSensitiveLogValue(error))
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

async function readJsonBody(request: HttpApiRequest): Promise<unknown> {
  if (request.body === undefined || request.body.length === 0) return undefined
  if (Buffer.byteLength(request.body, 'utf8') > MAX_REQUEST_BODY_BYTES) {
    throw new HttpApiRequestError('请求体过大', 413, 'request_body_too_large')
  }
  try {
    return JSON.parse(request.body) as unknown
  } catch {
    throw new HttpApiRequestError('请求体不是有效的 JSON', 400, 'invalid_json')
  }
}

async function handleAgentRequest(
  request: HttpApiRequest,
  url: URL,
  segments: string[],
  dependencies: HttpApiDependencies,
): Promise<HttpApiResponse> {
  const api = await getAgentApi(dependencies)
  const method = request.method
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
    await api.stopAgent(sessionId)
    return { status: 204 }
  }

  throw new HttpApiRequestError('Agent API 路径不存在', 404, 'not_found')
}

async function handleWorkingRequest(
  request: HttpApiRequest,
  url: URL,
  segments: string[],
  dependencies: HttpApiDependencies,
): Promise<HttpApiResponse> {
  const client = dependencies.getWorkingClient()
  const method = request.method
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
    return { status: 204 }
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
    return { status: 204 }
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
    return { status: 204 }
  }

  throw new HttpApiRequestError('Working API 路径不存在', 404, 'not_found')
}

async function handleAgentRpcInternalRequest(
  request: HttpApiRequest,
  segments: string[],
  dependencies: HttpApiDependencies,
): Promise<HttpApiResponse> {
  const action = segments[3]
  const isBrowserToolRequest = action === 'browser-tool'
  if (isBrowserToolRequest) {
    console.info('[AI浏览器][HTTP] browser-tool 请求进入', { method: request.method })
  }
  if (request.method !== 'POST') {
    if (isBrowserToolRequest) {
      console.warn('[AI浏览器][HTTP] browser-tool 参数校验拒绝', { method: request.method, reason: 'method_not_allowed' })
    }
    throw new HttpApiRequestError('Agent RPC 内部接口只支持 POST', 405, 'method_not_allowed')
  }
  let body: unknown
  try {
    body = await readJsonBody(request)
  } catch (error) {
    if (isBrowserToolRequest) {
      const errorRecord = isRecord(error) ? error : undefined
      console.warn('[AI浏览器][HTTP] browser-tool 参数校验拒绝', {
        method: request.method,
        reason: typeof errorRecord?.code === 'string' ? errorRecord.code : 'invalid_body',
      })
    }
    throw error
  }
  let bodyRecord: Record<string, unknown>
  try {
    bodyRecord = requireRecord(body)
  } catch (error) {
    if (isBrowserToolRequest) {
      const errorRecord = isRecord(error) ? error : undefined
      console.warn('[AI浏览器][HTTP] browser-tool 参数校验拒绝', {
        method: request.method,
        reason: typeof errorRecord?.code === 'string' ? errorRecord.code : 'invalid_body',
      })
    }
    throw error
  }
  if (segments.length !== 4) {
    if (isBrowserToolRequest) {
      console.warn('[AI浏览器][HTTP] browser-tool 参数校验拒绝', { method: request.method, reason: 'not_found' })
    }
    throw new HttpApiRequestError('Agent RPC 内部接口不存在', 404, 'not_found')
  }

  if (action === 'browser-tool') {
    const input = parseBrowserAgentToolRequest(bodyRecord)
    const logFields = {
      sessionId: shortLogId(bodyRecord.sessionId),
      toolCallId: shortLogId(bodyRecord.toolCallId),
      ...(typeof bodyRecord.toolName === 'string' ? { toolName: bodyRecord.toolName } : {}),
      ...(isRecord(bodyRecord.toolInput) ? { inputKeys: Object.keys(bodyRecord.toolInput).sort() } : {}),
    }
    console.info('[AI浏览器][HTTP] browser-tool 参数已解析', logFields)
    if (!input) {
      console.warn('[AI浏览器][HTTP] browser-tool 参数校验拒绝', logFields)
      throw new HttpApiRequestError('AI浏览器工具参数不正确', 400, 'invalid_browser_tool_request')
    }
    try {
      const browserAgentToolApi = await (dependencies.getBrowserAgentToolApi?.() ?? getDefaultBrowserAgentToolApi())
      const result = await browserAgentToolApi.executeWorker(input)
      console.info('[AI浏览器][HTTP] dispatcher 返回', {
        ...logFields,
        status: 200,
        resultKind: result.kind,
      })
      return { status: 200, body: result }
    } catch (error) {
      const errorRecord = isRecord(error) ? error : undefined
      const errorMessage = error instanceof Error ? error.message : errorRecord?.message
      const failureKind = errorRecord?.code === 'browser_page_policy_refused'
        ? 'main_policy_refused'
        : typeof errorMessage === 'string' && /timeout|timed out|超时/i.test(errorMessage)
          ? 'cdp_timeout'
          : 'dispatcher_error'
      console.error('[AI浏览器][HTTP] dispatcher 失败', {
        ...logFields,
        failureKind,
        error: redactSensitiveLogValue(error),
      })
      throw error
    }
  }

  if (action === 'prepare') {
    return { status: 200, body: await prepareAgentRpcRun(parseAgentRpcInput(bodyRecord)) }
  }

  if (action === 'queue') {
    return { status: 200, body: prepareAgentRpcQueue(parseAgentRpcQueueInput(bodyRecord)) }
  }

  if (action === 'message') {
    const sessionId = requireString(bodyRecord, 'sessionId')
    const message = bodyRecord.message
    if (!isRecord(message)) throw new HttpApiRequestError('SDK 消息参数不正确', 400, 'invalid_request')
    persistAgentRpcMessage(sessionId, message as unknown as SDKMessage)
    return { status: 204 }
  }

  if (action === 'meta') {
    const frame = parseWorkerFrame(JSON.stringify(bodyRecord))
    if (!frame || frame.type !== 'meta') {
      throw new HttpApiRequestError('Agent RPC 元数据帧不正确', 400, 'invalid_request')
    }
    persistAgentRpcMeta(frame)
    return { status: 204 }
  }

  if (action === 'credential') {
    const frame = parseWorkerFrame(JSON.stringify(bodyRecord))
    if (!frame || frame.type !== 'credential') {
      throw new HttpApiRequestError('Agent RPC 凭据帧不正确', 400, 'invalid_request')
    }
    persistAgentRpcCredential(frame)
    return { status: 204 }
  }

  if (action === 'complete') {
    const sessionId = requireString(bodyRecord, 'sessionId')
    if (typeof bodyRecord.stoppedByUser !== 'boolean') {
      throw new HttpApiRequestError('Agent RPC 完成状态不正确', 400, 'invalid_request')
    }
    const resultSubtype = typeof bodyRecord.resultSubtype === 'string' ? bodyRecord.resultSubtype : undefined
    const resultErrors = Array.isArray(bodyRecord.resultErrors)
      ? bodyRecord.resultErrors.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      : undefined
    return {
      status: 200,
      body: finalizeAgentRpcRun({
        sessionId,
        stoppedByUser: bodyRecord.stoppedByUser,
        ...(resultSubtype ? { resultSubtype } : {}),
        ...(resultErrors && resultErrors.length > 0 ? { resultErrors } : {}),
      }),
    }
  }

  throw new HttpApiRequestError('Agent RPC 内部接口不存在', 404, 'not_found')
}

function parseFileContext(record: Record<string, unknown>): FileApiContext {
  const candidateBasePaths = Array.isArray(record.candidateBasePaths)
    ? record.candidateBasePaths.filter((value): value is string => typeof value === 'string' && value.length > 0)
    : undefined
  return {
    ...(typeof record.sessionId === 'string' ? { sessionId: record.sessionId } : {}),
    ...(typeof record.workspaceSlug === 'string' ? { workspaceSlug: record.workspaceSlug } : {}),
    ...(candidateBasePaths && candidateBasePaths.length > 0 ? { candidateBasePaths } : {}),
  }
}

function parseExpertTeamNodeSnapshot(value: unknown, index: number): ExpertTeamNodeSnapshot {
  const node = requireRecord(value, `专家团队节点 ${index} 参数不正确`)
  const id = requireString(node, 'id', `专家团队节点 ${index} 缺少 id`)
  const role = requireString(node, 'role', `专家团队节点 ${id} 缺少 role`)
  const task = optionalString(node, 'task') ?? optionalString(node, 'prompt')
  if (!task) throw new HttpApiRequestError(`专家团队节点 ${id} 缺少任务文本`, 400, 'invalid_request')
  const dependsOn = Array.isArray(node.dependsOn)
    ? node.dependsOn.filter((value): value is string => typeof value === 'string')
    : undefined
  const outputPath = optionalString(node, 'outputPath') ?? optionalString(node, 'path')
  return {
    id,
    role: role as ExpertTeamNodeSnapshot['role'],
    task,
    ...(dependsOn ? { dependsOn } : {}),
    ...(outputPath ? { outputPath } : {}),
    ...(typeof node.allowNoArtifact === 'boolean' ? { allowNoArtifact: node.allowNoArtifact } : {}),
  }
}

/**
 * Rust HTTP 请求通过主进程 stdio bridge 到达这里。workspaceRoot 从持久化会话和工作区解析，
 * 不接受请求体中的绝对路径；调度本身异步执行，避免阻塞 Rust 请求线程。
 */
async function handleExpertTeamInternalRequest(
  request: HttpApiRequest,
  segments: string[],
  dependencies: HttpApiDependencies,
): Promise<HttpApiResponse> {
  if (request.method !== 'POST' || segments.length !== 6 || segments[3] !== 'runs' || segments[5] !== 'dispatch') {
    throw new HttpApiRequestError('专家团队内部 dispatch 路径不存在', 404, 'not_found')
  }
  const runId = decodePathSegment(segments[4] ?? '')
  const body = requireRecord(await readJsonBody(request))
  const requestedRunId = optionalString(body, 'runId')
  if (requestedRunId && requestedRunId !== runId) {
    throw new HttpApiRequestError('runId 与路径不一致', 400, 'invalid_request')
  }
  const parentSessionId = requireString(body, 'parentSessionId', '父 Agent 会话不能为空')
  const agentApi = await (dependencies.getAgentApi?.() ?? getDefaultAgentApi())
  const parent = agentApi.getAgentSessionMeta(parentSessionId)
  if (!parent) throw new HttpApiRequestError('父 Agent 会话不存在', 404, 'not_found')
  if (!parent.workspaceId || !parent.channelId) {
    throw new HttpApiRequestError('父 Agent 会话缺少工作区或渠道', 422, 'invalid_agent_context')
  }
  const workspace = getAgentWorkspace(parent.workspaceId)
  if (!workspace) throw new HttpApiRequestError('父 Agent 工作区不存在', 404, 'not_found')
  const requestedWorkspaceId = optionalString(body, 'workspaceId')
  if (requestedWorkspaceId && requestedWorkspaceId !== parent.workspaceId) {
    throw new HttpApiRequestError('工作区必须继承父 Agent 会话', 400, 'invalid_request')
  }
  const requestedChannelId = optionalString(body, 'channelId')
  if (requestedChannelId && requestedChannelId !== parent.channelId) {
    throw new HttpApiRequestError('渠道必须继承父 Agent 会话', 400, 'invalid_request')
  }
  const requestedModelId = optionalString(body, 'modelId')
  if (requestedModelId && requestedModelId !== parent.modelId) {
    throw new HttpApiRequestError('模型必须继承父 Agent 会话', 400, 'invalid_request')
  }
  if (!Array.isArray(body.nodes)) throw new HttpApiRequestError('专家团队节点快照不正确', 400, 'invalid_request')
  const snapshot: ExpertTeamRunSnapshot = {
    runId,
    parentSessionId,
    channelId: parent.channelId,
    workspaceId: parent.workspaceId,
    ...(parent.modelId ? { modelId: parent.modelId } : {}),
    nodes: body.nodes.map(parseExpertTeamNodeSnapshot),
  }
  const workspaceRoot = getAgentWorkspaceWritableRoot(workspace)
  const dispatcher = dependencies.dispatchExpertTeam
  if (!dispatcher) throw new HttpApiRequestError('专家团队调度器不可用', 503, 'service_unavailable')
  void dispatcher(snapshot, workspaceRoot).catch((error: unknown) => {
    console.error(`[专家团队] Rust bridge dispatch 失败 (${runId}):`, error)
  })
  return { status: 202, body: { accepted: true, runId } }
}

async function handleFileRequest(
  request: HttpApiRequest,
  segments: string[],
  dependencies: HttpApiDependencies,
): Promise<HttpApiResponse> {
  const bodyRecord = requireRecord(await readJsonBody(request))
  const fileApi = await (dependencies.getFileApi?.() ?? fileService)
  const action = segments[2]

  if (action === 'read-text' && request.method === 'POST') {
    const path = requireString(bodyRecord, 'path', '文件路径不正确')
    return {
      status: 200,
      body: fileApi.readText({ path, ...parseFileContext(bodyRecord) }),
    }
  }

  if (action === 'text' && request.method === 'PUT') {
    const path = requireString(bodyRecord, 'path', '文件路径不正确')
    if (typeof bodyRecord.content !== 'string') {
      throw new HttpApiRequestError('文件内容不正确', 400, 'invalid_request')
    }
    const expectedRevision = optionalString(bodyRecord, 'expectedRevision')
    const input: FileApiWriteTextRequest = {
      path,
      content: bodyRecord.content,
      ...parseFileContext(bodyRecord),
      ...(expectedRevision ? { expectedRevision } : {}),
    }
    return { status: 200, body: fileApi.writeText(input) }
  }

  throw new HttpApiRequestError('文件 API 路径不存在', 404, 'not_found')
}

export async function handleHttpApiRequest(
  request: HttpApiRequest,
  dependencies: HttpApiDependencies = defaultDependencies,
): Promise<HttpApiResponse> {
  try {
    let url: URL
    try {
      url = new URL(request.path || '/', `http://${HTTP_API_HOST}:${HTTP_API_PORT}`)
    } catch {
      throw new HttpApiRequestError('请求 URL 不正确', 400, 'invalid_url')
    }

    if (url.pathname === '/api/health' && request.method === 'GET') {
      return {
        status: 200,
        body: {
          ok: true,
          service: 'copis-http-api',
          port: HTTP_API_PORT,
        },
      }
    }

    if (url.pathname === '/api/settings' && request.method === 'GET') {
      return { status: 200, body: sanitizeAppSettings(dependencies.getAppSettings()) }
    }

    if (url.pathname === '/api/settings' && (request.method === 'PATCH' || request.method === 'PUT')) {
      const body = requireRecord(await readJsonBody(request))
      const updated = dependencies.updateAppSettings(sanitizeAppSettingsUpdates(body))
      return { status: 200, body: sanitizeAppSettings(updated) }
    }

    if (url.pathname === '/api/tutorial' && request.method === 'GET') {
      const { getTutorialContent } = await import('./tutorial-service')
      return { status: 200, body: { content: getTutorialContent() } }
    }

    const segments = url.pathname.split('/').filter(Boolean)
    if (segments[0] !== 'api') {
      throw new HttpApiRequestError('HTTP API 路径不存在', 404, 'not_found')
    }

    if (segments[1] === 'internal' && segments[2] === 'expert-teams') {
      return await handleExpertTeamInternalRequest(request, segments, dependencies)
    }
    if (segments[1] === 'internal' && segments[2] === 'agent') {
      return await handleAgentRpcInternalRequest(request, segments, dependencies)
    }
    if (segments[1] === 'files') {
      return await handleFileRequest(request, segments, dependencies)
    }
    if (segments[1] === 'agent') {
      return await handleAgentRequest(request, url, segments, dependencies)
    }
    if (segments[1] === 'working') {
      return await handleWorkingRequest(request, url, segments, dependencies)
    }
    throw new HttpApiRequestError('HTTP API 路径不存在', 404, 'not_found')
  } catch (error: unknown) {
    return sendError(error)
  }
}
