import { app } from 'electron'
import { randomBytes } from 'node:crypto'
import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptions } from 'node:child_process'
import { chmodSync, existsSync } from 'node:fs'
import { createInterface, type Interface } from 'node:readline'
import { join, resolve } from 'node:path'
import {
  COPIS_HTTP_API_HOST,
  resolveCopisHttpApiPort,
} from '@copis/shared/config'
import type {
  FunctionalModuleArchitecture,
  FunctionalModuleArtifact,
  FunctionalModulePlatform,
  FunctionalModuleProgressPayload,
} from '@copis/shared'
import { getBundledCliPath, getConfigDir, getFunctionalModulesDir } from './config-paths'
import { getSystemBunPath, getVendorBunPath } from './bun-finder'
import {
  resolvePiWorkerLaunch,
  resolvePiWorkerRuntime,
  type PiWorkerLaunch,
  type PiWorkerRuntime,
} from './pi-worker-launch'
import {
  activatePreparedFunctionalModule,
  getFunctionalModulePath,
  installFunctionalModule,
  prepareFunctionalModule,
  type FunctionalModuleFetch,
} from './functional-module-manager'
import {
  getFunctionalModulePaths,
  readActiveFunctionalModule,
  restoreFunctionalModule,
  type ActiveFunctionalModule,
} from './functional-module-store'
import {
  handleHttpApiRequest,
  type HttpApiRequest,
  type HttpApiResponse,
} from './http-api-handler'
import { getOrCreateHttpApiWebToken } from './http-api-web-token'
import { getWorkingTokenStore } from './working-auth-store'
import {
  MODEL_BASE_URL_ENV,
  resolveCopisBackendEndpoints,
  type CopisBackendEndpointResolution,
} from './backend-endpoint-resolver'

export const HTTP_API_HOST = COPIS_HTTP_API_HOST
export const HTTP_API_PORT = resolveCopisHttpApiPort({
  configuredPort: process.env.COPIS_HTTP_API_PORT,
  isPackaged: app.isPackaged === true,
})

const RUST_HTTP_API_BINARY = 'copis-http-api-server'
const HEALTH_POLL_INTERVAL_MS = 100
const DEFAULT_HEALTH_TIMEOUT_MS = 5_000
const WORKING_TOKEN_SYNC_RETRY_COUNT = 20
const WORKING_TOKEN_SYNC_RETRY_DELAY_MS = 100

