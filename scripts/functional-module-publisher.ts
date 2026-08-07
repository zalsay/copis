import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import type {
  FunctionalModuleArchitecture,
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
}

export interface FunctionalModuleReleaseInput {
  channel: string
  clientMinVersion?: string
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
    const binarySuffix = module.platform === 'win32' ? '.exe' : ''
    const objectKey = `${prefix}${input.channel}/${platformKey}/${module.module}-${module.version}${binarySuffix}`
    const artifact = {
      version: module.version,
      url: `${baseUrl}/${objectKey}`,
      sha256: metadata.sha256,
      size: metadata.size,
      format: 'binary' as const,
      entrypoint: getModuleEntrypoint(module.module, binarySuffix),
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

  const manifest: FunctionalModuleManifest = {
    schema: 1,
    channel: input.channel,
    ...(input.clientMinVersion ? { client: { minVersion: input.clientMinVersion } } : {}),
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

function validateReleaseInput(input: FunctionalModuleReleaseInput): void {
  if (!isSafeSegment(input.channel)) throw new Error(`发布 channel 不合法: ${input.channel}`)
  if (!isSafeHttpUrl(input.publicBaseUrl)) throw new Error('发布 publicBaseUrl 必须是 HTTP(S) URL')
  if (input.prefix !== undefined) normalizePrefix(input.prefix)
  if (input.modules.length === 0) throw new Error('发布模块不能为空')
  if (input.clientMinVersion !== undefined && !isSemver(input.clientMinVersion)) {
    throw new Error(`发布 clientMinVersion 不合法: ${input.clientMinVersion}`)
  }
  for (const module of input.modules) {
    if (!isSafeSegment(module.module)) throw new Error(`功能模块名称不合法: ${module.module}`)
    if (!isSemver(module.version)) throw new Error(`功能模块版本不合法: ${module.version}`)
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
  if (value.format !== 'binary') throw new Error(`发布 manifest 模块 format 不支持: ${name}`)
  if (typeof value.entrypoint !== 'string' || !isSafeRelativePath(value.entrypoint)) {
    throw new Error(`发布 manifest 模块 entrypoint 不安全: ${name}`)
  }
  if (typeof value.required !== 'boolean') throw new Error(`发布 manifest 模块 required 不合法: ${name}`)
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
  return name === 'officecli'
    ? `bin/officecli${suffix}`
    : `bin/copis-http-api-server${suffix}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
