#!/usr/bin/env bun
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { FunctionalModuleArchitecture, FunctionalModulePlatform } from '@copis/shared'

export const OFFICECLI_RELEASE_TAG = 'v1.0.143'
export const DEFAULT_RELEASE_API = `https://api.github.com/repos/iOfficeAI/OfficeCLI/releases/tags/${OFFICECLI_RELEASE_TAG}`

interface GitHubReleaseAsset {
  name: string
  browserDownloadUrl: string
  digest?: string
}

interface GitHubRelease {
  tagName: string
  assets: GitHubReleaseAsset[]
}

interface PublicOfficeCliArtifact {
  version: string
  url: string
  sha256: string
  size: number
}

interface OfficeCliCacheMetadata {
  version: string
  assetName: string
  sha256: string
}

export interface PrepareOfficeCliModuleInput {
  platform: FunctionalModulePlatform
  arch: FunctionalModuleArchitecture
  output: string
  releaseApiUrl?: string
  publicManifestUrl?: string
}

export interface PreparedOfficeCliModule {
  path: string
  version: string
  sha256: string
  size: number
}

const MAX_ERROR_BODY_LENGTH = 2000

if (import.meta.main) await main()

export async function prepareOfficeCliModule(
  input: PrepareOfficeCliModuleInput,
): Promise<PreparedOfficeCliModule> {
  const expectedVersion = releaseVersion(OFFICECLI_RELEASE_TAG)
  const assetName = officeCliAssetName(input.platform, input.arch)
  const output = resolve(input.output)
  const cached = readVerifiedCache(output, expectedVersion, assetName)
  if (cached) return cached

  const publicArtifact = await tryFetchPublicOfficeCliArtifact(
    input.publicManifestUrl,
    input.platform,
    input.arch,
  )
  if (publicArtifact?.version === expectedVersion) {
    console.log(
      `[prepare:officecli-module] COS OfficeCLI v${publicArtifact.version} 与构建版本一致，复用公网模块`,
    )
    const binary = await fetchBinary(
      publicArtifact.url,
      assetName,
      `下载 COS OfficeCLI 失败: ${assetName}`,
    )
    const sha256 = createHash('sha256').update(binary).digest('hex')
    if (binary.byteLength !== publicArtifact.size) {
      throw new Error(
        `COS OfficeCLI 大小校验失败: ${assetName}，期望 ${publicArtifact.size}，实际 ${binary.byteLength}`,
      )
    }
    if (sha256 !== publicArtifact.sha256) {
      throw new Error(`COS OfficeCLI SHA256 校验失败: ${assetName}`)
    }
    writeBinary(output, binary, input.platform)
    writeCacheMetadata(output, { version: expectedVersion, assetName, sha256 })
    return { path: output, version: expectedVersion, sha256, size: binary.byteLength }
  }

  const release = await fetchGitHubRelease(input.releaseApiUrl ?? DEFAULT_RELEASE_API)
  const version = releaseVersion(release.tagName)
  const binaryAsset = release.assets.find((asset) => asset.name === assetName)
  if (!binaryAsset) throw new Error(`OfficeCLI release 缺少目标二进制: ${assetName}`)
  const releaseCached = readVerifiedCache(output, version, assetName)
  if (releaseCached) return releaseCached

  const expectedSha256 = assetDigest(binaryAsset)
    ?? await checksumFromReleaseAsset(release.assets, assetName)

  const existing = readExistingBinary(output)
  if (existing) {
    const sha256 = createHash('sha256').update(existing).digest('hex')
    if (sha256 === expectedSha256) {
      writeCacheMetadata(output, { version, assetName, sha256 })
      return { path: output, version, sha256, size: existing.byteLength }
    }
  }

  const binary = await fetchBinary(binaryAsset.browserDownloadUrl, assetName)
  const sha256 = createHash('sha256').update(binary).digest('hex')
  if (sha256 !== expectedSha256) {
    throw new Error(`OfficeCLI SHA256 校验失败: ${assetName}`)
  }

  writeBinary(output, binary, input.platform)
  writeCacheMetadata(output, { version, assetName, sha256 })
  return { path: output, version, sha256, size: binary.byteLength }
}

