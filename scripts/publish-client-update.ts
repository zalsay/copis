#!/usr/bin/env bun
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import type { FunctionalModuleClientUpdate, FunctionalModuleManifest } from '@copis/shared'
import type { FunctionalModuleCosSdkClient } from './functional-module-cos-client'
import { createFunctionalModuleCosClient, parseFunctionalModuleCosBucketUrl } from './functional-module-cos-client'
import {
  buildFunctionalModuleManifestUpload,
  publishFunctionalModuleManifest,
  type FunctionalModuleObjectClient,
} from './functional-module-publisher'

export const DEFAULT_CLIENT_MANIFEST_PREFIX = 'copis/client'
export const DEFAULT_CLIENT_MANIFEST_CHANNEL = 'stable'

interface CosSdkConstructor {
  new (options: Record<string, string>): FunctionalModuleCosSdkClient
}

export interface ClientUpdatePublishInput {
  installerPath: string
  version: string
  installerUrl: string
  publicBaseUrl: string
  manifestPrefix?: string
  channel?: string
  manifestUrl?: string
  releaseNotes?: string
}

export interface ClientUpdatePublishResult {
  manifestUrl: string
  version: string
  installerUrl: string
  size: number
  sha256: string
}

export function buildClientUpdateManifest(
  existing: FunctionalModuleManifest,
  update: FunctionalModuleClientUpdate,
): FunctionalModuleManifest {
  return {
    ...existing,
    client: {
      ...(existing.client ?? {}),
      update,
    },
  }
}

export async function publishClientUpdate(
  input: ClientUpdatePublishInput,
  client: FunctionalModuleObjectClient,
  fetchImpl: typeof fetch = fetch,
): Promise<ClientUpdatePublishResult> {
  const installerPath = resolve(input.installerPath)
  const stats = statSync(installerPath)
  if (!stats.isFile()) throw new Error(`主程序安装包不是文件：${installerPath}`)
  const body = readFileSync(installerPath)
  const version = input.version.trim()
  const installerUrl = normalizeHttpsUrl(input.installerUrl, '主程序安装包 URL')
  const publicBaseUrl = normalizeHttpUrl(input.publicBaseUrl, 'COS_PUBLIC_BASE_URL').replace(/\/+$/, '')
  const channel = normalizeSegment(input.channel ?? DEFAULT_CLIENT_MANIFEST_CHANNEL, '发布 channel')
  const prefix = normalizePrefix(input.manifestPrefix ?? DEFAULT_CLIENT_MANIFEST_PREFIX)
  const manifestKey = `${prefix}${channel}/manifest.json`
  const manifestUrl = input.manifestUrl?.trim() || `${publicBaseUrl}/${manifestKey}`

  const response = await fetchImpl(manifestUrl, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) throw new Error(`客户端 manifest 获取失败（HTTP ${response.status}）：${manifestUrl}`)

  let existing: FunctionalModuleManifest
  try {
    existing = await response.json() as FunctionalModuleManifest
  } catch (error) {
    throw new Error(`客户端 manifest 不是有效的 JSON：${manifestUrl}`, { cause: error })
  }
  validateExistingManifest(existing, channel)
  const existingVersion = existing.client?.update?.version
  if (existingVersion && compareVersions(existingVersion, version) > 0) {
    throw new Error(`客户端 manifest 已是更高版本 ${existingVersion}，拒绝降级到 ${version}`)
  }

  const update: FunctionalModuleClientUpdate = {
    version,
    url: installerUrl,
    sha256: createHash('sha256').update(body).digest('hex'),
    size: body.byteLength,
    ...(input.releaseNotes?.trim() ? { releaseNotes: input.releaseNotes.trim() } : {}),
  }
  const manifest = buildClientUpdateManifest(existing, update)
  const entry = buildFunctionalModuleManifestUpload({
    channel,
    publicBaseUrl,
    prefix,
    manifest,
  })
  if (entry.key !== manifestKey) throw new Error(`客户端 manifest key 计算不一致：${entry.key}`)
  await publishFunctionalModuleManifest(entry, client)

  return {
    manifestUrl: entry.url,
    version,
    installerUrl,
    size: update.size,
    sha256: update.sha256,
  }
}

