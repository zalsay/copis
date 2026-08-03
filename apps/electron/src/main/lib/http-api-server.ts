import { app } from 'electron'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { chmodSync, existsSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { join, resolve } from 'node:path'
import {
  handleHttpApiRequest,
  HTTP_API_HOST,
  HTTP_API_PORT,
  type HttpApiRequest,
  type HttpApiResponse,
} from './http-api-handler'

export { HTTP_API_HOST, HTTP_API_PORT }

const RUST_HTTP_API_BINARY = 'copis-http-api-server'

interface RustBridgeRequest {
  readonly id: number
  readonly method: string
  readonly path: string
  readonly body?: string
}

let httpApiProcess: ChildProcessWithoutNullStreams | null = null
let stopping = false
let responseWriteChain = Promise.resolve()

function encodeHex(value: string): string {
  return Buffer.from(value, 'utf8').toString('hex')
}

function decodeHex(value: string): string | undefined {
  if (!/^(?:[0-9a-f]{2})*$/i.test(value)) return undefined
  return Buffer.from(value, 'hex').toString('utf8')
}

function getBinaryName(): string {
  return process.platform === 'win32' ? `${RUST_HTTP_API_BINARY}.exe` : RUST_HTTP_API_BINARY
}

function resolveBinaryPath(): string | undefined {
  const binaryName = getBinaryName()
  const configuredPath = process.env.COPIS_HTTP_API_SERVER?.trim()
  const candidates = configuredPath
    ? [configuredPath]
    : app.isPackaged
      ? [join(process.resourcesPath, 'bin', binaryName)]
      : [
        join(__dirname, '..', 'resources', 'bin', binaryName),
        resolve(__dirname, '../../..', 'native/http-api-server/target/debug', binaryName),
        resolve(__dirname, '../../..', 'native/http-api-server/target/release', binaryName),
      ]

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue
    if (process.platform !== 'win32') {
      try {
        chmodSync(candidate, 0o755)
      } catch {
        // 文件权限通常由构建阶段设置；无法修改时仍尝试启动。
      }
    }
    return candidate
  }
  return undefined
}

function parseBridgeRequest(line: string): RustBridgeRequest | undefined {
  const fields = line.split('\t')
  if (fields.length !== 4) return undefined

  const id = Number(fields[0])
  const method = decodeHex(fields[1] ?? '')
  const path = decodeHex(fields[2] ?? '')
  const body = fields[3] ? decodeHex(fields[3]) : ''
  if (!Number.isSafeInteger(id) || id < 1 || method === undefined || path === undefined || body === undefined) {
    return undefined
  }

  return {
    id,
    method,
    path,
    ...(body ? { body } : {}),
  }
}

function serializeBridgeResponse(id: number, response: HttpApiResponse): string {
  const body = response.body === undefined ? '' : encodeHex(JSON.stringify(response.body))
  return `${id}\t${response.status}\t${body}\n`
}

function writeBridgeResponse(
  child: ChildProcessWithoutNullStreams,
  id: number,
  response: HttpApiResponse,
): void {
  const line = serializeBridgeResponse(id, response)
  responseWriteChain = responseWriteChain.then(() => new Promise<void>((resolveWrite) => {
    if (httpApiProcess !== child || child.stdin.destroyed) {
      resolveWrite()
      return
    }
    try {
      child.stdin.write(line, () => resolveWrite())
    } catch {
      resolveWrite()
    }
  }))
}

function dispatchBridgeRequest(child: ChildProcessWithoutNullStreams, request: RustBridgeRequest): void {
  const input: HttpApiRequest = {
    method: request.method,
    path: request.path,
    ...(request.body === undefined ? {} : { body: request.body }),
  }
  void handleHttpApiRequest(input).then(
    (response) => writeBridgeResponse(child, request.id, response),
    (error: unknown) => {
      console.error('[HTTP API] 业务桥处理失败:', error)
      writeBridgeResponse(child, request.id, {
        status: 500,
        body: { error: 'HTTP API 请求失败', code: 'internal_error' },
      })
    },
  )
}

export function startHttpApiServer(): void {
  if (httpApiProcess && !httpApiProcess.killed) return

  const binaryPath = resolveBinaryPath()
  if (!binaryPath) {
    console.error(
      `[HTTP API] 找不到 Rust 二进制（${getBinaryName()}）。` +
      '请先运行 bun run build:http-api-server，或设置 COPIS_HTTP_API_SERVER。',
    )
    return
  }

  stopping = false
  responseWriteChain = Promise.resolve()
  let child: ChildProcessWithoutNullStreams
  try {
    child = spawn(binaryPath, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: false,
      windowsHide: true,
    })
  } catch (error) {
    console.error('[HTTP API] Rust 二进制启动失败:', error)
    return
  }

  httpApiProcess = child
  const lineReader = createInterface({ input: child.stdout })
  lineReader.on('line', (line) => {
    // 不能对整行调用 trim：空请求体由末尾的制表符表示，trim 会丢掉协议字段。
    const request = parseBridgeRequest(line.replace(/\r$/, ''))
    if (!request) {
      if (line.trim()) console.error('[HTTP API] 收到无法解析的 Rust 请求')
      return
    }
    dispatchBridgeRequest(child, request)
  })

  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => {
    const message = chunk.trim()
    if (message) console.warn(`[HTTP API][rust] ${message}`)
  })

  child.once('error', (error) => {
    if (httpApiProcess !== child || stopping) return
    httpApiProcess = null
    console.error('[HTTP API] Rust 进程错误:', error.message)
  })

  child.once('exit', (code, signal) => {
    lineReader.close()
    if (httpApiProcess !== child) return
    httpApiProcess = null
    if (!stopping) {
      console.error(`[HTTP API] Rust 进程退出（code=${code ?? 'null'}, signal=${signal ?? 'none'}）`)
    }
  })

  console.log(`[HTTP API] Rust 服务已启动：http://${HTTP_API_HOST}:${HTTP_API_PORT}`)
}

export function stopHttpApiServer(): Promise<void> {
  const child = httpApiProcess
  if (!child) return Promise.resolve()

  stopping = true
  httpApiProcess = null
  return new Promise<void>((resolveStop) => {
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      resolveStop()
    }

    child.once('exit', finish)
    child.once('error', finish)
    try {
      child.stdin.end()
    } catch {
      child.kill()
      finish()
    }

    const forceTimer = setTimeout(() => {
      if (!child.killed) child.kill()
      finish()
    }, 1_000)
    child.once('exit', () => clearTimeout(forceTimer))
  })
}
