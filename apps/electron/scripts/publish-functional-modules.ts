#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  buildFunctionalModuleRelease,
  publishFunctionalModuleRelease,
  type FunctionalModuleBinaryInput,
} from '../src/main/lib/functional-module-publisher'
import type { FunctionalModuleArchitecture, FunctionalModulePlatform } from '@copis/shared'
import {
  createFunctionalModuleCosClient,
  type FunctionalModuleCosSdkClient,
} from './functional-module-cos-client'

interface CosSdkConstructor {
  new (options: Record<string, string>): FunctionalModuleCosSdkClient
}

const electronDir = resolve(import.meta.dir, '..')
const repoRoot = resolve(electronDir, '../..')
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
const prefix = getOption('--prefix') ?? process.env.COS_PREFIX ?? 'copis/modules'

if (!bucket || !region) {
  throw new Error('无法从 COS_BUCKET_URL 推断 bucket/region，请设置 COS_BUCKET 和 COS_REGION')
}

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
    required: false,
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

const cosModule = await import('cos-nodejs-sdk-v5') as unknown as { default?: CosSdkConstructor }
const Cos = cosModule.default
if (!Cos) throw new Error('COS SDK 初始化失败')
const cos = new Cos({ SecretId: secretId, SecretKey: secretKey, Region: region })
const client = createFunctionalModuleCosClient(cos, { bucket, region })

await publishFunctionalModuleRelease(release, client)
console.log(`[publish:functional-modules] 已发布 ${release.binaries.length} 个二进制和 manifest`)

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

function parseArchitecture(value: string): FunctionalModuleArchitecture {
  if (value === 'arm64' || value === 'x64') return value
  throw new Error(`当前架构不支持功能模块发布: ${value}`)
}