async function main(): Promise<void> {
  const platform = parsePlatform(option('--platform') ?? process.platform)
  const arch = parseArchitecture(option('--arch') ?? process.arch)
  const output = resolve(option('--output') ?? `apps/electron/resources/bin/${binaryName(platform)}`)
  const prepared = await prepareOfficeCliModule({
    platform,
    arch,
    output,
    releaseApiUrl: option('--release-api-url') ?? process.env.COPIS_OFFICECLI_RELEASE_API?.trim(),
    publicManifestUrl: option('--public-manifest-url') ?? process.env.COPIS_OFFICECLI_PUBLIC_MANIFEST_URL?.trim(),
  })
  console.log(
    `[prepare:officecli-module] 已准备 OfficeCLI v${prepared.version}: ${prepared.path} sha256=${prepared.sha256} size=${prepared.size}`,
  )
}

async function fetchWithDiagnostics(
  url: string,
  failurePrefix: string,
  init: RequestInit,
): Promise<Response> {
  let response: Response
  try {
    response = await fetch(url, init)
  } catch (error) {
    throw new Error([
      `${failurePrefix}: 请求异常: ${formatThrownError(error)}`,
      `URL: ${redactUrl(url)}`,
    ].join('\n'))
  }

  if (response.ok) return response

  const lines = [
    `${failurePrefix}: HTTP ${response.status}`,
    `URL: ${redactUrl(url)}`,
  ]
  const contentType = response.headers.get('content-type')?.trim()
  if (contentType) lines.push(`响应类型: ${contentType}`)

  const remaining = response.headers.get('x-ratelimit-remaining')
  const limit = response.headers.get('x-ratelimit-limit')
  const used = response.headers.get('x-ratelimit-used')
  const reset = response.headers.get('x-ratelimit-reset')
  if (remaining || limit || used || reset) {
    lines.push(
      `GitHub rate limit: remaining=${remaining ?? '?'}/${limit ?? '?'}, used=${used ?? '?'}, reset=${reset ?? '?'}`,
    )
  }

  const retryAfter = response.headers.get('retry-after')?.trim()
  if (retryAfter) lines.push(`Retry-After: ${retryAfter}`)

  const requestId = response.headers.get('x-github-request-id')?.trim()
  if (requestId) lines.push(`GitHub request id: ${requestId}`)

  try {
    lines.push(`响应体: ${formatResponseBody(await response.text())}`)
  } catch (error) {
    lines.push(`响应体读取失败: ${formatThrownError(error)}`)
  }

  throw new Error(lines.join('\n'))
}

function formatResponseBody(body: string): string {
  const normalized = body.replace(/\s+/g, ' ').trim()
  if (!normalized) return '(empty)'
  if (normalized.length <= MAX_ERROR_BODY_LENGTH) return normalized
  return `${normalized.slice(0, MAX_ERROR_BODY_LENGTH)}... [已截断]`
}

function redactUrl(value: string): string {
  try {
    const url = new URL(value)
    url.username = ''
    url.password = ''
    return url.toString()
  } catch {
    return value.replace(/(\/\/)[^\/\s@]+@/, '$1<redacted>@')
  }
}

function formatThrownError(error: unknown): string {
  if (error instanceof Error) {
    const cause = error.cause
    if (cause instanceof Error) return `${error.name}: ${error.message} (cause: ${cause.name}: ${cause.message})`
    if (cause !== undefined) return `${error.name}: ${error.message} (cause: ${String(cause)})`
    return `${error.name}: ${error.message}`
  }
  return String(error)
}

