import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import type {
  FunctionalModuleArchitecture,
  FunctionalModuleClientUpdate,
  FunctionalModuleFormat,
  FunctionalModuleManifest,
  FunctionalModuleName,
  FunctionalModulePlatform,
} from '@copis/shared'

export interface FunctionalModuleBinaryInput {
  module: FunctionalModuleName
  version: string
  platform: FunctionalModulePlatform
  arch: FunctionalModuleArchitecture
  binaryPath: string
  required: boolean
  format?: FunctionalModuleFormat
  entrypoint?: string
}

export interface FunctionalModuleReleaseInput {
  channel: string
  clientMinVersion?: string
  clientUpdate?: FunctionalModuleClientUpdate
  publicBaseUrl: string
  prefix?: string
  modules: readonly FunctionalModuleBinaryInput[]
}

export interface FunctionalModuleUploadEntry {
  key: string
  url: string
  path?: string
  body?: Buffer
  size: number
  sha256: string
  contentType: string
  allowOverwrite?: boolean
}

export interface FunctionalModulePutObjectOptions {
  allowOverwrite?: boolean
}

export interface FunctionalModuleRelease {
  manifest: FunctionalModuleManifest
  binaries: FunctionalModuleUploadEntry[]
  manifestEntry: FunctionalModuleUploadEntry
}

export interface FunctionalModuleVersionBump {
  module: FunctionalModuleName
  fromVersion: string
  toVersion: string
}

export interface ResolvedFunctionalModuleRelease {
  release: FunctionalModuleRelease
  versionBumps: FunctionalModuleVersionBump[]
}

export interface ImmutableVersionResolutionOptions {
  /** 锁定模块在同版本对象内容变化时必须修改版本配置，禁止自动递增。 */
  lockedModules?: readonly FunctionalModuleName[]
}

export interface FunctionalModuleObjectUpload {
  key: string
  body: Buffer
  contentType: string
  cacheControl?: string
  contentDisposition?: string
  metadata: Record<string, string>
  allowOverwrite?: boolean
}

export interface FunctionalModuleObjectClient {
  putObject(input: FunctionalModuleObjectUpload, options?: FunctionalModulePutObjectOptions): Promise<void>
  headObject(input: { key: string }): Promise<{ size: number; sha256?: string }>
}

export function buildFunctionalModuleRelease(input: FunctionalModuleReleaseInput): FunctionalModuleRelease {
  validateReleaseInput(input)
  const baseUrl = input.publicBaseUrl.replace(/\/+$/, '')
  const prefix = normalizePrefix(input.prefix)
  const platforms: FunctionalModuleManifest['platforms'] = {}
  const binaries: FunctionalModuleUploadEntry[] = []
  const seen = new Set<string>()

  for (const module of input.modules) {
    const platformKey = `${module.platform}-${module.arch}`
    const moduleKey = `${platformKey}:${module.module}`
    if (seen.has(moduleKey)) throw new Error(`重复发布功能模块: ${moduleKey}`)
    seen.add(moduleKey)

    const metadata = readBinaryMetadata(module.binaryPath)
    const format = module.format ?? 'binary'
    const binarySuffix = format === 'binary' && module.platform === 'win32' ? '.exe' : ''
    const archiveSuffix = format === 'tar.gz' ? '.tar.gz' : ''
    const objectKey = `${prefix}${input.channel}/${platformKey}/${module.module}-${module.version}${binarySuffix}${archiveSuffix}`
    const artifact = {
      version: module.version,
      url: `${baseUrl}/${objectKey}`,
      sha256: metadata.sha256,
      size: metadata.size,
      format,
      entrypoint: module.entrypoint ?? getModuleEntrypoint(module.module, binarySuffix),
      required: module.required,
    }
    const platform = platforms[platformKey] ?? { modules: {} }
    if (platform.modules[module.module]) throw new Error(`重复发布功能模块: ${moduleKey}`)
    platform.modules[module.module] = artifact
    platforms[platformKey] = platform
    binaries.push({
      key: objectKey,
      url: artifact.url,
      path: module.binaryPath,
      size: metadata.size,
      sha256: metadata.sha256,
      contentType: 'application/octet-stream',
    })
  }

  const client = {
    ...(input.clientMinVersion ? { minVersion: input.clientMinVersion } : {}),
    ...(input.clientUpdate ? { update: input.clientUpdate } : {}),
  }
  const manifest: FunctionalModuleManifest = {
    schema: 1,
    channel: input.channel,
    ...(Object.keys(client).length > 0 ? { client } : {}),
    platforms,
  }
  const manifestEntry = buildFunctionalModuleManifestUpload({
    channel: input.channel,
    publicBaseUrl: baseUrl,
    prefix,
    manifest,
  })

  return { manifest, binaries, manifestEntry }
}

