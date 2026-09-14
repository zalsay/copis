#!/usr/bin/env bun
import { createHash } from 'node:crypto'
import { execFileSync, execSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
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
import { homedir, tmpdir } from 'node:os'
import { gzipSync } from 'node:zlib'
import type { FunctionalModuleArchitecture, FunctionalModulePlatform } from '@copis/shared'

export const CODEX_CLI_VERSION = '0.154.0'
export const CODEX_CLI_ENTRYPOINT = 'bin/codex'

export interface PreparedCodexCliModuleMetadata {
  version: string
  path: string
  sha256: string
  size: number
}

export function resolveSourceCodexBinary(customBinary?: string): string | undefined {
  if (customBinary && existsSync(customBinary)) return resolve(customBinary)
  if (process.env.COPIS_CODEX_CLI_BINARY && existsSync(process.env.COPIS_CODEX_CLI_BINARY)) {
    return resolve(process.env.COPIS_CODEX_CLI_BINARY)
  }
  if (process.env.COPIS_CODEX_EXECUTABLE && existsSync(process.env.COPIS_CODEX_EXECUTABLE)) {
    return resolve(process.env.COPIS_CODEX_EXECUTABLE)
  }

  const home = homedir()
  const candidates: string[] = []
  if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/ChatGPT.app/Contents/Resources/codex',
      join(home, 'Applications/ChatGPT.app/Contents/Resources/codex'),
      join(home, '.local/bin/codex'),
      '/usr/local/bin/codex',
      '/opt/homebrew/bin/codex',
    )
  } else if (process.platform === 'win32') {
    candidates.push(
      join(home, '.local', 'bin', 'codex.cmd'),
      join(home, '.local', 'bin', 'codex.exe'),
    )
  } else {
    candidates.push(
      join(home, '.local/bin/codex'),
      '/usr/local/bin/codex',
      '/usr/bin/codex',
    )
  }

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }

  try {
    const whichCmd = process.platform === 'win32' ? 'where codex' : 'which codex'
    const out = execSync(whichCmd, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 3000,
    }).trim()
    const first = out.split(/\r?\n/)[0]?.trim()
    if (first && existsSync(first)) return first
  } catch {
    // 未在 PATH 中找到
  }

  return undefined
}

export function readCodexCliVersion(binaryPath: string): string {
  try {
    const out = execFileSync(binaryPath, ['--version'], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000,
    }).trim()
    const match = /(\d+\.\d+\.\d+)/.exec(out)
    if (match?.[1]) return match[1]
  } catch {
    // 忽略错误并回退固定版本
  }
  return CODEX_CLI_VERSION
}

export function main(): void {
  const platform = parsePlatform(option('--platform') ?? process.platform)
  const arch = parseArchitecture(option('--arch') ?? process.arch)

  const output = resolve(option('--output') ?? `apps/electron/resources/codex-cli/${platform}-${arch}.tar.gz`)
  const metadataOutput = option('--metadata')
  const binaryOption = option('--binary')

  const sourceBinary = resolveSourceCodexBinary(binaryOption)
  if (!sourceBinary) {
    throw new Error(
      `未找到专业模式核心组件 (codex) 二进制文件。请通过 --binary <path> 或环境变量 COPIS_CODEX_CLI_BINARY 指定路径。`,
    )
  }

  const version = option('--version') ?? process.env.COPIS_CODEX_CLI_VERSION ?? readCodexCliVersion(sourceBinary)

  const staging = mkdtempSync(join(tmpdir(), 'copis-codex-cli-module-'))
  try {
    const moduleRoot = join(staging, 'module')
    const binDir = join(moduleRoot, 'bin')
    mkdirSync(binDir, { recursive: true })

    if (platform === 'win32') {
      const targetExe = join(binDir, 'codex.exe')
      copyFileSync(sourceBinary, targetExe)
      // 生成启动批处理
      writeFileSync(
        join(binDir, 'codex.cmd'),
        '@echo off\r\n"%~dp0codex.exe" %*\r\n',
        'utf8',
      )
    } else {
      const targetBin = join(binDir, 'codex')
      copyFileSync(sourceBinary, targetBin)
      chmodSync(targetBin, 0o755)
    }

    normalizeTimestamps(moduleRoot)
    createArchive(moduleRoot, output)

    const archiveBuffer = readFileSync(output)
    const sha256 = createHash('sha256').update(archiveBuffer).digest('hex')
    const size = archiveBuffer.byteLength

    if (metadataOutput) {
      const metadata: PreparedCodexCliModuleMetadata = {
        version,
        path: output,
        sha256,
        size,
      }
      const path = resolve(metadataOutput)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8')
    }
    console.log(`[prepare:codex-cli-module] 已生成 ${output}（codex-cli v${version}, sha256=${sha256}）`)
  } finally {
    rmSync(staging, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
}

function createArchive(moduleRoot: string, output: string): void {
  const archiveTar = join(dirname(moduleRoot), 'codex-cli.tar')
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

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  const value = index >= 0 ? process.argv[index + 1] : undefined
  return value?.trim() || undefined
}

function parsePlatform(value: string): FunctionalModulePlatform {
  if (value === 'darwin' || value === 'linux' || value === 'win32') return value
  throw new Error(`当前平台不支持专业模式核心组件模块: ${value}`)
}

function parseArchitecture(value: string): FunctionalModuleArchitecture {
  if (value === 'arm64' || value === 'x64') return value
  throw new Error(`当前架构不支持专业模式核心组件模块: ${value}`)
}

if (import.meta.main) main()