async function tryFetchPublicOfficeCliArtifact(
  manifestUrl: string | undefined,
  platform: FunctionalModulePlatform,
  arch: FunctionalModuleArchitecture,
): Promise<PublicOfficeCliArtifact | undefined> {
  if (!manifestUrl?.trim()) return undefined
  try {
    const response = await fetchWithDiagnostics(manifestUrl, '读取 COS 功能模块 manifest 失败', {
      headers: { Accept: 'application/json', 'User-Agent': 'Copis-functional-module-release' },
    })
    let value: unknown
    try {
      value = await response.json() as unknown
    } catch (error) {
      throw new Error('COS 功能模块 manifest JSON 无效', { cause: error })
    }
    return parsePublicOfficeCliArtifact(value, platform, arch)
  } catch (error) {
    console.warn(
      `[prepare:officecli-module] COS manifest 查询失败，回退 GitHub release: ${formatThrownError(error)}`,
    )
    return undefined
  }
}

function parsePublicOfficeCliArtifact(
  value: unknown,
  platform: FunctionalModulePlatform,
  arch: FunctionalModuleArchitecture,
): PublicOfficeCliArtifact | undefined {
  if (!isRecord(value) || !isRecord(value.platforms)) {
    throw new Error('COS 功能模块 manifest 格式无效')
  }
  const platformValue = value.platforms[`${platform}-${arch}`]
  if (!isRecord(platformValue) || !isRecord(platformValue.modules)) return undefined
  const artifact = platformValue.modules.officecli
  if (!isRecord(artifact)) return undefined
  if (artifact.format !== 'binary') throw new Error('COS OfficeCLI artifact 格式不是 binary')
  if (typeof artifact.version !== 'string') throw new Error('COS OfficeCLI artifact 缺少合法版本')
  if (typeof artifact.url !== 'string' || !isHttpUrl(artifact.url)) {
    throw new Error('COS OfficeCLI artifact URL 不合法')
  }
  if (typeof artifact.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(artifact.sha256)) {
    throw new Error('COS OfficeCLI artifact SHA256 不合法')
  }
  if (!Number.isSafeInteger(artifact.size) || artifact.size < 0) {
    throw new Error('COS OfficeCLI artifact size 不合法')
  }
  return {
    version: releaseVersion(artifact.version),
    url: artifact.url,
    sha256: artifact.sha256.toLowerCase(),
    size: artifact.size,
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

async function fetchGitHubRelease(url: string): Promise<GitHubRelease> {
  const response = await fetchWithDiagnostics(url, '读取 OfficeCLI GitHub release 失败', {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'Copis-functional-module-release',
    },
  })

  const value = await response.json() as unknown
  if (!isRecord(value) || typeof value.tag_name !== 'string' || !Array.isArray(value.assets)) {
    throw new Error('OfficeCLI GitHub release 返回格式无效')
  }
  const assets = value.assets.map(parseReleaseAsset)
  return { tagName: value.tag_name, assets }
}

function parseReleaseAsset(value: unknown): GitHubReleaseAsset {
  if (!isRecord(value)
    || typeof value.name !== 'string'
    || typeof value.browser_download_url !== 'string') {
    throw new Error('OfficeCLI GitHub release asset 格式无效')
  }
  return {
    name: value.name,
    browserDownloadUrl: value.browser_download_url,
    ...(typeof value.digest === 'string' ? { digest: value.digest } : {}),
  }
}

async function fetchBinary(
  url: string,
  name: string,
  failurePrefix = `下载 OfficeCLI 失败: ${name}`,
): Promise<Buffer> {
  const response = await fetchWithDiagnostics(url, failurePrefix, {
    headers: { 'User-Agent': 'Copis-functional-module-release' },
  })
  return Buffer.from(await response.arrayBuffer())
}

async function fetchText(url: string, name: string): Promise<string> {
  const response = await fetchWithDiagnostics(url, `下载 OfficeCLI 校验文件失败: ${name}`, {
    headers: { 'User-Agent': 'Copis-functional-module-release' },
  })
  return response.text()
}

function releaseVersion(tag: string): string {
  const version = tag.trim().replace(/^v/i, '')
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`OfficeCLI release 版本不合法: ${tag}`)
  return version
}