async function main(): Promise<void> {
  const installerPath = requiredOption('--file', 'COPIS_CLIENT_UPDATE_FILE')
  const publicBaseUrl = requiredOption('--public-base-url', 'COS_PUBLIC_BASE_URL')
  const bucketUrl = requiredOption('--bucket-url', 'COS_BUCKET_URL')
  const bucketInfo = parseFunctionalModuleCosBucketUrl(bucketUrl)
  const bucket = getOption('--bucket') ?? process.env.COS_BUCKET?.trim() ?? bucketInfo.bucket
  const region = getOption('--region') ?? process.env.COS_REGION?.trim() ?? bucketInfo.region
  if (!bucket || !region) throw new Error('无法从 COS_BUCKET_URL 推断 bucket/region，请设置 COS_BUCKET 和 COS_REGION')

  const publicInstallerKey = normalizeObjectKey(
    getOption('--object-key') ?? requiredOption('--installer-object-key', 'COPIS_CLIENT_UPDATE_OBJECT_KEY'),
  )
  const installerUrl = `${publicBaseUrl.replace(/\/+$/, '')}/${publicInstallerKey.split('/').map(encodeURIComponent).join('/')}`
  const manifestPrefix = getOption('--manifest-prefix')
    ?? process.env.OBJECT_PREFIX_PATH?.trim()
    ?? DEFAULT_CLIENT_MANIFEST_PREFIX
  const manifestUrl = getOption('--manifest-url')
    ?? process.env.COPIS_APP_UPDATE_MANIFEST_URL?.trim()
    ?? process.env.COPIS_FUNCTIONAL_MODULE_MANIFEST_URL?.trim()
  const version = requiredOption('--version', 'COPIS_CLIENT_UPDATE_VERSION')

  const cosModule = await import('cos-nodejs-sdk-v5') as unknown as { default?: CosSdkConstructor }
  if (!cosModule.default) throw new Error('COS SDK 初始化失败')
  const cos = new cosModule.default({
    SecretId: requiredEnv('COS_SECRET_ID'),
    SecretKey: requiredEnv('COS_SECRET_KEY'),
    Region: region,
  })
  const client = createFunctionalModuleCosClient(cos, { bucket, region })
  const result = await publishClientUpdate({
    installerPath,
    version,
    installerUrl,
    publicBaseUrl,
    manifestPrefix,
    manifestUrl,
    releaseNotes: getOption('--release-notes') ?? process.env.COPIS_CLIENT_UPDATE_NOTES,
  }, client)
  console.log(`[publish-client-update] 已更新客户端 manifest：${result.manifestUrl}`)
  console.log(`[publish-client-update] 版本：${result.version}，大小：${result.size}，sha256：${result.sha256}`)
  console.log(`[publish-client-update] 安装包地址：${result.installerUrl}`)
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`缺少环境变量 ${name}`)
  return value
}

function requiredOption(option: string, envName: string): string {
  const value = getOption(option) ?? process.env[envName]?.trim()
  if (!value) throw new Error(`缺少 ${option} 或环境变量 ${envName}`)
  return value
}

function getOption(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1]?.trim() || undefined : undefined
}

function normalizeSegment(value: string, label: string): string {
  const normalized = value.trim()
  if (!normalized || !/^[A-Za-z0-9._-]+$/.test(normalized)) throw new Error(`${label} 不合法：${value}`)
  return normalized
}

function normalizePrefix(value: string): string {
  const normalized = value.trim().replace(/^\/+|\/+$/g, '')
  if (!normalized || normalized.split('/').some((segment) => !/^[A-Za-z0-9._-]+$/.test(segment))) {
    throw new Error(`客户端 manifest 前缀不合法：${value}`)
  }
  return `${normalized}/`
}

function normalizeObjectKey(value: string): string {
  const normalized = value.trim().replace(/^\/+/, '')
  const segments = normalized.split('/')
  if (!normalized || normalized.includes('\\') || normalized.includes('\0')
    || segments.some((segment) => segment === '.' || segment === '..' || !/^[A-Za-z0-9._-]+$/.test(segment))) {
    throw new Error(`主程序安装包对象 key 不合法：${value}`)
  }
  return normalized
}

function normalizeHttpUrl(value: string, label: string): string {
  const url = new URL(value.trim())
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(`${label} 必须使用 HTTP(S)`)
  return value.trim()
}

function normalizeHttpsUrl(value: string, label: string): string {
  const url = new URL(value.trim())
  if (url.protocol !== 'https:') throw new Error(`${label} 必须使用 HTTPS`)
  return value.trim()
}

function validateExistingManifest(manifest: FunctionalModuleManifest, channel: string): void {
  if (!manifest || manifest.schema !== 1) throw new Error('客户端 manifest schema 不支持')
  if (manifest.channel !== channel) throw new Error(`客户端 manifest channel 不匹配：${manifest.channel} !== ${channel}`)
  if (!manifest.platforms || Object.keys(manifest.platforms).length === 0) {
    throw new Error('客户端 manifest 缺少 platforms，拒绝覆盖')
  }
}

function compareVersions(left: string, right: string): number {
  const leftParts = parseVersion(left)
  const rightParts = parseVersion(right)
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

function parseVersion(value: string): number[] {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/.exec(value.trim())
  if (!match) throw new Error(`客户端 manifest 版本不合法：${value}`)
  return match.slice(1, 4).map(Number)
}

if (import.meta.main) await main()