export type HttpApiSpawn = (
  file: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcessWithoutNullStreams

export interface HttpApiServerOptions {
  rootDir?: string
  manifestUrl?: string
  artifactOverride?: FunctionalModuleArtifact
  platform?: FunctionalModulePlatform
  arch?: FunctionalModuleArchitecture
  clientVersion?: string
  fetchImpl?: FunctionalModuleFetch
  onProgress?: (payload: FunctionalModuleProgressPayload) => void
  onHealthProgress?: (progress: number) => void
  spawnImpl?: HttpApiSpawn
  healthTimeoutMs?: number
  stopTimeoutMs?: number
  port?: number
  workerLaunch?: PiWorkerLaunch
  backendUrl?: string
  modelBaseUrl?: string
  endpointConfigUrl?: string
}

interface ManagedProcess {
  child: ChildProcessWithoutNullStreams
  lineReader?: Interface
  internalToken: string
}

interface RustBridgeRequest {
  readonly id: number
  readonly method: string
  readonly path: string
  readonly body?: string
}

let httpApiProcess: ChildProcessWithoutNullStreams | null = null
let httpApiInternalToken: string | null = null
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

export function resolveDevelopmentRustBinaryCandidates(
  baseDir: string,
  binaryName = getBinaryName(),
): string[] {
  return [
    resolve(baseDir, '../../..', 'native/http-api-server/target/release', binaryName),
    resolve(baseDir, '../../..', 'native/http-api-server/target/debug', binaryName),
  ]
}

function getRootDir(options: HttpApiServerOptions): string {
  return options.rootDir ?? getFunctionalModulesDir()
}

function resolveBinaryPath(options: HttpApiServerOptions): string | undefined {
  const binaryName = getBinaryName()
  const configuredPath = process.env.COPIS_HTTP_API_SERVER?.trim()
  if (configuredPath && existsSync(configuredPath)) return prepareBinary(configuredPath)

  const activePath = getFunctionalModulePath('rust-http-api', getRootDir(options))
  if (activePath) return prepareBinary(activePath)

  // 正式包只使用 active module；本地开发允许直接使用 Cargo 产物。
  if (app.isPackaged) return undefined
  const candidates = resolveDevelopmentRustBinaryCandidates(__dirname, binaryName)
  return candidates.find((candidate) => existsSync(candidate))
    ? prepareBinary(candidates.find((candidate) => existsSync(candidate))!)
    : undefined
}

function prepareBinary(path: string): string {
  if (process.platform !== 'win32') {
    try {
      chmodSync(path, 0o755)
    } catch {
      // 构建产物通常已经有执行权限；无法修改时继续尝试启动。
    }
  }
  return path
}

function resolvePiRpcWorkerLaunch(options: HttpApiServerOptions): PiWorkerLaunch | undefined {
  return options.workerLaunch ?? resolvePiWorkerLaunch({
    isPackaged: app.isPackaged,
    bundledCliPath: getBundledCliPath(),
    developmentCandidates: [
      join(__dirname, 'pi-rpc-worker.cjs'),
      resolve(__dirname, '../../..', 'apps/electron/dist/pi-rpc-worker.cjs'),
    ],
  })
}

function resolvePiRpcWorkerRuntime(workerLaunch: PiWorkerLaunch | undefined): PiWorkerRuntime | undefined {
  if (workerLaunch?.kind !== 'script') return undefined
  return resolvePiWorkerRuntime({
    isPackaged: app.isPackaged,
    bunPath: getSystemBunPath() ?? getVendorBunPath() ?? undefined,
  })
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

function spawnManagedProcess(
  binaryPath: string,
  port: number,
  options: HttpApiServerOptions,
  bridgeEnabled: boolean,
): ManagedProcess | undefined {
  const workerLaunch = resolvePiRpcWorkerLaunch(options)
  const workerRuntime = resolvePiRpcWorkerRuntime(workerLaunch)
  const useDevelopmentScriptRuntime = workerLaunch?.kind === 'script' && !app.isPackaged
  const spawnImpl = options.spawnImpl ?? ((file, args, spawnOptions) => (
    spawn(file, args, spawnOptions) as ChildProcessWithoutNullStreams
  ))
  const internalToken = randomBytes(32).toString('hex')
  let child: ChildProcessWithoutNullStreams
  try {
    child = spawnImpl(binaryPath, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: false,
      windowsHide: true,
      env: {
        ...process.env,
        COPIS_HTTP_API_PORT: String(port),
        COPIS_CONFIG_DIR: getConfigDir(),
        COPIS_MEMORY_DIR: join(getConfigDir(), 'memory'),
        COPIS_HTTP_API_INTERNAL_TOKEN: internalToken,
        COPIS_HTTP_API_WEB_TOKEN: getOrCreateHttpApiWebToken(),
        COPIS_WORKING_ACCESS_TOKEN: getWorkingTokenStore().getToken() ?? '',
        ...(options.backendUrl || process.env.COPIS_BACKEND_URL
          ? { COPIS_BACKEND_URL: options.backendUrl ?? process.env.COPIS_BACKEND_URL }
          : {}),
        ...(options.modelBaseUrl || process.env[MODEL_BASE_URL_ENV]
          ? { [MODEL_BASE_URL_ENV]: options.modelBaseUrl ?? process.env[MODEL_BASE_URL_ENV] }
          : {}),
        ...(app.isPackaged ? { COPIS_PI_RPC_COMPILED_RUNTIME: '1' } : {}),
        ...(useDevelopmentScriptRuntime
          ? {
            COPIS_PI_RPC_USE_SYSTEM_RUNTIME: '1',
            ...(workerRuntime ? { COPIS_PI_RPC_RUNTIME: workerRuntime.path } : {}),
          }
          : {}),
        ...(workerLaunch?.kind === 'executable'
          ? {
            COPIS_PI_RPC_EXECUTABLE: workerLaunch.path,
            COPIS_CLI: workerLaunch.path,
          }
          : {}),
        ...(workerLaunch?.kind === 'script'
          ? { COPIS_PI_RPC_WORKER: workerLaunch.path }
          : {}),
      },
    })
  } catch (error) {
    console.error('[HTTP API] Rust 二进制启动失败:', error)
    return undefined
  }

  let lineReader: Interface | undefined
  if (bridgeEnabled) {
    lineReader = createInterface({ input: child.stdout })
    lineReader.on('line', (line) => {
      // 空请求体由末尾制表符表示，不能先对整行调用 trim。
      const request = parseBridgeRequest(line.replace(/\r$/, ''))
      if (!request) {
        if (line.trim()) console.error('[HTTP API] 收到无法解析的 Rust 请求')
        return
      }
      dispatchBridgeRequest(child, request)
    })
  } else {
    child.stdout.resume()
  }

  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => {
    const message = chunk.trim()
    if (message) console.warn(`[HTTP API][rust] ${message}`)
  })

  child.once('error', (error) => {
    if (httpApiProcess === child) {
      httpApiProcess = null
      httpApiInternalToken = null
      if (!stopping) console.error('[HTTP API] Rust 进程错误:', error.message)
    }
  })
  child.once('exit', (code, signal) => {
    lineReader?.close()
    if (httpApiProcess !== child) return
    httpApiProcess = null
    httpApiInternalToken = null
    if (!stopping) {
      console.error(`[HTTP API] Rust 进程退出（code=${code ?? 'null'}, signal=${signal ?? 'none'}）`)
    }
  })

  return { child, internalToken, ...(lineReader ? { lineReader } : {}) }
}

