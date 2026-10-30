import { createHash } from 'node:crypto'
import { accessSync, constants, createReadStream, existsSync } from 'node:fs'
import { chmod, lstat, mkdir, open, rename, rm, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type {
  FunctionalModuleArchitecture,
  FunctionalModuleArtifact,
  FunctionalModuleInstallInput,
  FunctionalModuleName,
  FunctionalModulePlatform,
  FunctionalModuleProgressPayload,
  FunctionalModuleStatus,
} from '@copis/shared'
import { isChromeDesktopComponentMetadata } from '@copis/shared'
import { inspectChromeDesktopComponent } from './chrome-desktop-component-client-runtime'
import { getFunctionalModulesDir } from './config-paths'
import { FunctionalModuleNotPublishedError, getFunctionalModuleManifestUrl, parseFunctionalModuleManifest } from './functional-module-manifest'
import {
  activateFunctionalModule,
  assembleFunctionalModule,
  cacheFunctionalModule,
  getFunctionalModulePaths,
  hasActiveFunctionalModuleRecord,
  readActiveFunctionalModule,
  type FunctionalModulePackage,
} from './functional-module-store'

interface FunctionalModuleDefinition {
  name: FunctionalModuleName
  displayName: string
  required: boolean
  platforms?: readonly FunctionalModulePlatform[]
}

const MODULE_DEFINITIONS: readonly FunctionalModuleDefinition[] = [
  { name: 'node-runtime', displayName: 'Node.js 运行环境', required: true },
  { name: 'rust-http-api', displayName: '系统核心模块', required: true },
  { name: 'officecli', displayName: 'Office 文档支持', required: true },
  { name: 'alipay-bot', displayName: '支付宝智能体 CLI', required: true },
  { name: 'playwright-core', displayName: '浏览器自动化内核', required: true },
  { name: 'python-runtime', displayName: 'Python 3.12 运行环境', required: true },
  { name: 'agently-cli', displayName: 'Agent QQ 邮箱 CLI', required: false },
  { name: 'dsh', displayName: '创造模式', required: false },
  { name: 'chrome-desktop-cli', displayName: 'MCC · Chrome 桌面自动化', required: false, platforms: ['darwin'] },
  { name: 'codex-cli', displayName: '专业模式', required: false },
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
  /** DSH 和 Chrome 组件默认按独立契约检查更新；显式 true 时仍检查主程序最低版本。 */
  checkClientVersion?: boolean
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
    { checkClientVersion: options.checkClientVersion },
  )
}

export function getFunctionalModuleStatuses(
  rootDir = getFunctionalModulesDir(),
  platform: FunctionalModulePlatform = normalizePlatform(process.platform),
): FunctionalModuleStatus[] {
  return MODULE_DEFINITIONS.filter(definition => !definition.platforms || definition.platforms.includes(platform)).map((definition) => getFunctionalModuleStatus(definition.name, rootDir))
}

