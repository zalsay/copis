/**
 * DSH 模型统一配置解析与注入服务。
 *
 * 统一解析 Copis 当前激活的 Agent 渠道/模型配置，
 * 并注册 DSH Composer 可枚举的 Copis Working provider：
 * - 统一提取当前选中的 channelId、modelId、baseUrl 与运行时 apiKey；
 * - 将配置注册到 $DSH_HOME/settings.yaml 的 llm-pi-ai.providers 下；
 * - 将 agent-default-model 默认指向当前选中的 provider 与 model；
 * - 安全维护 $DSH_HOME/.credentials.yaml 中的 refs (COPIS_API_KEY 等)；
 * - 更新 profiles/copis/cordis.patch.yml 中的 agent-default-model 补丁；
 * - 导出供 DSH 启动进程注入的环境变量。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { Document, parseDocument } from 'yaml'
import {
  COPIS_DEFAULT_PERMISSION_MODE,
  COPIS_WORKING_CHANNEL_ID,
  COPIS_WORKING_DEEPSEEK_CHANNEL_ID,
  COPIS_WORKING_DEEPSEEK_FAST_MODEL_ID,
  COPIS_WORKING_EXPERT_MODEL_ID,
  COPIS_WORKING_FAST_MODEL_ID,
  COPIS_WORKING_GLOBAL_MODEL_ID,
  COPIS_WORKING_ZHIPU_CHANNEL_ID,
  COPIS_WORKING_MODEL_ENDPOINT_PATH,
  BUILTIN_CHANNEL_DEFINITIONS,
  getCopisWorkingModelDisplayName,
  PROVIDER_DEFAULT_URLS,
  ZHIPU_DEFAULT_MODEL_ID,
  isWorkingCustomModelChannelId,
  workingCustomModelChannelIdFor,
  type AgentThinkingLevel,
} from '@copis/shared'
import type { AppSettings } from '../../types'
import { resolvePiThinkingLevel } from './agent-thinking-level'
import { getSettings } from './settings-service'
import { getChannelById, listChannels, resolveChannelRuntimeApiKey } from './channel-manager'
import { getWorkingApiClient } from './working-api-service'
import { getDshHomeDir } from './config-paths'
import { getWorkingModelCatalog, getWorkingModelCatalogOwnerId, getWorkingCustomModelRuntime } from './working-model-catalog'
import { writeJsonFileAtomic } from './safe-file'

async function resolveHttpApiInternalToken(): Promise<string> {
  try {
    const { getHttpApiInternalToken } = await import('./http-api-server')
    return getHttpApiInternalToken() || 'copis-internal'
  } catch {
    return 'copis-internal'
  }
}

/** DSH 统一自定义 Provider 路由名 */
export const COPIS_DSH_PROVIDER_ROUTE = 'copis'

/** DSH 统一自定义 Provider API 密钥引用名 */
export const COPIS_DSH_API_KEY_ENV = 'COPIS_API_KEY'

/** DSH 访问本机 Working 模型代理时使用的长期 capability 环境变量。 */
export const COPIS_DSH_WORKING_CAPABILITY_ENV = 'COPIS_DSH_WORKING_CAPABILITY'
/** DeepSeek 内置模型在 DSH 中使用的默认上下文窗口（990K tokens）。 */
export const COPIS_DSH_DEEPSEEK_DEFAULT_CONTEXT_WINDOW = 990_000

export interface DshWorkingProviderConfig {
  providerRoute: string
  displayName: string
  apiKeyEnv: string
  protocol: DshUnifiedModelConfig['protocol']
  reasoning?: AgentThinkingLevel
  baseURL: string
  models: DshUnifiedModelConfig['models']
  defaultContextWindow?: number
  env: Record<string, string>
  credentialsRefs: Record<string, string>
}

