import type {
  FunctionalModuleArchitecture,
  FunctionalModuleArtifact,
  FunctionalModuleName,
  FunctionalModulePlatform,
  FunctionalModuleProgressPayload,
  FunctionalModuleStartupProgressPayload,
  FunctionalModuleStatus,
} from '@copis/shared'
import { getFunctionalModulesDir } from './config-paths'
import {
  fetchFunctionalModuleManifest,
  getFunctionalModuleStatuses,
  installFunctionalModule,
  type FunctionalModuleFetch,
} from './functional-module-manager'
import {
  getFunctionalModulePaths,
  readActiveFunctionalModule,
} from './functional-module-store'
import { resolvePlaywrightCoreEntrypoint } from './playwright-core-runtime'
import {
  HTTP_API_PORT,
  startHttpApiServer,
  stopHttpApiServer,
  updateHttpApiServer,
  waitForHttpApiHealth,
  type HttpApiSpawn,
} from './http-api-server'

const MODULE_PROGRESS_START = 0.05
const MODULE_PROGRESS_END = 0.95
const HEALTH_PROGRESS_START = 0.95
const HEALTH_PROGRESS_END = 1
const REQUIRED_MODULES: readonly FunctionalModuleName[] = [
  'node-runtime',
  'officecli',
  'alipay-bot',
  'rust-http-api',
  'playwright-core',
  'python-runtime',
]

export interface FunctionalModuleStartupOptions {
  rootDir?: string
  manifestUrl?: string
  skipModuleUpdates?: boolean
  platform?: FunctionalModulePlatform
  arch?: FunctionalModuleArchitecture
  clientVersion?: string
  fetchImpl?: FunctionalModuleFetch
  healthTimeoutMs?: number
  stopTimeoutMs?: number
  spawnImpl?: HttpApiSpawn
  /** 兼容旧版远端 manifest：Playwright Core 已随当前应用打包时可直接使用。 */
  allowBundledPlaywrightCore?: boolean
  onProgress?: (payload: FunctionalModuleStartupProgressPayload) => void
  onModuleProgress?: (payload: FunctionalModuleProgressPayload) => void
}

interface ActiveStartupRun {
  listeners: Set<(payload: FunctionalModuleStartupProgressPayload) => void>
  promise: Promise<FunctionalModuleStatus[]>
}

const activeStartupRuns = new Map<string, ActiveStartupRun>()

export function mapModuleProgress(
  progress: number,
  normalizedStart: number,
  normalizedWeight: number,
): number {
  const clampedProgress = clamp01(progress)
  const start = clamp01(normalizedStart)
  const weight = clamp01(normalizedWeight)
  return MODULE_PROGRESS_START
    + (MODULE_PROGRESS_END - MODULE_PROGRESS_START)
    * Math.min(1, start + weight * clampedProgress)
}

export function mapHealthProgress(progress: number): number {
  return HEALTH_PROGRESS_START
    + (HEALTH_PROGRESS_END - HEALTH_PROGRESS_START) * clamp01(progress)
}

export function toStartupError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const fallback = '必要组件准备失败，请重试'
  if (/secret|token|authorization|credential|password|internal/i.test(message)) {
    return fallback
  }
  if (/health|Rust HTTP API|本地 API|系统核心模块|运行检查/i.test(message)) {
    return '系统核心模块运行检查未通过，请重试'
  }
  if (/manifest|HTTP \d+|下载|响应没有内容|大小不匹配|校验|SHA256|安装|准备|必须是必要组件|缺少必要/i.test(message)) {
    return fallback
  }
  return message.trim() || fallback
}

