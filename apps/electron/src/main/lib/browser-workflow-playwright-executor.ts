import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { dirname } from 'node:path'

export type BrowserWorkflowPlaywrightScriptEvent =
  | { type: 'ready'; targetId: string }
  | { type: 'step_started'; stepId: string }
  | { type: 'step_completed'; stepId: string }
  | { type: 'fallback_used'; stepId: string }
  | { type: 'waiting_user'; stepId: string; message: string }
  | { type: 'paused'; stepId: string; message: string }
  | { type: 'resumed'; stepId: string }
  | { type: 'artifacts'; artifacts: string[] }
  | { type: 'completed' }
  | { type: 'error'; message: string }

export interface BrowserWorkflowPlaywrightScriptInput {
  nodeExecutable: string
  scriptPath: string
  cdpEndpoint: string
  targetId: string
  playwrightCoreEntrypoint: string
  artifactDirectory: string
  variables: Record<string, string | number | boolean>
  nodeEnvironment?: NodeJS.ProcessEnv
  signal: AbortSignal
  onEvent: (event: BrowserWorkflowPlaywrightScriptEvent) => void
}

export interface BrowserWorkflowPlaywrightScriptSession {
  promise: Promise<void>
  send(command: 'continue_manual' | 'resume_cdp'): void
  cancel(): void
}

function sanitizeStderr(value: string, input: BrowserWorkflowPlaywrightScriptInput): string {
  const forbidden = [
    input.cdpEndpoint,
    input.playwrightCoreEntrypoint,
    input.artifactDirectory,
    JSON.stringify(input.variables),
    ...Object.values(input.variables).map((value) => String(value)),
  ].filter(Boolean)
  let sanitized = value
  for (const item of forbidden) sanitized = sanitized.split(item).join('[已隐藏]')
  return sanitized
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-3)
    .join('\n')
}

function sanitizeRuntimeMessage(value: string, input: BrowserWorkflowPlaywrightScriptInput): string {
  let sanitized = value
  const forbidden = [
    input.cdpEndpoint,
    input.playwrightCoreEntrypoint,
    input.artifactDirectory,
    JSON.stringify(input.variables),
    ...Object.values(input.variables).map((item) => String(item)),
  ].filter(Boolean)
  for (const item of forbidden) sanitized = sanitized.split(item).join('[已隐藏]')
  return sanitized
}

function parseEvent(line: string): BrowserWorkflowPlaywrightScriptEvent | undefined {
  try {
    const value: unknown = JSON.parse(line)
    if (!value || typeof value !== 'object' || Array.isArray(value) || typeof (value as { type?: unknown }).type !== 'string') return undefined
    return value as BrowserWorkflowPlaywrightScriptEvent
  } catch {
    return undefined
  }
}

/** 启动主进程生成的固定脚本；脚本路径和运行变量均不来自用户可执行命令。 */
export function startBrowserWorkflowPlaywrightScript(
  input: BrowserWorkflowPlaywrightScriptInput,
): BrowserWorkflowPlaywrightScriptSession {
  let child: ChildProcessWithoutNullStreams
  try {
    child = spawn(input.nodeExecutable, [input.scriptPath], {
      cwd: dirname(input.scriptPath),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: {
        ...process.env,
        ...input.nodeEnvironment,
        COPIS_PLAYWRIGHT_CDP_ENDPOINT: input.cdpEndpoint,
        COPIS_PLAYWRIGHT_TARGET_ID: input.targetId,
        COPIS_PLAYWRIGHT_CORE_ENTRY: input.playwrightCoreEntrypoint,
        COPIS_PLAYWRIGHT_ARTIFACT_DIR: input.artifactDirectory,
        COPIS_PLAYWRIGHT_VARIABLES: JSON.stringify(input.variables),
      },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      promise: Promise.reject(new Error(`启动 Playwright Workflow 运行时失败: ${message}`)),
      send: () => undefined,
      cancel: () => undefined,
    }
  }

  let settled = false
  let outputBuffer = ''
  let stderrBuffer = ''
  let childReportedError: Error | undefined
  let resolvePromise: () => void = () => undefined
  let rejectPromise: (error: Error) => void = () => undefined
  const promise = new Promise<void>((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })
  const cleanup = (): void => {
    input.signal.removeEventListener('abort', abort)
  }
  const finish = (error?: Error): void => {
    if (settled) return
    settled = true
    cleanup()
    if (error) rejectPromise(error)
    else resolvePromise()
  }
  const consume = (chunk: string): void => {
    outputBuffer += chunk
    let newlineIndex = outputBuffer.indexOf('\n')
    while (newlineIndex >= 0) {
      const line = outputBuffer.slice(0, newlineIndex).trim()
      outputBuffer = outputBuffer.slice(newlineIndex + 1)
      newlineIndex = outputBuffer.indexOf('\n')
      if (!line) continue
      const event = parseEvent(line)
      if (!event) continue
      const safeEvent = event.type === 'error'
        ? { ...event, message: sanitizeRuntimeMessage(event.message, input) }
        : event
      if (safeEvent.type === 'error') childReportedError = new Error(safeEvent.message)
      input.onEvent(safeEvent)
    }
  }
  const abort = (): void => {
    if (!child.killed) child.kill()
    finish(new Error('Browser Workflow 已取消'))
  }

  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', consume)
  child.stderr.on('data', (chunk: string) => {
    stderrBuffer += chunk
    if (stderrBuffer.length > 16_384) stderrBuffer = stderrBuffer.slice(-16_384)
  })
  child.on('error', (error) => finish(new Error(`Playwright Workflow 运行时异常: ${error.message}`)))
  child.on('close', (code) => {
    if (settled) return
    if (outputBuffer.trim()) consume('\n')
    if (code === 0) finish()
    else {
      const diagnostic = sanitizeStderr(stderrBuffer, input)
      const suffix = diagnostic ? `: ${diagnostic}` : ''
      finish(childReportedError ?? new Error(`Playwright Workflow 脚本退出（状态码 ${code ?? 'unknown'}）${suffix}`))
    }
  })
  input.signal.addEventListener('abort', abort, { once: true })

  const send = (command: 'continue_manual' | 'resume_cdp'): void => {
    if (settled || child.stdin.destroyed) return
    try {
      child.stdin.write(`${JSON.stringify({ type: command })}\n`)
    } catch {
      // 子进程退出竞态由 close/error 事件统一处理。
    }
  }
  const cancel = (): void => {
    if (!child.killed) child.kill()
    finish(new Error('Browser Workflow 已取消'))
  }
  return { promise, send, cancel }
}