/** 将 Copis 内建 Working 模型组投影为 Composer 可枚举的独立 DSH Provider。 */
export function resolveDshWorkingProviderConfigs(options: {
  baseURL: string
  capability: string
}): DshWorkingProviderConfig[] {
  const baseURL = options.baseURL.replace(/\/+$/, '')
  const env = { [COPIS_DSH_WORKING_CAPABILITY_ENV]: options.capability }
  const common = {
    apiKeyEnv: COPIS_DSH_WORKING_CAPABILITY_ENV,
    protocol: 'openai-responses' as const,
    baseURL,
    env,
    // capability 只保留在 DSH 子进程环境中，不写入 DSH credentials 文件。
    credentialsRefs: {},
  }
  return [
    {
      ...common,
      providerRoute: COPIS_WORKING_CHANNEL_ID,
      displayName: 'Copis 内置模型',
      models: BUILTIN_CHANNEL_DEFINITIONS.groups[COPIS_WORKING_CHANNEL_ID].models.map((model) => ({
        id: model.id,
        name: getCopisWorkingModelDisplayName(COPIS_WORKING_CHANNEL_ID, model.id, model.name),
      })),
    },
    {
      ...common,
      providerRoute: COPIS_WORKING_DEEPSEEK_CHANNEL_ID,
      displayName: 'DeepSeek',
      defaultContextWindow: COPIS_DSH_DEEPSEEK_DEFAULT_CONTEXT_WINDOW,
      models: BUILTIN_CHANNEL_DEFINITIONS.groups[COPIS_WORKING_DEEPSEEK_CHANNEL_ID].models.map((model) => ({
        id: model.id,
        name: getCopisWorkingModelDisplayName(COPIS_WORKING_DEEPSEEK_CHANNEL_ID, model.id, model.name),
      })),
    },
    {
      ...common,
      providerRoute: COPIS_WORKING_ZHIPU_CHANNEL_ID,
      displayName: '智谱 AI',
      models: BUILTIN_CHANNEL_DEFINITIONS.groups[COPIS_WORKING_ZHIPU_CHANNEL_ID].models.map((model) => ({
        id: model.id,
        name: getCopisWorkingModelDisplayName(COPIS_WORKING_ZHIPU_CHANNEL_ID, model.id, model.name),
      })),
    },
  ]
}

export interface DshUnifiedModelConfig {
  /** 当前默认 Provider 的 route 标识符 */
  providerRoute: string
  /** 自定义 Provider 显示名称 */
  displayName: string
  /** 默认选中的模型 ID */
  defaultModelId: string
  /** 协议类型 */
  protocol: 'openai-completions' | 'openai-responses' | 'anthropic-messages'
  /** 请求 Base URL */
  baseURL: string
  /** API 凭据密钥（可为空字符串） */
  apiKey: string
  /** 凭据在 credentials.yaml / process.env 中的引用键名 */
  apiKeyEnv: string
  /** 模型级输入声明优先；未声明时默认支持 text + image。 */
  models: Array<{ id: string; name: string; input?: Array<'text' | 'image'> }>
  /** 需要注入子进程的环境变量 */
  env: Record<string, string>
  /** 需要持久化到 .credentials.yaml 的 refs */
  credentialsRefs: Record<string, string>
  /** 与当前默认路由同时注册的 Copis Working 模型路由。 */
  providerConfigs?: DshWorkingProviderConfig[]
}

/** 写入 DSH 的 Copis Agent 默认配置快照，不包含任何渠道密钥。 */
export interface DshCopisDefaults {
  agent: {
    channelId?: string
    modelId?: string
    channelIds: string[]
    workspaceId?: string
    runtime: AppSettings['agentRuntime']
    thinking: NonNullable<AppSettings['agentThinking']>
    effort?: AppSettings['agentEffort']
    openAIThinkingLevel?: AppSettings['defaultOpenAIThinkingLevel']
    maxBudgetUsd?: number
    maxTurns?: number
    permissionMode: typeof COPIS_DEFAULT_PERMISSION_MODE
  }
  memoryPolicy: NonNullable<AppSettings['defaultMemoryPolicy']>
  windowsShellPreference: NonNullable<AppSettings['windowsShellPreference']>
  browserWorkflowEnabled: boolean
  builtinMcp: {
    disabledIds: string[]
    enabledIds: string[]
  }
  gitAttributionEnabled: boolean
}

const DSH_COPIS_DEFAULT_SETTING_KEYS = new Set<keyof AppSettings>([
  'agentChannelId',
  'agentModelId',
  'agentChannelIds',
  'agentWorkspaceId',
  'agentRuntime',
  'defaultMemoryPolicy',
  'windowsShellPreference',
  'agentThinking',
  'agentEffort',
  'defaultOpenAIThinkingLevel',
  'agentMaxBudgetUsd',
  'agentMaxTurns',
  'browserWorkflowEnabled',
  'builtinMcpDisabledIds',
  'builtinMcpEnabledIds',
  'gitAttributionEnabled',
])

