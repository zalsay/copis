#!/usr/bin/env bun
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { FunctionalModuleArchitecture, FunctionalModulePlatform } from '@copis/shared'
import { buildFunctionalModuleRelease, type FunctionalModuleBinaryInput } from './functional-module-publisher'
import { resolveFunctionalModulePrefix } from './functional-module-prefix'

interface PackageMetadata {
  version: string
}

const repoRoot = resolve(import.meta.dir, '..')
const electronDir = join(repoRoot, 'apps/electron')
const packageMetadata = JSON.parse(readFileSync(join(electronDir, 'package.json'), 'utf8')) as PackageMetadata

const platform = parsePlatform(process.env.COPIS_MODULE_PLATFORM ?? process.platform)
const arch = parseArchitecture(process.env.COPIS_MODULE_ARCH ?? process.arch)
const version = getOption('--version') ?? process.env.COPIS_MODULE_VERSION ?? packageMetadata.version
const channel = getOption('--channel') ?? process.env.COPIS_MODULE_CHANNEL ?? 'stable'
const publicBaseUrl = getOption('--public-base-url') ?? process.env.COS_PUBLIC_BASE_URL
const rustOnly = hasFlag('--rust') || process.env.COPIS_RUST_ONLY === '1'
const officeCliOnly = hasFlag('--officecli') || process.env.COPIS_OFFICECLI_ONLY === '1'
const nodeRuntimeOnly = hasFlag('--node-runtime') || process.env.COPIS_NODE_RUNTIME_ONLY === '1'
const alipayBotOnly = hasFlag('--alipay-bot') || process.env.COPIS_ALIPAY_BOT_ONLY === '1'
if (Number(rustOnly) + Number(officeCliOnly) + Number(nodeRuntimeOnly) + Number(alipayBotOnly) > 1) {
  throw new Error('--rust、--officecli、--node-runtime 与 --alipay-bot 不能同时使用')
}
const prefix = resolveFunctionalModulePrefix({
  cliPrefix: getOption('--prefix'),
  objectPrefixPath: process.env.OBJECT_PREFIX_PATH,
  legacyCosPrefix: process.env.COS_PREFIX,
})
const outputPath = resolve(
  getOption('--output')
    ?? process.env.COPIS_FUNCTIONAL_MODULE_MANIFEST_OUTPUT
    ?? join(electronDir, 'dist/functional-modules/manifest.json'),
)

if (!publicBaseUrl) throw new Error('缺少 COS_PUBLIC_BASE_URL 或 --public-base-url')

const modules: FunctionalModuleBinaryInput[] = []

if (!officeCliOnly && !nodeRuntimeOnly && !alipayBotOnly) {
  const rustBinary = getOption('--rust-binary')
    ?? process.env.COPIS_RUST_HTTP_API_BINARY
    ?? join(repoRoot, 'native/http-api-server/target/release', binaryName('copis-http-api-server', platform))
  modules.push({
    module: 'rust-http-api',
    version: getOption('--rust-version') ?? process.env.COPIS_RUST_HTTP_API_VERSION ?? version,
    platform,
    arch,
    binaryPath: rustBinary,
    required: true,
  })
}

if (!rustOnly && !nodeRuntimeOnly && !alipayBotOnly) {
  const officeCliBinary = getOption('--officecli-binary')
    ?? process.env.COPIS_OFFICECLI_BINARY
    ?? join(electronDir, 'resources/bin', binaryName('officecli', platform))
  modules.push({
    module: 'officecli',
    version: getOption('--officecli-version') ?? process.env.COPIS_OFFICECLI_VERSION ?? version,
    platform,
    arch,
    binaryPath: officeCliBinary,
    required: true,
  })
}

if (!rustOnly && !officeCliOnly && !alipayBotOnly) {
  const nodeRuntimeArchive = getOption('--node-runtime-archive')
    ?? process.env.COPIS_NODE_RUNTIME_ARCHIVE
    ?? join(electronDir, 'resources/node-runtime', `${platform}-${arch}.tar.gz`)
  modules.push({
    module: 'node-runtime',
    version: getOption('--node-runtime-version') ?? process.env.COPIS_NODE_RUNTIME_VERSION ?? version,
    platform,
    arch,
    binaryPath: nodeRuntimeArchive,
    format: 'tar.gz',
    entrypoint: `bin/${binaryName('node', platform)}`,
    required: true,
  })
}

if (!rustOnly && !officeCliOnly && !nodeRuntimeOnly) {
  const alipayBotArchive = getOption('--alipay-bot-archive')
    ?? process.env.COPIS_ALIPAY_BOT_ARCHIVE
    ?? join(electronDir, 'resources/alipay-bot', `${platform}-${arch}.tar.gz`)
  modules.push({
    module: 'alipay-bot',
    version: getOption('--alipay-bot-version') ?? process.env.COPIS_ALIPAY_BOT_VERSION ?? version,
    platform,
    arch,
    binaryPath: alipayBotArchive,
    format: 'tar.gz',
    entrypoint: `bin/${platform === 'win32' ? 'alipay-bot.cmd' : 'alipay-bot'}`,
    required: true,
  })
}

const release = buildFunctionalModuleRelease({
  channel,
  clientMinVersion: getOption('--client-min-version')
    ?? process.env.COPIS_MODULE_CLIENT_MIN_VERSION
    ?? packageMetadata.version,
  publicBaseUrl,
  prefix,
  modules,
})

mkdirSync(resolve(outputPath, '..'), { recursive: true })
writeFileSync(outputPath, `${JSON.stringify(release.manifest, null, 2)}\n`, 'utf8')
console.log(`[build:functional-module-manifest] 已生成 ${outputPath}`)
for (const entry of release.binaries) {
  console.log(`[build:functional-module-manifest] ${entry.key} sha256=${entry.sha256} size=${entry.size}`)
}

function getOption(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  const value = index >= 0 ? process.argv[index + 1] : undefined
  return value?.trim() || undefined
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name)
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
