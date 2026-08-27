import { app } from 'electron'
import { randomBytes } from 'node:crypto'
import { execFileSync, spawn, type ChildProcessWithoutNullStreams, type SpawnOptions } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, realpathSync, statSync } from 'node:fs'
import { createInterface, type Interface } from 'node:readline'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  COPIS_HTTP_API_HOST,
  resolveCopisHttpApiPort,
} from '@copis/shared/config'
import type {
  AgentWorkspace,
  FunctionalModuleArchitecture,
  FunctionalModuleArtifact,
  FunctionalModulePlatform,
  FunctionalModuleProgressPayload,
} from '@copis/shared'
import { getBundledCliPath, getConfigDir, getFunctionalModulesDir } from './config-paths'
import { getSystemBunPath, getVendorBunPath } from './bun-finder'
import { ensureDefaultWorkspace } from './agent-workspace-manager'
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
  resolveFunctionalModuleArtifact,
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
import {
  MODEL_BASE_URL_ENV,
  resolveCopisBackendEndpoints,
  type CopisBackendEndpointResolution,
} from './backend-endpoint-resolver'
import { redactSensitiveLogValue } from './bridge-log-redaction'

export const HTTP_API_HOST = COPIS_HTTP_API_HOST
export const HTTP_API_PORT = resolveCopisHttpApiPort({
  configuredPort: process.env.COPIS_HTTP_API_PORT,
  isPackaged: app.isPackaged === true,
})

/** 默认 Pi 扩展目录：打包模式在 resources/pi-extensions，开发模式在 dist/resources/pi-extensions。 */
function resolvePiExtensionsDir(): string | undefined {
  const resourcesDir = app.isPackaged ? process.resourcesPath : join(__dirname, 'resources')
  const candidate = join(resourcesDir, 'pi-extensions')
  return existsSync(candidate) ? candidate : undefined
}

const RUST_HTTP_API_BINARY = 'copis-http-api-server'
const HEALTH_POLL_INTERVAL_MS = 100
const DEFAULT_HEALTH_TIMEOUT_MS = 5_000

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
  /** 仅测试内部注入；生产启动路径使用 ensureDefaultWorkspace()。 */
  paymentWorkspace?: Pick<AgentWorkspace, 'slug' | 'projectRootPath' | 'projectPath'>
}