/**
 * 为内容发生变化的不可变二进制自动递增 patch 版本。
 *
 * 同版本、同 SHA 的发布保持幂等；只有 COS 已存在同 key 但内容不同，
 * 才为对应模块生成下一个 patch 版本。manifest 始终由调用方使用返回的 release 生成。
 */
export async function resolveImmutableModuleVersions(
  input: FunctionalModuleReleaseInput,
  client: FunctionalModuleObjectClient,
  options: ImmutableVersionResolutionOptions = {},
): Promise<ResolvedFunctionalModuleRelease> {
  const modules = input.modules.map((module) => ({ ...module }))
  const initialVersions = new Map(modules.map((module) => [module.module, module.version]))

  for (let attempt = 0; attempt < 100; attempt += 1) {
    const release = buildFunctionalModuleRelease({ ...input, modules })
    const collisions = await Promise.all(release.binaries.map(async (entry, index) => (
      await hasImmutableObjectCollision(entry, client) ? index : -1
    )))
    const collisionIndexes = collisions.filter((index) => index >= 0)
    if (collisionIndexes.length === 0) {
      const versionBumps = modules.flatMap((module): FunctionalModuleVersionBump[] => {
        const fromVersion = initialVersions.get(module.module)
        return fromVersion && fromVersion !== module.version
          ? [{ module: module.module, fromVersion, toVersion: module.version }]
          : []
      })
      return { release, versionBumps }
    }

    for (const index of collisionIndexes) {
      const module = modules[index]
      if (!module) throw new Error('功能模块版本解析失败：二进制与模块索引不匹配')
      if (options.lockedModules?.includes(module.module)) {
        throw new Error(`锁定模块 ${module.module} 的 ${module.version} 版本已存在且内容不同；请先修改 scripts/functional-module-versions.json 中的版本号再发布`)
      }
      module.version = incrementPatchVersion(module.version)
    }
  }

  throw new Error('功能模块版本自动递增超过 100 次，已停止发布')
}

export interface FunctionalModuleManifestUploadInput {
  channel: string
  publicBaseUrl: string
  prefix?: string
  manifest: FunctionalModuleManifest
}

export function buildFunctionalModuleManifestUpload(
  input: FunctionalModuleManifestUploadInput,
): FunctionalModuleUploadEntry {
  validateManifestUploadInput(input)
  const baseUrl = input.publicBaseUrl.replace(/\/+$/, '')
  const prefix = normalizePrefix(input.prefix)
  const key = `${prefix}${input.channel}/manifest.json`
  const body = Buffer.from(`${JSON.stringify(input.manifest, null, 2)}\n`, 'utf8')
  return {
    key,
    url: `${baseUrl}/${key}`,
    body,
    size: body.byteLength,
    sha256: sha256(body),
    contentType: 'application/json',
    allowOverwrite: true,
  }
}

export function markFunctionalModuleRequired(
  manifest: FunctionalModuleManifest,
  name: FunctionalModuleName,
): FunctionalModuleManifest {
  let found = false
  const platforms: FunctionalModuleManifest['platforms'] = {}
  for (const [platformKey, platform] of Object.entries(manifest.platforms)) {
    const artifact = platform.modules[name]
    if (!artifact) {
      platforms[platformKey] = platform
      continue
    }
    found = true
    platforms[platformKey] = {
      ...platform,
      modules: {
        ...platform.modules,
        [name]: { ...artifact, required: true },
      },
    }
  }
  if (!found) throw new Error(`manifest 缺少功能模块: ${name}`)
  return { ...manifest, platforms }
}

export async function publishFunctionalModuleRelease(
  release: FunctionalModuleRelease,
  client: FunctionalModuleObjectClient,
): Promise<void> {
  for (const entry of release.binaries) {
    await uploadAndVerify(entry, client)
  }
  await publishFunctionalModuleManifest(release.manifestEntry, client)
}

