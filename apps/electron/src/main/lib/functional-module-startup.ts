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
import {
  HTTP_API_PORT,
  startHttpApiServer,
  stopHttpApiServer,
  syncWorkingAccessToken,
  updateHttpApiServer,
  waitForHttpApiHealth,
  type HttpApiSpawn,
} from './http-api-server'
import { getWorkingTokenStore } from './working-auth-store'

const MODULE_PROGRESS_START = 0.05
const MODULE_PROGRESS_END = 0.95
const HEALTH_PROGRESS_START = 0.95
const HEALTH_PROGRESS_END = 1
const REQUIRED_MODULES: readonly FunctionalModuleName[] = ['officecli', 'rust-http-api']

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
  if (/secret|token|authorization|credential|password|internal/i.test(message)) {
    return '功能模块更新失败，请重试'
  }
  return message.trim() || '功能模块更新失败，请重试'
}

export function assertRequiredModuleArtifacts(
  artifacts: readonly FunctionalModuleArtifact[],
): void {
  const byName = new Map(artifacts.map((artifact) => [artifact.name, artifact]))
  const officeCli = byName.get('officecli')
  if (!officeCli) throw new Error('功能模块 manifest 缺少必选模块 OfficeCLI')
  if (!officeCli.required) throw new Error('OfficeCLI 必须是必选模块')

  const rustApi = byName.get('rust-http-api')
  if (!rustApi) throw new Error('功能模块 manifest 缺少必选模块 Rust HTTP API')
  if (!rustApi.required) throw new Error('Rust HTTP API 必须是必选模块')
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

    publish({ phase: 'checking', detail: '正在检查功能模块版本', progress: 0.02 })
    const moduleOptions = createModuleOptions(options)
    const artifacts = await fetchFunctionalModuleManifest(moduleOptions)
    assertRequiredModuleArtifacts(artifacts)
    const artifactByName = new Map(artifacts.map((artifact) => [artifact.name, artifact]))
    const paths = getFunctionalModulePaths(options.rootDir)
    const totalWeight = Math.max(
      1,
      REQUIRED_MODULES.reduce((sum, name) => sum + (artifactByName.get(name)?.size ?? 0), 0),
    )
    let completedWeight = 0

    publish({ phase: 'modules', detail: '正在准备功能模块', progress: MODULE_PROGRESS_START })
    for (const name of REQUIRED_MODULES) {
      const artifact = artifactByName.get(name)
      if (!artifact) throw new Error(`功能模块 manifest 缺少必选模块: ${name}`)

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
                detail: '正在检查本地 API',
                progress: mapHealthProgress(progress),
                activeModule: 'rust-http-api',
              })
            },
          })
          if (!updated) throw new Error('Rust HTTP API 更新后健康检查失败')
        } else {
          await installFunctionalModule({ name }, {
            ...moduleOptions,
            artifactOverride: artifact,
            onProgress: emitModuleProgress,
          })
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

    publish({ phase: 'modules', detail: '功能模块已准备完成', progress: MODULE_PROGRESS_END })
    if (!await ensureFormalHttpApiHealth(options, publish)) {
      throw new Error('本地 Rust HTTP API 未通过 health 检查')
    }
    await syncWorkingAccessToken(getWorkingTokenStore().getToken())
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
    publish({ phase: 'ready', detail: '所有功能模块已就绪', progress: 1 })
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
        detail: '正在检查本地 API',
        progress: mapHealthProgress(progress),
        activeModule: 'rust-http-api',
      })
    },
  }

  startHttpApiServer(createHttpApiOptions(options))
  if (await waitForHttpApiHealth(HTTP_API_PORT, healthOptions)) {
    publish({ phase: 'ready', detail: '本地 API 已通过 health 检查', progress: 1, activeModule: 'rust-http-api' })
    return []
  }

  await stopHttpApiServer(options.stopTimeoutMs)
  startHttpApiServer(createHttpApiOptions(options))
  if (await waitForHttpApiHealth(HTTP_API_PORT, healthOptions)) {
    publish({ phase: 'ready', detail: '本地 API 已通过 health 检查', progress: 1, activeModule: 'rust-http-api' })
    return []
  }
  throw new Error('开发模式本地 Rust HTTP API 未通过 health 检查')
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
        detail: '正在检查本地 API',
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
  return name === 'officecli' ? 'OfficeCLI' : 'Rust HTTP API'
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0))
}