async function resolveHttpApiBackend(
  options: HttpApiServerOptions,
): Promise<{ options: HttpApiServerOptions; resolution: CopisBackendEndpointResolution }> {
  const resolution = await resolveCopisBackendEndpoints({
    configuredBackendUrl: options.backendUrl,
    configuredModelBaseUrl: options.modelBaseUrl,
    endpointConfigUrl: options.endpointConfigUrl,
    fetchImpl: options.fetchImpl,
  })
  return {
    options: {
      ...options,
      backendUrl: resolution.backendUrl,
      modelBaseUrl: resolution.modelBaseUrl,
    },
    resolution,
  }
}

export async function prepareHttpApiBackend(
  options: HttpApiServerOptions = {},
): Promise<HttpApiServerOptions> {
  const prepared = await resolveHttpApiBackend(options)
  process.env.COPIS_BACKEND_URL = prepared.resolution.backendUrl
  process.env[MODEL_BASE_URL_ENV] = prepared.resolution.modelBaseUrl
  console.log(
    `[HTTP API] edu-api endpoint 已选择（${prepared.resolution.source}）：${prepared.resolution.backendUrl}`,
  )
  return prepared.options
}

function stopManagedProcess(
  child: ChildProcessWithoutNullStreams,
  timeoutMs = 1_000,
): Promise<void> {
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
    }, Math.max(1, timeoutMs))
    child.once('exit', () => clearTimeout(forceTimer))
  })
}

export async function waitForHttpApiHealth(
  port: number,
  options: Pick<HttpApiServerOptions, 'fetchImpl' | 'healthTimeoutMs' | 'onHealthProgress'> = {},
): Promise<boolean> {
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = Math.max(1, options.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS)
  const deadline = Date.now() + timeoutMs
  options.onHealthProgress?.(0)
  do {
    try {
      const response = await fetchImpl(`http://${HTTP_API_HOST}:${port}/api/health`, {
        headers: { Accept: 'application/json' },
      })
      if (response.ok && await isHealthyHttpApiResponse(response)) {
        options.onHealthProgress?.(1)
        return true
      }
    } catch {
      // 候选进程启动需要一点时间，继续轮询直到超时。
    }
    const remaining = deadline - Date.now()
    if (remaining <= 0) break
    options.onHealthProgress?.(Math.min(0.99, 1 - remaining / timeoutMs))
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, Math.min(HEALTH_POLL_INTERVAL_MS, remaining)))
  } while (Date.now() < deadline)
  return false
}