export async function publishFunctionalModuleManifest(
  manifestEntry: FunctionalModuleUploadEntry,
  client: FunctionalModuleObjectClient,
): Promise<void> {
  await uploadAndVerify(manifestEntry, client, { allowOverwrite: true })
}

async function uploadAndVerify(
  entry: FunctionalModuleUploadEntry,
  client: FunctionalModuleObjectClient,
  options: FunctionalModulePutObjectOptions = {},
): Promise<void> {
  const body = entry.body ?? readFileSync(entry.path ?? '')
  if (body.byteLength !== entry.size || sha256(body) !== entry.sha256) {
    throw new Error(`发布文件校验失败: ${entry.key}`)
  }

  await client.putObject({
    key: entry.key,
    body,
    contentType: entry.contentType,
    metadata: { sha256: entry.sha256 },
    ...(entry.allowOverwrite ? { allowOverwrite: true } : {}),
  }, options)
  const remote = await client.headObject({ key: entry.key })
  if (remote.size !== entry.size || remote.sha256?.toLowerCase() !== entry.sha256) {
    throw new Error(`远端对象校验失败: ${entry.key}`)
  }
}

async function hasImmutableObjectCollision(
  entry: FunctionalModuleUploadEntry,
  client: FunctionalModuleObjectClient,
): Promise<boolean> {
  try {
    const remote = await client.headObject({ key: entry.key })
    return remote.size !== entry.size || remote.sha256?.toLowerCase() !== entry.sha256
  } catch (error) {
    if (isNotFoundError(error)) return false
    throw error
  }
}

function incrementPatchVersion(version: string): string {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version)
  if (!match) {
    throw new Error(`无法自动递增非稳定版功能模块版本: ${version}`)
  }
  return `${match[1]}.${match[2]}.${(BigInt(match[3]!) + 1n).toString()}`
}

function isNotFoundError(error: unknown): boolean {
  if (!isRecord(error)) return false
  return error.statusCode === 404 || error.status === 404 || error.code === 'NoSuchKey'
}

function validateReleaseInput(input: FunctionalModuleReleaseInput): void {
  if (!isSafeSegment(input.channel)) throw new Error(`发布 channel 不合法: ${input.channel}`)
  if (!isSafeHttpUrl(input.publicBaseUrl)) throw new Error('发布 publicBaseUrl 必须是 HTTP(S) URL')
  if (input.prefix !== undefined) normalizePrefix(input.prefix)
  if (input.modules.length === 0) throw new Error('发布模块不能为空')
  if (input.clientMinVersion !== undefined && !isSemver(input.clientMinVersion)) {
    throw new Error(`发布 clientMinVersion 不合法: ${input.clientMinVersion}`)
  }
  if (input.clientUpdate !== undefined) {
    validateClientUpdate(input.clientUpdate)
  }
  for (const module of input.modules) {
    if (!isSafeSegment(module.module)) throw new Error(`功能模块名称不合法: ${module.module}`)
    if (!isSemver(module.version)) throw new Error(`功能模块版本不合法: ${module.version}`)
    if (module.format !== undefined && module.format !== 'binary' && module.format !== 'tar.gz') {
      throw new Error(`功能模块 format 不支持: ${module.module}`)
    }
    if (module.entrypoint !== undefined && !isSafeRelativePath(module.entrypoint)) {
      throw new Error(`功能模块入口路径不安全: ${module.module}`)
    }
    if (typeof module.required !== 'boolean') throw new Error(`功能模块 required 不合法: ${module.module}`)
  }
}

function validateManifestUploadInput(input: FunctionalModuleManifestUploadInput): void {
  if (!isSafeSegment(input.channel)) throw new Error(`发布 channel 不合法: ${input.channel}`)
  if (!isSafeHttpUrl(input.publicBaseUrl)) throw new Error('发布 publicBaseUrl 必须是 HTTP(S) URL')
  if (input.prefix !== undefined) normalizePrefix(input.prefix)

  const manifest = input.manifest
  if (manifest.schema !== 1) throw new Error(`发布 manifest schema 不支持: ${String(manifest.schema)}`)
  if (manifest.channel !== input.channel) {
    throw new Error(`发布 manifest channel 不匹配: ${manifest.channel}`)
  }
  if (manifest.client?.minVersion !== undefined && !isSemver(manifest.client.minVersion)) {
    throw new Error(`发布 manifest client.minVersion 不合法: ${manifest.client.minVersion}`)
  }
  if (manifest.client?.update !== undefined) {
    validateClientUpdate(manifest.client.update)
  }

  const platforms = manifest.platforms as unknown
  if (!isRecord(platforms) || Object.keys(platforms).length === 0) {
    throw new Error('发布 manifest platforms 不能为空')
  }
  for (const [platformKey, platformValue] of Object.entries(platforms)) {
    if (!isSafeSegment(platformKey) || !isRecord(platformValue) || !isRecord(platformValue.modules)) {
      throw new Error(`发布 manifest 平台不合法: ${platformKey}`)
    }
    for (const [moduleName, artifactValue] of Object.entries(platformValue.modules)) {
      validateManifestUploadArtifact(moduleName, artifactValue)
    }
  }
}