export function assertRequiredModuleArtifacts(
  artifacts: readonly FunctionalModuleArtifact[],
  options: { allowMissingPlaywrightCore?: boolean } = {},
): void {
  const byName = new Map(artifacts.map((artifact) => [artifact.name, artifact]))
  const officeCli = byName.get('officecli')
  if (!officeCli) throw new Error('组件清单缺少必要的 Office 文档支持')
  if (!officeCli.required) throw new Error('Office 文档支持必须是必要组件')

  const rustApi = byName.get('rust-http-api')
  if (!rustApi) throw new Error('组件清单缺少必要的系统核心模块')
  if (!rustApi.required) throw new Error('系统核心模块必须是必要组件')

  const nodeRuntime = byName.get('node-runtime')
  if (!nodeRuntime) throw new Error('组件清单缺少必要的 Node.js 运行环境')
  if (!nodeRuntime.required) throw new Error('Node.js 运行环境必须是必要组件')
  const nodeEntrypoint = nodeRuntime.platform === 'win32' ? 'bin/node.exe' : 'bin/node'
  if (nodeRuntime.format !== 'tar.gz' || nodeRuntime.entrypoint !== nodeEntrypoint) {
    throw new Error('Node.js 运行环境模块格式不正确')
  }

  const alipayBot = byName.get('alipay-bot')
  if (!alipayBot) throw new Error('组件清单缺少必要的支付宝智能体 CLI')
  if (!alipayBot.required) throw new Error('支付宝智能体 CLI 必须是必要组件')
  const alipayBotEntrypoint = alipayBot.platform === 'win32' ? 'bin/alipay-bot.cmd' : 'bin/alipay-bot'
  if (alipayBot.format !== 'tar.gz' || alipayBot.entrypoint !== alipayBotEntrypoint) {
    throw new Error('支付宝智能体 CLI 模块格式不正确')
  }

  const playwrightCore = byName.get('playwright-core')
  if (playwrightCore) {
    if (!playwrightCore.required) throw new Error('浏览器自动化内核必须是必要组件')
    if (playwrightCore.format !== 'tar.gz' || playwrightCore.entrypoint !== 'node_modules/playwright-core/index.js') {
      throw new Error('浏览器自动化内核模块格式不正确')
    }
  } else if (!options.allowMissingPlaywrightCore) {
    throw new Error('组件清单缺少必要的浏览器自动化内核')
  }

  const pythonRuntime = byName.get('python-runtime')
  if (!pythonRuntime) throw new Error('组件清单缺少必要的 Python 3.12 运行环境')
  if (!pythonRuntime.required) throw new Error('Python 3.12 运行环境必须是必要组件')
  const pythonEntrypoint = pythonRuntime.platform === 'win32' ? 'bin/python.exe' : 'bin/python'
  if (pythonRuntime.format !== 'tar.gz' || pythonRuntime.entrypoint !== pythonEntrypoint) {
    throw new Error('Python 3.12 运行环境模块格式不正确')
  }
}

export function ensureRequiredFunctionalModules(
  options: FunctionalModuleStartupOptions = {},
): Promise<FunctionalModuleStatus[]> {
  const rootDir = options.rootDir ?? getFunctionalModulesDir()
  const existing = activeStartupRuns.get(rootDir)
  if (existing) {
    if (options.onProgress) existing.listeners.add(options.onProgress)
    return existing.promise
  }

  const listeners = new Set<(payload: FunctionalModuleStartupProgressPayload) => void>()
  if (options.onProgress) listeners.add(options.onProgress)
  const publish = (payload: FunctionalModuleStartupProgressPayload): void => {
    for (const listener of listeners) listener(payload)
  }
  const promise = runRequiredModuleStartup({ ...options, rootDir }, publish)
  const active: ActiveStartupRun = { listeners, promise }
  activeStartupRuns.set(rootDir, active)
  const cleanup = (): void => {
    if (activeStartupRuns.get(rootDir) === active) activeStartupRuns.delete(rootDir)
  }
  void promise.then(cleanup, cleanup)
  return promise
}