export interface PaymentWorkspaceRuntime {
  COPIS_PAYMENT_WORKSPACE_SLUG: 'default'
  COPIS_PAYMENT_WORKSPACE_PROJECT_ROOT: string
  COPIS_PAYMENT_WORKSPACE_CWD: string
  COPIS_PAYMENT_HOME_ROOT: string
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

export function resolvePaymentWorkspaceRuntime(
  workspace: Pick<AgentWorkspace, 'slug' | 'projectRootPath' | 'projectPath'>,
): PaymentWorkspaceRuntime {
  if (workspace.slug !== 'default' || !workspace.projectRootPath || !workspace.projectPath) {
    throw new Error('默认支付项目配置不完整')
  }

  const projectRootPath = realpathSync(resolve(workspace.projectRootPath))
  const projectPath = realpathSync(resolve(workspace.projectPath))
  if (!statSync(projectRootPath).isDirectory() || !statSync(projectPath).isDirectory()) {
    throw new Error('默认支付项目路径不是目录')
  }
  const relation = relative(projectRootPath, projectPath)
  if (!relation || relation === '..' || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    throw new Error('默认支付项目路径不在项目根目录内')
  }

  return {
    COPIS_PAYMENT_WORKSPACE_SLUG: 'default',
    COPIS_PAYMENT_WORKSPACE_PROJECT_ROOT: projectRootPath,
    COPIS_PAYMENT_WORKSPACE_CWD: projectPath,
    COPIS_PAYMENT_HOME_ROOT: join(projectRootPath, '.copis', 'payment'),
  }
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

/**
 * 开发模式直接启动 Electron 时，从仓库 alipay-bot 归档补齐隔离 CLI。
 * start-dev.sh 已负责 prepare/export，这里作为 bun run dev 路径的兜底。
 */
export function prepareDevelopmentAlipayBotCli(developmentRoot: string): string | undefined {
  if (app.isPackaged) return undefined

  const platform = process.platform === 'darwin' || process.platform === 'linux' || process.platform === 'win32'
    ? process.platform
    : undefined
  const architecture = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x64' : undefined
  if (!platform || !architecture) return undefined

  const moduleDir = process.env.COPIS_DEV_ALIPAY_BOT_DIR?.trim()
    || join(getConfigDir(), 'alipay-bot', `${platform}-${architecture}`)
  const entrypoint = join(moduleDir, 'bin', platform === 'win32' ? 'alipay-bot.cmd' : 'alipay-bot')
  const archive = join(
    developmentRoot,
    'apps/electron/resources/alipay-bot',
    `${platform}-${architecture}.tar.gz`,
  )

  if (existsSync(archive)) {
    try {
      mkdirSync(moduleDir, { recursive: true })
      execFileSync('tar', ['-xzf', archive, '-C', moduleDir], {
        stdio: 'ignore',
        timeout: 30_000,
      })
    } catch (error) {
      console.warn('[HTTP API] 开发环境 alipay-bot 解压失败，继续使用已有目录:', error)
    }
  }

  return existsSync(entrypoint) ? prepareBinary(entrypoint) : undefined
}

/** 开发模式未配置 Node runtime 时，使用系统 Node 启动 alipay-bot。 */
export function resolveDevelopmentAlipayBotNode(): string | undefined {
  if (app.isPackaged) return undefined
  const configuredPath = process.env.COPIS_ALIPAY_BOT_NODE?.trim()
  if (configuredPath && existsSync(configuredPath)) return configuredPath

  try {
    const result = execFileSync(
      process.platform === 'win32' ? 'where' : 'which',
      ['node'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000 },
    ).trim().split(/\r?\n/)[0]
    return result && existsSync(result) ? result : undefined
  } catch {
    return undefined
  }
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

function resolveNodeRuntimeRoot(options: HttpApiServerOptions): string | undefined {
  const active = readActiveFunctionalModule(
    getFunctionalModulePaths(getRootDir(options)),
    'node-runtime',
  )
  const nodeEntrypoint = process.platform === 'win32' ? 'bin/node.exe' : 'bin/node'
  if (!active || active.entrypoint !== nodeEntrypoint) return undefined
  return dirname(dirname(active.path))
}

function resolvePythonRuntimeRoot(options: HttpApiServerOptions): string | undefined {
  const active = readActiveFunctionalModule(
    getFunctionalModulePaths(getRootDir(options)),
    'python-runtime',
  )
  const entrypoint = process.platform === 'win32' ? 'bin/python.exe' : 'bin/python'
  if (!active || active.entrypoint !== entrypoint) return undefined
  const root = dirname(dirname(active.path))
  // Windows install_only 包的完整 Python 安装树位于 bin，PYTHONHOME 必须指向该目录才能找到 Lib 和 DLL。
  return process.platform === 'win32' ? join(root, 'bin') : root
}

function resolveOfficeCli(options: HttpApiServerOptions): string | undefined {
  const active = readActiveFunctionalModule(
    getFunctionalModulePaths(getRootDir(options)),
    'officecli',
  )
  const entrypoint = process.platform === 'win32' ? 'bin/officecli.exe' : 'bin/officecli'
  if (active?.entrypoint !== entrypoint) return undefined
  return prepareBinary(active.path)
}

function resolveAgentlyCli(options: HttpApiServerOptions): string | undefined {
  const active = readActiveFunctionalModule(
    getFunctionalModulePaths(getRootDir(options)),
    'agently-cli',
  )
  const entrypoint = process.platform === 'win32' ? 'bin/agently-cli.exe' : 'bin/agently-cli'
  if (active?.entrypoint !== entrypoint) return undefined
  return prepareBinary(active.path)
}

function resolveAlipayBotCli(options: HttpApiServerOptions): string | undefined {
  const configuredPath = process.env.COPIS_ALIPAY_BOT_CLI?.trim()
  if (!app.isPackaged && configuredPath && existsSync(configuredPath)) {
    return prepareBinary(configuredPath)
  }
  const active = readActiveFunctionalModule(
    getFunctionalModulePaths(getRootDir(options)),
    'alipay-bot',
  )
  const entrypoint = process.platform === 'win32' ? 'bin/alipay-bot.cmd' : 'bin/alipay-bot'
  if (active?.entrypoint === entrypoint) return prepareBinary(active.path)

  return prepareDevelopmentAlipayBotCli(resolve(__dirname, '../../..'))
}

function resolveAlipayBotNode(nodeRuntimeRoot: string | undefined): string | undefined {
  const configuredPath = process.env.COPIS_ALIPAY_BOT_NODE?.trim()
  if (!app.isPackaged && configuredPath && existsSync(configuredPath)) return configuredPath
  if (nodeRuntimeRoot) {
    const nodePath = join(nodeRuntimeRoot, 'bin', process.platform === 'win32' ? 'node.exe' : 'node')
    if (existsSync(nodePath)) return nodePath
  }
  return resolveDevelopmentAlipayBotNode()
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

function isAuthBridgeRequest(path: string): boolean {
  return path.startsWith('/api/internal/auth-storage/') || path === '/api/internal/auth-state/changed'
}

function dispatchBridgeRequest(child: ChildProcessWithoutNullStreams, request: RustBridgeRequest): void {
  const diagnostic = isAuthBridgeRequest(request.path)
  if (diagnostic) {
    console.info('[HTTP API][认证桥] 请求开始', {
      id: request.id,
      method: request.method,
      path: request.path,
      bodyBytes: Buffer.byteLength(request.body ?? '', 'utf8'),
    })
  }
  const input: HttpApiRequest = {
    method: request.method,
    path: request.path,
    ...(request.body === undefined ? {} : { body: request.body }),
  }
  void handleHttpApiRequest(input).then(
    (response) => {
      if (diagnostic) {
        console.info('[HTTP API][认证桥] 请求完成', {
          id: request.id,
          status: response.status,
          responseBodyBytes: response.body === undefined ? 0 : Buffer.byteLength(JSON.stringify(response.body), 'utf8'),
        })
      }
      writeBridgeResponse(child, request.id, response)
    },
    (error: unknown) => {
      console.error('[HTTP API] 业务桥处理失败:', redactSensitiveLogValue(error))
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
  const piExtensionsDir = resolvePiExtensionsDir()
  const nodeRuntimeRoot = resolveNodeRuntimeRoot(options)
  const pythonRuntimeRoot = resolvePythonRuntimeRoot(options)
  const officeCli = resolveOfficeCli(options)
  const agentlyCli = resolveAgentlyCli(options)
  const alipayBotCli = resolveAlipayBotCli(options)
  const alipayBotNode = resolveAlipayBotNode(nodeRuntimeRoot)
  let paymentRuntime: PaymentWorkspaceRuntime
  try {
    paymentRuntime = resolvePaymentWorkspaceRuntime(options.paymentWorkspace ?? ensureDefaultWorkspace())
  } catch (error) {
    console.error('[HTTP API] 默认支付项目解析失败，已阻止启动 Rust 进程:', error)
    return undefined
  }
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
        COPIS_HTTP_API_BRIDGE_ENABLED: bridgeEnabled ? '1' : '0',
        ...paymentRuntime,
        ...(options.backendUrl || process.env.COPIS_BACKEND_URL
          ? { COPIS_BACKEND_URL: options.backendUrl ?? process.env.COPIS_BACKEND_URL }
          : {}),
        ...(options.modelBaseUrl || process.env[MODEL_BASE_URL_ENV]
          ? { [MODEL_BASE_URL_ENV]: options.modelBaseUrl ?? process.env[MODEL_BASE_URL_ENV] }
          : {}),
        ...(piExtensionsDir ? { COPIS_PI_EXTENSIONS_DIR: piExtensionsDir } : {}),
        ...(nodeRuntimeRoot ? { COPIS_RUNTIME_ROOT: nodeRuntimeRoot } : {}),
        ...(pythonRuntimeRoot ? { COPIS_PYTHON_RUNTIME_ROOT: pythonRuntimeRoot } : {}),
        ...(officeCli ? { COPIS_OFFICECLI: officeCli } : {}),
        ...(agentlyCli ? { COPIS_AGENTLY_CLI: agentlyCli } : {}),
        ...(alipayBotCli ? { COPIS_ALIPAY_BOT_CLI: alipayBotCli } : {}),
        ...(alipayBotNode ? { COPIS_ALIPAY_BOT_NODE: alipayBotNode } : {}),
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
  if (next) {
    // 正式进程启动阶段可能立刻通过 stdio 请求认证存储；先登记进程，
    // 否则 writeBridgeResponse 会把健康检查前到达的响应丢弃。
    httpApiProcess = next.child
    httpApiInternalToken = next.internalToken
  }
  if (next && await waitForHttpApiHealth(formalPort, {
    ...runtimeOptions,
    onHealthProgress: runtimeOptions.onHealthProgress,
  })) {
    console.log(`[HTTP API] Rust 模块已切换到 v${prepared.artifact.version}`)
    return true
  }

  if (next) {
    if (httpApiProcess === next.child) {
      httpApiProcess = null
      httpApiInternalToken = null
    }
    await stopManagedProcess(next.child, runtimeOptions.stopTimeoutMs)
  }
  if (previous) {
    await restoreFunctionalModule(paths, previous)
    startHttpApiServer({ ...runtimeOptions, rootDir })
  }
  console.warn('[HTTP API] 新 Rust 模块正式端口健康检查失败，已恢复旧版本')
  return false
}

/**
 * 启动窗口前只校验并切换 Rust API，避免登录页先连到不兼容的旧模块。
 * 其他功能模块仍由登录后的完整启动 Gate 负责准备。
 */
export async function ensureRustHttpApiServerReady(options: HttpApiServerOptions = {}): Promise<void> {
  const runtimeOptions = await prepareHttpApiBackend(options)
  const rootDir = getRootDir(runtimeOptions)
  const paths = getFunctionalModulePaths(rootDir)

  if (!app.isPackaged) {
    startHttpApiServer({ ...runtimeOptions, rootDir })
    return
  }

  const artifact = await resolveFunctionalModuleArtifact('rust-http-api', {
    rootDir,
    manifestUrl: runtimeOptions.manifestUrl,
    platform: runtimeOptions.platform,
    arch: runtimeOptions.arch,
    clientVersion: runtimeOptions.clientVersion,
    fetchImpl: runtimeOptions.fetchImpl,
  })
  const active = readActiveFunctionalModule(paths, 'rust-http-api')
  const needsUpdate = !active
    || active.version !== artifact.version
    || active.sha256.toLowerCase() !== artifact.sha256.toLowerCase()

  if (needsUpdate) {
    const updated = await updateHttpApiServer({
      ...runtimeOptions,
      rootDir,
      artifactOverride: artifact,
    })
    if (!updated) throw new Error('系统核心模块更新后运行检查未通过')
    return
  }

  startHttpApiServer({ ...runtimeOptions, rootDir })
  if (!await waitForHttpApiHealth(HTTP_API_PORT, runtimeOptions)) {
    await stopHttpApiServer(runtimeOptions.stopTimeoutMs)
    startHttpApiServer({ ...runtimeOptions, rootDir })
    if (!await waitForHttpApiHealth(HTTP_API_PORT, runtimeOptions)) {
      throw new Error('系统核心模块未通过运行检查')
    }
  }
}

export function getHttpApiInternalToken(): string | null {
  return httpApiInternalToken
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
