import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import {
  COPIS_DEFAULT_PERMISSION_MODE,
  COPIS_WORKING_CHANNEL_ID,
  COPIS_WORKING_FAST_MODEL_ID,
  createCopisWorkingChannel,
  isCopisPermissionMode,
  normalizeWorkingMode,
  workingModeToModelId,
  type AgentSendInput,
  type AgentSessionMeta,
  type AgentWorkspace,
  type CopisPermissionMode,
  type MemoryPolicy,
  type ProviderType,
  type SDKMessage,
  type WorkingMode,
} from '@copis/shared'
import type { AppSettings } from '../../types'
import {
  getChannelById,
  persistCodexOAuthCredentials,
  persistXaiOAuthCredentials,
  resolveCodexOAuthCredentials,
  resolveChannelRuntimeApiKey,
  resolveXaiOAuthCredentials,
} from './channel-manager'
import { getWorkingApiClient } from './working-api-service'
import {
  appendSDKMessages,
  getAgentSessionMeta,
  resolveAgentCwd,
  updateAgentSessionMeta,
  getAgentSessionSDKMessages,
} from './agent-session-manager'
import {
  ensureAgentWorkspaceContextDir,
  getAgentWorkspace,
  getAgentWorkspaceWritableRoot,
  getLocalProjectRootStatus,
} from './agent-workspace-manager'
import { getAgentWorkspacePath, getSdkConfigDir, getWorkspaceSkillsDir } from './config-paths'
import { buildDynamicContext, buildSystemPrompt } from './agent-prompt-builder'
import { appendMemoryContext } from './memory-context-builder'
import { buildContextPrompt } from './agent-session-context-prompt'
import { buildAgentRuntimeEnv, mergeRuntimeEnv } from './agent-runtime-env'
import { getFunctionalModulePath } from './functional-module-manager'
import { getEffectiveProxyUrl } from './proxy-settings-service'
import { getRuntimeStatus } from './runtime-init'
import { getSettings } from './settings-service'
import { createFallbackTitle } from './title-generation'
import { isVisibleRunMessage } from './agent-run-message-visibility'
import {
  extractMemoryFactsWithProvider,
  MemoryAutoCapture,
} from './adapters/pi-memory-auto-capture'
import {
  createMemoryMaintenanceRunner,
  sharedMemoryMaintenanceService,
} from './adapters/pi-memory-maintenance'
import {
  buildRpcMemoryTurn,
  shouldCaptureRpcRun,
} from './agent-rpc-memory'
import type {
  AgentRpcWorkerFrame,
  PiWorkerRunConfig,
  PiWorkerQueryConfig,
} from './agent-rpc-protocol'

const DEFAULT_PI_MODEL_ID = 'claude-sonnet-5'

interface PendingAgentRpcRun {
  readonly userMessage: string
  readonly channelId: string
  readonly modelId: string
  readonly startedAt: number
  readonly provider: ProviderType
  readonly baseUrl?: string
  readonly apiKey: string
  readonly proxyUrl?: string
  readonly workspaceSlug?: string
  readonly memoryPolicy: MemoryPolicy
  readonly triggeredBy?: AgentSendInput['triggeredBy']
  readonly compactRequest: boolean
}

export interface AgentRpcInputRecord {
  sessionId: string
  userMessage: string
  rawUserMessage?: string
  channelId?: string
  modelId?: string
  agentRuntime?: 'pi'
  workspaceId?: string
  additionalDirectories?: string[]
  permissionModeOverride?: CopisPermissionMode
  workingMode?: WorkingMode
  startedAt?: number
  retryOfErrorUuid?: string
  triggeredBy?: AgentSendInput['triggeredBy']
  automationContext?: string
}

export interface AgentRpcCompletionResult {
  session: AgentSessionMeta | undefined
  title?: string
}

const pendingAgentRpcRuns = new Map<string, PendingAgentRpcRun>()
const rpcMemoryAutoCapture = new MemoryAutoCapture()
const rpcMemoryMaintenance = sharedMemoryMaintenanceService

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const values = value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
  return values.length > 0 ? values : undefined
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

function isWorkingMode(value: unknown): value is WorkingMode {
  return value === 'fast' || value === 'expert'
}

