#!/usr/bin/env bun
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { gzipSync } from 'node:zlib'
import type { FunctionalModuleArchitecture, FunctionalModulePlatform } from '@copis/shared'

export const ALIPAY_AGENT_PAYMENT_PACKAGE = '@alipay/agent-payment'
export const ALIPAY_AGENT_PAYMENT_VERSION = '1.0.20'
export const ALIPAY_AGENT_PAYMENT_INTEGRITY = 'sha512-OR78BdjoHueJ7XgKPNxawUFbptc9E4CX9PpV8dHLguGOKQeM+CYRPQuRrxltPqZzyTeta372B/xyFb6uwRYfew=='
const OFFICIAL_INSTALLER_ATTEMPTS = 3
const DEFAULT_OFFICIAL_INSTALLER_TIMEOUT_MS = 180_000
const MINIMUM_OFFICIAL_INSTALLER_TIMEOUT_MS = 30_000
const MAXIMUM_OFFICIAL_INSTALLER_TIMEOUT_MS = 600_000
const OFFICIAL_INSTALLER_TIMEOUT_MS = resolveInstallerTimeoutMs()

interface RuntimePackageMetadata {
  version: string
}

interface PreparedAlipayBotModuleMetadata {
  version: string
  installerVersion: string
  path: string
}

if (import.meta.main) main()

