import { createHash } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { mkdir, open, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  FunctionalModuleArchitecture,
  FunctionalModuleArtifact,
  FunctionalModuleInstallInput,
  FunctionalModuleName,
  FunctionalModulePlatform,
  FunctionalModuleProgressPayload,
  FunctionalModuleStatus,
} from '@copis/shared'
import { getFunctionalModulesDir } from './config-paths'
import { getFunctionalModuleManifestUrl, parseFunctionalModuleManifest } from './functional-module-manifest'
import {
  activateFunctionalModule,
  assembleFunctionalModule,
  cacheFunctionalModule,
  getFunctionalModulePaths,
  readActiveFunctionalModule,
  type FunctionalModulePackage,
} from './functional-module-store'

interface FunctionalModuleDefinition {
  name: FunctionalModuleName
  displayName: string
  required: boolean
}

const MODULE_DEFINITIONS: readonly FunctionalModuleDefinition[] = [
  { name: 'rust-http-api', displayName: 'Rust HTTP API', required: true },
  { name: 'officecli', displayName: 'OfficeCLI', required: true },
]

export type FunctionalModuleFetch = (
  input: string,
  init?: RequestInit,
) => Promise<Response>

export interface FunctionalModuleManagerOptions {
  rootDir?: string
  manifestUrl?: string
  platform?: FunctionalModulePlatform
  arch?: FunctionalModuleArchitecture
  clientVersion?: string
  fetchImpl?: FunctionalModuleFetch
  onProgress?: (payload: FunctionalModuleProgressPayload) => void
  artifactOverride?: FunctionalModuleArtifact
}

export interface PreparedFunctionalModule {
  artifact: FunctionalModuleArtifact
  packageInfo: FunctionalModulePackage
  versionDir: string
}

const activeInstalls = new Map<string, Promise<FunctionalModuleStatus>>()
const activePrepares = new Map<string, Promise<PreparedFunctionalModule>>()

export async function fetchFunctionalModuleManifest(
  options: FunctionalModuleManagerOptions = {},
): Promise<FunctionalModuleArtifact[]> {
  const manifestUrl = options.manifestUrl ?? getFunctionalModuleManifestUrl()
  if (!manifestUrl) throw new Error('功能模块 manifest 地址未配置')

  const fetchImpl = options.fetchImpl ?? fetch
  const response = await fetchImpl(manifestUrl, {
    redirect: 'follow',
    headers: {
      Accept: 'application/json',
      'User-Agent': 'Copis-Desktop-App',
    },
  })
  if (!response.ok) throw new Error(`获取功能模块 manifest 失败: HTTP ${response.status}`)

  const json = await response.text()
  return parseFunctionalModuleManifest(
    json,
    options.clientVersion ?? process.env.COPIS_VERSION ?? '0.0.0',
    options.platform ?? normalizePlatform(process.platform),
    options.arch ?? normalizeArchitecture(process.arch),
  )
}

export function getFunctionalModuleStatuses(rootDir = getFunctionalModulesDir()): FunctionalModuleStatus[] {
  return MODULE_DEFINITIONS.map((definition) => getFunctionalModuleStatus(definition.name, rootDir))
}

export function getFunctionalModuleStatus(
  name: FunctionalModuleName,
  rootDir = getFunctionalModulesDir(),
): FunctionalModuleStatus {
  const definition = getModuleDefinition(name)
  const active = readActiveFunctionalModule(getFunctionalModulePaths(rootDir), name)
  return {
    name,
    displayName: definition.displayName,
    installed: Boolean(active),
    version: active?.version ?? null,
    path: active?.path ?? null,
    availableVersion: null,
    updateAvailable: false,
    required: active?.required ?? definition.required,
    error: null,
  }
}

export function getFunctionalModulePath(
  name: FunctionalModuleName,
  rootDir = getFunctionalModulesDir(),
): string | undefined {
  getModuleDefinition(name)
  return readActiveFunctionalModule(getFunctionalModulePaths(rootDir), name)?.path
}