function isTriggeredBy(value: unknown): AgentSendInput['triggeredBy'] | undefined {
  return value === 'user' || value === 'automation' || value === 'delegation' ? value : undefined
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = optionalString(record[key])
  if (!value) throw new Error(`${key} 参数不正确`)
  return value
}

export function parseAgentRpcInput(record: Record<string, unknown>): AgentSendInput {
  const sessionId = requireString(record, 'sessionId')
  const userMessage = requireString(record, 'userMessage')
  const permissionMode = optionalString(record.permissionModeOverride)
  if (permissionMode !== undefined && !isCopisPermissionMode(permissionMode)) {
    throw new Error('权限模式参数不正确')
  }
  const agentRuntime = optionalString(record.agentRuntime)
  if (agentRuntime !== undefined && agentRuntime !== 'pi') {
    throw new Error('Agent RPC 只支持 Pi runtime')
  }
  const rawStartedAt = record.startedAt
  const startedAt = typeof rawStartedAt === 'number' && Number.isFinite(rawStartedAt) ? rawStartedAt : undefined
  const rawWorkingMode = record.workingMode
  if (rawWorkingMode !== undefined && !isWorkingMode(rawWorkingMode)) {
    throw new Error('Working 模式参数不正确')
  }
  const triggeredBy = isTriggeredBy(record.triggeredBy)

  return {
    sessionId,
    userMessage,
    ...(optionalString(record.rawUserMessage) ? { rawUserMessage: optionalString(record.rawUserMessage) } : {}),
    channelId: optionalString(record.channelId) ?? COPIS_WORKING_CHANNEL_ID,
    ...(optionalString(record.modelId) ? { modelId: optionalString(record.modelId) } : {}),
    agentRuntime: 'pi',
    ...(optionalString(record.workspaceId) ? { workspaceId: optionalString(record.workspaceId) } : {}),
    ...(stringArray(record.additionalDirectories) ? { additionalDirectories: stringArray(record.additionalDirectories) } : {}),
    ...(permissionMode ? { permissionModeOverride: permissionMode } : {}),
    ...(isWorkingMode(rawWorkingMode) ? { workingMode: rawWorkingMode } : {}),
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(optionalString(record.retryOfErrorUuid) ? { retryOfErrorUuid: optionalString(record.retryOfErrorUuid) } : {}),
    ...(triggeredBy ? { triggeredBy } : {}),
    ...(optionalString(record.automationContext) ? { automationContext: optionalString(record.automationContext) } : {}),
  }
}

function uniqueDirectories(input: AgentSendInput, session: AgentSessionMeta | undefined): string[] {
  const attachedDirectories = session?.attachedDirectories ?? []
  const attachedFileDirectories = (session?.attachedFiles ?? []).map((filePath) => dirname(filePath))
  return Array.from(new Set([
    ...(input.additionalDirectories ?? []),
    ...attachedDirectories,
    ...attachedFileDirectories,
  ].map((path) => resolve(path))))
}

function buildUserMessage(input: AgentSendInput, startedAt: number): SDKMessage {
  return {
    type: 'user',
    message: {
      content: [{ type: 'text', text: input.rawUserMessage ?? input.userMessage }],
    },
    parent_tool_use_id: null,
    _createdAt: startedAt,
  } as unknown as SDKMessage
}

function buildRuntimeEnv(
  settings: AppSettings,
  proxyUrl: string | undefined,
  workspace: AgentWorkspace | undefined,
  workspaceSlug: string | undefined,
): ReturnType<typeof buildAgentRuntimeEnv> {
  const base = buildAgentRuntimeEnv({
    proxyUrl,
    runtimeStatus: getRuntimeStatus(),
    windowsShellPreference: settings.windowsShellPreference,
    officeCliPath: getFunctionalModulePath('officecli'),
  })
  if (!workspace || !workspaceSlug) return base
  const workspaceEnv = {
    COPIS_WORKSPACE_DIR: getAgentWorkspacePath(workspaceSlug),
    COPIS_WORKSPACE_SLUG: workspaceSlug,
    PROMA_WORKSPACE_DIR: getAgentWorkspacePath(workspaceSlug),
    PROMA_WORKSPACE_SLUG: workspaceSlug,
  }
  return { ...base, env: mergeRuntimeEnv(base.env, workspaceEnv) }
}