/** 判断此次 Copis 设置更新是否需要同步到 DSH 专有 profile。 */
export function shouldSyncDshCopisDefaults(updates: Partial<AppSettings>): boolean {
  return Object.keys(updates).some((key) => DSH_COPIS_DEFAULT_SETTING_KEYS.has(key as keyof AppSettings))
}

/** 将 Copis 的有效 Agent 默认设置投影为 DSH 可读取的配置快照。 */
export function resolveDshCopisDefaults(settings: AppSettings = getSettings()): DshCopisDefaults {
  return {
    agent: {
      ...(settings.agentChannelId ? { channelId: settings.agentChannelId } : {}),
      ...(settings.agentModelId ? { modelId: settings.agentModelId } : {}),
      channelIds: settings.agentChannelIds ?? [],
      ...(settings.agentWorkspaceId ? { workspaceId: settings.agentWorkspaceId } : {}),
      runtime: settings.agentRuntime ?? 'pi',
      thinking: settings.agentThinking ?? { type: 'adaptive' },
      ...(settings.agentEffort ? { effort: settings.agentEffort } : {}),
      ...(settings.defaultOpenAIThinkingLevel ? { openAIThinkingLevel: settings.defaultOpenAIThinkingLevel } : {}),
      ...(settings.agentMaxBudgetUsd !== undefined ? { maxBudgetUsd: settings.agentMaxBudgetUsd } : {}),
      ...(settings.agentMaxTurns !== undefined ? { maxTurns: settings.agentMaxTurns } : {}),
      permissionMode: COPIS_DEFAULT_PERMISSION_MODE,
    },
    memoryPolicy: settings.defaultMemoryPolicy ?? 'writable',
    windowsShellPreference: settings.windowsShellPreference ?? 'auto',
    browserWorkflowEnabled: settings.browserWorkflowEnabled !== false,
    builtinMcp: {
      disabledIds: settings.builtinMcpDisabledIds ?? [],
      enabledIds: settings.builtinMcpEnabledIds ?? [],
    },
    gitAttributionEnabled: settings.gitAttributionEnabled !== false,
  }
}

export interface ResolveDshModelOptions {
  channelId?: string
  modelId?: string
  dshHomeDir?: string
}

let activeDshWorkingCapability: { baseURL: string; capability: string } | undefined

/** 将 Copis 全局思考设置映射为 DSH Responses 请求使用的 effort。 */
export function resolveDshWorkingReasoningEffort(
  settings: Pick<AppSettings, 'agentThinking' | 'agentEffort'> = getSettings(),
): string {
  const level = resolvePiThinkingLevel(settings, undefined, 'openai-responses')
  return level === 'off' ? 'none' : level
}

async function resolveDshWorkingCapability(baseURL: string, reasoningEffort: string): Promise<string> {
  const normalizedBaseURL = baseURL.replace(/\/+$/, '')
  if (activeDshWorkingCapability?.baseURL === normalizedBaseURL) {
    return activeDshWorkingCapability.capability
  }

  const internalToken = await resolveHttpApiInternalToken()
  const response = await fetch(`${normalizedBaseURL}/api/internal/dsh-model-capability`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Copis-Internal-Token': internalToken,
    },
    body: JSON.stringify({ reasoningEffort }),
  })
  if (!response.ok) {
    throw new Error(`DSH Working capability 签发失败（HTTP ${response.status}）`)
  }
  const payload = await response.json().catch(() => null) as { capability?: unknown } | null
  const capability = typeof payload?.capability === 'string' ? payload.capability.trim() : ''
  if (!capability) {
    throw new Error('DSH Working capability 响应无效')
  }
  activeDshWorkingCapability = { baseURL: normalizedBaseURL, capability }
  return capability
}

async function resolveDshWorkingProviders(): Promise<DshWorkingProviderConfig[]> {
  const baseURL = getWorkingApiClient().baseUrl.replace(/\/+$/, '')
  const capability = await resolveDshWorkingCapability(baseURL, resolveDshWorkingReasoningEffort())
  return resolveDshWorkingProviderConfigs({
    baseURL: `${baseURL}${COPIS_WORKING_MODEL_ENDPOINT_PATH}`,
    capability,
  })
}

const CUSTOM_KEY_PREFIX = 'COPIS_DSH_CUSTOM_'