async function runRequiredModuleStartup(
  options: FunctionalModuleStartupOptions & { rootDir: string },
  publish: (payload: FunctionalModuleStartupProgressPayload) => void,
): Promise<FunctionalModuleStatus[]> {
  try {
    if (options.skipModuleUpdates) return await runDevelopmentHealthCheck(options, publish)

    publish({ phase: 'checking', detail: '正在检查必要组件版本', progress: 0.02 })
    const moduleOptions = createModuleOptions(options)
    const artifacts = await fetchFunctionalModuleManifest(moduleOptions)
    const bundledPlaywrightCoreAvailable = options.allowBundledPlaywrightCore
      && canUseBundledPlaywrightCore(options.rootDir)
    assertRequiredModuleArtifacts(artifacts, {
      allowMissingPlaywrightCore: bundledPlaywrightCoreAvailable,
    })
    const artifactByName = new Map(artifacts.map((artifact) => [artifact.name, artifact]))
    const paths = getFunctionalModulePaths(options.rootDir)
    const totalWeight = Math.max(
      1,
      REQUIRED_MODULES.reduce((sum, name) => sum + (artifactByName.get(name)?.size ?? 0), 0),
    )
    let completedWeight = 0
    let httpApiRuntimeDependenciesUpdated = false

    publish({ phase: 'modules', detail: '正在准备必要组件', progress: MODULE_PROGRESS_START })
    for (const name of REQUIRED_MODULES) {
      const artifact = artifactByName.get(name)
      if (!artifact && name === 'playwright-core' && bundledPlaywrightCoreAvailable) {
        publish({
          phase: 'modules',
          detail: '浏览器自动化内核已随应用准备完成',
          progress: MODULE_PROGRESS_END,
          activeModule: name,
        })
        continue
      }
      if (!artifact) throw new Error(`组件清单缺少必要组件: ${name}`)

      const moduleStart = completedWeight / totalWeight
      const moduleWeight = artifact.size / totalWeight
      const emitModuleProgress = (payload: FunctionalModuleProgressPayload): void => {
        options.onModuleProgress?.(payload)
        publish({
          phase: 'modules',
          detail: payload.detail,
          progress: mapModuleProgress(payload.progress, moduleStart, moduleWeight),
          activeModule: name,
          ...(payload.downloadedBytes === undefined ? {} : { downloadedBytes: payload.downloadedBytes }),
          ...(payload.totalBytes === undefined ? {} : { totalBytes: payload.totalBytes }),
        })
      }

      const active = readActiveFunctionalModule(paths, name)
      const needsUpdate = !active
        || active.version !== artifact.version
        || active.sha256.toLowerCase() !== artifact.sha256.toLowerCase()
      if (needsUpdate) {
        if (name === 'rust-http-api') {
          const updated = await updateHttpApiServer({
            ...createHttpApiOptions(options),
            artifactOverride: artifact,
            onProgress: emitModuleProgress,
            onHealthProgress: (progress) => {
              publish({
                phase: 'health',
                detail: '正在检查本地服务',
                progress: mapHealthProgress(progress),
                activeModule: 'rust-http-api',
              })
            },
          })
          if (!updated) throw new Error('系统核心模块更新后运行检查未通过')
        } else {
          await installFunctionalModule({ name }, {
            ...moduleOptions,
            artifactOverride: artifact,
            onProgress: emitModuleProgress,
          })
          if (name === 'node-runtime' || name === 'officecli' || name === 'alipay-bot' || name === 'playwright-core' || name === 'python-runtime') {
            httpApiRuntimeDependenciesUpdated = true
          }
        }
      } else {
        emitModuleProgress({
          name,
          phase: 'done',
          detail: `${displayName(name)} 已是最新版本 v${artifact.version}`,
          progress: 1,
          version: artifact.version,
        })
      }
      completedWeight += artifact.size
    }

    publish({ phase: 'modules', detail: '必要组件已准备完成', progress: MODULE_PROGRESS_END })
    if (httpApiRuntimeDependenciesUpdated) {
      await stopHttpApiServer(options.stopTimeoutMs)
    }
    if (!await ensureFormalHttpApiHealth(options, publish)) {
      throw new Error('系统核心模块未通过运行检查')
    }
    const statuses = getFunctionalModuleStatuses(options.rootDir).map((status) => {
      const artifact = artifactByName.get(status.name)
      return {
        ...status,
        ...(artifact ? {
          availableVersion: artifact.version,
          updateAvailable: false,
          required: artifact.required,
        } : {}),
      }
    })
    publish({ phase: 'ready', detail: '必要组件已准备完成', progress: 1 })
    return statuses
  } catch (error) {
    const detail = toStartupError(error)
    publish({ phase: 'error', detail, progress: 0, error: detail })
    throw new Error(detail, { cause: error })
  }
}