export function main(): void {
  const platform = parsePlatform(option('--platform') ?? process.platform)
  const arch = parseArchitecture(option('--arch') ?? process.arch)
  if (platform !== process.platform || arch !== process.arch) {
    throw new Error('支付宝智能体 CLI 只能在当前本机平台和架构准备')
  }

  const output = resolve(option('--output') ?? `apps/electron/resources/alipay-bot/${platform}-${arch}.tar.gz`)
  const metadataOutput = option('--metadata')
  const staging = mkdtempSync(join(tmpdir(), 'copis-alipay-bot-module-'))
  try {
    const runtimePath = installOfficialRuntime(staging)
    const runtimeMetadata = readRuntimeMetadata(runtimePath)
    const moduleRoot = join(staging, 'module')
    cpSync(runtimePath, join(moduleRoot, 'runtime'), {
      recursive: true,
      dereference: true,
      preserveTimestamps: true,
    })
    writeLaunchers(moduleRoot, platform)
    normalizeTimestamps(moduleRoot)
    createArchive(moduleRoot, output)

    const metadata: PreparedAlipayBotModuleMetadata = {
      version: runtimeMetadata.version,
      installerVersion: ALIPAY_AGENT_PAYMENT_VERSION,
      path: output,
    }
    if (metadataOutput) {
      const resolvedMetadataOutput = resolve(metadataOutput)
      mkdirSync(dirname(resolvedMetadataOutput), { recursive: true })
      writeFileSync(resolvedMetadataOutput, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8')
    }
    console.log(`[prepare:alipay-bot-module] 已生成 ${output}（alipay-bot v${runtimeMetadata.version}）`)
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

function installOfficialRuntime(staging: string): string {
  const packageCache = join(staging, 'package-cache')
  const installerRoot = join(staging, 'installer')
  const installerHome = join(staging, 'home')
  mkdirSync(packageCache, { recursive: true })
  mkdirSync(installerRoot, { recursive: true })
  mkdirSync(installerHome, { recursive: true })

  const npmPath = resolveNpmPath()
  const nodePath = resolveNodePath()
  const packageTarball = downloadInstallerPackage(npmPath, packageCache)
  verifyInstallerPackage(packageTarball)
  execFileSync(npmPath, [
    'install',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--no-package-lock',
    '--no-save',
    packageTarball,
  ], { cwd: installerRoot, stdio: 'inherit' })

  const installerCli = join(installerRoot, 'node_modules', '@alipay', 'agent-payment', 'dist', 'cli.js')
  if (!isFile(installerCli)) throw new Error('官方支付宝安装器缺少 CLI 入口')
  return runOfficialInstaller(nodePath, installerCli, installerRoot, installerHome)
}

function runOfficialInstaller(
  nodePath: string,
  installerCli: string,
  installerRoot: string,
  installerHome: string,
): string {
  const runtimePath = join(installerHome, '.local', 'share', 'alipay-bot-cli', 'runtime')
  let lastError: unknown
  for (let attempt = 1; attempt <= OFFICIAL_INSTALLER_ATTEMPTS; attempt += 1) {
    try {
      execFileSync(nodePath, [installerCli, 'install-cli'], {
        cwd: installerRoot,
        stdio: 'inherit',
        env: { ...process.env, HOME: installerHome },
        timeout: OFFICIAL_INSTALLER_TIMEOUT_MS,
        killSignal: 'SIGTERM',
      })
      if (isFile(join(runtimePath, 'dist', 'cli.js'))) return runtimePath
      throw new Error('官方支付宝安装器未生成 alipay-bot runtime')
    } catch (error) {
      lastError = error
      rmSync(join(installerHome, '.local'), { recursive: true, force: true })
      if (attempt < OFFICIAL_INSTALLER_ATTEMPTS) {
        console.warn(
          `[prepare:alipay-bot-module] 官方安装器第 ${attempt} 次失败，正在重试：${toErrorMessage(error)}`,
        )
      }
    }
  }
  throw new Error(
    `官方支付宝安装器在 ${OFFICIAL_INSTALLER_ATTEMPTS} 次尝试后仍未完成：${toErrorMessage(lastError)}`,
  )
}

function resolveInstallerTimeoutMs(): number {
  const value = process.env.COPIS_ALIPAY_BOT_INSTALL_TIMEOUT_MS?.trim()
  if (!value) return DEFAULT_OFFICIAL_INSTALLER_TIMEOUT_MS
  if (!/^\d+$/.test(value)) {
    throw new Error('COPIS_ALIPAY_BOT_INSTALL_TIMEOUT_MS 必须是毫秒整数')
  }
  const timeout = Number(value)
  if (timeout < MINIMUM_OFFICIAL_INSTALLER_TIMEOUT_MS || timeout > MAXIMUM_OFFICIAL_INSTALLER_TIMEOUT_MS) {
    throw new Error(
      `COPIS_ALIPAY_BOT_INSTALL_TIMEOUT_MS 必须在 ${MINIMUM_OFFICIAL_INSTALLER_TIMEOUT_MS} 到 ${MAXIMUM_OFFICIAL_INSTALLER_TIMEOUT_MS} 之间`,
    )
  }
  return timeout
}

function downloadInstallerPackage(npmPath: string, packageCache: string): string {
  const output = execFileSync(npmPath, [
    'pack',
    '--silent',
    `${ALIPAY_AGENT_PAYMENT_PACKAGE}@${ALIPAY_AGENT_PAYMENT_VERSION}`,
  ], { cwd: packageCache, encoding: 'utf8' }).trim()
  const packageName = output.split(/\r?\n/).at(-1)?.trim()
  if (!packageName) throw new Error('下载官方支付宝安装器失败')
  const packageTarball = join(packageCache, packageName)
  if (!isFile(packageTarball)) throw new Error('官方支付宝安装器归档不存在')
  return packageTarball
}

function verifyInstallerPackage(packageTarball: string): void {
  const actualIntegrity = `sha512-${createHash('sha512').update(readFileSync(packageTarball)).digest('base64')}`
  if (actualIntegrity !== ALIPAY_AGENT_PAYMENT_INTEGRITY) {
    throw new Error('官方支付宝安装器完整性校验失败')
  }
}

function readRuntimeMetadata(runtimePath: string): RuntimePackageMetadata {
  const path = join(runtimePath, 'package.json')
  const metadata = JSON.parse(readFileSync(path, 'utf8')) as Partial<RuntimePackageMetadata>
  if (!metadata.version || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(metadata.version)) {
    throw new Error('官方支付宝 runtime 版本无效')
  }
  return { version: metadata.version }
}

function writeLaunchers(moduleRoot: string, platform: FunctionalModulePlatform): void {
  const bin = join(moduleRoot, 'bin')
  mkdirSync(bin, { recursive: true })
  if (platform === 'win32') {
    writeFileSync(
      join(bin, 'alipay-bot.cmd'),
      '@echo off\r\nif "%COPIS_ALIPAY_BOT_NODE%"=="" (echo 未配置 Copis Node.js runtime >&2 & exit /b 1)\r\n"%COPIS_ALIPAY_BOT_NODE%" "%~dp0..\\runtime\\dist\\cli.js" %*\r\n',
      'utf8',
    )
    return
  }
  const launcher = join(bin, 'alipay-bot')
  writeFileSync(
    launcher,
    '#!/bin/sh\nif [ -z "${COPIS_ALIPAY_BOT_NODE:-}" ]; then\n  echo "未配置 Copis Node.js runtime" >&2\n  exit 1\nfi\nSCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexec "$COPIS_ALIPAY_BOT_NODE" "$SCRIPT_DIR/../runtime/dist/cli.js" "$@"\n',
    { encoding: 'utf8', mode: 0o755 },
  )
  chmodSync(launcher, 0o755)
}

function createArchive(moduleRoot: string, output: string): void {
  const archiveTar = join(dirname(moduleRoot), 'alipay-bot.tar')
  const temporaryOutput = `${output}.${process.pid}.tmp`
  mkdirSync(dirname(output), { recursive: true })
  try {
    execFileSync('tar', ['--format=pax', '-cf', archiveTar, '-C', moduleRoot, '.'], { stdio: 'inherit' })
    // Node zlib avoids requiring an external gzip executable on Windows.
    writeFileSync(temporaryOutput, gzipSync(readFileSync(archiveTar), { mtime: 0 }), { mode: 0o644 })
    renameSync(temporaryOutput, output)
  } finally {
    if (existsSync(temporaryOutput)) rmSync(temporaryOutput, { force: true })
  }
}

function normalizeTimestamps(path: string): void {
  for (const entry of requireDirectory(path)) {
    const entryPath = join(path, entry)
    if (statSync(entryPath).isDirectory()) normalizeTimestamps(entryPath)
    utimesSync(entryPath, new Date(0), new Date(0))
  }
  utimesSync(path, new Date(0), new Date(0))
}

function requireDirectory(path: string): string[] {
  return readdirSync(path).sort()
}

function resolveNpmPath(): string {
  const path = execFileSync('node', ['-p', 'process.execPath'], { encoding: 'utf8' }).trim()
  const npm = process.platform === 'win32' ? join(dirname(path), 'npm.cmd') : join(dirname(path), 'npm')
  if (!isFile(npm)) throw new Error('未找到与 Node.js 配套的 npm')
  return npm
}

function resolveNodePath(): string {
  const path = execFileSync('node', ['-p', 'process.execPath'], { encoding: 'utf8' }).trim()
  if (!isFile(path)) throw new Error('未找到 Node.js')
  return path
}

function isFile(path: string): boolean {
  return existsSync(path) && statSync(path).isFile()
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  const value = index >= 0 ? process.argv[index + 1]?.trim() : undefined
  return value || undefined
}

function parsePlatform(value: string): FunctionalModulePlatform {
  if (value === 'darwin' || value === 'linux' || value === 'win32') return value
  throw new Error(`当前平台不支持支付宝智能体 CLI: ${value}`)
}

function parseArchitecture(value: string): FunctionalModuleArchitecture {
  if (value === 'arm64' || value === 'x64') return value
  throw new Error(`当前架构不支持支付宝智能体 CLI: ${value}`)
}
