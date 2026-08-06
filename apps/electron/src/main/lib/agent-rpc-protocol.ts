import type {
  AgentStreamPayload,
  AgentThinkingLevel,
  CopisPermissionMode,
  MemoryPolicy,
  CodexOAuthCredentials,
  ProviderType,
  SDKMessage,
  XaiOAuthCredentials,
} from '@copis/shared'
import type { AgentRuntimeEnv } from './agent-runtime-env'

export interface PiWorkerQueryConfig {
  sessionId: string
  prompt: string
  model?: string
  cwd?: string
  apiKey: string
  baseUrl?: string
  provider: ProviderType
  channelId?: string
  channelName?: string
  maxTurns?: number
  permissionMode: CopisPermissionMode
  systemPrompt: string
  resumeSessionId?: string
  piAgentDir: string
  piSessionDir: string
  thinkingLevel?: AgentThinkingLevel
  maxBudgetUsd?: number
  additionalDirectories?: string[]
  additionalSkillPaths?: string[]
  /** 当前用户输入显式引用的 Skill slug。 */
  skillMentions?: string[]
  workspaceSlug?: string
  memoryPolicy?: MemoryPolicy
  proxyUrl?: string
  transport?: 'sse' | 'websocket' | 'websocket-cached'
  httpIdleTimeoutMs?: number
  websocketConnectTimeoutMs?: number
  runtimeEnv?: AgentRuntimeEnv
  compactRequest?: boolean
  codexFastMode?: boolean
  codexOAuthCredentials?: CodexOAuthCredentials
  xaiOAuthCredentials?: XaiOAuthCredentials
  openAIThinkingLevel?: AgentThinkingLevel
  retryRunStartedAt?: number
  /**
   * 仅由 Electron 传给 Rust 的会话文件授权策略。Rust 启动 Worker 前会移除它，
   * Pi 只能使用固定的文件操作端点，不能读取或修改策略。
   */
  fileAccessPolicy?: PiWorkerFileAccessPolicy
  useRustFileApi?: boolean
}

export interface PiWorkerFileAccessPolicy {
  readRoots: string[]
  readFiles: string[]
  writeRoots: string[]
  permissionMode: CopisPermissionMode
}

export interface PiWorkerRunConfig {
  sessionId: string
  query: PiWorkerQueryConfig
}

export interface PiWorkerQueueConfig {
  sessionId: string
  userMessage: string
  uuid: string
  interrupt?: boolean
  skillMentions?: string[]
}

export type AgentRpcWorkerCommand =
  | { type: 'run'; requestId: string; config: PiWorkerRunConfig }
  | { type: 'stop'; sessionId: string }
  | { type: 'set_permission_mode'; sessionId: string; mode: CopisPermissionMode }
  | { type: 'queue'; requestId: string; config: PiWorkerQueueConfig }

export type AgentRpcWorkerFrame =
  | { type: 'event'; sessionId: string; payload: AgentStreamPayload }
  | {
    type: 'meta'
    sessionId: string
    sdkSessionId?: string
    piSessionFile?: string
    piEntryBindings?: Record<string, string>
  }
  | { type: 'error'; sessionId: string; error: string }
  | {
    type: 'complete'
    sessionId: string
    sdkMessages?: SDKMessage[]
    stoppedByUser: boolean
    startedAt?: number
    resultSubtype?: string
    resultErrors?: string[]
  }
  | { type: 'credential'; sessionId: string; channelId: string; provider: 'openai-codex' | 'xai'; credentials: CodexOAuthCredentials | XaiOAuthCredentials }
  | { type: 'fatal'; sessionId?: string; error: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isWorkerFrameType(value: unknown): value is AgentRpcWorkerFrame['type'] {
  return value === 'event'
    || value === 'meta'
    || value === 'error'
    || value === 'complete'
    || value === 'credential'
    || value === 'fatal'
}

export function serializeWorkerCommand(command: AgentRpcWorkerCommand): string {
  return `${JSON.stringify(command)}\n`
}

export function parseWorkerCommand(line: string): AgentRpcWorkerCommand | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(line) as unknown
  } catch {
    return undefined
  }
  if (!isRecord(parsed) || (parsed.type !== 'run' && parsed.type !== 'stop' && parsed.type !== 'set_permission_mode' && parsed.type !== 'queue')) return undefined
  if (parsed.type === 'stop') {
    return typeof parsed.sessionId === 'string' && parsed.sessionId.length > 0
      ? { type: 'stop', sessionId: parsed.sessionId }
      : undefined
  }
  if (parsed.type === 'set_permission_mode') {
    return typeof parsed.sessionId === 'string'
      && parsed.sessionId.length > 0
      && (parsed.mode === 'bypassPermissions' || parsed.mode === 'plan')
      ? { type: 'set_permission_mode', sessionId: parsed.sessionId, mode: parsed.mode }
      : undefined
  }
  if (typeof parsed.requestId !== 'string' || parsed.requestId.length === 0 || !isRecord(parsed.config)) return undefined
  if (parsed.type === 'queue') {
    const config = parsed.config
    if (typeof config.sessionId !== 'string' || config.sessionId.length === 0) return undefined
    if (typeof config.userMessage !== 'string' || config.userMessage.length === 0) return undefined
    if (typeof config.uuid !== 'string' || config.uuid.length === 0) return undefined
    if (config.interrupt !== undefined && typeof config.interrupt !== 'boolean') return undefined
    if (config.skillMentions !== undefined && (
      !Array.isArray(config.skillMentions)
      || !config.skillMentions.every((value) => typeof value === 'string' && value.trim().length > 0)
    )) return undefined
  }
  return parsed as unknown as AgentRpcWorkerCommand
}

export function parseWorkerFrame(line: string): AgentRpcWorkerFrame | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(line) as unknown
  } catch {
    return undefined
  }
  if (!isRecord(parsed) || !isWorkerFrameType(parsed.type)) return undefined
  return parsed as unknown as AgentRpcWorkerFrame
}

export function parseAgentSseData(chunk: string): AgentRpcWorkerFrame | undefined {
  const dataLines = chunk
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).trimStart())
  if (dataLines.length === 0) return undefined
  return parseWorkerFrame(dataLines.join('\n'))
}