export async function checkFunctionalModule(
  name: FunctionalModuleName,
  options: FunctionalModuleManagerOptions = {},
): Promise<FunctionalModuleStatus> {
  const definition = getModuleDefinition(name)
  const rootDir = options.rootDir ?? getFunctionalModulesDir()
  const current = getFunctionalModuleStatus(name, rootDir)

  try {
    const artifact = await resolveFunctionalModuleArtifact(name, options)
    const active = readActiveFunctionalModule(getFunctionalModulePaths(rootDir), name)
    return {
      ...current,
      displayName: definition.displayName,
      required: artifact.required,
      availableVersion: artifact.version,
      updateAvailable: !active
        || active.version !== artifact.version
        || active.sha256.toLowerCase() !== artifact.sha256.toLowerCase(),
      error: null,
    }
  } catch (error) {
    return {
      ...current,
      error: toErrorMessage(error),
    }
  }
}

export async function resolveFunctionalModuleArtifact(
  name: FunctionalModuleName,
  options: FunctionalModuleManagerOptions = {},
): Promise<FunctionalModuleArtifact> {
  const definition = getModuleDefinition(name)
  if (options.artifactOverride) {
    if (options.artifactOverride.name !== name) {
      throw new Error(`功能模块 manifest 与目标不匹配: ${name}`)
    }
    return ensureRequiredArtifact(definition, options.artifactOverride)
  }
  const artifact = (await fetchFunctionalModuleManifest(options)).find((item) => item.name === name)
  if (!artifact) throw new Error(`当前平台没有功能模块: ${name}`)
  return ensureRequiredArtifact(definition, artifact)
}

function ensureRequiredArtifact(
  definition: FunctionalModuleDefinition,
  artifact: FunctionalModuleArtifact,
): FunctionalModuleArtifact {
  if (definition.required && !artifact.required) {
    throw new Error(`${definition.displayName} 必须是必选模块`)
  }
  return artifact
}

export async function installFunctionalModule(
  input: FunctionalModuleInstallInput,
  options: FunctionalModuleManagerOptions = {},
): Promise<FunctionalModuleStatus> {
  const definition = getModuleDefinition(input.name)
  const rootDir = options.rootDir ?? getFunctionalModulesDir()
  const key = `${rootDir}:${input.name}`
  const existing = activeInstalls.get(key)
  if (existing) return existing

  const operation = installFunctionalModuleInner(input, { ...options, rootDir }, definition)
  activeInstalls.set(key, operation)
  try {
    return await operation
  } finally {
    if (activeInstalls.get(key) === operation) activeInstalls.delete(key)
  }
}

export async function prepareFunctionalModule(
  input: FunctionalModuleInstallInput,
  options: FunctionalModuleManagerOptions = {},
): Promise<PreparedFunctionalModule> {
  const definition = getModuleDefinition(input.name)
  const rootDir = options.rootDir ?? getFunctionalModulesDir()
  const key = `${rootDir}:${input.name}`
  const existing = activePrepares.get(key)
  if (existing) return existing

  const operation = prepareFunctionalModuleInner(input, { ...options, rootDir }, definition)
  activePrepares.set(key, operation)
  try {
    return await operation
  } finally {
    if (activePrepares.get(key) === operation) activePrepares.delete(key)
  }
}

export async function activatePreparedFunctionalModule(
  prepared: PreparedFunctionalModule,
  rootDir = getFunctionalModulesDir(),
): Promise<FunctionalModuleStatus> {
  const paths = getFunctionalModulePaths(rootDir)
  await activateFunctionalModule(paths, prepared.packageInfo, prepared.versionDir)
  return statusWithArtifact(getFunctionalModuleStatus(prepared.artifact.name, rootDir), prepared.artifact)
}

