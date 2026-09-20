#!/usr/bin/env bun
import { createHash } from 'node:crypto'
import { execFileSync, execSync } from 'node:child_process'
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
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

/** 检查文件是否为 Windows PE 可执行文件（MZ 头） */
export function isPeBinary(filePath: string): boolean {
  if (!existsSync(filePath)) return false
  try {
    const buffer = Buffer.alloc(2)
    const fd = openSync(filePath, 'r')
    readSync(fd, buffer, 0, 2, 0)
    closeSync(fd)
    return buffer[0] === 0x4d && buffer[1] === 0x5a // 'MZ'
  } catch {
    return false
  }
}

/** 尝试从候选路径或其关联的 npm 包目录中穿透解析真实的 Codex 原生二进制 */
export function resolveNativeCodexFromCandidate(
  candidatePath: string,
  platform: string = process.platform,
  arch: string = process.arch,
): string | undefined {
  if (platform === 'win32') {
    if (candidatePath.toLowerCase().endsWith('.exe') && isPeBinary(candidatePath)) {
      return candidatePath
    }
    const adjacentExe = candidatePath.replace(/\.(cmd|bat|ps1)$/i, '') + '.exe'
    if (existsSync(adjacentExe) && isPeBinary(adjacentExe)) {
      return adjacentExe
    }
  } else {
    if (existsSync(candidatePath) && !candidatePath.endsWith('.cmd') && !candidatePath.endsWith('.bat')) {
      return candidatePath
    }
  }

  // 针对 npm 全局/局部安装场景解析底层原生包
  const dir = dirname(candidatePath)
  const searchRoots = [
    dir,
    join(dir, 'node_modules'),
    join(dir, '..', 'node_modules'),
  ]
  const targetTriple =
    platform === 'win32'
      ? (arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc')
      : platform === 'darwin'
        ? (arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin')
        : (arch === 'arm64' ? 'aarch64-unknown-linux-musl' : 'x86_64-unknown-linux-musl')

  const pkgName =
    platform === 'win32'
      ? (arch === 'arm64' ? '@openai/codex-win32-arm64' : '@openai/codex-win32-x64')
      : platform === 'darwin'
        ? (arch === 'arm64' ? '@openai/codex-darwin-arm64' : '@openai/codex-darwin-x64')
        : (arch === 'arm64' ? '@openai/codex-linux-arm64' : '@openai/codex-linux-x64')

  const binFilename = platform === 'win32' ? 'codex.exe' : 'codex'

  for (const root of searchRoots) {
    const candidates = [
      join(root, pkgName, 'vendor', targetTriple, 'bin', binFilename),
      join(root, '@openai', 'codex', 'node_modules', pkgName, 'vendor', targetTriple, 'bin', binFilename),
    ]
    for (const c of candidates) {
      if (existsSync(c) && (platform !== 'win32' || isPeBinary(c))) {
        return c
      }
    }
  }

  return undefined
}

export function resolveSourceCodexBinary(
  customBinary?: string,
  options?: { platform?: string; arch?: string },
): string | undefined {
  const platform = options?.platform ?? process.platform
  const arch = options?.arch ?? process.arch

  if (customBinary && existsSync(customBinary)) {
    const native = resolveNativeCodexFromCandidate(resolve(customBinary), platform, arch)
    if (native) return native
    if (platform !== 'win32' || isPeBinary(customBinary)) return resolve(customBinary)
  }
  if (process.env.COPIS_CODEX_CLI_BINARY && existsSync(process.env.COPIS_CODEX_CLI_BINARY)) {
    const native = resolveNativeCodexFromCandidate(resolve(process.env.COPIS_CODEX_CLI_BINARY), platform, arch)
    if (native) return native
    if (platform !== 'win32' || isPeBinary(process.env.COPIS_CODEX_CLI_BINARY)) return resolve(process.env.COPIS_CODEX_CLI_BINARY)
  }
  if (process.env.COPIS_CODEX_EXECUTABLE && existsSync(process.env.COPIS_CODEX_EXECUTABLE)) {
    const native = resolveNativeCodexFromCandidate(resolve(process.env.COPIS_CODEX_EXECUTABLE), platform, arch)
    if (native) return native
    if (platform !== 'win32' || isPeBinary(process.env.COPIS_CODEX_EXECUTABLE)) return resolve(process.env.COPIS_CODEX_EXECUTABLE)
  }

  const home = homedir()
  const candidates: string[] = []
  if (platform === 'darwin') {
    candidates.push(
      '/Applications/ChatGPT.app/Contents/Resources/codex',
      join(home, 'Applications/ChatGPT.app/Contents/Resources/codex'),
      join(home, '.local/bin/codex'),
      '/usr/local/bin/codex',
      '/opt/homebrew/bin/codex',
    )
  } else if (platform === 'win32') {
    candidates.push(
      join(home, '.local', 'bin', 'codex.exe'),
      join(home, '.local', 'bin', 'codex.cmd'),
    )
    const appData = process.env.APPDATA || join(home, 'AppData', 'Roaming')
    candidates.push(join(appData, 'npm', 'codex.cmd'))
    const localAppData = process.env.LOCALAPPDATA || join(home, 'AppData', 'Local')
    candidates.push(join(localAppData, 'Programs', 'codex', 'codex.exe'))
  } else {
    candidates.push(
      join(home, '.local/bin/codex'),
      '/usr/local/bin/codex',
      '/usr/bin/codex',
    )
  }

  for (const candidate of candidates) {
    const native = resolveNativeCodexFromCandidate(candidate, platform, arch)
    if (native) return native
    if (existsSync(candidate) && (platform !== 'win32' || isPeBinary(candidate))) return candidate
  }

  try {
    const whichCmd = platform === 'win32' ? 'where codex' : 'which codex'
    const out = execSync(whichCmd, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 3000,
    }).trim()
    const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    for (const line of lines) {
      const native = resolveNativeCodexFromCandidate(line, platform, arch)
      if (native) return native
      if (existsSync(line) && (platform !== 'win32' || isPeBinary(line))) return line
    }
  } catch {
    // 未在 PATH 中找到
  }

  return undefined
}

export function readCodexCliVersion(binaryPath: string): string {
  try {
    const isWin = process.platform === 'win32'
    const out = execFileSync(binaryPath, ['--version'], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000,
      shell: isWin && (binaryPath.endsWith('.cmd') || binaryPath.endsWith('.bat')),
    }).trim()
    const match = /(\d+\.\d+\.\d+[\w.-]*)/.exec(out)
    if (match?.[1]) return match[1]
  } catch (err) {
    console.warn(`[prepare-codex-cli-module] 读取版本失败 (${binaryPath}):`, err)
  }
  return CODEX_CLI_VERSION
}

