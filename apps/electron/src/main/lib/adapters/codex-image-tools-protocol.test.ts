import { spawn, type ChildProcess } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { createInterface, type Interface as ReadlineInterface } from 'node:readline'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import {
  startCodexImageToolsMcp,
  type CodexImageToolsMcpOptions,
} from './codex-image-tools-mcp'

type JsonRecord = Record<string, unknown>

interface PendingRpc {
  method: string
  resolve: (result: JsonRecord) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

interface NotificationWaiter {
  predicate: (message: JsonRecord) => boolean
  resolve: (message: JsonRecord) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

class CodexAppServerProcess {
  private nextId = 0
  private readonly pending = new Map<number, PendingRpc>()
  private readonly notificationWaiters = new Set<NotificationWaiter>()
  private readonly readline: ReadlineInterface
  private exited = false
  private readonly exitWaiters = new Set<() => void>()

  constructor(private readonly child: ChildProcess) {
    if (!child.stdout || !child.stdin) throw new Error('Codex app-server did not expose stdio pipes')
    this.readline = createInterface({ input: child.stdout })
    this.readline.on('line', line => this.handleLine(line))
    child.stderr?.resume()
    child.once('error', error => {
      const code = 'code' in error ? String(error.code) : 'unknown'
      this.failPending(`Codex app-server process error (${code})`)
    })
    child.once('exit', () => {
      this.exited = true
      this.failPending('Codex app-server process exited before replying')
      for (const resolve of this.exitWaiters) resolve()
      this.exitWaiters.clear()
    })
  }

