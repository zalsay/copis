/**
 * 构建时验证自包含 Worker 的真实工具注册。
 * 仅请求本机模型 fixture：拒绝模型响应，不运行任何工具或访问真实 Chrome。
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REQUIRED_CHROME_TOOLS = [
  'ChromeDesktopStart', 'ChromeDesktopObserve', 'ChromeDesktopClick',
  'ChromeDesktopScroll', 'ChromeDesktopType', 'ChromeDesktopPress', 'ChromeDesktopStop',
]

export async function verifyCompiledPiWorker(
  executablePath: string,
  workerArgs: readonly string[] = ['__pi-worker'],
  timeoutMs = 20_000,
): Promise<void> {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'copis-worker-build-'))
  let requestedTools: Set<string> | undefined
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        tools?: Array<{ function?: { name?: string } }>
      }
      requestedTools = new Set(body.tools?.flatMap(tool => tool.function?.name ? [tool.function.name] : []) ?? [])
      // 非重试型失败让模型回合立即结束；不会返回 tool call，也不消费外部模型额度。
      response.writeHead(400, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'local-build-smoke-complete' } }))
    } catch {
      response.writeHead(400)
      response.end()
    }
  })

  let child: ReturnType<typeof spawn> | undefined
  let workerClosed: Promise<void> | undefined
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Worker smoke 本机端口不可用')
    const baseUrl = `http://127.0.0.1:${address.port}/v1`
    child = spawn(executablePath, [...workerArgs], {
      cwd: fixtureRoot,
      windowsHide: true,
      env: {
        ...process.env,
        COPIS_PI_RPC_COMPILED_RUNTIME: '1',
        COPIS_PI_FILE_API_TOKEN: 'local-build-file-token',
        COPIS_HTTP_API_PORT: String(address.port),
      },
      stdio: ['pipe', 'ignore', 'ignore'],
    })
    const worker = child
    workerClosed = new Promise<void>(resolve => worker.once('close', () => resolve()))
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`自包含 Pi Worker 工具检查超时 (${timeoutMs}ms)`))
      }, timeoutMs)
      worker.once('error', error => { clearTimeout(timer); reject(error) })
      worker.once('close', code => { clearTimeout(timer); resolve(code) })
      worker.stdin?.on('error', () => {}) // 启动失败时由 error/close 统一报告。
      worker.stdin?.write(`${JSON.stringify({
        type: 'run', requestId: 'build-tools-smoke',
        config: {
          sessionId: 'build-tools-smoke',
          query: {
            sessionId: 'build-tools-smoke', useRustFileApi: true,
            apiKey: 'local-build-api-key', provider: 'openai', model: 'gpt-4.1', baseUrl,
            prompt: '本机构建检查，不执行任何工具', systemPrompt: '本机构建检查',
            permissionMode: 'bypassPermissions', memoryPolicy: 'off',
            cwd: fixtureRoot, piAgentDir: join(fixtureRoot, 'agent'), piSessionDir: join(fixtureRoot, 'sessions'),
            chromeDesktopControl: { endpoint: '/api/internal/agent/chrome-desktop-tool', token: 'local-build-chrome-token' },
          },
        },
      })}\n`)
      // 不 end stdin；真实 Rust owner 在 Worker 完成前也不会发送 EOF。
    })
    if (exitCode !== 0) throw new Error(`自包含 Pi Worker 工具检查退出码异常: ${exitCode}`)
    const registeredTools = requestedTools
    if (!registeredTools) throw new Error('自包含 Pi Worker 未向本机模型 fixture 发送请求，不能确认工具可用')
    const missing = REQUIRED_CHROME_TOOLS.filter(name => !registeredTools.has(name))
    if (missing.length) throw new Error(`自包含 Pi Worker 缺少工具: ${missing.join(', ')}`)
  } finally {
    child?.stdin?.destroy()
    if (child && workerClosed) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM')
        let stopTimer: ReturnType<typeof setTimeout> | undefined
        const exited = await Promise.race([
          workerClosed.then(() => true),
          new Promise<boolean>(resolve => { stopTimer = setTimeout(() => resolve(false), 500) }),
        ]).finally(() => clearTimeout(stopTimer))
        if (!exited) child.kill('SIGKILL')
      }
      // 先等进程与 stdio 完全退出，再删除 cwd；超时失败也不能留下孤儿 Worker。
      await workerClosed
    }
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    rmSync(fixtureRoot, { recursive: true, force: true })
  }
}
