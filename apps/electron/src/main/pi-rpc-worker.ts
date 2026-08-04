import { createInterface } from 'node:readline'
import type { AgentStreamPayload, SDKMessage } from '@copis/shared'
import type { PiAgentQueryOptions, PiAgentAdapter } from './lib/adapters/pi-agent-adapter'
import {
  parseWorkerCommand,
  type AgentRpcWorkerCommand,
  type AgentRpcWorkerFrame,
  type PiWorkerRunConfig,
} from './lib/agent-rpc-protocol'
import { attachAgentRunDuration } from './lib/agent-rpc-duration'

interface ActiveWorkerRun {
  sessionId: string
  adapter: PiAgentAdapter
  stopped: boolean
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

  const runStartedAt = config.query.retryRunStartedAt ?? Date.now()
  const { PiAgentAdapter } = await import('./lib/adapters/pi-agent-adapter')
  const adapter = new PiAgentAdapter()
  const run: ActiveWorkerRun = {
    sessionId: config.sessionId,
    adapter,
    stopped: false,
  }
  activeRun = run

  let resultSubtype: string | undefined
  let resultErrors: string[] | undefined

  const query: PiAgentQueryOptions = {
    ...config.query,
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
  void runWorker(command.config)
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
