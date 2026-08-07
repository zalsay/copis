import { createInterface } from 'node:readline'
import type { AgentStreamPayload, CopisPermissionMode, SDKMessage } from '@copis/shared'
import type { PiAgentQueryOptions, PiAgentAdapter } from './lib/adapters/pi-agent-adapter'
import {
  parseWorkerCommand,
  parsePiWorkerBrowserCapability,
  type AgentRpcWorkerCommand,
  type AgentRpcWorkerFrame,
  type PiWorkerQueueConfig,
  type PiWorkerRunConfig,
} from './lib/agent-rpc-protocol'
import { attachAgentRunDuration } from './lib/agent-rpc-duration'
import { createMemoryMaintenanceRunner, MemoryMaintenanceService } from './lib/adapters/pi-memory-maintenance'
import { receiveActiveWorkerQueue } from './lib/pi-worker-queue-receiver'

interface ActiveWorkerRun {
  sessionId: string
  adapter: PiAgentAdapter
  stopped: boolean
  acceptedQueueUuids: Set<string>
}

let activeRun: ActiveWorkerRun | undefined
let outputChain = Promise.resolve()

function formatLogValue(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function redirectLogsToStderr(): void {
  const writeLog = (...values: unknown[]): void => {
    process.stderr.write(`${values.map(formatLogValue).join(' ')}\n`)
  }
  console.log = writeLog
  console.info = writeLog
  console.warn = writeLog
  console.debug = writeLog
}

function writeFrame(frame: AgentRpcWorkerFrame): Promise<void> {
  const line = `${JSON.stringify(frame)}\n`
  let resolveWrite!: () => void
  const next = new Promise<void>((resolve) => {
    resolveWrite = resolve
  })
  outputChain = outputChain.then(() => new Promise<void>((resolve) => {
    process.stdout.write(line, () => {
      resolveWrite()
      resolve()
    })
  }))
  return next
}

async function flushOutput(): Promise<void> {
  await outputChain
}

function emitEvent(sessionId: string, payload: AgentStreamPayload): void {
  void writeFrame({ type: 'event', sessionId, payload })
}

function emitCopisEvent(sessionId: string, event: Extract<AgentStreamPayload, { kind: 'copis_event' }>['event']): void {
  emitEvent(sessionId, { kind: 'copis_event', event })
}

function extractResultDetails(message: SDKMessage): { subtype?: string; errors?: string[] } {
  if (message.type !== 'result') return {}
  const record = message as unknown as Record<string, unknown>
  const errors = Array.isArray(record.errors)
    ? record.errors.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    : undefined
  return {
    ...(typeof record.subtype === 'string' ? { subtype: record.subtype } : {}),
    ...(errors && errors.length > 0 ? { errors } : {}),
  }
}

async function runWorker(config: PiWorkerRunConfig): Promise<void> {
  if (activeRun) {
    await writeFrame({ type: 'fatal', sessionId: config.sessionId, error: 'Pi worker 已在执行其他会话' })
    return
  }

  // 权限策略只能由 Rust 保存和校验。策略字段若能到达 Pi Worker，说明 Rust
  // 没有完成“取走策略再启动”的边界，必须拒绝运行，不能降级执行。
  if (config.query.useRustFileApi !== true) {
    await writeFrame({ type: 'fatal', sessionId: config.sessionId, error: 'Pi Worker 未启用 Rust 文件权限服务' })
    await flushOutput()
    return
  }
  if (Object.prototype.hasOwnProperty.call(config.query, 'fileAccessPolicy')) {
    await writeFrame({ type: 'fatal', sessionId: config.sessionId, error: '文件权限策略不允许传入 Pi Worker' })
    await flushOutput()
    return
  }
  const browserPageControl = config.query.browserPageControl === undefined
    ? undefined
    : parsePiWorkerBrowserCapability(config.query.browserPageControl)
  if (config.query.browserPageControl !== undefined && !browserPageControl) {
    await writeFrame({ type: 'fatal', sessionId: config.sessionId, error: 'AI浏览器 capability 不正确' })
    await flushOutput()
    return
  }

  const runStartedAt = config.query.retryRunStartedAt ?? Date.now()
  const { PiAgentAdapter } = await import('./lib/adapters/pi-agent-adapter')
  const adapter = new PiAgentAdapter()
  const memoryMaintenance = new MemoryMaintenanceService()
  const run: ActiveWorkerRun = {
    sessionId: config.sessionId,
    adapter,
    stopped: false,
    acceptedQueueUuids: new Set(),
  }
  activeRun = run

  let resultSubtype: string | undefined
  let resultErrors: string[] | undefined

  const query: PiAgentQueryOptions = {
    ...config.query,
    ...(browserPageControl ? { browserPageControl } : {}),
    agentRuntime: 'pi',
    canUseTool: async (_toolName, input) => ({ behavior: 'allow', updatedInput: input }),
    onSessionId: (sdkSessionId, sessionFile) => {
      void writeFrame({
        type: 'meta',
        sessionId: config.sessionId,
        sdkSessionId,
        ...(sessionFile ? { piSessionFile: sessionFile } : {}),
      })
    },
    onPiEntryBindings: (bindings) => {
      void writeFrame({ type: 'meta', sessionId: config.sessionId, piEntryBindings: bindings })
    },
    onModelResolved: (model) => {
      emitCopisEvent(config.sessionId, { type: 'model_resolved', model })
    },
    onContextWindow: (contextWindow) => {
      emitCopisEvent(config.sessionId, { type: 'context_window', contextWindow })
    },
    onRetry: (retry) => {
      emitCopisEvent(config.sessionId, { type: 'retry', ...retry })
    },
    ...(config.query.workspaceSlug && config.query.memoryPolicy === 'writable'
      ? {
        memoryMaintenanceRunner: createMemoryMaintenanceRunner({
          service: memoryMaintenance,
          workspaceSlug: config.query.workspaceSlug,
          policy: config.query.memoryPolicy,
          provider: config.query.provider,
          baseUrl: config.query.baseUrl,
          apiKey: config.query.apiKey,
          modelId: config.query.model ?? 'default',
          proxyUrl: config.query.proxyUrl,
          force: true,
        }),
      }
      : {}),
    ...(config.query.codexOAuthCredentials
      ? {
        onCodexOAuthCredentialsRefreshed: (credentials) => {
          void writeFrame({ type: 'credential', sessionId: config.sessionId, channelId: config.query.channelId ?? '', provider: 'openai-codex', credentials })
        },
      }
      : {}),
    ...(config.query.xaiOAuthCredentials
      ? {
        onXaiOAuthCredentialsRefreshed: (credentials) => {
          void writeFrame({ type: 'credential', sessionId: config.sessionId, channelId: config.query.channelId ?? '', provider: 'xai', credentials })
        },
      }
      : {}),
  }

  try {
    for await (const message of adapter.query(query)) {
      const messageWithDuration = attachAgentRunDuration(message, runStartedAt, Date.now())
      const details = extractResultDetails(messageWithDuration)
      if (details.subtype) resultSubtype = details.subtype
      if (details.errors) resultErrors = details.errors
      emitEvent(config.sessionId, { kind: 'sdk_message', message: messageWithDuration })
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    if (!run.stopped) {
      await writeFrame({ type: 'error', sessionId: config.sessionId, error: message })
    }
    if (!resultSubtype) resultSubtype = run.stopped ? 'aborted' : 'error_during_execution'
    if (!resultErrors) resultErrors = [message]
  } finally {
    await writeFrame({
      type: 'complete',
      sessionId: config.sessionId,
      stoppedByUser: run.stopped,
      startedAt: runStartedAt,
      ...(resultSubtype ? { resultSubtype } : {}),
      ...(resultErrors && resultErrors.length > 0 ? { resultErrors } : {}),
    })
    await flushOutput()
    adapter.dispose()
    if (activeRun === run) activeRun = undefined
    process.exit(0)
  }
}

function handleCommand(command: AgentRpcWorkerCommand): void {
  if (command.type === 'stop') {
    if (activeRun?.sessionId === command.sessionId) {
      activeRun.stopped = true
      activeRun.adapter.abort(command.sessionId)
    }
    return
  }
  if (command.type === 'queue') {
    void queueWorker(command.config)
    return
  }
  if (command.type === 'set_permission_mode') {
    void setWorkerPermissionMode(command.sessionId, command.mode)
    return
  }
  void runWorker(command.config)
}

async function setWorkerPermissionMode(sessionId: string, mode: CopisPermissionMode): Promise<void> {
  const run = activeRun
  if (!run || run.sessionId !== sessionId) {
    await writeFrame({ type: 'error', sessionId, error: '当前会话没有正在运行的 Pi Worker' })
    return
  }

  try {
    // Pi 不接收文件策略；该调用仅保持 SDK 非文件工具状态兼容，实际文件权限由 Rust 执行。
    await run.adapter.setPermissionMode(sessionId, mode)
    emitCopisEvent(sessionId, {
      type: 'plan_mode_changed',
      sessionId,
      active: mode === 'plan',
      source: 'permission',
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    await writeFrame({ type: 'error', sessionId, error: message })
  }
}

async function queueWorker(config: PiWorkerQueueConfig): Promise<void> {
  const run = activeRun
  if (!run || run.sessionId !== config.sessionId) {
    await writeFrame({ type: 'error', sessionId: config.sessionId, error: '当前会话没有正在运行的 Pi Worker' })
    return
  }

  try {
    const accepted = await receiveActiveWorkerQueue(run, config.uuid, async () => {
      await run.adapter.sendQueuedMessage(
        config.sessionId,
        {
          type: 'user',
          message: { role: 'user', content: config.userMessage },
          parent_tool_use_id: null,
          priority: 'now',
          uuid: config.uuid,
          session_id: config.sessionId,
        },
        {
          ...(config.interrupt ? { interrupt: true } : {}),
          ...(config.skillMentions && config.skillMentions.length > 0 ? { skillMentions: config.skillMentions } : {}),
        },
      )
    })
    if (!accepted) {
      console.info(`[Pi Worker] 忽略重复 queue UUID: sessionId=${config.sessionId}, uuid=${config.uuid}`)
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    await writeFrame({ type: 'error', sessionId: config.sessionId, error: message })
  }
}

async function main(): Promise<void> {
  redirectLogsToStderr()
  const lineReader = createInterface({ input: process.stdin, terminal: false })
  lineReader.on('line', (line) => {
    const command = parseWorkerCommand(line.trim())
    if (!command) {
      if (line.trim()) process.stderr.write('[Pi Worker] 收到无法解析的命令\n')
      return
    }
    handleCommand(command)
  })
  lineReader.on('close', () => {
    if (activeRun) {
      activeRun.stopped = true
      activeRun.adapter.abort(activeRun.sessionId)
    } else {
      process.exit(0)
    }
  })
}

void main()
