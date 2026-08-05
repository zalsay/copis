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
}

export interface PiWorkerRunConfig {
  sessionId: string
  query: PiWorkerQueryConfig
}

export type AgentRpcWorkerCommand =
  | { type: 'run'; requestId: string; config: PiWorkerRunConfig }
  | { type: 'stop'; sessionId: string }

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
  if (!isRecord(parsed) || (parsed.type !== 'run' && parsed.type !== 'stop')) return undefined
  if (parsed.type === 'stop') {
    return typeof parsed.sessionId === 'string' && parsed.sessionId.length > 0
      ? { type: 'stop', sessionId: parsed.sessionId }
      : undefined
  }
  if (typeof parsed.requestId !== 'string' || !isRecord(parsed.config)) return undefined
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
