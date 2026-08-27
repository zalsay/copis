import { app } from 'electron'
import type { WorkingApiClient } from './working-api-client'
import { getWorkingApiClient } from './working-api-service'
import {
  clearWorkingAuthFromRust,
  loadWorkingAuthForRust,
  saveWorkingAuthFromRust,
  type RustWorkingAuthRecord,
} from './working-auth-store'
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
  prepareAutomationRpcRun,
} from './agent-rpc-service'
import { parseBrowserAgentToolRequest, parseWorkerFrame } from './agent-rpc-protocol'
import type { AgentRpcWorkerFrame, BrowserAgentToolRequest } from './agent-rpc-protocol'
import type { BrowserAgentToolResult } from './browser-agent-tool-service'
import { redactSensitiveLogValue, shortLogId } from './bridge-log-redaction'
import type { AppSettings } from '../../types'
import {
  assertWorkingCustomModelSelection,
  filterWorkingModelCatalogUpdate,
  getWorkingModelCatalog,
  getWorkingModelCatalogOwnerId,
  redactWorkingModelCatalog,
  saveWorkingModelCatalog,
} from './working-model-catalog'
import {
  COPIS_WORKING_CHANNEL_ID,
  COPIS_WORKING_DEEPSEEK_CHANNEL_ID,
  COPIS_WORKING_DEEPSEEK_FAST_MODEL_ID,
  COPIS_WORKING_DEEPSEEK_PRO_MODEL_ID,
  COPIS_WORKING_EXPERT_MODEL_ID,
  COPIS_WORKING_FAST_MODEL_ID,
  COPIS_WORKING_GLOBAL_MODEL_ID,
  isCopisWorkingChannelId,
  isWorkingCustomModelChannelId,
  WORKING_IPC_CHANNELS,
} from '@copis/shared'
import { resolveCopisHttpApiPort } from '@copis/shared/config'
import type {
  AgentMessage,
  AgentCwdMode,
  AgentExpertTeamSession,
  AgentRuntime,
  AgentSendInput,
  AgentSessionMeta,
  AgentWorkspace,
  Automation,
  AutomationRun,
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
  WorkingAuthState,
} from '@copis/shared'
import { fileService } from './file-service'
import { getAgentWorkspace, getAgentWorkspaceWritableRoot } from './agent-workspace-manager'
import { broadcastChanged as broadcastAutomationsChanged } from './automation-scheduler'
import { notifyAutomationRunFinished } from './automation-notification-service'
import {
  forwardExternalAgentComplete,
  forwardExternalAgentError,
  forwardExternalAgentEvent,
  forwardExternalAgentRunStarted,
} from './agent-service'
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
  refreshAfterVipPayment(): ReturnType<WorkingApiClient['refreshAfterVipPayment']>
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
  getWorkingModelCatalog?: (isVip: boolean, ownerId?: string) => import('@copis/shared').WorkingModelCatalog
  saveWorkingModelCatalog?: (value: unknown, isVip: boolean, ownerId?: string) => import('@copis/shared').WorkingModelCatalog
  /** Rust 后台支付确认后，向主渲染进程广播最新 Working 账户资料。 */
  notifyWorkingAuthUpdated?: (state: WorkingAuthState) => void
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
  deleteAgentSession: (id: string) => void
  clearAgentCompletionState: (id: string) => AgentSessionMeta
  updateAgentSessionModel: (id: string, channelId?: string, modelId?: string) => AgentSessionMeta
  createAgentSession: (
    title?: string,
    channelId?: string,
    workspaceId?: string,
    modelId?: string,
    agentRuntime?: AgentRuntime,
    agentCwdMode?: AgentCwdMode,
    expertTeamSession?: AgentExpertTeamSession,
    expertTeamSetup?: boolean,
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
  getWorkingModelCatalog,
  saveWorkingModelCatalog,
  notifyWorkingAuthUpdated: (state) => {
    void import('../index').then(({ getMainWindow }) => {
      const mainWindow = getMainWindow()
      if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return
      mainWindow.webContents.send(WORKING_IPC_CHANNELS.AUTH_UPDATED, state)
    }).catch((error: unknown) => {
      console.error('[Copis Working] 广播账户状态失败:', error)
    })
  },
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
      deleteAgentSession: sessionManager.deleteAgentSession,
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
      updateAgentSessionModel: (id: string, channelId?: string, modelId?: string) => sessionManager.updateAgentSessionMeta(id, {
        channelId,
        modelId,
      }),
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

function optionalExpertTeamSession(record: Record<string, unknown>): AgentExpertTeamSession | undefined {
  const value = record.expertTeamSession
  if (value === undefined) return undefined
  if (!isRecord(value)) {
    throw new HttpApiRequestError('专家团队会话关联不正确', 400, 'invalid_expert_team_session')
  }

  const runId = optionalString(value, 'runId')
  const schemaId = optionalString(value, 'schemaId')
  if (!runId || !schemaId) {
    throw new HttpApiRequestError('专家团队会话关联不完整', 400, 'invalid_expert_team_session')
  }

  const requestedSchemaRevisionId = value.schemaRevisionId
  let schemaRevisionId: number | undefined
  if (requestedSchemaRevisionId !== undefined) {
    if (typeof requestedSchemaRevisionId !== 'number'
      || !Number.isSafeInteger(requestedSchemaRevisionId)
      || requestedSchemaRevisionId < 0) {
      throw new HttpApiRequestError('专家团队 Schema revision 不正确', 400, 'invalid_expert_team_session')
    }
    schemaRevisionId = requestedSchemaRevisionId
  }

  return {
    runId,
    schemaId,
    ...(schemaRevisionId === undefined ? {} : { schemaRevisionId }),
  }
}

function optionalExpertTeamSetup(record: Record<string, unknown>): boolean | undefined {
  const value = record.expertTeamSetup
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') {
    throw new HttpApiRequestError('专家团队筹备标记不正确', 400, 'invalid_expert_team_setup')
  }
  return value
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

  if (isRecord(error) && error.code === 'vip_required' && typeof error.message === 'string') {
    return {
      status: 403,
      body: { error: error.message, code: 'vip_required' },
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
  const {
    voiceDictation: _voiceDictation,
    workingModelApiKeys: _workingModelApiKeys,
    workingModelCatalogOwnerId: _workingModelCatalogOwnerId,
    ...safeUpdates
  } = value
  return safeUpdates as Partial<AppSettings>
}

function getWorkingAccountId(dependencies: HttpApiDependencies): string | undefined {
  return getWorkingModelCatalogOwnerId(dependencies.getWorkingClient().getCachedUser())
}

function isWorkingVip(dependencies: HttpApiDependencies): boolean {
  return dependencies.getWorkingClient().getCachedUser()?.isVip === true
}

function isSupportedWorkingAgentChannel(channelId: string | undefined): boolean {
  return isCopisWorkingChannelId(channelId)
    || isWorkingCustomModelChannelId(channelId)
}

function resolveWorkingAgentChannelId(requestedChannelId: string | undefined, fallbackChannelId: string): string {
  return requestedChannelId && isSupportedWorkingAgentChannel(requestedChannelId)
    ? requestedChannelId
    : fallbackChannelId
}

function resolveWorkingAgentModelId(
  channelId: string,
  requestedModelId: string | undefined,
  fallbackModelId: string | undefined,
): string | undefined {
  if (isWorkingCustomModelChannelId(channelId)) return requestedModelId ?? fallbackModelId
  if (channelId === COPIS_WORKING_DEEPSEEK_CHANNEL_ID) {
    return requestedModelId === COPIS_WORKING_DEEPSEEK_PRO_MODEL_ID
      ? COPIS_WORKING_DEEPSEEK_PRO_MODEL_ID
      : COPIS_WORKING_DEEPSEEK_FAST_MODEL_ID
  }
  if (channelId === COPIS_WORKING_CHANNEL_ID) {
    if (requestedModelId === COPIS_WORKING_EXPERT_MODEL_ID) {
      return COPIS_WORKING_EXPERT_MODEL_ID
    }
    if (requestedModelId === COPIS_WORKING_GLOBAL_MODEL_ID) {
      return COPIS_WORKING_GLOBAL_MODEL_ID
    }
    return COPIS_WORKING_FAST_MODEL_ID
  }
  return requestedModelId ?? fallbackModelId
}

function assertHttpWorkingCustomModelSelection(
  dependencies: HttpApiDependencies,
  channelId: string | undefined,
  modelId: string | undefined,
): void {
  if (!isWorkingCustomModelChannelId(channelId)) return
  assertWorkingCustomModelSelection(
    channelId,
    modelId,
    isWorkingVip(dependencies),
    getWorkingAccountId(dependencies),
  )
}

function redactHttpApiSettings(
  dependencies: HttpApiDependencies,
  isVip: boolean,
  ownerId: string | undefined,
): Omit<AppSettings, 'voiceDictation'> {
  const safeSettings = redactWorkingModelCatalog(
    sanitizeAppSettings(dependencies.getAppSettings()),
    isVip,
    ownerId,
  )
  if (isVip && ownerId && !safeSettings.workingModelCatalog) {
    const getCatalog = dependencies.getWorkingModelCatalog ?? getWorkingModelCatalog
    return {
      ...safeSettings,
      workingModelCatalog: getCatalog(true, ownerId),
    }
  }
  return safeSettings
}

function makeAuthState(client: WorkingApiFacade): {
  authenticated: boolean
  user: ReturnType<WorkingApiFacade['getCachedUser']>
  backendUrl: string
} {
  return {
    authenticated: client.getCachedUser() !== null,
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

    const requestedChannelId = optionalString(bodyRecord ?? {}, 'channelId')
    const channelId = resolveWorkingAgentChannelId(requestedChannelId, COPIS_WORKING_CHANNEL_ID)
    const requestedModelId = optionalString(bodyRecord ?? {}, 'modelId')
    assertHttpWorkingCustomModelSelection(dependencies, channelId, requestedModelId)
    const modelId = resolveWorkingAgentModelId(channelId, requestedModelId, undefined)
    const expertTeamSession = optionalExpertTeamSession(bodyRecord ?? {})
    const expertTeamSetup = optionalExpertTeamSetup(bodyRecord ?? {})
    const session = api.createAgentSession(
      optionalString(bodyRecord ?? {}, 'title'),
      channelId,
      workspace.id,
      modelId,
      'pi',
      undefined,
      expertTeamSession,
      expertTeamSetup,
    )
    return { status: 201, body: session }
  }

  if (resource !== 'sessions' || action === undefined) {
    throw new HttpApiRequestError('Agent API 路径不存在', 404, 'not_found')
  }

  const sessionId = decodePathSegment(action)
  const session = getRequiredAgentSession(api, sessionId)

  if (sessionAction === undefined && method === 'DELETE') {
    api.deleteAgentSession(session.id)
    return { status: 204 }
  }

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

  if (sessionAction === 'model' && method === 'PATCH') {
    const requestedChannelId = optionalString(bodyRecord ?? {}, 'channelId')
    if (requestedChannelId !== undefined && !isSupportedWorkingAgentChannel(requestedChannelId)) {
      throw new HttpApiRequestError('浏览器 Agent 不支持该模型渠道', 400, 'unsupported_agent_channel')
    }
    const requestedModelId = optionalString(bodyRecord ?? {}, 'modelId')
    assertHttpWorkingCustomModelSelection(dependencies, requestedChannelId, requestedModelId)
    return {
      status: 200,
      body: api.updateAgentSessionModel(sessionId, requestedChannelId, requestedModelId),
    }
  }

  if (sessionAction === 'messages' && method === 'POST') {
    const userMessage = requireString(bodyRecord ?? {}, 'userMessage', 'Agent 消息不能为空')
    const startedAt = Date.now()
    let runError: string | undefined
    const requestedChannelId = optionalString(bodyRecord ?? {}, 'channelId')
    const channelId = resolveWorkingAgentChannelId(
      requestedChannelId,
      session.channelId ?? COPIS_WORKING_CHANNEL_ID,
    )
    const requestedModelId = optionalString(bodyRecord ?? {}, 'modelId')
    assertHttpWorkingCustomModelSelection(dependencies, channelId, requestedModelId)
    const modelId = resolveWorkingAgentModelId(channelId, requestedModelId, session.modelId)
    const workingMode = channelId === COPIS_WORKING_CHANNEL_ID
      ? (modelId === COPIS_WORKING_EXPERT_MODEL_ID ? 'expert' : 'fast')
      : undefined

    const input: AgentSendInput = {
      sessionId,
      userMessage,
      rawUserMessage: userMessage,
      channelId,
      ...(modelId ? { modelId } : {}),
      agentRuntime: 'pi',
      workspaceId: session.workspaceId,
      ...(workingMode ? { workingMode } : {}),
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

function isAutomation(value: unknown): value is Automation {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.name === 'string'
    && typeof value.prompt === 'string'
    && typeof value.channelId === 'string'
    && typeof value.workspaceId === 'string'
    && Array.isArray(value.runHistory)
}

function broadcastAutomationAgentFrame(frame: AgentRpcWorkerFrame): void {
  if (frame.type === 'event') {
    forwardExternalAgentEvent(frame.sessionId, frame.payload)
  } else if ((frame.type === 'error' || frame.type === 'fatal') && frame.sessionId) {
    forwardExternalAgentError(frame.sessionId, frame.error)
  }
}

async function handleAutomationInternalRequest(
  request: HttpApiRequest,
  segments: string[],
): Promise<HttpApiResponse> {
  if (request.method !== 'POST' || segments.length !== 4) {
    throw new HttpApiRequestError('定时任务内部接口不存在', 404, 'not_found')
  }
  const body = requireRecord(await readJsonBody(request))
  const action = segments[3]
  if (action === 'prepare-run') {
    const automation = body.automation
    const runAt = body.runAt
    if (!isAutomation(automation) || typeof runAt !== 'number' || !Number.isFinite(runAt)) {
      throw new HttpApiRequestError('定时任务执行配置不正确', 400, 'invalid_request')
    }
    const prepared = await prepareAutomationRpcRun(automation, runAt)
    forwardExternalAgentRunStarted({ sessionId: prepared.sessionId, startedAt: runAt, triggeredBy: 'automation' })
    return { status: 200, body: prepared }
  }
  if (action === 'event') {
    const frame = parseWorkerFrame(JSON.stringify(body))
    if (!frame) throw new HttpApiRequestError('定时任务事件帧不正确', 400, 'invalid_request')
    broadcastAutomationAgentFrame(frame)
    return { status: 204 }
  }
  if (action === 'run-finished') {
    const automation = body.automation
    const run = body.run
    if (!isAutomation(automation) || !isRecord(run)
      || typeof run.runAt !== 'number' || typeof run.sessionId !== 'string'
      || (run.status !== 'success' && run.status !== 'error' && run.status !== 'skipped')) {
      throw new HttpApiRequestError('定时任务运行结果不正确', 400, 'invalid_request')
    }
    broadcastAutomationsChanged()
    if (run.sessionId) {
      forwardExternalAgentComplete({
        sessionId: run.sessionId,
        triggeredBy: 'automation',
        stoppedByUser: false,
        startedAt: run.runAt,
        ...(run.status === 'error' && typeof run.error === 'string' ? { resultErrors: [run.error] } : {}),
      })
    }
    await notifyAutomationRunFinished({
      automation,
      run: run as unknown as AutomationRun,
    })
    return { status: 204 }
  }
  throw new HttpApiRequestError('定时任务内部接口不存在', 404, 'not_found')
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

/**
 * 工作区 MCP 扩展路由（Rust 直管 mcp.json 的 GET/PUT 之外的部分）：
 * - GET  /api/workspaces/:slug/mcp/builtin        内置 MCP 列表
 * - PATCH /api/workspaces/:slug/mcp/builtin/:id   内置 MCP 开关
 * - POST  /api/workspaces/:slug/mcp/test          连接测试
 *
 * 内置 MCP 目录与开关依赖 Electron 设置/工具凭据状态，连接测试依赖
 * 本地进程环境，因此这些路由通过业务桥在 Electron 侧实现。
 */
async function handleWorkspaceMcpRequest(
  request: HttpApiRequest,
  segments: string[],
): Promise<HttpApiResponse> {
  const workspaceSlug = segments[2]
  if (!workspaceSlug) {
    throw new HttpApiRequestError('工作区 slug 不正确', 400, 'invalid_workspace')
  }

  if (request.method === 'GET' && segments[4] === 'builtin') {
    const { listBuiltinMcpServers } = await import('./builtin-mcp/catalog')
    return { status: 200, body: listBuiltinMcpServers({ workspaceSlug }) }
  }

  if (request.method === 'PATCH' && segments[4] === 'builtin' && segments[5]) {
    const body = requireRecord(await readJsonBody(request))
    const enabled = body.enabled
    if (typeof enabled !== 'boolean') {
      throw new HttpApiRequestError('enabled 参数不正确', 400, 'invalid_request')
    }
    const [{ setBuiltinMcpUserEnabled }, { listBuiltinMcpServers }] = await Promise.all([
      import('./builtin-mcp/settings'),
      import('./builtin-mcp/catalog'),
    ])
    setBuiltinMcpUserEnabled(segments[5], enabled)
    return { status: 200, body: listBuiltinMcpServers({ workspaceSlug }) }
  }

  throw new HttpApiRequestError('MCP 路径不存在', 404, 'not_found')
}

/** 测试 MCP 服务器连接（POST /api/mcp/test） */
async function handleMcpTestRequest(request: HttpApiRequest): Promise<HttpApiResponse> {
  const body = requireRecord(await readJsonBody(request))
  const name = requireString(body, 'name', 'MCP 名称不正确')
  const entry = body.entry
  if (!isRecord(entry)) {
    throw new HttpApiRequestError('MCP 配置不正确', 400, 'invalid_request')
  }
  const { validateMcpServer } = await import('./mcp-validator')
  const result = await validateMcpServer(name, entry as unknown as import('@copis/shared').McpServerEntry)
  return {
    status: 200,
    body: {
      success: result.valid,
      message: result.valid ? '连接成功' : (result.reason || '连接失败'),
    },
  }
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
      const isVip = isWorkingVip(dependencies)
      const ownerId = getWorkingAccountId(dependencies)
      return {
        status: 200,
        body: redactHttpApiSettings(dependencies, isVip, ownerId),
      }
    }

    if (url.pathname === '/api/settings' && (request.method === 'PATCH' || request.method === 'PUT')) {
      const body = requireRecord(await readJsonBody(request))
      const isVip = isWorkingVip(dependencies)
      const ownerId = getWorkingAccountId(dependencies)
      const safeUpdates = sanitizeAppSettingsUpdates(body)
      const catalogValue = body.workingModelCatalog
      const { workingModelCatalog: _workingModelCatalog, ...ordinaryUpdates } = safeUpdates
      const filteredOrdinaryUpdates = filterWorkingModelCatalogUpdate(
        ordinaryUpdates,
        isVip,
        ownerId,
      )
      if (catalogValue !== undefined && !isVip) {
        throw new HttpApiRequestError('仅 VIP 用户可使用模型管理', 403, 'vip_required')
      }
      let updated = Object.keys(filteredOrdinaryUpdates).length > 0
        ? dependencies.updateAppSettings(filteredOrdinaryUpdates)
        : dependencies.getAppSettings()
      if (catalogValue !== undefined) {
        const saveCatalog = dependencies.saveWorkingModelCatalog ?? saveWorkingModelCatalog
        const catalog = saveCatalog(catalogValue, isVip, ownerId)
        updated = { ...updated, workingModelCatalog: catalog }
      }
      return {
        status: 200,
        body: redactWorkingModelCatalog(sanitizeAppSettings(updated), isVip, ownerId),
      }
    }

    if (url.pathname === '/api/tutorial' && request.method === 'GET') {
      const { getTutorialContent } = await import('./tutorial-service')
      return { status: 200, body: { content: getTutorialContent() } }
    }

    const segments = url.pathname.split('/').filter(Boolean)
    if (segments[0] !== 'api') {
      throw new HttpApiRequestError('HTTP API 路径不存在', 404, 'not_found')
    }

    if (segments[1] === 'internal' && segments[2] === 'auth-storage') {
      if (segments[3] === 'load' && request.method === 'GET') {
        const record = loadWorkingAuthForRust()
        console.info('[HTTP API][认证存储] load 完成', {
          authenticated: record !== null,
          provider: record?.provider ?? '-',
          hasRefreshToken: Boolean(record?.refreshToken),
          hasUser: record?.user !== null && record?.user !== undefined,
        })
        return { status: 200, body: record }
      }
      if (segments[3] === 'save' && request.method === 'POST') {
        const body = await readJsonBody(request)
        if (!isRecord(body)) throw new HttpApiRequestError('认证存储记录不正确', 400, 'invalid_auth_storage')
        console.info('[HTTP API][认证存储] save 收到请求', {
          provider: body.provider ?? '-',
          hasAccessToken: typeof body.accessToken === 'string' && body.accessToken.length > 0,
          hasRefreshToken: typeof body.refreshToken === 'string' && body.refreshToken.length > 0,
          hasUser: body.user !== null && body.user !== undefined,
          bodyKeys: Object.keys(body).filter((key) => !/token|secret|password|credential/i.test(key)),
        })
        try {
          saveWorkingAuthFromRust(body as unknown as RustWorkingAuthRecord)
        } catch (error) {
          console.error('[HTTP API][认证存储] save 失败', redactSensitiveLogValue(error))
          throw error
        }
        console.info('[HTTP API][认证存储] save 完成')
        return { status: 204 }
      }
      if (segments[3] === 'clear' && request.method === 'POST') {
        console.info('[HTTP API][认证存储] clear 收到请求')
        try {
          clearWorkingAuthFromRust()
        } catch (error) {
          console.error('[HTTP API][认证存储] clear 失败', redactSensitiveLogValue(error))
          throw error
        }
        console.info('[HTTP API][认证存储] clear 完成')
        return { status: 204 }
      }
      throw new HttpApiRequestError('认证存储路径不存在', 404, 'not_found')
    }
    if (segments[1] === 'internal' && segments[2] === 'auth-state' && segments[3] === 'changed' && request.method === 'POST') {
      const body = await readJsonBody(request)
      if (!isRecord(body) || typeof body.authenticated !== 'boolean') {
        throw new HttpApiRequestError('认证状态通知格式不正确', 400, 'invalid_auth_state')
      }
      if ('accessToken' in body || 'refreshToken' in body || 'token' in body) {
        throw new HttpApiRequestError('认证状态通知不得包含凭据', 400, 'credential_leak')
      }
      const user = body.user === null || body.user === undefined
        ? null
        : isRecord(body.user) ? body.user as WorkingAuthState['user'] : null
      const expiresAt = typeof body.expiresAt === 'number' && Number.isFinite(body.expiresAt)
        ? body.expiresAt
        : null
      dependencies.notifyWorkingAuthUpdated?.({
        authenticated: body.authenticated,
        user,
        backendUrl: dependencies.getWorkingClient().baseUrl,
        expiresAt,
      })
      console.info('[HTTP API][认证状态] changed 完成', {
        authenticated: body.authenticated,
        hasUser: user !== null,
        expiresAtPresent: expiresAt !== null,
      })
      return { status: 204 }
    }
    if (segments[1] === 'workspaces' && segments[2] && segments[3] === 'mcp') {
      return await handleWorkspaceMcpRequest(request, segments)
    }
    if (segments[1] === 'mcp' && segments[2] === 'test') {
      return await handleMcpTestRequest(request)
    }
    if (segments[1] === 'internal' && segments[2] === 'expert-teams') {
      return await handleExpertTeamInternalRequest(request, segments, dependencies)
    }
    if (segments[1] === 'internal' && segments[2] === 'agent') {
      return await handleAgentRpcInternalRequest(request, segments, dependencies)
    }
    if (segments[1] === 'internal' && segments[2] === 'working-auth') {
      throw new HttpApiRequestError('Working 业务桥已禁用，请通过本机 Rust API 请求', 410, 'working_bridge_disabled')
    }
    if (segments[1] === 'internal' && segments[2] === 'automation') {
      return await handleAutomationInternalRequest(request, segments)
    }
    if (segments[1] === 'files') {
      return await handleFileRequest(request, segments, dependencies)
    }
    if (segments[1] === 'agent') {
      return await handleAgentRequest(request, url, segments, dependencies)
    }
    if (segments[1] === 'working') {
      throw new HttpApiRequestError('Working 业务桥已禁用，请通过本机 Rust API 请求', 410, 'working_bridge_disabled')
    }
    throw new HttpApiRequestError('HTTP API 路径不存在', 404, 'not_found')
  } catch (error: unknown) {
    return sendError(error)
  }
}
