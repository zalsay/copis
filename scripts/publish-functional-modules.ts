#!/usr/bin/env bun
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  buildFunctionalModuleManifestUpload,
  buildFunctionalModuleRelease,
  markFunctionalModuleRequired,
  publishFunctionalModuleManifest,
  publishFunctionalModuleRelease,
  type FunctionalModuleBinaryInput,
} from './functional-module-publisher'
import type {
  FunctionalModuleArchitecture,
  FunctionalModuleManifest,
  FunctionalModulePlatform,
} from '@copis/shared'
import {
  createFunctionalModuleCosClient,
  type FunctionalModuleCosSdkClient,
} from './functional-module-cos-client'
import { mergeFunctionalModuleManifests } from './functional-module-manifest-merge'
import { resolveFunctionalModulePrefix } from './functional-module-prefix'

interface CosSdkConstructor {
  new (options: Record<string, string>): FunctionalModuleCosSdkClient
}

const repoRoot = resolve(import.meta.dir, '..')
const electronDir = join(repoRoot, 'apps/electron')
const packageMetadata = JSON.parse(readFileSync(join(electronDir, 'package.json'), 'utf8')) as { version: string }
const secretId = requiredEnv('COS_SECRET_ID')
const secretKey = requiredEnv('COS_SECRET_KEY')
const bucketUrl = requiredOption('--bucket-url', 'COS_BUCKET_URL')
const bucketInfo = parseBucketUrl(bucketUrl)
const bucket = getOption('--bucket') ?? (process.env.COS_BUCKET?.trim() || bucketInfo.bucket)
const region = getOption('--region') ?? (process.env.COS_REGION?.trim() || bucketInfo.region)
const publicBaseUrl = requiredOption('--public-base-url', 'COS_PUBLIC_BASE_URL')
const channel = getOption('--channel') ?? process.env.COPIS_MODULE_CHANNEL?.trim() ?? 'stable'
const version = getOption('--version') ?? process.env.COPIS_MODULE_VERSION?.trim() ?? packageMetadata.version
const platform = parsePlatform(getOption('--platform') ?? process.env.COPIS_MODULE_PLATFORM ?? process.platform)
const arch = parseArchitecture(getOption('--arch') ?? process.env.COPIS_MODULE_ARCH ?? process.arch)
const prefix = resolveFunctionalModulePrefix({
  cliPrefix: getOption('--prefix'),
  objectPrefixPath: process.env.OBJECT_PREFIX_PATH,
  legacyCosPrefix: process.env.COS_PREFIX,
})

if (!bucket || !region) {
  throw new Error('无法从 COS_BUCKET_URL 推断 bucket/region，请设置 COS_BUCKET 和 COS_REGION')
}

const cosModule = await import('cos-nodejs-sdk-v5') as unknown as { default?: CosSdkConstructor }
const Cos = cosModule.default
if (!Cos) throw new Error('COS SDK 初始化失败')
const cos = new Cos({ SecretId: secretId, SecretKey: secretKey, Region: region })
const client = createFunctionalModuleCosClient(cos, { bucket, region })