/** 与 Agent 共用账号目录模型配置，每个模型保留独立协议及凭据。 */
function resolveDshCustomProviders(): DshWorkingProviderConfig[] {
  const user = getWorkingApiClient().getCachedUser()
  const ownerId = getWorkingModelCatalogOwnerId(user)
  const catalog = getWorkingModelCatalog(true, ownerId)
  return catalog.models.filter((model) => model.apiKeyConfigured).flatMap((model) => {
    const providerRoute = workingCustomModelChannelIdFor(model.id)
    try {
      const runtime = getWorkingCustomModelRuntime(providerRoute, true, ownerId)
      const apiKeyEnv = CUSTOM_KEY_PREFIX + createHash('sha256').update(`${ownerId ?? 'default'}:${model.id}`).digest('hex').toUpperCase()
      return [{
        providerRoute,
        displayName: catalog.categories.find((category) => category.id === model.categoryId)?.name ?? '自定义模型',
        protocol: model.protocol,
        reasoning: model.thinkingLevel,
        baseURL: model.baseUrl.replace(/\/+$/, ''),
        models: [{ id: model.modelId, name: model.name }],
        apiKeyEnv,
        // 通过 credentials 热更新，不把密钥固化进子进程环境。
        env: {},
        credentialsRefs: { [apiKeyEnv]: runtime.apiKey },
      }]
    } catch {
      // 暂时无法解密不等于用户撤销了凭据，不能据此清空原生模型配置。
      throw new Error(`自定义模型 ${model.id} 的凭据无法读取，已停止同步以保护 DSH 配置`)
    }
  })
}

/**
 * 统一解析 Copis 当前激活的 Agent 渠道/模型，返回 DSH 自定义 provider 的结构化配置
 */
