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

export const DSH_PACKAGE = '@deepseek-ai/dsh'
export const DSH_PACKAGE_VERSION = '0.1.2-rc.1'
export const DSH_VERSION = '0.1.2'
export const DSH_INTEGRITY = 'sha512-RPq48TzxvwpdT9/7W1tbhZDBMmeK+bxDrX9cqQC27Wx/LqtgJF8PSa3b3xriU8oxtvhwYmk21w2cej3uMQrnVA=='
export const DSH_ENTRYPOINT = 'bin/dsh'
const DSH_RUNTIME_ENTRYPOINT = 'node_modules/@deepseek-ai/dsh/lib/bin.js'

interface PreparedDshModuleMetadata {
  version: string
  packageVersion: string
  package: string
  path: string
}

if (import.meta.main) main()

export function main(): void {
  const platform = parsePlatform(option('--platform') ?? process.platform)
  const arch = parseArchitecture(option('--arch') ?? process.arch)
  if (platform !== process.platform || arch !== process.arch) {
    throw new Error('dsh 运行环境只能在当前本机平台和架构准备')
  }

  const output = resolve(option('--output') ?? `apps/electron/resources/dsh/${platform}-${arch}.tar.gz`)
  const metadataOutput = option('--metadata')
  const staging = mkdtempSync(join(tmpdir(), 'copis-dsh-module-'))
  try {
    const moduleRoot = join(staging, 'module')
    const runtimeRoot = join(moduleRoot, 'runtime')
    installOfficialCli(runtimeRoot, join(staging, 'package-cache'))
    if (!isFile(join(runtimeRoot, DSH_RUNTIME_ENTRYPOINT))) {
      throw new Error(`官方 dsh 缺少入口文件: ${DSH_RUNTIME_ENTRYPOINT}`)
    }
    writeLaunchers(moduleRoot, platform)
    normalizeTimestamps(moduleRoot)
    createArchive(moduleRoot, output)

    if (metadataOutput) {
      const metadata: PreparedDshModuleMetadata = {
        version: DSH_VERSION,
        packageVersion: DSH_PACKAGE_VERSION,
        package: DSH_PACKAGE,
        path: output,
      }
      const path = resolve(metadataOutput)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8')
    }
    console.log(`[prepare:dsh-module] 已生成 ${output}（dsh v${DSH_VERSION}，官方包 v${DSH_PACKAGE_VERSION}）`)
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
    `${DSH_PACKAGE}@${DSH_PACKAGE_VERSION}`,
  ], { cwd: packageCache, encoding: 'utf8' }).trim()
  const packageName = output.split(/\r?\n/).at(-1)?.trim()
  if (!packageName) throw new Error('下载官方 dsh 失败')
  const packageTarball = join(packageCache, packageName)
  if (!isFile(packageTarball)) throw new Error('官方 dsh 归档不存在')
  return packageTarball
}

function verifyOfficialPackage(packageTarball: string): void {
  const actualIntegrity = `sha512-${createHash('sha512').update(readFileSync(packageTarball)).digest('base64')}`
  if (actualIntegrity !== DSH_INTEGRITY) {
    throw new Error('官方 dsh 完整性校验失败')
  }
}

function writeLaunchers(moduleRoot: string, platform: FunctionalModulePlatform): void {
  const bin = join(moduleRoot, 'bin')
  mkdirSync(bin, { recursive: true })
  if (platform === 'win32') {
    writeFileSync(
      join(bin, 'dsh.cmd'),
      '@echo off\r\nset "NODE_BIN=%COPIS_DSH_NODE%"\r\nif "%NODE_BIN%"=="" set "NODE_BIN=%COPIS_NODE%"\r\nif "%NODE_BIN%"=="" where node >nul 2>nul && set "NODE_BIN=node"\r\nif "%NODE_BIN%"=="" (echo 未配置 Copis Node.js runtime >&2 & exit /b 1)\r\n"%NODE_BIN%" "%~dp0..\\runtime\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js" %*\r\n',
      'utf8',
    )
    return
  }

  const launcher = join(bin, 'dsh')
  writeFileSync(
    launcher,
    '#!/bin/sh\nNODE_BIN="${COPIS_DSH_NODE:-${COPIS_NODE:-}}"\nif [ -z "$NODE_BIN" ]; then\n  if command -v node >/dev/null 2>&1; then\n    NODE_BIN="node"\n  else\n    echo "未配置 Copis Node.js runtime" >&2\n    exit 1\n  fi\nfi\nSCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexec "$NODE_BIN" "$SCRIPT_DIR/../runtime/node_modules/@deepseek-ai/dsh/lib/bin.js" "$@"\n',
    { encoding: 'utf8', mode: 0o755 },
  )
  chmodSync(launcher, 0o755)
}

function createArchive(moduleRoot: string, output: string): void {
  const archiveTar = join(dirname(moduleRoot), 'dsh.tar')
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
  throw new Error(`当前平台不支持 dsh 模块: ${value}`)
}

function parseArchitecture(value: string): FunctionalModuleArchitecture {
  if (value === 'arm64' || value === 'x64') return value
  throw new Error(`当前架构不支持 dsh 模块: ${value}`)
}