async function isHealthyHttpApiResponse(response: Response): Promise<boolean> {
  try {
    const body = await response.json() as unknown
    return isRecord(body) && body.ok === true && body.service === 'copis-http-api'
  } catch {
    return false
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function managerOptions(options: HttpApiServerOptions, rootDir: string): {
  rootDir: string
  manifestUrl?: string
  artifactOverride?: FunctionalModuleArtifact
  platform?: FunctionalModulePlatform
  arch?: FunctionalModuleArchitecture
  clientVersion?: string
  fetchImpl?: FunctionalModuleFetch
  onProgress?: (payload: FunctionalModuleProgressPayload) => void
} {
  return {
    rootDir,
    ...(options.manifestUrl ? { manifestUrl: options.manifestUrl } : {}),
    ...(options.artifactOverride ? { artifactOverride: options.artifactOverride } : {}),
    ...(options.platform ? { platform: options.platform } : {}),
    ...(options.arch ? { arch: options.arch } : {}),
    ...(options.clientVersion ? { clientVersion: options.clientVersion } : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
  }
}

export function startHttpApiServer(options: HttpApiServerOptions = {}): void {
  if (httpApiProcess && !httpApiProcess.killed) return

  const binaryPath = resolveBinaryPath(options)
  if (!binaryPath) {
    console.error(
      `[HTTP API] 找不到 Rust 二进制（${getBinaryName()}）。` +
      '请先安装 Rust HTTP API 功能模块，或运行 bun run build:http-api-server。',
    )
    return
  }

  const workerLaunch = resolvePiRpcWorkerLaunch(options)
  if (!workerLaunch) {
    console.warn('[HTTP API] 找不到 Pi RPC Worker，将暂时只提供非 Agent HTTP API。请重新构建 Copis 运行时。')
  } else if (workerLaunch.kind === 'script' && !app.isPackaged && !resolvePiRpcWorkerRuntime(workerLaunch)) {
    console.warn('[HTTP API] 开发模式找不到 Bun runtime，Agent Worker 暂不可用。请先安装 Bun 或配置 vendor/bun。')
  }

  stopping = false
  responseWriteChain = Promise.resolve()
  const managed = spawnManagedProcess(binaryPath, options.port ?? HTTP_API_PORT, options, true)
  if (!managed) return
  httpApiProcess = managed.child
  httpApiInternalToken = managed.internalToken
  console.log(`[HTTP API] Rust 服务已启动：http://${HTTP_API_HOST}:${options.port ?? HTTP_API_PORT}${workerLaunch ? `，Pi Worker: ${workerLaunch.path}` : ''}`)
}

export async function updateHttpApiServer(options: HttpApiServerOptions = {}): Promise<boolean> {
  const runtimeOptions = await prepareHttpApiBackend(options)
  const rootDir = getRootDir(runtimeOptions)
  const paths = getFunctionalModulePaths(rootDir)
  const previous = readActiveFunctionalModule(paths, 'rust-http-api')
  const formalPort = runtimeOptions.port ?? HTTP_API_PORT
  const candidatePort = formalPort + 1 <= 65_535 ? formalPort + 1 : formalPort - 1

  let prepared
  try {
    prepared = await prepareFunctionalModule({ name: 'rust-http-api' }, managerOptions(runtimeOptions, rootDir))
  } catch (error) {
    console.warn('[HTTP API] 准备候选 Rust 模块失败:', error)
    return false
  }

  const candidatePath = join(prepared.versionDir, prepared.artifact.entrypoint)
  const candidate = spawnManagedProcess(candidatePath, candidatePort, runtimeOptions, false)
  if (!candidate) return false

  if (!await waitForHttpApiHealth(candidatePort, {
    ...runtimeOptions,
    onHealthProgress: undefined,
  })) {
    await stopManagedProcess(candidate.child, runtimeOptions.stopTimeoutMs)
    console.warn('[HTTP API] 候选 Rust 模块健康检查失败，保留当前版本')
    return false
  }
  await stopManagedProcess(candidate.child, runtimeOptions.stopTimeoutMs)

  const oldProcess = httpApiProcess
  if (oldProcess) {
    httpApiProcess = null
    httpApiInternalToken = null
    await stopManagedProcess(oldProcess, runtimeOptions.stopTimeoutMs)
  }

  try {
    await activatePreparedFunctionalModule(prepared, rootDir)
  } catch (error) {
    if (previous) await restoreFunctionalModule(paths, previous)
    if (previous) startHttpApiServer({ ...runtimeOptions, rootDir })
    console.warn('[HTTP API] 激活候选 Rust 模块失败，已恢复旧版本:', error)
    return false
  }

  const next = spawnManagedProcess(candidatePath, formalPort, runtimeOptions, true)
  if (next && await waitForHttpApiHealth(formalPort, {
    ...runtimeOptions,
    onHealthProgress: runtimeOptions.onHealthProgress,
  })) {
    httpApiProcess = next.child
    httpApiInternalToken = next.internalToken
    console.log(`[HTTP API] Rust 模块已切换到 v${prepared.artifact.version}`)
    return true
  }

  if (next) await stopManagedProcess(next.child, runtimeOptions.stopTimeoutMs)
  if (previous) {
    await restoreFunctionalModule(paths, previous)
    startHttpApiServer({ ...runtimeOptions, rootDir })
  }
  console.warn('[HTTP API] 新 Rust 模块正式端口健康检查失败，已恢复旧版本')
  return false
}

export function getHttpApiInternalToken(): string | null {
  return httpApiInternalToken
}

/** 将 Electron 保存的 Working token 同步到 Rust，技能市场业务不再经过 Electron 业务桥。 */
export async function syncWorkingAccessToken(token: string | null): Promise<void> {
  const internalToken = getHttpApiInternalToken()
  if (!internalToken) return

  let lastError: unknown
  for (let attempt = 0; attempt < WORKING_TOKEN_SYNC_RETRY_COUNT; attempt += 1) {
    try {
      const response = await fetch(`http://${HTTP_API_HOST}:${HTTP_API_PORT}/internal/working-auth/token`, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'X-Copis-Internal-Token': internalToken,
        },
        body: JSON.stringify({ token }),
      })
      if (response.ok) return
      lastError = new Error(`HTTP ${response.status}`)
      // 非网络错误通常不会因重试改变；保留一次重试窗口只用于 Rust 启动竞态。
      if (response.status >= 400 && response.status < 500) break
    } catch (error) {
      lastError = error
    }
    if (attempt + 1 < WORKING_TOKEN_SYNC_RETRY_COUNT) {
      await new Promise<void>((resolve) => setTimeout(resolve, WORKING_TOKEN_SYNC_RETRY_DELAY_MS))
    }
  }
  // Rust 重启或更新期间可能暂时没有监听；重试结束后保留日志，下一次认证操作会再次同步。
  console.warn('[HTTP API] 同步 Working token 到 Rust 失败:', lastError)
}

export function shouldInstallMissingHttpApiModule(isPackaged: boolean): boolean {
  return !isPackaged
}

export async function ensureHttpApiServer(options: HttpApiServerOptions = {}): Promise<void> {
  const runtimeOptions = await prepareHttpApiBackend(options)
  const rootDir = getRootDir(runtimeOptions)
  if (resolveBinaryPath({ ...runtimeOptions, rootDir })) {
    startHttpApiServer({ ...runtimeOptions, rootDir })
    return
  }

  if (!shouldInstallMissingHttpApiModule(app.isPackaged === true)) {
    console.warn('[HTTP API] 当前没有 active Rust 模块，等待登录后的功能模块 Gate 完成首次安装')
    return
  }

  try {
    await installFunctionalModule({ name: 'rust-http-api' }, managerOptions(runtimeOptions, rootDir))
    startHttpApiServer({ ...runtimeOptions, rootDir })
  } catch (error) {
    console.error('[HTTP API] Rust 功能模块初始化失败:', error)
  }
}

export function stopHttpApiServer(stopTimeoutMs = 1_000): Promise<void> {
  const child = httpApiProcess
  if (!child) return Promise.resolve()

  stopping = true
  httpApiProcess = null
  httpApiInternalToken = null
  return stopManagedProcess(child, stopTimeoutMs).finally(() => {
    stopping = false
  })
}