async function installFunctionalModuleInner(
  input: FunctionalModuleInstallInput,
  options: FunctionalModuleManagerOptions,
  definition: FunctionalModuleDefinition,
): Promise<FunctionalModuleStatus> {
  const rootDir = options.rootDir ?? getFunctionalModulesDir()
  const paths = getFunctionalModulePaths(rootDir)
  const emit = (payload: Omit<FunctionalModuleProgressPayload, 'name'>): void => {
    options.onProgress?.({ name: input.name, ...payload })
  }

  try {
    emit({ phase: 'manifest', detail: '正在获取功能模块版本信息', progress: 0.04 })
    const artifact = await resolveFunctionalModuleArtifact(input.name, options)
    const current = readActiveFunctionalModule(paths, input.name)
    if (!input.force
      && current?.version === artifact.version
      && current.sha256.toLowerCase() === artifact.sha256.toLowerCase()) {
      emit({ phase: 'done', detail: `已是最新版本 v${artifact.version}`, progress: 1, version: artifact.version })
      return statusWithArtifact(getFunctionalModuleStatus(input.name, rootDir), artifact)
    }

    const prepared = await prepareFunctionalModuleInner(input, options, definition, emit, artifact)
    emit({ phase: 'activate', detail: `正在启用 ${definition.displayName}`, progress: 0.94, version: artifact.version })
    await activateFunctionalModule(paths, prepared.packageInfo, prepared.versionDir)
    emit({ phase: 'done', detail: `${definition.displayName} v${artifact.version} 已就绪`, progress: 1, version: artifact.version })
    return statusWithArtifact(getFunctionalModuleStatus(input.name, rootDir), artifact)
  } catch (error) {
    const detail = toErrorMessage(error)
    emit({ phase: 'error', detail, progress: 1 })
    throw new Error(`安装${definition.displayName}失败: ${detail}`, { cause: error })
  }
}

async function prepareFunctionalModuleInner(
  input: FunctionalModuleInstallInput,
  options: FunctionalModuleManagerOptions,
  definition: FunctionalModuleDefinition,
  emit?: (payload: Omit<FunctionalModuleProgressPayload, 'name'>) => void,
  artifactOverride?: FunctionalModuleArtifact,
): Promise<PreparedFunctionalModule> {
  const rootDir = options.rootDir ?? getFunctionalModulesDir()
  const paths = getFunctionalModulePaths(rootDir)
  const emitProgress = emit ?? ((payload: Omit<FunctionalModuleProgressPayload, 'name'>): void => {
    options.onProgress?.({ name: input.name, ...payload })
  })

  try {
    if (!artifactOverride) {
      emitProgress({ phase: 'manifest', detail: '正在获取功能模块版本信息', progress: 0.04 })
    }
    const artifact = artifactOverride ?? await resolveFunctionalModuleArtifact(input.name, options)
    const packageInfo: FunctionalModulePackage = {
      name: artifact.name,
      version: artifact.version,
      sha256: artifact.sha256,
      size: artifact.size,
      format: artifact.format,
      entrypoint: artifact.entrypoint,
      required: artifact.required,
    }
    const artifactPath = await downloadFunctionalModule(
      artifact,
      definition.displayName,
      paths.downloadsDir,
      emitProgress,
      options.fetchImpl ?? fetch,
    )
    emitProgress({ phase: 'verify', detail: '正在校验功能模块', progress: 0.78, version: artifact.version })
    const verifiedSha256 = await sha256File(artifactPath)
    if (verifiedSha256 !== artifact.sha256.toLowerCase()) {
      throw new Error(`功能模块校验失败：期望 ${artifact.sha256}，实际 ${verifiedSha256}`)
    }

    emitProgress({ phase: 'install', detail: `正在安装 ${definition.displayName}`, progress: 0.84, version: artifact.version })
    await cacheFunctionalModule(paths, packageInfo, artifactPath)
    const versionDir = await assembleFunctionalModule(paths, packageInfo)
    return { artifact, packageInfo, versionDir }
  } catch (error) {
    throw new Error(`准备${definition.displayName}失败: ${toErrorMessage(error)}`, { cause: error })
  }
}