if (hasFlag('--manifest-only')) {
  const manifestPath = requiredOption('--manifest-file', 'COPIS_FUNCTIONAL_MODULE_MANIFEST_FILE')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as FunctionalModuleManifest
  const requiredManifest = markFunctionalModuleRequired(manifest, 'officecli')
  const manifestEntry = buildFunctionalModuleManifestUpload({
    channel,
    publicBaseUrl,
    prefix,
    manifest: requiredManifest,
  })
  await publishFunctionalModuleManifest(manifestEntry, client)
  console.log(`[publish:functional-modules] 已覆盖发布 manifest: ${manifestEntry.key}`)
} else {
  const rustBinary = getOption('--rust-binary')
    ?? process.env.COPIS_RUST_HTTP_API_BINARY?.trim()
    ?? join(repoRoot, 'native/http-api-server/target/release', binaryName('copis-http-api-server', platform))
  const officeCliBinary = getOption('--officecli-binary')
    ?? process.env.COPIS_OFFICECLI_BINARY?.trim()
    ?? join(electronDir, 'resources/bin', binaryName('officecli', platform))
  const modules: FunctionalModuleBinaryInput[] = [
    {
      module: 'rust-http-api',
      version: getOption('--rust-version') ?? process.env.COPIS_RUST_HTTP_API_VERSION?.trim() ?? version,
      platform,
      arch,
      binaryPath: rustBinary,
      required: true,
    },
    {
      module: 'officecli',
      version: getOption('--officecli-version') ?? process.env.COPIS_OFFICECLI_VERSION?.trim() ?? version,
      platform,
      arch,
      binaryPath: officeCliBinary,
      required: true,
    },
  ]
  const release = buildFunctionalModuleRelease({
    channel,
    clientMinVersion: getOption('--client-min-version')
      ?? process.env.COPIS_MODULE_CLIENT_MIN_VERSION?.trim()
      ?? packageMetadata.version,
    publicBaseUrl,
    prefix,
    modules,
  })
  const existingManifest = await fetchExistingManifest(release.manifestEntry.url)
  const mergedManifest = mergeFunctionalModuleManifests(existingManifest, release.manifest)
  const mergedManifestBody = Buffer.from(`${JSON.stringify(mergedManifest, null, 2)}\n`, 'utf8')
  const releaseToPublish = {
    ...release,
    manifest: mergedManifest,
    manifestEntry: {
      ...release.manifestEntry,
      body: mergedManifestBody,
      size: mergedManifestBody.byteLength,
      sha256: createHash('sha256').update(mergedManifestBody).digest('hex'),
      allowOverwrite: true,
    },
  }

  if (existingManifest) {
    console.log('[publish:functional-modules] 已合并 COS 中现有 manifest，保留其他平台模块')
  }

  await publishFunctionalModuleRelease(releaseToPublish, client)
  console.log(`[publish:functional-modules] 已发布 ${release.binaries.length} 个二进制和 manifest`)
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
  const value = index >= 0 ? process.argv[index + 1] : undefined
  return value?.trim() || undefined
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name)
}

function parseBucketUrl(value: string): { bucket: string; region: string } {
  const url = new URL(value)
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('COS_BUCKET_URL 必须是 HTTP(S) URL')
  }
  const parts = url.hostname.split('.')
  const cosIndex = parts.indexOf('cos')
  const bucket = parts[0]
  const region = cosIndex >= 0 ? parts[cosIndex + 1] : undefined
  return {
    bucket: bucket && cosIndex > 0 ? bucket : '',
    region: region ?? '',
  }
}

function binaryName(name: string, targetPlatform: FunctionalModulePlatform): string {
  return targetPlatform === 'win32' ? `${name}.exe` : name
}

function parsePlatform(value: string): FunctionalModulePlatform {
  if (value === 'darwin' || value === 'linux' || value === 'win32') return value
  throw new Error(`当前平台不支持功能模块发布: ${value}`)
}

async function fetchExistingManifest(url: string): Promise<FunctionalModuleManifest | undefined> {
  const response = await fetch(url)
  if (response.status === 404) return undefined
  if (!response.ok) {
    throw new Error(`读取现有 COS manifest 失败：HTTP ${response.status}`)
  }

  let value: unknown
  try {
    value = await response.json()
  } catch (error) {
    throw new Error('现有 COS manifest 不是有效 JSON', { cause: error })
  }
  if (!isRecord(value)
    || typeof value.schema !== 'number'
    || typeof value.channel !== 'string'
    || !isRecord(value.platforms)) {
    throw new Error('现有 COS manifest 结构无效，已停止发布以避免覆盖')
  }
  return value as unknown as FunctionalModuleManifest
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseArchitecture(value: string): FunctionalModuleArchitecture {
  if (value === 'arm64' || value === 'x64') return value
  throw new Error(`当前架构不支持功能模块发布: ${value}`)
}