async function resolveWorkerCredentials(channelId: string, provider: string): Promise<{
  apiKey: string
  codexOAuthCredentials?: Awaited<ReturnType<typeof resolveCodexOAuthCredentials>>
  xaiOAuthCredentials?: Awaited<ReturnType<typeof resolveXaiOAuthCredentials>>
}> {
  if (channelId === COPIS_WORKING_CHANNEL_ID) {
    const token = await getWorkingApiClient().getValidToken()
    if (!token) throw new Error('请先登录 Copis Working')
    return { apiKey: token }
  }
  if (provider === 'openai-codex') {
    const credentials = await resolveCodexOAuthCredentials(channelId)
    return { apiKey: credentials.access, codexOAuthCredentials: credentials }
  }
  if (provider === 'xai') {
    const credentials = await resolveXaiOAuthCredentials(channelId)
    return { apiKey: credentials.access, xaiOAuthCredentials: credentials }
  }
  return { apiKey: await resolveChannelRuntimeApiKey(channelId) }
}

export async function prepareAgentRpcRun(input: AgentSendInput): Promise<PiWorkerRunConfig> {
  const session = getAgentSessionMeta(input.sessionId)
  if (!session) throw new Error(`Agent 会话不存在: ${input.sessionId}`)

  const workspaceId = session.workspaceId ?? input.workspaceId
  const workspace = workspaceId ? getAgentWorkspace(workspaceId) : undefined
  if (workspaceId && !workspace) throw new Error(`Agent 项目不存在: ${workspaceId}`)
  if (workspace) {
    const projectRootStatus = getLocalProjectRootStatus(workspace.projectRootPath)
    if (projectRootStatus && projectRootStatus !== 'available') {
      throw new Error(`本地项目根目录不可用：${workspace.projectRootPath}`)
    }
  }

  const channelId = input.channelId ?? session.channelId ?? COPIS_WORKING_CHANNEL_ID
  const workingClient = channelId === COPIS_WORKING_CHANNEL_ID ? getWorkingApiClient() : undefined
  const channel = workingClient
    ? createCopisWorkingChannel(workingClient.baseUrl)
    : getChannelById(channelId)
  if (!channel) throw new Error(`渠道不存在: ${channelId}`)
  if (!channel.enabled) throw new Error('当前渠道已禁用')

  const workingMode = normalizeWorkingMode(input.workingMode ?? session.workingMode)
  const modelId = workingClient
    ? workingModeToModelId(workingMode)
    : input.modelId ?? session.modelId ?? DEFAULT_PI_MODEL_ID
  const credentials = await resolveWorkerCredentials(channelId, channel.provider)
  const settings = getSettings()
  const workspaceSlug = workspace?.slug
  const agentCwd = workspace ? resolveAgentCwd(workspace, input.sessionId, session.agentCwdMode) ?? homedir() : homedir()
  const workspaceWriteRoot = workspace ? getAgentWorkspaceWritableRoot(workspace) : undefined
  if (workspace) ensureAgentWorkspaceContextDir(workspace)
  const startedAt = input.startedAt ?? Date.now()
  const existingSdkSessionId = session.sdkSessionId
  const directories = uniqueDirectories(input, session)
  const proxyUrl = await getEffectiveProxyUrl()
  const runtimeEnv = buildRuntimeEnv(settings, proxyUrl, workspace, workspaceSlug)
  const compactRequest = input.userMessage.trim() === '/compact'

  const initialPermissionMode = input.permissionModeOverride
    ?? session.permissionMode
    ?? COPIS_DEFAULT_PERMISSION_MODE
  const memoryPolicy = workspace?.memoryPolicy ?? settings.defaultMemoryPolicy ?? 'writable'
  const dynamicContext = buildDynamicContext({
    workspaceName: workspace?.name,
    workspaceSlug,
    agentCwd,
  })
  const baseContextualMessage = `${dynamicContext}\n\n${input.userMessage}`
  const contextualMessage = compactRequest
    ? baseContextualMessage
    : await appendMemoryContext(baseContextualMessage, {
      workspaceSlug,
      userMessage: input.userMessage,
      policy: memoryPolicy,
    })
  appendSDKMessages(input.sessionId, [buildUserMessage(input, startedAt)])
  const prompt = compactRequest
    ? '/compact'
    : existingSdkSessionId
      ? contextualMessage
      : buildContextPrompt(input.sessionId, contextualMessage, { agentCwd, workspaceSlug })
  const systemPrompt = buildSystemPrompt({
    agentRuntime: 'pi',
    workspaceName: workspace?.name,
    workspaceSlug,
    sessionId: input.sessionId,
    agentCwd,
    workspaceWriteRoot,
    permissionMode: initialPermissionMode,
    collaborationAvailable: false,
    currentModelId: modelId,
    workingMode,
    memoryPolicy,
  }) + (input.automationContext ? `\n\n## 定时任务执行上下文\n\n${input.automationContext}` : '')

  const maxTurns = settings.agentMaxTurns && settings.agentMaxTurns > 0 ? settings.agentMaxTurns : undefined
  const query: PiWorkerQueryConfig = {
    sessionId: input.sessionId,
    prompt,
    model: modelId,
    cwd: agentCwd,
    apiKey: credentials.apiKey,
    baseUrl: channel.baseUrl,
    provider: channel.provider,
    channelId,
    channelName: channel.name,
    ...(maxTurns !== undefined ? { maxTurns } : {}),
    permissionMode: initialPermissionMode,
    systemPrompt,
    ...(existingSdkSessionId ? { resumeSessionId: existingSdkSessionId } : {}),
    piAgentDir: getSdkConfigDir(),
    piSessionDir: join(getSdkConfigDir(), 'sessions'),
    ...(settings.agentMaxBudgetUsd && settings.agentMaxBudgetUsd > 0 ? { maxBudgetUsd: settings.agentMaxBudgetUsd } : {}),
    ...(directories.length > 0 ? { additionalDirectories: directories } : {}),
    ...(workspaceSlug ? { additionalSkillPaths: [getWorkspaceSkillsDir(workspaceSlug)] } : {}),
    ...(workspaceSlug ? { workspaceSlug } : {}),
    memoryPolicy,
    ...(proxyUrl ? { proxyUrl } : {}),
    runtimeEnv,
    ...(compactRequest ? { compactRequest: true } : {}),
    ...(session.codexFastMode && channel.provider === 'openai-codex' ? { codexFastMode: true } : {}),
    ...(credentials.codexOAuthCredentials ? { codexOAuthCredentials: credentials.codexOAuthCredentials } : {}),
    ...(credentials.xaiOAuthCredentials ? { xaiOAuthCredentials: credentials.xaiOAuthCredentials } : {}),
    thinkingLevel: settings.agentEffort === 'max' ? 'xhigh' : settings.agentEffort ?? 'high',
    retryRunStartedAt: startedAt,
  }

  updateAgentSessionMeta(input.sessionId, {
    agentRuntime: 'pi',
    channelId,
    modelId,
    workingMode,
    workspaceId,
    stoppedByUser: false,
  })
  pendingAgentRpcRuns.set(input.sessionId, {
    userMessage: input.userMessage,
    channelId,
    modelId,
    startedAt,
    provider: channel.provider,
    baseUrl: channel.baseUrl,
    apiKey: credentials.apiKey,
    ...(proxyUrl ? { proxyUrl } : {}),
    ...(workspaceSlug ? { workspaceSlug } : {}),
    memoryPolicy,
    ...(input.triggeredBy ? { triggeredBy: input.triggeredBy } : {}),
    compactRequest,
  })
  return { sessionId: input.sessionId, query }
}