function officeCliAssetName(platform: FunctionalModulePlatform, arch: FunctionalModuleArchitecture): string {
  const platformName = platform === 'darwin' ? 'mac' : platform === 'win32' ? 'win' : 'linux'
  return `officecli-${platformName}-${arch}${platform === 'win32' ? '.exe' : ''}`
}

function checksumForAsset(checksumText: string, assetName: string): string {
  for (const line of checksumText.split(/\r?\n/)) {
    const match = /^([a-fA-F0-9]{64})\s+\*?(.+)$/.exec(line.trim())
    if (match?.[2] === assetName) return match[1].toLowerCase()
  }
  throw new Error(`OfficeCLI SHA256SUMS 缺少 ${assetName}`)
}

function assetDigest(asset: GitHubReleaseAsset): string | undefined {
  const match = /^sha256:([a-fA-F0-9]{64})$/.exec(asset.digest?.trim() ?? '')
  return match?.[1]?.toLowerCase()
}

async function checksumFromReleaseAsset(
  assets: readonly GitHubReleaseAsset[],
  assetName: string,
): Promise<string> {
  const checksumAsset = assets.find((asset) => asset.name === 'SHA256SUMS')
  if (!checksumAsset) throw new Error('OfficeCLI release 缺少 SHA256SUMS')
  const checksumText = await fetchText(checksumAsset.browserDownloadUrl, 'SHA256SUMS')
  return checksumForAsset(checksumText, assetName)
}

function readVerifiedCache(
  output: string,
  version: string,
  assetName: string,
): PreparedOfficeCliModule | undefined {
  const metadata = readCacheMetadata(output)
  if (!metadata || metadata.version !== version || metadata.assetName !== assetName) return undefined
  const binary = readExistingBinary(output)
  if (!binary) return undefined
  const sha256 = createHash('sha256').update(binary).digest('hex')
  if (sha256 !== metadata.sha256) return undefined
  return { path: output, version, sha256, size: binary.byteLength }
}

function readCacheMetadata(output: string): OfficeCliCacheMetadata | undefined {
  const path = `${output}.metadata.json`
  if (!existsSync(path)) return undefined
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as unknown
    if (!isRecord(value)
      || typeof value.version !== 'string'
      || typeof value.assetName !== 'string'
      || typeof value.sha256 !== 'string'
      || !/^[a-f0-9]{64}$/i.test(value.sha256)) {
      return undefined
    }
    return {
      version: value.version,
      assetName: value.assetName,
      sha256: value.sha256.toLowerCase(),
    }
  } catch {
    return undefined
  }
}

function readExistingBinary(output: string): Buffer | undefined {
  return existsSync(output) ? readFileSync(output) : undefined
}

function writeCacheMetadata(output: string, metadata: OfficeCliCacheMetadata): void {
  writeFileSync(`${output}.metadata.json`, `${JSON.stringify(metadata)}\n`, 'utf8')
}

function writeBinary(output: string, binary: Buffer, platform: FunctionalModulePlatform): void {
  const temporary = `${output}.${process.pid}.tmp`
  mkdirSync(dirname(output), { recursive: true })
  try {
    writeFileSync(temporary, binary, { mode: platform === 'win32' ? 0o644 : 0o755 })
    if (platform !== 'win32') chmodSync(temporary, 0o755)
    renameSync(temporary, output)
  } finally {
    if (existsSync(temporary)) rmSync(temporary, { force: true })
  }
}

function parsePlatform(value: string): FunctionalModulePlatform {
  if (value === 'darwin' || value === 'linux' || value === 'win32') return value
  throw new Error(`当前平台不支持 OfficeCLI 功能模块: ${value}`)
}

function parseArchitecture(value: string): FunctionalModuleArchitecture {
  if (value === 'arm64' || value === 'x64') return value
  throw new Error(`当前架构不支持 OfficeCLI 功能模块: ${value}`)
}

function binaryName(platform: FunctionalModulePlatform): string {
  return platform === 'win32' ? 'officecli.exe' : 'officecli'
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  const value = index >= 0 ? process.argv[index + 1]?.trim() : undefined
  return value || undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