  rpc(method: string, params: JsonRecord, timeoutMs = 20_000): Promise<JsonRecord> {
    if (this.exited || !this.child.stdin) return Promise.reject(new Error(`Codex app-server is not running (${method})`))
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Codex app-server request timed out (${method})`))
      }, timeoutMs)
      this.pending.set(id, { method, resolve, reject, timer })
      this.child.stdin!.write(`${JSON.stringify({ id, method, params })}\n`, error => {
        if (!error) return
        const request = this.pending.get(id)
        if (!request) return
        clearTimeout(request.timer)
        this.pending.delete(id)
        request.reject(new Error(`Codex app-server request could not be written (${method})`))
      })
    })
  }

  waitForNotification(predicate: (message: JsonRecord) => boolean, timeoutMs = 30_000): Promise<JsonRecord> {
    return new Promise((resolve, reject) => {
      const waiter: NotificationWaiter = {
        predicate,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.notificationWaiters.delete(waiter)
          reject(new Error('Codex app-server notification timed out'))
        }, timeoutMs),
      }
      this.notificationWaiters.add(waiter)
    })
  }

  async stop(): Promise<void> {
    if (!this.exited) {
      this.child.kill('SIGTERM')
      if (!await this.waitForExit(5_000)) {
        this.child.kill('SIGKILL')
        await this.waitForExit(2_000)
      }
    }
    this.readline.close()
  }

  private handleLine(line: string): void {
    let message: JsonRecord
    try {
      const parsed: unknown = JSON.parse(line)
      if (!isRecord(parsed)) return
      message = parsed
    } catch {
      // app-server 日志行不是 JSON-RPC；不把可能敏感的原始内容写入测试输出。
      return
    }

    if (typeof message.id === 'number') {
      const request = this.pending.get(message.id)
      if (!request) return
      this.pending.delete(message.id)
      clearTimeout(request.timer)
      if (isRecord(message.error)) {
        const code = typeof message.error.code === 'string' || typeof message.error.code === 'number'
          ? ` code=${message.error.code}`
          : ''
        const detail = typeof message.error.message === 'string'
          ? message.error.message.replace(/Bearer\s+[^\s"',}]+/gi, 'Bearer [redacted]').slice(0, 240)
          : ''
        request.reject(new Error(`Codex app-server RPC failed (${request.method})${code}${detail ? `: ${detail}` : ''}`))
      } else {
        request.resolve(isRecord(message.result) ? message.result : {})
      }
      return
    }

    for (const waiter of this.notificationWaiters) {
      if (!waiter.predicate(message)) continue
      clearTimeout(waiter.timer)
      this.notificationWaiters.delete(waiter)
      waiter.resolve(message)
      break
    }
  }

  private failPending(message: string): void {
    for (const [id, request] of this.pending) {
      clearTimeout(request.timer)
      this.pending.delete(id)
      request.reject(new Error(`${message} (${request.method})`))
    }
    for (const waiter of this.notificationWaiters) {
      clearTimeout(waiter.timer)
      this.notificationWaiters.delete(waiter)
      waiter.reject(new Error(message))
    }
  }

  private waitForExit(timeoutMs: number): Promise<boolean> {
    if (this.exited) return Promise.resolve(true)
    return new Promise(resolve => {
      let timer: ReturnType<typeof setTimeout>
      const onExit = () => {
        clearTimeout(timer)
        this.exitWaiters.delete(onExit)
        resolve(true)
      }
      timer = setTimeout(() => {
        this.exitWaiters.delete(onExit)
        resolve(this.exited)
      }, timeoutMs)
      this.exitWaiters.add(onExit)
    })
  }
}

function spawnCodexAppServer(binary: string, cwd: string, home: string, codexHome: string, modelUrl: string): CodexAppServerProcess {
  const child = spawn(binary, [
    'app-server',
    '-c', 'model_provider="copis_protocol_test"',
    '-c', 'model_providers.copis_protocol_test.name="copis_protocol_test"',
    '-c', 'model_providers.copis_protocol_test.wire_api="responses"',
    '-c', `model_providers.copis_protocol_test.base_url="${modelUrl}"`,
    '-c', 'model_providers.copis_protocol_test.request_max_retries=0',
    '-c', 'model_providers.copis_protocol_test.stream_max_retries=0',
  ], {
    cwd,
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: home,
      CODEX_HOME: codexHome,
      TMPDIR: home,
      TMP: home,
      TEMP: home,
      NO_COLOR: '1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  return new CodexAppServerProcess(child)
}

async function createLocalFailingModelEndpoint(): Promise<{
  server: Server
  baseUrl: string
  requests: string[]
}> {
  const requests: string[] = []
  const server = createServer((request, response) => {
    requests.push(`${request.method ?? 'GET'} ${request.url ?? '/'}`)
    request.resume()
    response.writeHead(400, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ error: { message: 'Local protocol test endpoint intentionally rejects model requests' } }))
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Local model endpoint did not bind a TCP port')
  return { server, baseUrl: `http://127.0.0.1:${address.port}/v1`, requests }
}

function modelConfig(baseUrl: string, imageMcpConfig: Record<string, unknown>): JsonRecord {
  return {
    model_provider: 'copis_protocol_test',
    model_providers: {
      copis_protocol_test: {
        name: 'copis_protocol_test',
        wire_api: 'responses',
        base_url: baseUrl,
        request_max_retries: 0,
        stream_max_retries: 0,
      },
    },
    mcp_servers: { copis_image: imageMcpConfig },
  }
}

function getThreadId(result: JsonRecord): string {
  const thread = isRecord(result.thread) ? result.thread : undefined
  const threadId = thread?.id ?? result.threadId ?? result.id
  if (typeof threadId !== 'string' || !threadId) throw new Error('Codex app-server response did not contain a thread ID')
  return threadId
}

function collectImageToolNames(value: unknown, names = new Set<string>()): Set<string> {
  const expectedNames = new Set(['generate_image', 'get_image_task', 'list_image_tasks'])
  if (Array.isArray(value)) {
    for (const item of value) collectImageToolNames(item, names)
    return names
  }
  if (!isRecord(value)) return names
  if (typeof value.name === 'string' && expectedNames.has(value.name)) names.add(value.name)
  for (const child of Object.values(value)) collectImageToolNames(child, names)
  return names
}

function resultData(result: JsonRecord): unknown[] {
  return Array.isArray(result.data) ? result.data : []
}

function fetchListTasks(marker: string, calls: string[]): NonNullable<CodexImageToolsMcpOptions['fetchImpl']> {
  return async (input, init) => {
    const url = input instanceof Request
      ? input.url
      : input instanceof URL
        ? input.href
        : String(input)
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
    calls.push(`${method} ${new URL(url).pathname}${new URL(url).search}`)
    if (method !== 'GET' || new URL(url).pathname !== '/api/working/image/tasks') {
      throw new Error('Protocol fixture only permits the non-billable image-task list request')
    }
    return new Response(JSON.stringify({ tasks: [{ protocol_marker: marker }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }
}

async function closeServer(server: Server | undefined): Promise<void> {
  if (!server?.listening) return
  server.closeAllConnections()
  await new Promise<void>(resolve => server.close(() => resolve()))
}

const configuredCodexBinary = process.env.COPIS_TEST_CODEX_BINARY
const protocolTest = configuredCodexBinary ? test : test.skip

protocolTest('Given Codex app-server 可选真实协议运行 When 图片 MCP 热 fork 与冷恢复 Then 工具连接、历史和禁用权限符合配置', async () => {
  const binary = configuredCodexBinary!
  const testRoot = mkdtempSync(join(tmpdir(), 'copis-codex-image-protocol-'))
  const home = join(testRoot, 'home')
  const codexHome = join(testRoot, 'codex-home')
  const cwd = join(testRoot, 'workspace')
  mkdirSync(home, { recursive: true })
  mkdirSync(codexHome, { recursive: true })
  mkdirSync(cwd, { recursive: true })

  const clients: CodexAppServerProcess[] = []
  const listCallsA: string[] = []
  const listCallsB: string[] = []
  const listCallsBCold: string[] = []
  let modelEndpoint: Awaited<ReturnType<typeof createLocalFailingModelEndpoint>> | undefined
  let bridgeA: Awaited<ReturnType<typeof startCodexImageToolsMcp>> | undefined
  let bridgeB: Awaited<ReturnType<typeof startCodexImageToolsMcp>> | undefined
  let bridgeBCold: Awaited<ReturnType<typeof startCodexImageToolsMcp>> | undefined

  try {
    modelEndpoint = await createLocalFailingModelEndpoint()
    bridgeA = await startCodexImageToolsMcp({
      sessionId: 'codex-image-protocol-test',
      cwd,
      baseUrl: 'http://127.0.0.1:1',
      fetchImpl: fetchListTasks('bridge-A', listCallsA),
    })
    bridgeB = await startCodexImageToolsMcp({
      sessionId: 'codex-image-protocol-test',
      cwd,
      baseUrl: 'http://127.0.0.1:1',
      fetchImpl: fetchListTasks('bridge-B', listCallsB),
    })

    const startClient = () => {
      const client = spawnCodexAppServer(binary, cwd, home, codexHome, modelEndpoint!.baseUrl)
      clients.push(client)
      return client
    }
    const client = startClient()
    await client.rpc('initialize', {
      clientInfo: { name: 'copis-codex-image-protocol-test', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    })

    const initialThreadResult = await client.rpc('thread/start', {
      cwd,
      approvalPolicy: 'never',
      sandbox: 'read-only',
      model: 'gpt-5.4',
      modelProvider: 'copis_protocol_test',
      config: modelConfig(modelEndpoint.baseUrl, bridgeA.config),
    })
    const initialThreadId = getThreadId(initialThreadResult)

    const statusA = await client.rpc('mcpServerStatus/list', { threadId: initialThreadId })
    expect([...collectImageToolNames(statusA)].sort()).toEqual([
      'generate_image',
      'get_image_task',
      'list_image_tasks',
    ])
    const callA = await client.rpc('mcpServer/tool/call', {
      threadId: initialThreadId,
      server: 'copis_image',
      tool: 'list_image_tasks',
      arguments: { session_id: 'codex-image-protocol-test' },
    })
    expect(JSON.stringify(callA)).toContain('bridge-A')
    expect(listCallsA).toEqual(['GET /api/working/image/tasks?session_id=codex-image-protocol-test'])

    const loadedBeforeTurn = await client.rpc('thread/loaded/list', { limit: 100 })
    expect(resultData(loadedBeforeTurn)).toContain(initialThreadId)

    const turnCompleted = client.waitForNotification(message => message.method === 'turn/completed', 60_000)
    await client.rpc('turn/start', {
      threadId: initialThreadId,
      cwd,
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'readOnly', networkAccess: false },
      input: [{ type: 'text', text: '本地协议测试；请求由本机 HTTP 400 fixture 立即拒绝，不调用外部模型。' }],
      model: 'gpt-5.4',
    })
    const failedTurn = await turnCompleted
    const turn = isRecord(failedTurn.params) && isRecord(failedTurn.params.turn)
      ? failedTurn.params.turn
      : undefined
    expect(turn?.status).not.toBe('completed')
    expect(modelEndpoint.requests.length).toBeGreaterThan(0)
    expect(modelEndpoint.requests.every(request => request.startsWith('POST /v1/'))).toBe(true)

    const hotForkResult = await client.rpc('thread/fork', {
      threadId: initialThreadId,
      deferGoalContinuation: true,
      cwd,
      approvalPolicy: 'never',
      sandbox: 'read-only',
      model: 'gpt-5.4',
      modelProvider: 'copis_protocol_test',
      config: modelConfig(modelEndpoint.baseUrl, bridgeB.config),
    })
    const hotForkId = getThreadId(hotForkResult)
    const forkedThread = isRecord(hotForkResult.thread) ? hotForkResult.thread : undefined
    expect(Array.isArray(forkedThread?.turns) ? forkedThread.turns.length : 0).toBeGreaterThan(0)

    const statusB = await client.rpc('mcpServerStatus/list', { threadId: hotForkId })
    expect([...collectImageToolNames(statusB)].sort()).toEqual([
      'generate_image',
      'get_image_task',
      'list_image_tasks',
    ])
    const hotForkCall = await client.rpc('mcpServer/tool/call', {
      threadId: hotForkId,
      server: 'copis_image',
      tool: 'list_image_tasks',
      arguments: { session_id: 'codex-image-protocol-test' },
    })
    expect(JSON.stringify(hotForkCall)).toContain('bridge-B')
    expect(listCallsB).toEqual(['GET /api/working/image/tasks?session_id=codex-image-protocol-test'])

    const disabledForkResult = await client.rpc('thread/fork', {
      threadId: hotForkId,
      deferGoalContinuation: true,
      cwd,
      approvalPolicy: 'never',
      sandbox: 'read-only',
      model: 'gpt-5.4',
      modelProvider: 'copis_protocol_test',
      config: modelConfig(modelEndpoint.baseUrl, { ...bridgeB.config, enabled: false }),
    })
    const disabledForkId = getThreadId(disabledForkResult)
    let disabledToolError = ''
    try {
      const disabledCall = await client.rpc('mcpServer/tool/call', {
        threadId: disabledForkId,
        server: 'copis_image',
        tool: 'list_image_tasks',
        arguments: { session_id: 'codex-image-protocol-test' },
      })
      if (disabledCall.isError === true) disabledToolError = JSON.stringify(disabledCall)
    } catch (error) {
      disabledToolError = error instanceof Error ? error.message : String(error)
    }
    expect(disabledToolError).toMatch(/unknown.*MCP server|MCP server.*(?:disabled|not found|unavailable)/i)

    // 已加载 Thread 的 resume 会忽略新 MCP config，且 unsubscribe 有延迟卸载窗口；
    // 重启 app-server 后确认目标 Thread 冷加载，再 resume 验证持久化配置确实切到 B。
    await client.stop()
    await bridgeB.close()
    bridgeB = undefined
    bridgeBCold = await startCodexImageToolsMcp({
      sessionId: 'codex-image-protocol-test',
      cwd,
      baseUrl: 'http://127.0.0.1:1',
      fetchImpl: fetchListTasks('bridge-B', listCallsBCold),
    })
    const restartedClient = startClient()
    await restartedClient.rpc('initialize', {
      clientInfo: { name: 'copis-codex-image-protocol-test', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    })
    const loadedAfterRestart = await restartedClient.rpc('thread/loaded/list', { limit: 100 })
    expect(resultData(loadedAfterRestart)).not.toContain(initialThreadId)

    const coldResumeResult = await restartedClient.rpc('thread/resume', {
      threadId: initialThreadId,
      cwd,
      approvalPolicy: 'never',
      sandbox: 'read-only',
      model: 'gpt-5.4',
      modelProvider: 'copis_protocol_test',
      config: modelConfig(modelEndpoint.baseUrl, bridgeBCold.config),
    })
    expect(getThreadId(coldResumeResult)).toBe(initialThreadId)
    const coldResumeCall = await restartedClient.rpc('mcpServer/tool/call', {
      threadId: initialThreadId,
      server: 'copis_image',
      tool: 'list_image_tasks',
      arguments: { session_id: 'codex-image-protocol-cold-resume' },
    })
    expect(JSON.stringify(coldResumeCall)).toContain('bridge-B')
    expect(listCallsBCold).toEqual(['GET /api/working/image/tasks?session_id=codex-image-protocol-cold-resume'])
  } finally {
    await Promise.allSettled(clients.map(client => client.stop()))
    await Promise.allSettled([bridgeA?.close(), bridgeB?.close(), bridgeBCold?.close()].filter((close): close is Promise<void> => Boolean(close)))
    await closeServer(modelEndpoint?.server)
    rmSync(testRoot, { recursive: true, force: true })
  }
}, 120_000)