export function shouldPersistAgentRpcMessage(message: SDKMessage): boolean {
  const record = message as unknown as Record<string, unknown>
  if (record._partial === true || record.isReplay === true) return false
  return message.type === 'result' || isVisibleRunMessage(message)
}

export function persistAgentRpcMessage(sessionId: string, message: SDKMessage): void {
  if (!shouldPersistAgentRpcMessage(message)) return
  const record = message as unknown as Record<string, unknown>
  const persisted = typeof record._createdAt === 'number'
    ? message
    : { ...record, _createdAt: Date.now() } as unknown as SDKMessage
  appendSDKMessages(sessionId, [persisted])
}

export function persistAgentRpcMeta(frame: Extract<AgentRpcWorkerFrame, { type: 'meta' }>): void {
  const current = getAgentSessionMeta(frame.sessionId)
  if (!current) return
  updateAgentSessionMeta(frame.sessionId, {
    ...(frame.sdkSessionId ? { sdkSessionId: frame.sdkSessionId } : {}),
    ...(frame.piSessionFile ? { piSessionFile: frame.piSessionFile } : {}),
    ...(frame.piEntryBindings
      ? { piEntryBindings: { ...(current.piEntryBindings ?? {}), ...frame.piEntryBindings } }
      : {}),
  })
}