function validateManifestUploadArtifact(name: string, value: unknown): void {
  if (!isSafeSegment(name) || !isRecord(value)) throw new Error(`发布 manifest 模块不合法: ${name}`)
  if (!isSemver(value.version)) throw new Error(`发布 manifest 模块版本不合法: ${name}`)
  if (!isSafeHttpUrl(value.url)) throw new Error(`发布 manifest 模块 URL 不合法: ${name}`)
  if (typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(value.sha256)) {
    throw new Error(`发布 manifest 模块 sha256 不合法: ${name}`)
  }
  if (!Number.isSafeInteger(value.size) || value.size < 0) {
    throw new Error(`发布 manifest 模块 size 不合法: ${name}`)
  }
  if (value.format !== 'binary' && value.format !== 'tar.gz') {
    throw new Error(`发布 manifest 模块 format 不支持: ${name}`)
  }
  if (typeof value.entrypoint !== 'string' || !isSafeRelativePath(value.entrypoint)) {
    throw new Error(`发布 manifest 模块 entrypoint 不安全: ${name}`)
  }
  if (typeof value.required !== 'boolean') throw new Error(`发布 manifest 模块 required 不合法: ${name}`)
}

function validateClientUpdate(update: FunctionalModuleClientUpdate): void {
  if (!isSemver(update.version)) {
    throw new Error(`发布 client.update.version 不合法: ${update.version}`)
  }
  if (!update.url.startsWith('https://')) {
    throw new Error('发布 client.update.url 必须使用 HTTPS')
  }
  if (typeof update.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(update.sha256)) {
    throw new Error('发布 client.update.sha256 不合法')
  }
  if (!Number.isSafeInteger(update.size) || update.size <= 0) {
    throw new Error('发布 client.update.size 不合法')
  }
  if (update.releaseNotes !== undefined && typeof update.releaseNotes !== 'string') {
    throw new Error('发布 client.update.releaseNotes 不合法')
  }
}

function readBinaryMetadata(path: string): { size: number; sha256: string } {
  let stats
  try {
    stats = statSync(path)
  } catch (error) {
    throw new Error(`功能模块二进制不存在: ${path}`, { cause: error })
  }
  if (!stats.isFile()) throw new Error(`功能模块二进制不存在: ${path}`)
  const body = readFileSync(path)
  return { size: body.byteLength, sha256: sha256(body) }
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function isSafeSegment(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value !== '.'
    && value !== '..'
    && !value.includes('/')
    && !value.includes('\\')
}

function isSemver(value: unknown): value is string {
  return typeof value === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value)
}

function isSafeHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:'
  } catch {
    return false
  }
}

function isSafeRelativePath(value: string): boolean {
  if (!value || value.includes('\0') || value.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(value)) return false
  const normalized = value.replaceAll('\\', '/')
  return normalized !== '.'
    && normalized !== '..'
    && !normalized.startsWith('../')
    && !normalized.includes('/../')
}

function normalizePrefix(value: string | undefined): string {
  if (!value) return ''
  const normalized = value.trim().replace(/^\/+|\/+$/g, '')
  if (!normalized || normalized.split('/').some((segment) => !isSafeSegment(segment))) {
    throw new Error(`发布 COS_PREFIX 不合法: ${value}`)
  }
  return `${normalized}/`
}

function getModuleEntrypoint(name: FunctionalModuleName, suffix: string): string {
  if (name === 'officecli') return `bin/officecli${suffix}`
  if (name === 'node-runtime') return `bin/node${suffix}`
  return `bin/copis-http-api-server${suffix}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