export function main(): void {
  const platform = parsePlatform(option('--platform') ?? process.platform)
  const arch = parseArchitecture(option('--arch') ?? process.arch)

  const output = resolve(option('--output') ?? `apps/electron/resources/codex-cli/${platform}-${arch}.tar.gz`)
  const metadataOutput = option('--metadata')
  const binaryOption = option('--binary')

  const sourceBinary = resolveSourceCodexBinary(binaryOption, { platform, arch })
  if (!sourceBinary) {
    throw new Error(
      `未找到专业模式核心组件 (codex) 二进制文件。请通过 --binary <path> 或环境变量 COPIS_CODEX_CLI_BINARY 指定路径。`,
    )
  }

  if (platform === 'win32' && !isPeBinary(sourceBinary)) {
    throw new Error(
      `检测到的文件不是有效的 Windows PE 二进制文件: ${sourceBinary}。请指定正确的原生 codex.exe 路径。`,
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
      const hostExe = join(dirname(sourceBinary), 'codex-code-mode-host.exe')
      if (existsSync(hostExe) && isPeBinary(hostExe)) {
        copyFileSync(hostExe, join(binDir, 'codex-code-mode-host.exe'))
      }
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
      const hostBin = join(dirname(sourceBinary), 'codex-code-mode-host')
      if (existsSync(hostBin)) {
        copyFileSync(hostBin, join(binDir, 'codex-code-mode-host'))
        chmodSync(join(binDir, 'codex-code-mode-host'), 0o755)
      }
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