export function getFunctionalModuleStatus(
  name: FunctionalModuleName,
  rootDir = getFunctionalModulesDir(),
  arch = normalizeArchitecture(process.arch),
): FunctionalModuleStatus {
  const definition = getModuleDefinition(name)
  const paths = getFunctionalModulePaths(rootDir)
  const active = readActiveFunctionalModule(paths, name)
  let localIssue: FunctionalModuleStatus['localIssue']
  if (name === 'chrome-desktop-cli') {
    if (!active && hasActiveFunctionalModuleRecord(paths, name)) localIssue = 'invalid-installation'
    if (active) {
      if (basename(active.path) === 'copis-chrome') localIssue = 'upgrade-required'
      else {
        try {
          const installation = inspectChromeDesktopComponent(rootDir, active, arch)
          accessSync(installation.helperPath, constants.X_OK)
        } catch { localIssue = 'invalid-installation' }
      }
    }
  }
  return {
    name,
    displayName: definition.displayName,
    installed: Boolean(active) && !localIssue,
    version: active?.version ?? null,
    path: active?.path ?? null,
    availableVersion: null,
    updateAvailable: false,
    required: active?.required ?? definition.required,
    error: localIssue === 'upgrade-required' ? '旧版 Chrome 组件需要升级为 MCC'
      : localIssue ? '本地 MCC 组件文件异常，暂不可用' : null,
    ...(localIssue ? { localIssue } : {}),
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
  try {
    const artifact = await resolveFunctionalModuleArtifact(name, options)
    const current = getFunctionalModuleStatus(name, rootDir, options.arch)
    const active = readActiveFunctionalModule(getFunctionalModulePaths(rootDir), name)
    return {
      ...current,
      displayName: definition.displayName,
      required: artifact.required,
      availableVersion: artifact.version,
      updateAvailable: !current.installed || !active
        || active.version !== artifact.version
        || active.sha256.toLowerCase() !== artifact.sha256.toLowerCase(),
    }
  } catch (error) {
    return {
      ...getFunctionalModuleStatus(name, rootDir, options.arch),
      updateError: {
        code: error instanceof FunctionalModuleNotPublishedError ? 'not-published' : 'check-failed',
        message: toErrorMessage(error),
      },
    }
  }
}

export async function resolveFunctionalModuleArtifact(
  name: FunctionalModuleName,
  options: FunctionalModuleManagerOptions = {},
): Promise<FunctionalModuleArtifact> {
  const definition = getModuleDefinition(name)
  assertModulePlatform(definition, options.platform ?? normalizePlatform(process.platform))
  if (options.artifactOverride) {
    if (options.artifactOverride.name !== name) {
      throw new Error(`功能模块 manifest 与目标不匹配: ${name}`)
    }
    return ensureRequiredArtifact(definition, options.artifactOverride, options.arch ?? normalizeArchitecture(process.arch))
  }
  // DSH 和 Chrome 组件使用独立版本/协议，不默认受全平台主程序版本门槛拦截。
  const checkClientVersion = options.checkClientVersion ?? (name !== 'dsh' && name !== 'chrome-desktop-cli')
  const artifact = (await fetchFunctionalModuleManifest({ ...options, checkClientVersion })).find((item) => item.name === name)
  if (!artifact) throw new FunctionalModuleNotPublishedError(`当前平台没有功能模块: ${name}`)
  return ensureRequiredArtifact(definition, artifact, options.arch ?? normalizeArchitecture(process.arch))
}

function assertModulePlatform(definition: FunctionalModuleDefinition, platform: FunctionalModulePlatform): void {
  if (definition.platforms && !definition.platforms.includes(platform)) {
    throw new Error(`${definition.name} 仅支持 macOS (darwin)，不支持 ${platform}`)
  }
}

function ensureRequiredArtifact(
  definition: FunctionalModuleDefinition,
  artifact: FunctionalModuleArtifact,
  arch: FunctionalModuleArchitecture,
): FunctionalModuleArtifact {
  if (definition.required && !artifact.required) {
    throw new Error(`${definition.displayName} 必须是必选模块`)
  }
  if (definition.name === 'chrome-desktop-cli') {
    const entrypoint = `copis-chrome-${artifact.version}-darwin-${arch}/mcc`
    if (artifact.platform !== 'darwin' || artifact.arch !== arch || artifact.required
      || artifact.format !== 'tar.gz' || artifact.entrypoint !== entrypoint) {
      throw new Error('Chrome 模块必须使用对应版本和架构的 macOS 可选归档与顶层入口')
    }
  }
  return artifact
}

export async function installFunctionalModule(
  input: FunctionalModuleInstallInput,
  options: FunctionalModuleManagerOptions = {},
): Promise<FunctionalModuleStatus> {
  const definition = getModuleDefinition(input.name)
  assertModulePlatform(definition, options.platform ?? normalizePlatform(process.platform))
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
  assertModulePlatform(definition, options.platform ?? normalizePlatform(process.platform))
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
  await validateChromeDesktopModule(prepared)
  const paths = getFunctionalModulePaths(rootDir)
  await activateFunctionalModule(paths, prepared.packageInfo, prepared.versionDir)
  return statusWithArtifact(getFunctionalModuleStatus(prepared.artifact.name, rootDir, prepared.artifact.arch), prepared.artifact)
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
    emit({ phase: 'manifest', detail: '正在获取组件版本信息', progress: 0.04 })
    const artifact = await resolveFunctionalModuleArtifact(input.name, options)
    const current = readActiveFunctionalModule(paths, input.name)
    if (!input.force && getFunctionalModuleStatus(input.name, rootDir, options.arch).installed
      && current?.version === artifact.version
      && current.sha256.toLowerCase() === artifact.sha256.toLowerCase()) {
      emit({ phase: 'done', detail: `已是最新版本 v${artifact.version}`, progress: 1, version: artifact.version })
      return statusWithArtifact(getFunctionalModuleStatus(input.name, rootDir, options.arch), artifact)
    }

    const prepared = await prepareFunctionalModuleInner(input, options, definition, emit, artifact)
    emit({ phase: 'activate', detail: `正在启用 ${definition.displayName}`, progress: 0.94, version: artifact.version })
    await activatePreparedFunctionalModule(prepared, rootDir)
    emit({ phase: 'done', detail: `${definition.displayName} v${artifact.version} 已就绪`, progress: 1, version: artifact.version })
    return statusWithArtifact(getFunctionalModuleStatus(input.name, rootDir, options.arch), artifact)
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
      emitProgress({ phase: 'manifest', detail: '正在获取组件版本信息', progress: 0.04 })
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
    emitProgress({ phase: 'verify', detail: '正在校验组件', progress: 0.78, version: artifact.version })
    const verifiedSha256 = await sha256File(artifactPath)
    if (verifiedSha256 !== artifact.sha256.toLowerCase()) {
      throw new Error(`功能模块校验失败：期望 ${artifact.sha256}，实际 ${verifiedSha256}`)
    }

    emitProgress({ phase: 'install', detail: `正在安装 ${definition.displayName}`, progress: 0.84, version: artifact.version })
    await cacheFunctionalModule(paths, packageInfo, artifactPath)
    const versionDir = await assembleFunctionalModule(paths, packageInfo)
    const prepared = { artifact, packageInfo, versionDir }
    await validateChromeDesktopModule(prepared)
    return prepared
  } catch (error) {
    throw new Error(`准备${definition.displayName}失败: ${toErrorMessage(error)}`, { cause: error })
  }
}