async function downloadFunctionalModule(
  artifact: FunctionalModuleArtifact,
  displayName: string,
  downloadsDir: string,
  emit: (payload: Omit<FunctionalModuleProgressPayload, 'name'>) => void,
  fetchImpl: FunctionalModuleFetch,
): Promise<string> {
  await mkdir(downloadsDir, { recursive: true })
  const checksum = artifact.sha256.toLowerCase()
  const target = join(downloadsDir, `${checksum}.artifact`)
  if (await isVerifiedArtifact(target, artifact)) return target

  const partial = join(downloadsDir, `${checksum}.partial`)
  try {
    await rm(partial, { force: true })
    const response = await fetchImpl(artifact.url, {
      redirect: 'follow',
      headers: { Accept: 'application/octet-stream', 'User-Agent': 'Copis-Desktop-App' },
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`)
    if (!response.body) throw new Error('下载响应没有内容')

    const declaredSize = Number(response.headers.get('content-length') ?? 0)
    if (declaredSize > 0 && declaredSize !== artifact.size) {
      throw new Error(`下载大小不匹配：期望 ${artifact.size}，实际 ${declaredSize}`)
    }

    const file = await open(partial, 'w')
    const reader = response.body.getReader()
    let downloadedBytes = 0
    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        if (!chunk.value) continue
        await file.write(chunk.value)
        downloadedBytes += chunk.value.byteLength
        const ratio = artifact.size === 0 ? 1 : downloadedBytes / artifact.size
        emit({
          phase: 'download',
          detail: `正在下载 ${displayName}`,
          progress: 0.1 + Math.min(1, ratio) * 0.62,
          downloadedBytes,
          totalBytes: artifact.size,
          version: artifact.version,
        })
      }
    } finally {
      await file.close()
      reader.releaseLock()
    }

    if (downloadedBytes !== artifact.size) {
      throw new Error(`下载大小不匹配：期望 ${artifact.size}，实际 ${downloadedBytes}`)
    }
    emit({
      phase: 'download',
      detail: `已下载 ${displayName}`,
      progress: 0.72,
      downloadedBytes,
      totalBytes: artifact.size,
      version: artifact.version,
    })
    await rm(target, { force: true })
    await rename(partial, target)
    if (!(await isVerifiedArtifact(target, artifact))) {
      await rm(target, { force: true })
      throw new Error(`下载文件校验失败（SHA256 不匹配）: ${displayName}`)
    }
    return target
  } catch (error) {
    await rm(partial, { force: true })
    throw new Error(`下载${displayName}失败: ${toErrorMessage(error)}`, { cause: error })
  }
}

async function isVerifiedArtifact(path: string, artifact: FunctionalModuleArtifact): Promise<boolean> {
  if (!existsSync(path)) return false
  const fileStats = await stat(path).catch(() => undefined)
  if (!fileStats?.isFile() || fileStats.size !== artifact.size) return false
  return (await sha256File(path)) === artifact.sha256.toLowerCase()
}

function statusWithArtifact(
  status: FunctionalModuleStatus,
  artifact: FunctionalModuleArtifact,
): FunctionalModuleStatus {
  return {
    ...status,
    availableVersion: artifact.version,
    updateAvailable: false,
    required: artifact.required,
    error: null,
  }
}

function getModuleDefinition(name: FunctionalModuleName): FunctionalModuleDefinition {
  const definition = MODULE_DEFINITIONS.find((item) => item.name === name)
  if (!definition) throw new Error(`未知功能模块: ${name}`)
  return definition
}

function normalizePlatform(platform: NodeJS.Platform): FunctionalModulePlatform {
  if (platform === 'darwin' || platform === 'linux' || platform === 'win32') return platform
  throw new Error(`当前平台暂不支持功能模块: ${platform}`)
}

function normalizeArchitecture(arch: string): FunctionalModuleArchitecture {
  if (arch === 'arm64' || arch === 'x64') return arch
  throw new Error(`当前架构暂不支持功能模块: ${arch}`)
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  const stream = createReadStream(path)
  for await (const chunk of stream) hash.update(chunk)
  return hash.digest('hex')
}