export async function resolveDshUnifiedModelConfig(
  options: ResolveDshModelOptions = {},
): Promise<DshUnifiedModelConfig> {
  const settings = getSettings()
  const targetChannelId = options.channelId ?? settings.agentChannelId
  const requestedModelId = options.modelId ?? settings.agentModelId

  let displayName = 'Copis AI'
  let protocol: DshUnifiedModelConfig['protocol'] = 'openai-responses'
  let baseURL = 'https://api.deepseek.com'
  let apiKey = ''
  let models: Array<{ id: string; name: string }> = []
  let defaultModelId = 'deepseek-v4-flash'
  let providerConfigs: DshWorkingProviderConfig[] = []
  let isWorkingRoute = isCopisWorkingProviderRoute(targetChannelId) || !targetChannelId

  try {
    providerConfigs = await resolveDshWorkingProviders()
  } catch (error) {
    console.warn('[DSH Cordis Web] Working 模型路由同步失败:', error)
  }
  providerConfigs.push(...resolveDshCustomProviders())
  const selectedCustom = providerConfigs.find((provider) => provider.providerRoute === targetChannelId && isWorkingCustomModelChannelId(targetChannelId))
  if (selectedCustom) {
    return {
      ...selectedCustom,
      env: Object.assign({}, ...providerConfigs.map((provider) => provider.env)),
      defaultModelId: selectedCustom.models[0]!.id,
      apiKey: selectedCustom.credentialsRefs[selectedCustom.apiKeyEnv] ?? '',
      providerConfigs,
    }
  }

  // 1. Copis Working 内置快速 / 专家 / 通识渠道
  if (targetChannelId === COPIS_WORKING_CHANNEL_ID) {
    const provider = providerConfigs.find((item) => item.providerRoute === COPIS_WORKING_CHANNEL_ID)
    if (!provider) throw new Error('Copis Working 模型路由不可用')
    displayName = provider.displayName
    protocol = provider.protocol
    baseURL = provider.baseURL
    apiKey = provider.env[provider.apiKeyEnv] || ''
    models = provider.models
    defaultModelId = requestedModelId && models.some((model) => model.id === requestedModelId)
      ? requestedModelId
      : COPIS_WORKING_FAST_MODEL_ID
  }
  // 2. Copis Working 智谱渠道
  else if (targetChannelId === COPIS_WORKING_ZHIPU_CHANNEL_ID) {
    const provider = providerConfigs.find((item) => item.providerRoute === COPIS_WORKING_ZHIPU_CHANNEL_ID)
    if (!provider) throw new Error('Copis Zhipu 模型路由不可用')
    displayName = provider.displayName
    protocol = provider.protocol
    baseURL = provider.baseURL
    apiKey = provider.env[provider.apiKeyEnv] || ''
    models = provider.models
    defaultModelId = ZHIPU_DEFAULT_MODEL_ID
  }
  // 3. Copis Working DeepSeek 渠道或未配置渠道时的默认兜底（DeepSeek）
  else if (targetChannelId === COPIS_WORKING_DEEPSEEK_CHANNEL_ID || !targetChannelId) {
    const provider = providerConfigs.find((item) => item.providerRoute === COPIS_WORKING_DEEPSEEK_CHANNEL_ID)
    if (!provider) throw new Error('Copis DeepSeek 模型路由不可用')
    displayName = provider.displayName
    protocol = provider.protocol
    baseURL = provider.baseURL
    apiKey = provider.env[provider.apiKeyEnv] || ''
    models = provider.models
    defaultModelId = requestedModelId && models.some((model) => model.id === requestedModelId)
      ? requestedModelId
      : COPIS_WORKING_DEEPSEEK_FAST_MODEL_ID
  }
  // 4. 用户配置的渠道（OpenAI / Anthropic / Kimi / 智谱 / MiniMax / 豆包 / 千问 / Custom 等）
  else {
    let channel: import('@copis/shared').Channel | undefined
    try {
      channel = getChannelById(targetChannelId) || listChannels().find((c) => c.id === targetChannelId)
    } catch {
      // ignore
    }

    if (channel) {
      displayName = channel.name ? `Copis (${channel.name})` : `Copis (${channel.provider})`
      apiKey = await resolveChannelRuntimeApiKey(channel.id).catch(() => '')
      baseURL = (channel.baseUrl || PROVIDER_DEFAULT_URLS[channel.provider] || '').replace(/\/+$/, '')

      // 协议推断
      if (channel.provider === 'openai-responses') {
        protocol = 'openai-responses'
      } else if (
        channel.provider === 'anthropic' ||
        channel.provider === 'anthropic-compatible' ||
        channel.provider === 'minimax' ||
        channel.provider === 'qwen-anthropic' ||
        baseURL.endsWith('/anthropic')
      ) {
        protocol = 'anthropic-messages'
      } else {
        protocol = 'openai-responses'
      }

      if (channel.models && channel.models.length > 0) {
        models = channel.models.map((m) => ({ id: m.id, name: m.name || m.id }))
      } else {
        const fallbackId = requestedModelId || 'default'
        models = [{ id: fallbackId, name: fallbackId }]
      }

      defaultModelId = requestedModelId && models.some((m) => m.id === requestedModelId)
        ? requestedModelId
        : models[0]?.id || 'default'
    } else {
      // 渠道不存在时回退到 Copis 内置 DeepSeek，避免写入 DeepSeek 官方 API 配置。
      const provider = providerConfigs.find((item) => item.providerRoute === COPIS_WORKING_DEEPSEEK_CHANNEL_ID)
      if (!provider) throw new Error('Copis 内置 DeepSeek 模型路由不可用')
      isWorkingRoute = true
      displayName = provider.displayName
      protocol = provider.protocol
      baseURL = provider.baseURL
      apiKey = provider.env[provider.apiKeyEnv] || ''
      models = provider.models
      defaultModelId = COPIS_WORKING_DEEPSEEK_FAST_MODEL_ID
    }
  }

  // 组装环境变量与凭据映射
  const env: Record<string, string> = Object.assign({}, ...providerConfigs.map((provider) => provider.env))
  const credentialsRefs: Record<string, string> = {}

  if (isWorkingRoute && apiKey) {
    env[COPIS_DSH_WORKING_CAPABILITY_ENV] = apiKey
  } else if (apiKey) {
    env[COPIS_DSH_API_KEY_ENV] = apiKey
    credentialsRefs[COPIS_DSH_API_KEY_ENV] = apiKey
  }

  // 对 DeepSeek 系列渠道/端点额外同步 DEEPSEEK_API_KEY 与 DEEPSEEK_BASE_URL，
  // 确保 DSH 内部的 web-search-deepseek 工具或原生插件能正常工作。
  const isDeepSeekRelated = !isWorkingRoute && (
    displayName.includes('DeepSeek') ||
    baseURL.includes('deepseek.com') ||
    targetChannelId === COPIS_WORKING_DEEPSEEK_CHANNEL_ID
  )
  if (isDeepSeekRelated) {
    if (apiKey) {
      env['DEEPSEEK_API_KEY'] = apiKey
      credentialsRefs['DEEPSEEK_API_KEY'] = apiKey
    }
    if (baseURL) {
      env['DEEPSEEK_BASE_URL'] = baseURL
    }
  }

  return {
    providerRoute: isWorkingRoute
      ? (isCopisWorkingProviderRoute(targetChannelId) ? targetChannelId : COPIS_WORKING_DEEPSEEK_CHANNEL_ID)
      : COPIS_DSH_PROVIDER_ROUTE,
    displayName,
    defaultModelId,
    protocol,
    baseURL,
    apiKey,
    apiKeyEnv: isWorkingRoute ? COPIS_DSH_WORKING_CAPABILITY_ENV : COPIS_DSH_API_KEY_ENV,
    models,
    env,
    credentialsRefs,
    ...(providerConfigs.length > 0 ? { providerConfigs } : {}),
  }
}