export function persistAgentRpcCredential(frame: Extract<AgentRpcWorkerFrame, { type: 'credential' }>): void {
  if (frame.provider === 'openai-codex') {
    persistCodexOAuthCredentials(frame.channelId, frame.credentials as Awaited<ReturnType<typeof resolveCodexOAuthCredentials>>)
  } else {
    persistXaiOAuthCredentials(frame.channelId, frame.credentials as Awaited<ReturnType<typeof resolveXaiOAuthCredentials>>)
  }
}

function scheduleRpcMemoryCapture(
  pending: PendingAgentRpcRun,
  input: {
    sessionId: string
    stoppedByUser: boolean
    resultSubtype?: string
    resultErrors?: string[]
  },
): void {
  if (!shouldCaptureRpcRun({
    stoppedByUser: input.stoppedByUser,
    resultSubtype: input.resultSubtype,
    resultErrors: input.resultErrors,
    compactRequest: pending.compactRequest,
  })) return

  const turn = buildRpcMemoryTurn(
    { ...pending, sessionId: input.sessionId },
    getAgentRpcSessionMessages(input.sessionId),
  )
  if (!turn) return

  const maintenanceRunner = pending.workspaceSlug
    ? createMemoryMaintenanceRunner({
      service: rpcMemoryMaintenance,
      workspaceSlug: pending.workspaceSlug,
      policy: pending.memoryPolicy,
      provider: pending.provider,
      baseUrl: pending.baseUrl,
      apiKey: pending.apiKey,
      modelId: pending.modelId,
      proxyUrl: pending.proxyUrl,
      force: false,
    })
    : undefined

  void rpcMemoryAutoCapture.onTurnEnd({
    ...turn,
    extractor: (turns) => extractMemoryFactsWithProvider({
      provider: pending.provider,
      baseUrl: pending.baseUrl,
      apiKey: pending.apiKey,
      modelId: pending.modelId,
      proxyUrl: pending.proxyUrl,
      turns,
    }),
    ...(maintenanceRunner ? { maintenanceRunner } : {}),
  }).catch((error) => {
    console.warn('[Memory] RPC 自动捕获调度失败:', error)
  })
}

export function finalizeAgentRpcRun(input: {
  sessionId: string
  stoppedByUser: boolean
  resultSubtype?: string
  resultErrors?: string[]
}): AgentRpcCompletionResult {
  const pending = pendingAgentRpcRuns.get(input.sessionId)
  const current = getAgentSessionMeta(input.sessionId)
  if (!current) {
    pendingAgentRpcRuns.delete(input.sessionId)
    return { session: undefined }
  }
  const updates: Partial<Pick<AgentSessionMeta, 'stoppedByUser' | 'title'>> = {
    stoppedByUser: input.stoppedByUser,
  }
  let title: string | undefined
  if (pending && current.title === '新 Agent 会话') {
    title = createFallbackTitle(pending.userMessage) ?? undefined
    if (title) updates.title = title
  }
  const session = Object.keys(updates).length > 0
    ? updateAgentSessionMeta(input.sessionId, updates)
    : current
  if (pending) scheduleRpcMemoryCapture(pending, input)
  pendingAgentRpcRuns.delete(input.sessionId)
  return { session, ...(title ? { title } : {}) }
}

export function getAgentRpcSessionMessages(sessionId: string): SDKMessage[] {
  return getAgentSessionSDKMessages(sessionId)
}