/** prepare 与激活分别校验，避免准备后的 metadata 损坏被写入 active 指针。 */
async function validateChromeDesktopModule(prepared: PreparedFunctionalModule): Promise<void> {
  const { artifact, packageInfo, versionDir } = prepared
  if (artifact.name !== 'chrome-desktop-cli' && packageInfo.name !== 'chrome-desktop-cli') return
  if (artifact.name !== packageInfo.name || artifact.version !== packageInfo.version || artifact.entrypoint !== packageInfo.entrypoint) {
    throw new Error('Chrome 模块元数据与待激活版本不一致')
  }
  ensureRequiredArtifact(getModuleDefinition('chrome-desktop-cli'), artifact, artifact.arch)
  const componentDir = dirname(join(versionDir, packageInfo.entrypoint))
  const metadataPath = join(componentDir, 'module.json')
  const limit = 64 * 1024
  let metadata: unknown
  try {
    const before = await lstat(metadataPath)
    if (!before.isFile() || before.nlink !== 1 || before.size <= 0 || before.size > limit) {
      throw new Error('module.json 必须是 64 KiB 内的普通文件')
    }
    const handle = await open(metadataPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const opened = await handle.stat()
      if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) {
        throw new Error('module.json 在打开时发生变化')
      }
      const buffer = Buffer.alloc(limit + 1)
      let length = 0
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null)
        if (!bytesRead) break
        length += bytesRead
      }
      if (!length || length > limit) throw new Error('module.json 超过读取上限或内容为空')
      metadata = JSON.parse(buffer.subarray(0, length).toString('utf8'))
    } finally {
      await handle.close()
    }
  } catch (error) {
    throw new Error('Chrome 模块元数据读取失败或不是有效 JSON', { cause: error })
  }
  if (!isChromeDesktopComponentMetadata(metadata, { version: packageInfo.version, arch: artifact.arch })) {
    throw new Error('Chrome 模块元数据的名称、版本、平台、架构、协议或入口不匹配')
  }
  const helperPath = join(componentDir, metadata.helper)
  if (!(await lstat(helperPath)).isFile()) throw new Error('Chrome 模块 helper 必须是普通文件')
  // store 只为入口和 bin/ 文件设置权限；元数据通过后才允许修改同级 helper 的执行位。
  await chmod(helperPath, 0o755)
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