function isCopisWorkingProviderRoute(channelId: string | undefined): channelId is typeof COPIS_WORKING_CHANNEL_ID | typeof COPIS_WORKING_DEEPSEEK_CHANNEL_ID | typeof COPIS_WORKING_ZHIPU_CHANNEL_ID {
  return channelId === COPIS_WORKING_CHANNEL_ID
    || channelId === COPIS_WORKING_DEEPSEEK_CHANNEL_ID
    || channelId === COPIS_WORKING_ZHIPU_CHANNEL_ID
}

/** 只记录上次同步托管的模型 ID，以区分修改/删除与 DSH 原生附加模型；不保存凭据。 */
function readDshManagedModels(path: string): Record<string, string[]> {
  if (!existsSync(path)) return {}
  const state = JSON.parse(readFileSync(path, 'utf8'))
  if (state?.version !== 1 || !state.models || typeof state.models !== 'object' || Array.isArray(state.models)
    || !Object.values(state.models).every((ids) => Array.isArray(ids) && ids.every((id) => typeof id === 'string'))) {
    throw new Error('DSH 模型同步记录无效，已停止同步以保护原生配置')
  }
  return state.models
}

function mergeDshProviderModels(
  provider: DshWorkingProviderConfig,
  previous: Record<string, any>,
  managedIds: string[],
  legacy: Record<string, any>,
): Record<string, any>[] {
  const currentIds = new Set(provider.models.map((model) => model.id))
  const previousManaged = new Set(managedIds)
  const models = new Map<string, Record<string, any>>((previous.models ?? [])
    .filter((model: { id: string }) => !previousManaged.has(model.id) || currentIds.has(model.id))
    .map((model: { id: string }) => [model.id, model]))
  for (const model of provider.models) {
    const stored = models.get(model.id)
    const input = model.input ?? stored?.input ?? legacy.models?.find((entry: { id: string }) => entry.id === model.id)?.input
    models.set(model.id, {
      ...stored,
      id: model.id,
      name: model.name,
      input: input?.length ? [...input] : ['text', 'image'],
      ...(isWorkingCustomModelChannelId(provider.providerRoute) && provider.reasoning !== undefined
        ? { reasoningEfforts: provider.reasoning === 'off' ? false : { [provider.reasoning]: provider.reasoning } }
        : {}),
    })
  }
  return [...models.values()]
}

/**
 * 将解析出的统一模型配置写入 DSH 的配置文件（settings.yaml、.credentials.yaml 与 cordis.patch.yml）
 */