async function runDevelopmentHealthCheck(
  options: FunctionalModuleStartupOptions & { rootDir: string },
  publish: (payload: FunctionalModuleStartupProgressPayload) => void,
): Promise<FunctionalModuleStatus[]> {
  const healthOptions = {
    fetchImpl: options.fetchImpl,
    healthTimeoutMs: options.healthTimeoutMs,
    onHealthProgress: (progress: number): void => {
      publish({
        phase: 'health',
        detail: '正在检查本地服务',
        progress: mapHealthProgress(progress),
        activeModule: 'rust-http-api',
      })
    },
  }

  startHttpApiServer(createHttpApiOptions(options))
  if (await waitForHttpApiHealth(HTTP_API_PORT, healthOptions)) {
    publish({ phase: 'ready', detail: '本地服务运行正常', progress: 1, activeModule: 'rust-http-api' })
    return []
  }

  await stopHttpApiServer(options.stopTimeoutMs)
  startHttpApiServer(createHttpApiOptions(options))
  if (await waitForHttpApiHealth(HTTP_API_PORT, healthOptions)) {
    publish({ phase: 'ready', detail: '本地服务运行正常', progress: 1, activeModule: 'rust-http-api' })
    return []
  }
  throw new Error('系统核心模块未通过运行检查')
}

async function ensureFormalHttpApiHealth(
  options: FunctionalModuleStartupOptions & { rootDir: string },
  publish: (payload: FunctionalModuleStartupProgressPayload) => void,
): Promise<boolean> {
  startHttpApiServer({
    ...createHttpApiOptions(options),
  })
  const healthOptions = {
    fetchImpl: options.fetchImpl,
    healthTimeoutMs: options.healthTimeoutMs,
    onHealthProgress: (progress: number): void => {
      publish({
        phase: 'health',
        detail: '正在检查本地服务',
        progress: mapHealthProgress(progress),
        activeModule: 'rust-http-api',
      })
    },
  }
  if (await waitForHttpApiHealth(HTTP_API_PORT, healthOptions)) return true

  await stopHttpApiServer(options.stopTimeoutMs)
  startHttpApiServer(createHttpApiOptions(options))
  return waitForHttpApiHealth(HTTP_API_PORT, healthOptions)
}

function createModuleOptions(options: FunctionalModuleStartupOptions & { rootDir: string }): {
  rootDir: string
  manifestUrl?: string
  platform?: FunctionalModulePlatform
  arch?: FunctionalModuleArchitecture
  clientVersion?: string
  fetchImpl?: FunctionalModuleFetch
} {
  return {
    rootDir: options.rootDir,
    ...(options.manifestUrl ? { manifestUrl: options.manifestUrl } : {}),
    ...(options.platform ? { platform: options.platform } : {}),
    ...(options.arch ? { arch: options.arch } : {}),
    ...(options.clientVersion ? { clientVersion: options.clientVersion } : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  }
}

function canUseBundledPlaywrightCore(rootDir: string): boolean {
  try {
    resolvePlaywrightCoreEntrypoint({ isPackaged: true, modulesRoot: rootDir })
    return true
  } catch {
    return false
  }
}

function createHttpApiOptions(options: FunctionalModuleStartupOptions & { rootDir: string }): {
  rootDir: string
  manifestUrl?: string
  platform?: FunctionalModulePlatform
  arch?: FunctionalModuleArchitecture
  clientVersion?: string
  fetchImpl?: FunctionalModuleFetch
  healthTimeoutMs?: number
  stopTimeoutMs?: number
  spawnImpl?: HttpApiSpawn
} {
  return {
    ...createModuleOptions(options),
    ...(options.healthTimeoutMs === undefined ? {} : { healthTimeoutMs: options.healthTimeoutMs }),
    ...(options.stopTimeoutMs === undefined ? {} : { stopTimeoutMs: options.stopTimeoutMs }),
    ...(options.spawnImpl ? { spawnImpl: options.spawnImpl } : {}),
  }
}

function displayName(name: FunctionalModuleName): string {
  if (name === 'node-runtime') return 'Node.js 运行环境'
  if (name === 'officecli') return 'Office 文档支持'
  if (name === 'alipay-bot') return '支付宝智能体 CLI'
  if (name === 'agently-cli') return 'Agent QQ 邮箱 CLI'
  if (name === 'playwright-core') return '浏览器自动化内核'
  if (name === 'python-runtime') return 'Python 3.12 运行环境'
  return '系统核心模块'
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0))
}
