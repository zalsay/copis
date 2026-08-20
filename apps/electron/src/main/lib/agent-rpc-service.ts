import { randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import {
  COPIS_DEFAULT_PERMISSION_MODE,
  COPIS_WORKING_CHANNEL_ID,
  COPIS_WORKING_MODEL_SOURCE_TYPE_HEADER,
  COPIS_WORKING_MODEL_SOURCE_TYPE_COPIS_AGENT,
  createCopisWorkingChannelForId,
  isCopisPermissionMode,
  isCopisWorkingChannelId,
  isWorkingCustomModelChannelId,
  normalizeWorkingMode,
  workingModeToModelId,
  type AgentQueueMessageInput,
  type AgentSendInput,
  type AgentSessionMeta,
  type AgentWorkspace,
  type Automation,
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
import { getWorkingCustomModelRuntime, getWorkingModelCatalogOwnerId } from './working-model-catalog'
import {
  appendSDKMessages,
  createAgentSession,
  getAgentSessionMeta,
  resolveAgentCwd,
  updateAgentSessionMeta,
  getAgentSessionSDKMessages,
} from './agent-session-manager'
import {
  ensureAgentWorkspaceBrowserSessionPath,
  ensureAgentWorkspaceContextDir,
  getAgentWorkspace,
  getAgentWorkspaceCopisPath,
  getAgentWorkspaceReadableRoots,
  getAgentWorkspaceWritableRoot,
  getProjectFilesPath,
  getWorkspaceAttachedDirectories,
  getWorkspaceAttachedFiles,
  getLocalProjectRootStatus,
} from './agent-workspace-manager'
import { getAgentSessionWorkspacePath, getAgentWorkspacePath, getSdkConfigDir, getWorkspaceSkillsDir } from './config-paths'
import { buildDynamicContext, buildSystemPrompt } from './agent-prompt-builder'
import {
  HttpExpertTeamContextReader,
  resolveExpertTeamPromptContext,
  validateInternalExpertTeamContext,
} from './expert-team-context'
import { appendMemoryContext } from './memory-context-builder'
import { buildReferencedSessionsPrompt, buildContextPrompt } from './agent-session-context-prompt'
import { buildReferencedPlanningPrompt } from './planning-reference-context'
import { buildMentionedToolsPrompt } from './agent-mentioned-tools-prompt'
import { buildAgentRuntimeEnv, mergeRuntimeEnv } from './agent-runtime-env'
import { getFunctionalModulePath } from './functional-module-manager'
import { getEffectiveProxyUrl } from './proxy-settings-service'
import { getRuntimeStatus } from './runtime-init'
import { getSettings } from './settings-service'
import { isBuiltinMcpUserEnabled } from './builtin-mcp/settings'
import {
  resolveBrowserAgentPermissionMode,
  resolveBrowserAgentSkillMentions,
} from './browser-agent-skill'
import {
  getBrowserAgentContext,
  isBrowserPageAdvancedAuthorizationEnabled,
  sanitizeBrowserWorkflowUrl,
} from './browser-workflow-service'
import { getWebTabState } from './web-tab-manager'
import {
  issueBrowserAgentWorkerCapability,
  revokeBrowserAgentWorkerCapability,
} from './browser-agent-worker-capability'
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
import { filterAttachedPaths } from './attached-paths'
import type {
  AgentRpcWorkerFrame,
  PiWorkerFileAccessPolicy,
  PiWorkerQueueConfig,
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
  mentionedSkills?: string[]
  mentionedMcpServers?: string[]
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

export interface PreparedAutomationRpcRun {
  sessionId: string
  config: PiWorkerRunConfig
}

const pendingAgentRpcRuns = new Map<string, PendingAgentRpcRun>()
const rpcMemoryAutoCapture = new MemoryAutoCapture()
const rpcMemoryMaintenance = sharedMemoryMaintenanceService

function stringArray(value: unknown): string[] | undefined {
  const values = filterAttachedPaths(value)
  return values.length > 0 ? values : undefined
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const values = value
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map((item) => item.trim())
  const uniqueValues = Array.from(new Set(values))
  return uniqueValues.length > 0 ? uniqueValues : undefined
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
  const mentionedSkills = stringList(record.mentionedSkills)
  const mentionedMcpServers = stringList(record.mentionedMcpServers)
  // 专家团队上下文是主进程内部字段：只有 delegation 子会话携带，且必须通过
  // revision/hash/受管控标记校验；renderer 或 user/automation 提交的同名字段一律忽略。
  const expertTeamContext = triggeredBy === 'delegation'
    ? validateInternalExpertTeamContext(record.expertTeamContext)
    : undefined

  return {
    sessionId,
    userMessage,
    ...(optionalString(record.rawUserMessage) ? { rawUserMessage: optionalString(record.rawUserMessage) } : {}),
    channelId: optionalString(record.channelId) ?? COPIS_WORKING_CHANNEL_ID,
    ...(optionalString(record.modelId) ? { modelId: optionalString(record.modelId) } : {}),
    agentRuntime: 'pi',
    ...(optionalString(record.workspaceId) ? { workspaceId: optionalString(record.workspaceId) } : {}),
    ...(stringArray(record.additionalDirectories) ? { additionalDirectories: stringArray(record.additionalDirectories) } : {}),
    ...(mentionedSkills ? { mentionedSkills } : {}),
    ...(mentionedMcpServers ? { mentionedMcpServers } : {}),
    ...(permissionMode ? { permissionModeOverride: permissionMode } : {}),
    ...(isWorkingMode(rawWorkingMode) ? { workingMode: rawWorkingMode } : {}),
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(optionalString(record.retryOfErrorUuid) ? { retryOfErrorUuid: optionalString(record.retryOfErrorUuid) } : {}),
    ...(triggeredBy ? { triggeredBy } : {}),
    ...(optionalString(record.automationContext) ? { automationContext: optionalString(record.automationContext) } : {}),
    ...(expertTeamContext ? { expertTeamContext } : {}),
  }
}

export function parseAgentRpcQueueInput(record: Record<string, unknown>): AgentQueueMessageInput {
  const sessionId = requireString(record, 'sessionId')
  const userMessage = requireString(record, 'userMessage')
  if (record.interrupt !== undefined && typeof record.interrupt !== 'boolean') {
    throw new Error('interrupt 参数不正确')
  }

  const mentionedSkills = stringList(record.mentionedSkills)
  const mentionedMcpServers = stringList(record.mentionedMcpServers)
  const mentionedSessionIds = stringList(record.mentionedSessionIds)
  const mentionedTodoIds = stringList(record.mentionedTodoIds)
  const mentionedCalendarEventIds = stringList(record.mentionedCalendarEventIds)

  return {
    sessionId,
    userMessage,
    ...(optionalString(record.rawUserMessage) ? { rawUserMessage: optionalString(record.rawUserMessage) } : {}),
    ...(optionalString(record.uuid) ? { uuid: optionalString(record.uuid) } : {}),
    ...(record.interrupt === true ? { interrupt: true } : {}),
    ...(mentionedSkills ? { mentionedSkills } : {}),
    ...(mentionedMcpServers ? { mentionedMcpServers } : {}),
    ...(mentionedSessionIds ? { mentionedSessionIds } : {}),
    ...(mentionedTodoIds ? { mentionedTodoIds } : {}),
    ...(mentionedCalendarEventIds ? { mentionedCalendarEventIds } : {}),
  }
}

function uniqueDirectories(
  input: AgentSendInput,
  session: AgentSessionMeta | undefined,
  workspace: AgentWorkspace | undefined,
): string[] {
  const attachedDirectories = filterAttachedPaths(session?.attachedDirectories)
  const workspaceAttachedDirectories = workspace ? getWorkspaceAttachedDirectories(workspace.slug) : []
  const authorizedDirectories = [
    ...attachedDirectories,
    ...workspaceAttachedDirectories,
  ].map((path) => resolve(path))
  const authorizedSet = new Set(authorizedDirectories)
  const requestedDirectories = filterAttachedPaths(input.additionalDirectories).map((path) => resolve(path))
  const ignoredDirectories = requestedDirectories.filter((path) => !authorizedSet.has(path))
  if (ignoredDirectories.length > 0) {
    console.warn(`[Agent RPC] 忽略未在工作区授权清单中的附加目录: ${ignoredDirectories.join(', ')}`)
  }
  return Array.from(new Set(authorizedDirectories))
}

function uniqueAbsolutePaths(paths: readonly string[]): string[] {
  return Array.from(new Set(paths.filter((path) => path.trim().length > 0).map((path) => resolve(path))))
}

function buildRustFileAccessPolicy(input: {
  workspace: AgentWorkspace
  session: AgentSessionMeta
  sessionId: string
  agentCwd: string
  workspaceSkillsDir: string
  workspaceWriteRoot: string
  additionalDirectories: string[]
  permissionMode: CopisPermissionMode
  advancedAuthorization: boolean
}): PiWorkerFileAccessPolicy {
  const projectRoot = getProjectFilesPath(input.workspace.slug)
  const sessionWorkspaceRoot = getAgentSessionWorkspacePath(input.workspace.slug, input.sessionId)
  const browserSessionRoot = ensureAgentWorkspaceBrowserSessionPath(input.workspace, input.sessionId)
  const workspaceReadRoots = [
    input.agentCwd,
    ...getAgentWorkspaceReadableRoots(input.workspace),
    input.workspaceWriteRoot,
    browserSessionRoot,
    sessionWorkspaceRoot,
    input.workspaceSkillsDir,
    ...input.additionalDirectories,
    ...getWorkspaceAttachedDirectories(input.workspace.slug),
  ]
  const workspaceCopisRoot = getAgentWorkspaceCopisPath(input.workspace)
  const writeRoots = [projectRoot, workspaceCopisRoot, browserSessionRoot, sessionWorkspaceRoot]

  return {
    readRoots: uniqueAbsolutePaths(workspaceReadRoots),
    readFiles: uniqueAbsolutePaths([
      ...filterAttachedPaths(input.session.attachedFiles),
      ...getWorkspaceAttachedFiles(input.workspace.slug),
    ]),
    writeRoots: uniqueAbsolutePaths(writeRoots),
    browserSessionRoot,
    permissionMode: input.permissionMode,
    advancedAuthorization: input.advancedAuthorization,
  }
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
    pythonRuntimePath: getFunctionalModulePath('python-runtime'),
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

export function prepareAgentRpcQueue(input: AgentQueueMessageInput): PiWorkerQueueConfig {
  const session = getAgentSessionMeta(input.sessionId)
  if (!session) throw new Error(`Agent 会话不存在: ${input.sessionId}`)
  if (!pendingAgentRpcRuns.has(input.sessionId)) {
    throw new Error(`Agent 会话未运行，无法追加消息: ${input.sessionId}`)
  }

  const workspace = session.workspaceId ? getAgentWorkspace(session.workspaceId) : undefined
  const workspaceSlug = workspace?.slug
  const browserBinding = getBrowserAgentContext(input.sessionId)
  const hasBrowserContext = Boolean(browserBinding && getWebTabState(browserBinding.tabId))
  const effectiveSkillMentions = resolveBrowserAgentSkillMentions(input.mentionedSkills, hasBrowserContext)
  let enrichedText = input.userMessage

  const referencedSessionsBlock = buildReferencedSessionsPrompt(
    input.sessionId,
    input.mentionedSessionIds,
    workspaceSlug,
  )
  if (referencedSessionsBlock) enrichedText = `${referencedSessionsBlock}\n\n${enrichedText}`

  const mentionedToolsPrompt = buildMentionedToolsPrompt(input.mentionedSkills, input.mentionedMcpServers)
  if (mentionedToolsPrompt) enrichedText = `${mentionedToolsPrompt}\n\n${enrichedText}`

  const referencedPlanningBlock = buildReferencedPlanningPrompt(
    input.mentionedTodoIds,
    input.mentionedCalendarEventIds,
    { requireToolRead: true },
  )
  if (referencedPlanningBlock) enrichedText = `${referencedPlanningBlock}\n\n${enrichedText}`

  const uuid = input.uuid ?? randomUUID()
  // HTTP 响应丢失时前端会按原 UUID 重试；JSONL 只能保留首次接受的用户消息。
  const alreadyPersisted = getAgentSessionSDKMessages(input.sessionId).some((message) => {
    const record = message as unknown as Record<string, unknown>
    return record.uuid === uuid
  })
  if (!alreadyPersisted) {
    appendSDKMessages(input.sessionId, [{
      type: 'user',
      uuid,
      message: {
        content: [{ type: 'text', text: input.rawUserMessage ?? input.userMessage }],
      },
      parent_tool_use_id: null,
      _createdAt: Date.now(),
    } as unknown as SDKMessage])
  }

  return {
    sessionId: input.sessionId,
    userMessage: enrichedText,
    uuid,
    ...(input.interrupt ? { interrupt: true } : {}),
    ...(effectiveSkillMentions?.length ? { skillMentions: effectiveSkillMentions } : {}),
  }
}

async function resolveWorkerCredentials(channelId: string, provider: string): Promise<{
  apiKey: string
  codexOAuthCredentials?: Awaited<ReturnType<typeof resolveCodexOAuthCredentials>>
  xaiOAuthCredentials?: Awaited<ReturnType<typeof resolveXaiOAuthCredentials>>
}> {
  if (isCopisWorkingChannelId(channelId)) {
    // Rust PiWorkerManager 启动时注入一次性本地 Working model capability。
    return { apiKey: '' }
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
  if (!workspace) {
    throw new Error('Agent 必须绑定有效工作区后才能执行文件操作')
  }
  const projectRootStatus = getLocalProjectRootStatus(workspace.projectRootPath)
  if (projectRootStatus && projectRootStatus !== 'available') {
    throw new Error(`本地项目根目录不可用：${workspace.projectRootPath}`)
  }

  const channelId = input.channelId ?? session.channelId ?? COPIS_WORKING_CHANNEL_ID
  const workingClient = isCopisWorkingChannelId(channelId) ? getWorkingApiClient() : undefined
  const workingUser = getWorkingApiClient().getCachedUser()
  const customModelRuntime = isWorkingCustomModelChannelId(channelId)
    ? getWorkingCustomModelRuntime(
      channelId,
      workingUser?.isVip === true,
      getWorkingModelCatalogOwnerId(workingUser),
    )
    : undefined
  const channel = workingClient
    ? createCopisWorkingChannelForId(workingClient.baseUrl, channelId)
    : customModelRuntime?.channel ?? getChannelById(channelId)
  if (!channel) throw new Error(`渠道不存在: ${channelId}`)
  if (!channel.enabled) throw new Error('当前渠道已禁用')

  const workingMode = channelId === COPIS_WORKING_CHANNEL_ID
    ? normalizeWorkingMode(input.workingMode ?? session.workingMode)
    : undefined
  const modelId = customModelRuntime
    ? customModelRuntime.model.modelId
    : workingClient
    ? channelId === COPIS_WORKING_CHANNEL_ID
      ? workingModeToModelId(workingMode ?? 'fast')
      : input.modelId ?? channel.models[0]?.id ?? DEFAULT_PI_MODEL_ID
    : input.modelId ?? session.modelId ?? DEFAULT_PI_MODEL_ID
  const credentials = customModelRuntime
    ? { apiKey: customModelRuntime.apiKey }
    : await resolveWorkerCredentials(channelId, channel.provider)
  const settings = getSettings()
  const workspaceSlug = workspace.slug
  const browserBinding = getBrowserAgentContext(input.sessionId)
  const browserTab = browserBinding ? getWebTabState(browserBinding.tabId) : undefined
  const hasBrowserContext = Boolean(browserBinding && browserTab)
  const browserAdvancedAuthorization = (input.triggeredBy ?? 'user') === 'user'
    && isBrowserPageAdvancedAuthorizationEnabled(input.sessionId)
  const effectivePermissionMode = resolveBrowserAgentPermissionMode(
    hasBrowserContext,
    input.permissionModeOverride ?? session.permissionMode ?? COPIS_DEFAULT_PERMISSION_MODE,
  )
  const effectiveSkillMentions = resolveBrowserAgentSkillMentions(input.mentionedSkills, hasBrowserContext)
  const agentCwd = resolveAgentCwd(workspace, input.sessionId, session.agentCwdMode)
  if (!agentCwd) throw new Error('Agent 工作区 cwd 不可用，已拒绝启动文件操作')
  const workspaceWriteRoot = getAgentWorkspaceWritableRoot(workspace)
  ensureAgentWorkspaceContextDir(workspace)
  const workspaceSkillsDir = getWorkspaceSkillsDir(workspaceSlug)
  const startedAt = input.startedAt ?? Date.now()
  const existingSdkSessionId = session.sdkSessionId
  const directories = uniqueDirectories(input, session, workspace)
  const proxyUrl = await getEffectiveProxyUrl()
  const runtimeEnv = buildRuntimeEnv(settings, proxyUrl, workspace, workspaceSlug)
  const compactRequest = input.userMessage.trim() === '/compact'
  const mentionedToolsPrompt = buildMentionedToolsPrompt(input.mentionedSkills, input.mentionedMcpServers)
  const enrichedUserMessage = mentionedToolsPrompt
    ? `${mentionedToolsPrompt}\n\n${input.userMessage}`
    : input.userMessage

  const fileAccessPolicy = buildRustFileAccessPolicy({
    workspace,
    session,
    sessionId: input.sessionId,
    agentCwd,
    workspaceSkillsDir,
    workspaceWriteRoot,
    additionalDirectories: directories,
    permissionMode: effectivePermissionMode,
    advancedAuthorization: session.advancedAuthorization === true,
  })
  const memoryPolicy = workspace.memoryPolicy ?? settings.defaultMemoryPolicy ?? 'writable'
  const dynamicContext = buildDynamicContext({
    workspaceName: workspace.name,
    workspaceSlug,
    agentCwd,
  })
  const baseContextualMessage = `${dynamicContext}\n\n${enrichedUserMessage}`
  const contextualMessage = compactRequest
    ? baseContextualMessage
    : await appendMemoryContext(baseContextualMessage, {
      workspaceSlug,
      userMessage: enrichedUserMessage,
      policy: memoryPolicy,
    })
  appendSDKMessages(input.sessionId, [buildUserMessage(input, startedAt)])
  const prompt = compactRequest
    ? '/compact'
    : existingSdkSessionId
      ? contextualMessage
      : buildContextPrompt(input.sessionId, contextualMessage, { agentCwd, workspaceSlug })
  // 专家团队上下文：delegation 只接受主进程 runner 生成的冻结上下文；
  // user 回合每次按 Rust 当前 binding/revision 重新解析（fail-soft）。
  const expertTeamContext = input.expertTeamContext
    ? (input.triggeredBy === 'delegation'
      ? validateInternalExpertTeamContext(input.expertTeamContext)
      : undefined)
    : compactRequest
      ? undefined
      : (input.triggeredBy ?? 'user') === 'user'
        ? await resolveExpertTeamPromptContext({
          workspace,
          reader: new HttpExpertTeamContextReader(),
        })
        : undefined
  const systemPrompt = buildSystemPrompt({
    agentRuntime: 'pi',
    workspaceName: workspace.name,
    workspaceSlug,
    sessionId: input.sessionId,
    agentCwd,
    workspaceWriteRoot,
    permissionMode: effectivePermissionMode,
    collaborationAvailable: false,
    // 与 Pi 内置工具保持一致：只有用户主会话可使用专家团队，委派/自动化会话只执行成员或任务本身。
    expertTeamAvailable: (input.triggeredBy ?? 'user') === 'user' && Boolean(workspaceId && workspaceSlug),
    currentModelId: modelId,
    workingMode,
    memoryPolicy,
    ...(session.expertTeamSession ? { expertTeamSession: session.expertTeamSession } : {}),
    ...(session.expertTeamSetup ? { expertTeamSetup: true } : {}),
    ...(expertTeamContext ? { expertTeamContext } : {}),
    ...(browserBinding && browserTab
      ? {
        browserContext: {
          tabId: browserBinding.tabId,
          title: browserTab.title,
          url: sanitizeBrowserWorkflowUrl(browserTab.url),
        },
        browserAdvancedAuthorization,
      }
      : {}),
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
    permissionMode: effectivePermissionMode,
    systemPrompt,
    ...(existingSdkSessionId ? { resumeSessionId: existingSdkSessionId } : {}),
    piAgentDir: getSdkConfigDir(),
    piSessionDir: join(getSdkConfigDir(), 'sessions'),
    ...(settings.agentMaxBudgetUsd && settings.agentMaxBudgetUsd > 0 ? { maxBudgetUsd: settings.agentMaxBudgetUsd } : {}),
    ...(directories.length > 0 ? { additionalDirectories: directories } : {}),
    ...(workspaceSlug ? { additionalSkillPaths: [workspaceSkillsDir] } : {}),
    ...(effectiveSkillMentions?.length ? { skillMentions: effectiveSkillMentions } : {}),
    ...(workspaceSlug ? { workspaceSlug } : {}),
    ...(workspace?.id ? { workspaceId: workspace.id } : {}),
    ...(session.sourceAutomationId ? { sourceAutomationId: session.sourceAutomationId } : {}),
    automationEnabled: isBuiltinMcpUserEnabled('automation'),
    memoryPolicy,
    ...(proxyUrl ? { proxyUrl } : {}),
    runtimeEnv,
    ...(compactRequest ? { compactRequest: true } : {}),
    ...(session.codexFastMode && channel.provider === 'openai-codex' ? { codexFastMode: true } : {}),
    ...(credentials.codexOAuthCredentials ? { codexOAuthCredentials: credentials.codexOAuthCredentials } : {}),
    ...(credentials.xaiOAuthCredentials ? { xaiOAuthCredentials: credentials.xaiOAuthCredentials } : {}),
    ...(customModelRuntime?.model.protocol === 'openai-responses'
      ? { openAIThinkingLevel: customModelRuntime.model.thinkingLevel }
      : {}),
    thinkingLevel: customModelRuntime?.model.thinkingLevel
      ?? (settings.agentEffort === 'max' ? 'xhigh' : settings.agentEffort ?? 'high'),
    retryRunStartedAt: startedAt,
    ...(fileAccessPolicy ? { fileAccessPolicy, useRustFileApi: true } : {}),
    browserPageControl: issueBrowserAgentWorkerCapability({
      sessionId: input.sessionId,
      ...(browserBinding && browserTab ? { tabId: browserBinding.tabId } : {}),
      triggeredBy: input.triggeredBy ?? 'user',
    }),
    triggeredBy: input.triggeredBy ?? 'user',
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

function automationContext(automation: Automation): string {
  return `这是 Copis 定时任务「${automation.name}」的自动执行（ID: ${automation.id}）。这本身就是定时任务，不要建议用户再创建定时任务。直接执行任务即可。如发现本任务连续失败、输出价值低、频率不合适或提示词不完整，可以使用 automation 工具读取并更新当前任务。`
}

/**
 * Rust 调度器通过私有业务桥请求一次已授权的 Pi 配置。
 * 会话元数据与渠道凭据仍在 Electron，但 Worker 启动、调度和运行记录均由 Rust 负责。
 */
export async function prepareAutomationRpcRun(
  automation: Automation,
  runAt: number,
): Promise<PreparedAutomationRpcRun> {
  if (!automation.channelId || !automation.workspaceId) {
    throw new Error('请先为该任务配置模型与项目')
  }

  let sessionId: string | undefined
  const lastSession = automation.lastSessionId
    ? getAgentSessionMeta(automation.lastSessionId)
    : undefined
  if (lastSession && !lastSession.automationGraduated) sessionId = lastSession.id

  if (!sessionId) {
    const session = createAgentSession(
      automation.name,
      automation.channelId,
      automation.workspaceId,
      automation.modelId,
      'pi',
    )
    updateAgentSessionMeta(session.id, { sourceAutomationId: automation.id, agentRuntime: 'pi' })
    sessionId = session.id
  }

  const config = await prepareAgentRpcRun({
    sessionId,
    userMessage: `${automation.prompt}\n<!--COPIS_SCHEDULED_RUN-->`,
    automationContext: automationContext(automation),
    channelId: automation.channelId,
    ...(automation.modelId ? { modelId: automation.modelId } : {}),
    workspaceId: automation.workspaceId,
    agentRuntime: 'pi',
    permissionModeOverride: 'bypassPermissions',
    triggeredBy: 'automation',
    startedAt: runAt,
  })
  return { sessionId, config }
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
      ...(isCopisWorkingChannelId(pending.channelId)
        ? { extraHeaders: { [COPIS_WORKING_MODEL_SOURCE_TYPE_HEADER]: COPIS_WORKING_MODEL_SOURCE_TYPE_COPIS_AGENT } }
        : {}),
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
  revokeBrowserAgentWorkerCapability(input.sessionId)
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