export function applyDshModelConfig(
  config: DshUnifiedModelConfig,
  dshHomeDir = getDshHomeDir(),
  profileName = 'copis',
): void {
  if (!existsSync(dshHomeDir)) {
    mkdirSync(dshHomeDir, { recursive: true })
  }

  // 先读取官方 Profile，避免 legacy settings 导入后丢失模型级能力覆盖。
  const profileDir = join(dshHomeDir, 'profiles', profileName)
  if (!existsSync(profileDir)) {
    mkdirSync(profileDir, { recursive: true })
  }

  const patchFile = join(profileDir, 'cordis.patch.yml')
  let patchItems: any[] = []
  if (existsSync(patchFile)) {
    const parsed = parseDocument(readFileSync(patchFile, 'utf-8'))
    const items = parsed.toJS()
    if (parsed.errors.length || !Array.isArray(items)) {
      throw new Error('DSH 原生 Profile 格式无效，已停止同步以保护模型配置')
    }
    patchItems = items
  }
  const syncStatePath = join(profileDir, 'copis-model-sync.json')
  const previouslyManaged = readDshManagedModels(syncStatePath)

  // 1. 写入 $DSH_HOME/settings.yaml
  const settingsPath = join(dshHomeDir, 'settings.yaml')
  let settingsDoc: Document
  if (existsSync(settingsPath)) {
    try {
      settingsDoc = parseDocument(readFileSync(settingsPath, 'utf-8'))
      // yaml.parseDocument 对重复键只记录 errors，不会主动抛异常；必须丢弃非法 AST，
      // 否则后续 setIn 仍会保留重复键，并在 toString 时再次失败。
      if (settingsDoc.errors.length > 0) {
        settingsDoc = new Document({})
      }
    } catch {
      settingsDoc = new Document({})
    }
  } else {
    settingsDoc = new Document({})
  }

  // 配置当前默认模型
  settingsDoc.set('agent-default-model', {
    provider: config.providerRoute,
    model: config.defaultModelId,
  })

  const legacyLlmConfig = settingsDoc.toJS()?.['llm-pi-ai'] ?? {}
  const llmEntry = patchItems.find((item) => item?.id === 'llm-pi-ai')
  const profileLlmConfig = llmEntry?.config ?? {}
  const oldProviders = legacyLlmConfig.providers ?? {}
  const existingProviders = profileLlmConfig.providers ?? oldProviders
  const providers = { ...existingProviders }

  // copis-custom-* 是 Copis 托管路由：删除或撤销密钥后必须清除整个路由。
  const activeCustomRoutes = new Set((config.providerConfigs ?? [])
    .filter((provider) => isWorkingCustomModelChannelId(provider.providerRoute)).map((provider) => provider.providerRoute))
  if (isWorkingCustomModelChannelId(config.providerRoute)) activeCustomRoutes.add(config.providerRoute)
  for (const route of Object.keys(providers)) {
    if (isWorkingCustomModelChannelId(route) && !activeCustomRoutes.has(route)) delete providers[route]
  }
  // 保持既有旧版 Working 路由迁移规则。
  if (isCopisWorkingProviderRoute(config.providerRoute)) {
    delete providers[COPIS_DSH_PROVIDER_ROUTE]
    delete providers.deepseek
  }
  const managedModels: Record<string, string[]> = {}
  for (const provider of [
    ...(config.providerConfigs ?? []).filter((provider) => !isWorkingCustomModelChannelId(provider.providerRoute)),
    ...((config.providerConfigs ?? []).some((provider) => provider.providerRoute === config.providerRoute) ? [] : [{
      providerRoute: config.providerRoute,
      displayName: config.displayName,
      apiKeyEnv: config.apiKeyEnv,
      protocol: config.protocol,
      baseURL: config.baseURL,
      models: config.models,
      env: config.env,
      credentialsRefs: config.credentialsRefs,
      ...(config.providerRoute === COPIS_WORKING_DEEPSEEK_CHANNEL_ID
        ? { defaultContextWindow: COPIS_DSH_DEEPSEEK_DEFAULT_CONTEXT_WINDOW }
        : {}),
    }]),
    ...(config.providerConfigs ?? []).filter((provider) => isWorkingCustomModelChannelId(provider.providerRoute)),
  ]) {
    const previous = existingProviders[provider.providerRoute] ?? {}
    providers[provider.providerRoute] = {
      ...previous,
      displayName: provider.displayName,
      ...(provider.apiKeyEnv ? { apiKeyEnv: provider.apiKeyEnv } : {}),
      api: provider.protocol,
      baseURL: provider.baseURL,
      ...('reasoning' in provider && provider.reasoning !== undefined ? { reasoning: provider.reasoning } : {}),
      models: mergeDshProviderModels(provider, previous, previouslyManaged[provider.providerRoute] ?? [], oldProviders[provider.providerRoute] ?? {}),
      ...(provider.defaultContextWindow !== undefined ? { defaultContextWindow: provider.defaultContextWindow } : {}),
    }
    managedModels[provider.providerRoute] = provider.models.map((model) => model.id)
  }
  const llmConfig = { ...legacyLlmConfig, ...profileLlmConfig, providers }
  settingsDoc.set('llm-pi-ai', llmConfig)

  const copisDefaults = resolveDshCopisDefaults()
  settingsDoc.set('copis-defaults', copisDefaults)

  writeFileSync(settingsPath, settingsDoc.toString(), 'utf-8')

  // 2. 写入 $DSH_HOME/.credentials.yaml
  const credentialsPath = join(dshHomeDir, '.credentials.yaml')
  let credDoc: Document
  if (existsSync(credentialsPath)) {
    try {
      credDoc = parseDocument(readFileSync(credentialsPath, 'utf-8'))
    } catch {
      credDoc = new Document({ version: 1 })
    }
  } else {
    credDoc = new Document({ version: 1 })
  }

  if (credDoc.get('version') !== 1) {
    credDoc.set('version', 1)
  }

  const oldRefs = credDoc.toJS()?.refs ?? {}
  for (const key of Object.keys(oldRefs)) {
    if (key.startsWith(CUSTOM_KEY_PREFIX)) credDoc.deleteIn(['refs', key])
  }
  const refs = Object.assign({}, config.credentialsRefs, ...(config.providerConfigs ?? []).map((provider) => provider.credentialsRefs))
  for (const [key, val] of Object.entries(refs)) {
    credDoc.setIn(['refs', key], val)
  }

  try {
    writeFileSync(credentialsPath, credDoc.toString(), { encoding: 'utf-8', mode: 0o600 })
  } catch {
    // 权限受限时退回常规写入
    writeFileSync(credentialsPath, credDoc.toString(), 'utf-8')
  }

  // 3. 写入 $DSH_HOME/profiles/<profile>/cordis.patch.yml
  // 确保 agent-presets default: cordis 保持生效
  const presetsIdx = patchItems.findIndex((item) => item?.id === 'agent-presets')
  if (presetsIdx !== -1) {
    patchItems[presetsIdx] = { id: 'agent-presets', config: { default: 'cordis' } }
  } else {
    patchItems.unshift({ id: 'agent-presets', config: { default: 'cordis' } })
  }

  // 确保 agent-default-model 指向当前默认 provider
  const modelIdx = patchItems.findIndex((item) => item?.id === 'agent-default-model')
  const modelEntry = {
    id: 'agent-default-model',
    config: {
      provider: config.providerRoute,
      model: config.defaultModelId,
    },
  }
  if (modelIdx !== -1) {
    patchItems[modelIdx] = modelEntry
  } else {
    patchItems.push(modelEntry)
  }

  const defaultsIdx = patchItems.findIndex((item) => item?.id === 'copis-defaults')
  const defaultsEntry = {
    id: 'copis-defaults',
    config: copisDefaults,
  }
  if (defaultsIdx !== -1) {
    patchItems[defaultsIdx] = defaultsEntry
  } else {
    patchItems.push(defaultsEntry)
  }

  // Copis 仅通过 llm-pi-ai 的本机 Working 路由发起模型请求；禁用 DSH Base
  // 默认挂载的 llm-deepseek，移除 Composer 中的 deepseek-official 官方分类。
  const deepSeekAdapterIdx = patchItems.findIndex((item) => item?.id === 'llm-deepseek')
  const disabledDeepSeekAdapterEntry = { id: 'llm-deepseek', disabled: true }
  if (deepSeekAdapterIdx !== -1) {
    patchItems[deepSeekAdapterIdx] = disabledDeepSeekAdapterEntry
  } else {
    patchItems.push(disabledDeepSeekAdapterEntry)
  }

  // 直接更新官方持久化 Profile；legacy 启动导入与热重载使用完全相同的目录。
  const llmIndex = patchItems.findIndex((item) => item?.id === 'llm-pi-ai')
  const nextLlmEntry = { ...llmEntry, id: 'llm-pi-ai', config: llmConfig }
  if (llmIndex === -1) patchItems.push(nextLlmEntry)
  else patchItems[llmIndex] = nextLlmEntry
  writeFileSync(patchFile, new Document(patchItems).toString(), 'utf-8')
  writeJsonFileAtomic(syncStatePath, { version: 1, models: managedModels }, true, 0o600)
}

/**
 * 完整执行 Copis 模型配置同步到 DSH。
 */
export async function syncCopisModelConfigToDsh(options: {
  dshRootDir?: string
  profile?: string
  channelId?: string
  modelId?: string
} = {}): Promise<DshUnifiedModelConfig> {
  const dshHomeDir = options.dshRootDir || getDshHomeDir()
  const profile = options.profile || 'copis'
  const config = await resolveDshUnifiedModelConfig({
    channelId: options.channelId,
    modelId: options.modelId,
    dshHomeDir,
  })
  applyDshModelConfig(config, dshHomeDir, profile)
  return config
}
