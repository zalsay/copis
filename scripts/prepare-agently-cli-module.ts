#!/usr/bin/env bun
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
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

export const AGENTLY_CLI_PACKAGE = '@tencent-qqmail/agently-cli'
export const AGENTLY_CLI_VERSION = '1.0.17'
export const AGENTLY_CLI_INTEGRITY = 'sha512-caBBFdnswGon/oXLSFnKfeztX7nmMvCs2OjREPReJicVypMMZcOLwDByBMUsJzHH6jCjCiZi+UhaIacOf8OIcw=='
export const AGENTLY_CLI_ENTRYPOINT = 'bin/agently-cli'
const AGENTLY_CLI_RUNTIME_ENTRYPOINT = 'node_modules/@tencent-qqmail/agently-cli/scripts/run.js'

interface PreparedAgentlyCliModuleMetadata {
  version: string
  package: string
  path: string
}

if (import.meta.main) main()

export function main(): void {
  const platform = parsePlatform(option('--platform') ?? process.platform)
  const arch = parseArchitecture(option('--arch') ?? process.arch)
  if (platform !== process.platform || arch !== process.arch) {
    throw new Error('Agent QQ 邮箱 CLI 只能在当前本机平台和架构准备')
  }

  const output = resolve(option('--output') ?? `apps/electron/resources/agently-cli/${platform}-${arch}.tar.gz`)
  const metadataOutput = option('--metadata')
  const staging = mkdtempSync(join(tmpdir(), 'copis-agently-cli-module-'))
  try {
    const moduleRoot = join(staging, 'module')
    const runtimeRoot = join(moduleRoot, 'runtime')
    installOfficialCli(runtimeRoot, join(staging, 'package-cache'))
    if (!isFile(join(runtimeRoot, AGENTLY_CLI_RUNTIME_ENTRYPOINT))) {
      throw new Error(`官方 Agent QQ 邮箱 CLI 缺少入口文件: ${AGENTLY_CLI_RUNTIME_ENTRYPOINT}`)
    }
    writeLaunchers(moduleRoot, platform)
    normalizeTimestamps(moduleRoot)
    createArchive(moduleRoot, output)

    if (metadataOutput) {
      const metadata: PreparedAgentlyCliModuleMetadata = {
        version: AGENTLY_CLI_VERSION,
        package: AGENTLY_CLI_PACKAGE,
        path: output,
      }
      const path = resolve(metadataOutput)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8')
    }
    console.log(`[prepare:agently-cli-module] 已生成 ${output}（agently-cli v${AGENTLY_CLI_VERSION}）`)
  } finally {
    rmSync(staging, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
}

function installOfficialCli(runtimeRoot: string, packageCache: string): void {
  mkdirSync(runtimeRoot, { recursive: true })
  mkdirSync(packageCache, { recursive: true })
  const npmPath = resolveNpmPath()
  const packageTarball = downloadOfficialPackage(npmPath, packageCache)
  verifyOfficialPackage(packageTarball)
  execFileSync(npmPath, [
    'install',
    '--ignore-scripts',
    '--omit=dev',
    '--no-audit',
    '--no-fund',
    '--no-package-lock',
    '--no-save',
    packageTarball,
  ], { cwd: runtimeRoot, stdio: 'inherit' })
}

function downloadOfficialPackage(npmPath: string, packageCache: string): string {
  const output = execFileSync(npmPath, [
    'pack',
    '--silent',
    `${AGENTLY_CLI_PACKAGE}@${AGENTLY_CLI_VERSION}`,
  ], { cwd: packageCache, encoding: 'utf8' }).trim()
  const packageName = output.split(/\r?\n/).at(-1)?.trim()
  if (!packageName) throw new Error('下载官方 Agent QQ 邮箱 CLI 失败')
  const packageTarball = join(packageCache, packageName)
  if (!isFile(packageTarball)) throw new Error('官方 Agent QQ 邮箱 CLI 归档不存在')
  return packageTarball
}

function verifyOfficialPackage(packageTarball: string): void {
  const actualIntegrity = `sha512-${createHash('sha512').update(readFileSync(packageTarball)).digest('base64')}`
  if (actualIntegrity !== AGENTLY_CLI_INTEGRITY) {
    throw new Error('官方 Agent QQ 邮箱 CLI 完整性校验失败')
  }
}

function writeLaunchers(moduleRoot: string, platform: FunctionalModulePlatform): void {
  const bin = join(moduleRoot, 'bin')
  mkdirSync(bin, { recursive: true })
  if (platform === 'win32') {
    writeFileSync(
      join(bin, 'agently-cli.cmd'),
      '@echo off\r\nif "%COPIS_AGENTLY_CLI_NODE%"=="" (echo 未配置 Copis Node.js runtime >&2 & exit /b 1)\r\n"%COPIS_AGENTLY_CLI_NODE%" "%~dp0..\\runtime\\node_modules\\@tencent-qqmail\\agently-cli\\scripts\\run.js" %*\r\n',
      'utf8',
    )
    return
  }

  const launcher = join(bin, 'agently-cli')
  writeFileSync(
    launcher,
    '#!/bin/sh\nif [ -z "${COPIS_AGENTLY_CLI_NODE:-}" ]; then\n  echo "未配置 Copis Node.js runtime" >&2\n  exit 1\nfi\nSCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexec "$COPIS_AGENTLY_CLI_NODE" "$SCRIPT_DIR/../runtime/node_modules/@tencent-qqmail/agently-cli/scripts/run.js" "$@"\n',
    { encoding: 'utf8', mode: 0o755 },
  )
  chmodSync(launcher, 0o755)
}

function createArchive(moduleRoot: string, output: string): void {
  const archiveTar = join(dirname(moduleRoot), 'agently-cli.tar')
  const temporaryOutput = `${output}.${process.pid}.tmp`
  mkdirSync(dirname(output), { recursive: true })
  try {
    execFileSync('tar', ['--format=pax', '-cf', archiveTar, '-C', moduleRoot, '.'], {
      stdio: 'inherit',
      env: { ...process.env, LC_ALL: 'C' },
    })
    writeFileSync(temporaryOutput, gzipSync(readFileSync(archiveTar), { mtime: 0 }), { mode: 0o644 })
    renameSync(temporaryOutput, output)
  } finally {
    if (existsSync(temporaryOutput)) rmSync(temporaryOutput, { force: true })
  }
}

function normalizeTimestamps(path: string): void {
  for (const entry of readdirSync(path).sort()) {
    const entryPath = join(path, entry)
    if (statSync(entryPath).isDirectory()) normalizeTimestamps(entryPath)
    utimesSync(entryPath, new Date(0), new Date(0))
  }
  utimesSync(path, new Date(0), new Date(0))
}

function resolveNpmPath(): string {
  const nodePath = execFileSync('node', ['-p', 'process.execPath'], { encoding: 'utf8' }).trim()
  const npmPath = process.platform === 'win32' ? join(dirname(nodePath), 'npm.cmd') : join(dirname(nodePath), 'npm')
  if (!isFile(npmPath)) throw new Error('未找到与 Node.js 配套的 npm')
  return npmPath
}

function isFile(path: string): boolean {
  return existsSync(path) && statSync(path).isFile()
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  const value = index >= 0 ? process.argv[index + 1] : undefined
  return value?.trim() || undefined
}

function parsePlatform(value: string): FunctionalModulePlatform {
  if (value === 'darwin' || value === 'linux' || value === 'win32') return value
  throw new Error(`当前平台不支持 Agent QQ 邮箱 CLI 模块: ${value}`)
}

function parseArchitecture(value: string): FunctionalModuleArchitecture {
  if (value === 'arm64' || value === 'x64') return value
  throw new Error(`当前架构不支持 Agent QQ 邮箱 CLI 模块: ${value}`)
}
