#!/usr/bin/env bun
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import {
  buildFunctionalModuleManifestUpload,
  buildFunctionalModuleRelease,
  markFunctionalModuleRequired,
  publishFunctionalModuleManifest,
  publishFunctionalModuleRelease,
  resolveImmutableModuleVersions,
  type FunctionalModuleBinaryInput,
} from './functional-module-publisher'
import type {
  FunctionalModuleArchitecture,
  FunctionalModuleManifest,
  FunctionalModulePlatform,
} from '@copis/shared'
import {
  createFunctionalModuleCosClient,
  parseFunctionalModuleCosBucketUrl,
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

async function main(): Promise<void> {
  const rustOnly = hasFlag('--rust') || process.env.COPIS_RUST_ONLY === '1'
  const officeCliOnly = hasFlag('--officecli') || process.env.COPIS_OFFICECLI_ONLY === '1'
  const nodeRuntimeOnly = hasFlag('--node-runtime') || process.env.COPIS_NODE_RUNTIME_ONLY === '1'
  if (Number(rustOnly) + Number(officeCliOnly) + Number(nodeRuntimeOnly) > 1) {
    throw new Error('--rust、--officecli 与 --node-runtime 不能同时使用')
  }

  const secretId = requiredEnv('COS_SECRET_ID')
  const secretKey = requiredEnv('COS_SECRET_KEY')
  const bucketUrl = requiredOption('--bucket-url', 'COS_BUCKET_URL')
  const bucketInfo = parseFunctionalModuleCosBucketUrl(bucketUrl)
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
    const requiredManifest = ['node-runtime', 'officecli', 'rust-http-api'].reduce<FunctionalModuleManifest>(
      (value, name) => markFunctionalModuleRequired(value, name),
      manifest,
    )
    const manifestEntry = buildFunctionalModuleManifestUpload({
      channel,
      publicBaseUrl,
      prefix,
      manifest: requiredManifest,
    })
    await publishFunctionalModuleManifest(manifestEntry, client)
    console.log(`[publish:functional-modules] 已覆盖发布 manifest: ${manifestEntry.key}`)
  } else {
    const rustBinary = officeCliOnly || nodeRuntimeOnly
      ? ''
      : getOption('--rust-binary')
        ?? process.env.COPIS_RUST_HTTP_API_BINARY?.trim()
        ?? join(repoRoot, 'native/http-api-server/target/release', binaryName('copis-http-api-server', platform))
    const officeCliBinary = rustOnly || nodeRuntimeOnly
      ? undefined
      : getOption('--officecli-binary')
        ?? process.env.COPIS_OFFICECLI_BINARY?.trim()
        ?? join(electronDir, 'resources/bin', binaryName('officecli', platform))
    const nodeRuntimeArchive = rustOnly || officeCliOnly
      ? undefined
      : getOption('--node-runtime-archive')
        ?? process.env.COPIS_NODE_RUNTIME_ARCHIVE?.trim()
        ?? join(electronDir, 'resources/node-runtime', `${platform}-${arch}.tar.gz`)
    const modules = buildFunctionalModuleBinaryInputs({
      rustOnly,
      officeCliOnly,
      nodeRuntimeOnly,
      rustBinary,
      rustVersion: getOption('--rust-version') ?? process.env.COPIS_RUST_HTTP_API_VERSION?.trim() ?? version,
      officeCliBinary,
      officeCliVersion: getOption('--officecli-version') ?? process.env.COPIS_OFFICECLI_VERSION?.trim() ?? version,
      nodeRuntimeArchive,
      nodeRuntimeVersion: getOption('--node-runtime-version') ?? process.env.COPIS_NODE_RUNTIME_VERSION?.trim() ?? version,
      platform,
      arch,
    })
    const releaseInput = {
      channel,
      clientMinVersion: getOption('--client-min-version')
        ?? process.env.COPIS_MODULE_CLIENT_MIN_VERSION?.trim()
        ?? packageMetadata.version,
      publicBaseUrl,
      prefix,
      modules,
    }
    const initialRelease = buildFunctionalModuleRelease(releaseInput)
    const existingManifest = await fetchExistingManifest(initialRelease.manifestEntry.url)
    if (rustOnly) {
      requireExistingOfficeCli(existingManifest, platform, arch)
      const hasNodeRuntime = requireExistingNodeRuntime(existingManifest, platform, arch, { allowMissing: true })
      if (!hasNodeRuntime) {
        console.warn(`[publish:functional-modules] COS manifest 当前平台/架构缺少 node-runtime: ${platform}-${arch}，--rust 将继续发布；请随后执行 --node-runtime 补齐`)
      }
    }
    if (officeCliOnly) {
      requireExistingRustApi(existingManifest, platform, arch)
      requireExistingNodeRuntime(existingManifest, platform, arch)
    }
    if (nodeRuntimeOnly) {
      requireExistingRustApi(existingManifest, platform, arch)
      requireExistingOfficeCli(existingManifest, platform, arch)
    }
    const resolvedRelease = await resolveImmutableModuleVersions(releaseInput, client)
    const release = resolvedRelease.release
    for (const bump of resolvedRelease.versionBumps) {
      console.log(`[publish:functional-modules] 检测到不可变对象内容变化，${bump.module} 自动递增版本：${bump.fromVersion} → ${bump.toVersion}`)
    }
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
    const manifestOutput = getOption('--manifest-output')
    if (manifestOutput) {
      writePublishedManifest(manifestOutput, mergedManifestBody)
      console.log(`[publish:functional-modules] 已同步最终 manifest: ${resolve(manifestOutput)}`)
    }
    console.log(`[publish:functional-modules] 已发布 ${release.binaries.length} 个二进制和 manifest`)
  }
}

