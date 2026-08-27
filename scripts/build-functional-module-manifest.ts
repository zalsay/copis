#!/usr/bin/env bun
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { FunctionalModuleArchitecture, FunctionalModuleClientUpdate, FunctionalModulePlatform } from '@copis/shared'
import { buildFunctionalModuleRelease, type FunctionalModuleBinaryInput } from './functional-module-publisher'
import { resolveFunctionalModulePrefix } from './functional-module-prefix'
import { applyFunctionalModuleVersionLocks, loadFunctionalModuleVersionLocks } from './functional-module-version-lock'

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
const playwrightCoreOnly = hasFlag('--playwright-core') || process.env.COPIS_PLAYWRIGHT_CORE_ONLY === '1'
const pythonRuntimeOnly = hasFlag('--python-runtime') || process.env.COPIS_PYTHON_RUNTIME_ONLY === '1'
const agentlyCliOnly = hasFlag('--agently-cli') || process.env.COPIS_AGENTLY_CLI_ONLY === '1'
if (Number(rustOnly) + Number(officeCliOnly) + Number(nodeRuntimeOnly) + Number(alipayBotOnly) + Number(playwrightCoreOnly) + Number(pythonRuntimeOnly) + Number(agentlyCliOnly) > 1) {
  throw new Error('--rust、--officecli、--node-runtime、--alipay-bot、--playwright-core、--python-runtime 与 --agently-cli 不能同时使用')
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

if (!officeCliOnly && !nodeRuntimeOnly && !alipayBotOnly && !playwrightCoreOnly && !pythonRuntimeOnly && !agentlyCliOnly) {
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

if (!rustOnly && !nodeRuntimeOnly && !alipayBotOnly && !playwrightCoreOnly && !pythonRuntimeOnly && !agentlyCliOnly) {
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

if (!rustOnly && !officeCliOnly && !alipayBotOnly && !playwrightCoreOnly && !pythonRuntimeOnly && !agentlyCliOnly) {
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

if (!rustOnly && !officeCliOnly && !nodeRuntimeOnly && !playwrightCoreOnly && !pythonRuntimeOnly && !agentlyCliOnly) {
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

if (!rustOnly && !officeCliOnly && !nodeRuntimeOnly && !alipayBotOnly && !pythonRuntimeOnly && !agentlyCliOnly) {
  const playwrightCoreArchive = getOption('--playwright-core-archive')
    ?? process.env.COPIS_PLAYWRIGHT_CORE_ARCHIVE
    ?? join(electronDir, 'resources/playwright-core/playwright-core.tar.gz')
  modules.push({
    module: 'playwright-core',
    version: getOption('--playwright-core-version') ?? process.env.COPIS_PLAYWRIGHT_CORE_VERSION ?? version,
    platform,
    arch,
    binaryPath: playwrightCoreArchive,
    format: 'tar.gz',
    entrypoint: 'node_modules/playwright-core/index.js',
    required: true,
  })
}

if (!rustOnly && !officeCliOnly && !nodeRuntimeOnly && !alipayBotOnly && !playwrightCoreOnly && !agentlyCliOnly) {
  const pythonRuntimeArchive = getOption('--python-runtime-archive')
    ?? process.env.COPIS_PYTHON_RUNTIME_ARCHIVE
    ?? join(electronDir, 'resources/python-runtime', `${platform}-${arch}.tar.gz`)
  modules.push({
    module: 'python-runtime',
    version: getOption('--python-runtime-version') ?? process.env.COPIS_PYTHON_RUNTIME_VERSION ?? version,
    platform,
    arch,
    binaryPath: pythonRuntimeArchive,
    format: 'tar.gz',
    entrypoint: `bin/${binaryName('python', platform)}`,
    required: true,
  })
}

if (!rustOnly && !officeCliOnly && !nodeRuntimeOnly && !alipayBotOnly && !playwrightCoreOnly && !pythonRuntimeOnly) {
  const agentlyCliBinary = getOption('--agently-cli-binary')
    ?? process.env.COPIS_AGENTLY_CLI_BINARY
    ?? join(electronDir, 'resources/bin', binaryName('agently-cli', platform))
  modules.push({
    module: 'agently-cli',
    version: getOption('--agently-cli-version') ?? process.env.COPIS_AGENTLY_CLI_VERSION ?? '1.0.17',
    platform,
    arch,
    binaryPath: agentlyCliBinary,
    required: true,
  })
}

const release = buildFunctionalModuleRelease({
  channel,
  clientMinVersion: getOption('--client-min-version')
    ?? process.env.COPIS_MODULE_CLIENT_MIN_VERSION
    ?? packageMetadata.version,
  clientUpdate: readClientUpdate(),
  publicBaseUrl,
  prefix,
  modules: applyFunctionalModuleVersionLocks(modules, loadFunctionalModuleVersionLocks()),
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

function readClientUpdate(): FunctionalModuleClientUpdate | undefined {
  const version = getOption('--app-update-version') ?? process.env.COPIS_APP_UPDATE_VERSION
  const url = getOption('--app-update-url') ?? process.env.COPIS_APP_UPDATE_URL
  const sha256 = getOption('--app-update-sha256') ?? process.env.COPIS_APP_UPDATE_SHA256
  const size = getOption('--app-update-size') ?? process.env.COPIS_APP_UPDATE_SIZE
  const releaseNotes = getOption('--app-update-notes') ?? process.env.COPIS_APP_UPDATE_NOTES
  if (!version && !url && !sha256 && !size && !releaseNotes) return undefined
  if (!version || !url || !sha256 || !size) {
    throw new Error('发布主程序更新时缺少 --app-update-version/url/sha256/size')
  }
  const parsedSize = Number(size)
  if (!Number.isSafeInteger(parsedSize) || parsedSize <= 0) {
    throw new Error('主程序更新 size 不合法')
  }
  return {
    version,
    url,
    sha256: sha256.toLowerCase(),
    size: parsedSize,
    ...(releaseNotes ? { releaseNotes } : {}),
  }
}