if (import.meta.main) await main()

/** 将已发布的最终 manifest 回写到本地构建目录，避免自动升版后留下过期文件。 */
export function writePublishedManifest(outputPath: string, body: Buffer): void {
  const path = resolve(outputPath)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, body)
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

export function requireExistingOfficeCli(
  manifest: FunctionalModuleManifest | undefined,
  platform: FunctionalModulePlatform,
  arch: FunctionalModuleArchitecture,
): void {
  const platformKey = `${platform}-${arch}`
  const artifact = manifest?.platforms[platformKey]?.modules.officecli
  if (!artifact) {
    throw new Error(`COS manifest 当前平台/架构缺少 officecli: ${platformKey}，--rust 发布已停止`)
  }
  if (artifact.required !== true) {
    throw new Error(`COS manifest 当前平台/架构的 officecli 未标记 required=true: ${platformKey}，--rust 发布已停止`)
  }
}

export function requireExistingRustApi(
  manifest: FunctionalModuleManifest | undefined,
  platform: FunctionalModulePlatform,
  arch: FunctionalModuleArchitecture,
): void {
  const platformKey = `${platform}-${arch}`
  const artifact = manifest?.platforms[platformKey]?.modules['rust-http-api']
  if (!artifact) {
    throw new Error(`COS manifest 当前平台/架构缺少 rust-http-api: ${platformKey}，--officecli 发布已停止`)
  }
  if (artifact.required !== true) {
    throw new Error(`COS manifest 当前平台/架构的 rust-http-api 未标记 required=true: ${platformKey}，--officecli 发布已停止`)
  }
}

export function requireExistingNodeRuntime(
  manifest: FunctionalModuleManifest | undefined,
  platform: FunctionalModulePlatform,
  arch: FunctionalModuleArchitecture,
  options: NodeRuntimeValidationOptions = {},
): boolean {
  const platformKey = `${platform}-${arch}`
  const artifact = manifest?.platforms[platformKey]?.modules['node-runtime']
  if (!artifact) {
    if (options.allowMissing) return false
    throw new Error(`COS manifest 当前平台/架构缺少 node-runtime: ${platformKey}，单模块发布已停止`)
  }
  if (artifact.required !== true || artifact.format !== 'tar.gz' || artifact.entrypoint !== `bin/${binaryName('node', platform)}`) {
    throw new Error(`COS manifest 当前平台/架构的 node-runtime 无效: ${platformKey}，单模块发布已停止`)
  }
  return true
}

interface NodeRuntimeValidationOptions {
  allowMissing?: boolean
}

interface FunctionalModuleBinaryInputOptions {
  rustOnly: boolean
  officeCliOnly?: boolean
  nodeRuntimeOnly?: boolean
  rustBinary: string
  rustVersion: string
  officeCliBinary?: string
  officeCliVersion: string
  nodeRuntimeArchive?: string
  nodeRuntimeVersion?: string
  platform: FunctionalModulePlatform
  arch: FunctionalModuleArchitecture
}

export function buildFunctionalModuleBinaryInputs(
  input: FunctionalModuleBinaryInputOptions,
): FunctionalModuleBinaryInput[] {
  const officeCliOnly = input.officeCliOnly ?? false
  const nodeRuntimeOnly = input.nodeRuntimeOnly ?? false
  if (Number(input.rustOnly) + Number(officeCliOnly) + Number(nodeRuntimeOnly) > 1) {
    throw new Error('--rust、--officecli 与 --node-runtime 不能同时使用')
  }
  const modules: FunctionalModuleBinaryInput[] = []
  if (!officeCliOnly && !nodeRuntimeOnly) {
    modules.push({
      module: 'rust-http-api',
      version: input.rustVersion,
      platform: input.platform,
      arch: input.arch,
      binaryPath: input.rustBinary,
      required: true,
    })
  }
  if (!input.rustOnly && !nodeRuntimeOnly) {
    if (!input.officeCliBinary) throw new Error('正常发布或 OfficeCLI-only 发布需要提供 OfficeCLI 二进制路径')
    modules.push({
      module: 'officecli',
      version: input.officeCliVersion,
      platform: input.platform,
      arch: input.arch,
      binaryPath: input.officeCliBinary,
      required: true,
    })
  }
  if (!input.rustOnly && !officeCliOnly) {
    if (!input.nodeRuntimeArchive) throw new Error('正常发布或 Node.js runtime-only 发布需要提供 Node.js runtime 归档')
    modules.push({
      module: 'node-runtime',
      version: input.nodeRuntimeVersion ?? input.rustVersion,
      platform: input.platform,
      arch: input.arch,
      binaryPath: input.nodeRuntimeArchive,
      format: 'tar.gz',
      entrypoint: `bin/${binaryName('node', input.platform)}`,
      required: true,
    })
  }
  return modules
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
