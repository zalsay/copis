#!/usr/bin/env bun
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { gzipSync } from 'node:zlib'
import type { FunctionalModuleArchitecture, FunctionalModulePlatform } from '@copis/shared'

export const PYTHON_RUNTIME_RELEASE_TAG = '20260814'
export const PYTHON_RUNTIME_VERSION = '3.12.14'
export const PYTHON_RUNTIME_RELEASE_BASE_URL = `https://github.com/astral-sh/python-build-standalone/releases/download/${PYTHON_RUNTIME_RELEASE_TAG}`

export type PythonRuntimeTarget = `${FunctionalModulePlatform}-${FunctionalModuleArchitecture}`

export interface PythonRuntimeAsset {
  platform: FunctionalModulePlatform
  arch: FunctionalModuleArchitecture
  archiveName: string
  url: string
  sha256: string
}

const PYTHON_RUNTIME_ASSET_VALUES: Record<PythonRuntimeTarget, PythonRuntimeAsset> = {
  'darwin-arm64': asset('darwin', 'arm64', 'aarch64-apple-darwin', '4572133a5542f306b9bdb155da5800f9e38950cd0a98d469b832ce256fe299ea'),
  'darwin-x64': asset('darwin', 'x64', 'x86_64-apple-darwin', '1a94c83264731e9603fbea78e57e7ca8f20e7d91eb866627ac2304621b0f6f1f'),
  'linux-arm64': asset('linux', 'arm64', 'aarch64-unknown-linux-gnu', '4952b18bafda1880d4ab1f86e1c348dbdb31f0e6d049e76dc5f052f2f796f1c5'),
  'linux-x64': asset('linux', 'x64', 'x86_64-unknown-linux-gnu', '3297691ae34f75fed81ac424e040145fccb0bafe8e581cd5cadbddfa1c0766c0'),
  'win32-arm64': asset('win32', 'arm64', 'aarch64-pc-windows-msvc', '6a7e4b012dd74eeb674ca0591ad1e676fc8d37a650e71c7b2140c3c8ed632e30'),
  'win32-x64': asset('win32', 'x64', 'x86_64-pc-windows-msvc', '7330282b47cd43a66b702d39078d2e5a88e580cee351d82f95045f21f5ee042a'),
}

export const PYTHON_RUNTIME_ASSETS: Readonly<Record<PythonRuntimeTarget, PythonRuntimeAsset>> =
  PYTHON_RUNTIME_ASSET_VALUES

const ARCHIVE_TIMESTAMP = new Date(0)

export interface PackPythonRuntimeModuleInput {
  platform: FunctionalModulePlatform
  arch: FunctionalModuleArchitecture
  sourceArchive: Buffer
  expectedSourceSha256: string
  output: string
}

export interface PreparedPythonRuntimeModule {
  path: string
  version: string
  sha256: string
  size: number
  sourceSha256: string
  assetName?: string
}

export interface PreparePythonRuntimeModuleInput {
  platform: FunctionalModulePlatform
  arch: FunctionalModuleArchitecture
  output: string
  sourceArchivePath?: string
  fetch?: typeof fetch
}

/** 返回目标平台对应的官方 install_only 归档信息。 */
export function getPythonRuntimeAsset(
  platform: FunctionalModulePlatform,
  arch: FunctionalModuleArchitecture,
): PythonRuntimeAsset {
  return PYTHON_RUNTIME_ASSETS[`${platform}-${arch}`]
}

/** 将 python-build-standalone 归档整理为 Copis 统一的功能模块目录。 */
export function packPythonRuntimeModule(
  input: PackPythonRuntimeModuleInput,
): PreparedPythonRuntimeModule {
  const expectedSourceSha256 = normalizeSha256(input.expectedSourceSha256, '期望的 Python runtime 源归档 SHA256')
  const sourceSha256 = sha256(input.sourceArchive)
  if (sourceSha256 !== expectedSourceSha256) {
    throw new Error(`Python runtime 源归档 SHA256 校验失败：期望 ${expectedSourceSha256}，实际 ${sourceSha256}`)
  }

  const output = resolve(input.output)
  const staging = mkdtempSync(join(tmpdir(), 'copis-python-runtime-module-'))
  const sourcePath = join(staging, 'source.tar.gz')
  const runtimeRoot = join(staging, 'runtime')
  const temporaryOutput = `${output}.${process.pid}.tmp`

  try {
    writeFileSync(sourcePath, input.sourceArchive)
    const archiveEntries = readSourceArchiveEntries(sourcePath)
    const normalizedEntries = normalizePythonRuntimeArchiveEntries(archiveEntries)
    const sourceEntrypoint = input.platform === 'win32'
      ? pythonExecutableName(input.platform)
      : `bin/${pythonExecutableName(input.platform)}`
    if (!normalizedEntries.includes(sourceEntrypoint)) {
      throw new Error(`Python runtime 源归档缺少入口：${sourceEntrypoint}`)
    }

    mkdirSync(runtimeRoot, { recursive: true })
    execFileSync('tar', [
      '-xzf',
      sourcePath,
      '-C',
      runtimeRoot,
      '--strip-components=1',
    ], {
      stdio: 'ignore',
      env: { ...process.env, COPYFILE_DISABLE: '1' },
    })
    if (input.platform === 'win32') normalizeWindowsRuntimeLayout(runtimeRoot)
    const outputEntrypoint = `./bin/${pythonExecutableName(input.platform)}`
    if (!listArchiveEntries(runtimeRoot).includes(outputEntrypoint)) {
      throw new Error(`Python runtime 整理后缺少入口：bin/${pythonExecutableName(input.platform)}`)
    }
    normalizeTimestamps(runtimeRoot)

    const archiveEntriesPath = join(staging, '.archive-entries')
    writeFileSync(archiveEntriesPath, `${listArchiveEntries(runtimeRoot).join('\n')}\n`, 'utf8')
    const tarPath = join(staging, 'python-runtime.tar')
    execFileSync('tar', [
      '--format',
      'ustar',
      '-cf',
      tarPath,
      '-C',
      runtimeRoot,
      '-T',
      archiveEntriesPath,
    ], {
      stdio: 'ignore',
      env: { ...process.env, COPYFILE_DISABLE: '1' },
    })

    mkdirSync(dirname(output), { recursive: true })
    writeFileSync(temporaryOutput, gzipSync(readFileSync(tarPath), { mtime: 0 }), { mode: 0o644 })
    renameSync(temporaryOutput, output)
    const body = readFileSync(output)
    return {
      path: output,
      version: PYTHON_RUNTIME_VERSION,
      sha256: sha256(body),
      size: body.byteLength,
      sourceSha256,
    }
  } finally {
    if (existsSync(temporaryOutput)) rmSync(temporaryOutput, { force: true })
    rmSync(staging, { recursive: true, force: true })
  }
}

/** 下载并校验官方归档后再生成目标平台模块；sourceArchivePath 便于离线重打包。 */
export async function preparePythonRuntimeModule(
  input: PreparePythonRuntimeModuleInput,
): Promise<PreparedPythonRuntimeModule> {
  const asset = getPythonRuntimeAsset(input.platform, input.arch)
  const sourceArchive = input.sourceArchivePath
    ? readFileSync(resolve(input.sourceArchivePath))
    : await fetchPythonRuntimeArchive(asset.url, input.fetch ?? fetch)
  const prepared = packPythonRuntimeModule({
    platform: input.platform,
    arch: input.arch,
    sourceArchive,
    expectedSourceSha256: asset.sha256,
    output: input.output,
  })
  return { ...prepared, assetName: asset.archiveName }
}

/** manifest 使用的统一 Python 可执行文件入口。 */
export function pythonRuntimeEntrypoint(platform: FunctionalModulePlatform): string {
  return `bin/python${platform === 'win32' ? '.exe' : ''}`
}

/** 仅允许官方归档的 python/ 根目录，并移除该根目录得到统一布局。 */
export function normalizePythonRuntimeArchiveEntries(entries: readonly string[]): string[] {
  return entries
    .map((entry) => entry.trim().replace(/^\.\//, '').replace(/\/$/, ''))
    .filter(Boolean)
    .map((entry) => {
      if (entry === 'python') return ''
      if (!entry.startsWith('python/')) {
        throw new Error(`Python runtime 源归档根目录不合法：${entry}`)
      }
      const normalized = entry.slice('python/'.length)
      if (!normalized || normalized === '.' || normalized.startsWith('../') || normalized.includes('/../')) {
        throw new Error(`Python runtime 源归档包含不安全路径：${entry}`)
      }
      return normalized
    })
    .filter(Boolean)
}

async function fetchPythonRuntimeArchive(url: string, fetchImpl: typeof fetch): Promise<Buffer> {
  let response: Response
  try {
    response = await fetchImpl(url, {
      headers: {
        Accept: 'application/octet-stream',
        'User-Agent': 'Copis-functional-module-release',
      },
    })
  } catch (error) {
    throw new Error(`下载 Python runtime 官方归档失败：${url}`, { cause: error })
  }
  if (!response.ok) {
    throw new Error(`下载 Python runtime 官方归档失败：HTTP ${response.status} ${url}`)
  }
  return Buffer.from(await response.arrayBuffer())
}

function readSourceArchiveEntries(sourcePath: string): string[] {
  let listing: string
  try {
    listing = execFileSync('tar', ['-tzf', sourcePath], { encoding: 'utf8' })
  } catch (error) {
    throw new Error('Python runtime 源归档不是有效 tar.gz', { cause: error })
  }
  return listing.split(/\r?\n/).filter(Boolean)
}

function normalizeTimestamps(path: string): void {
  const entries = readdirSync(path, { withFileTypes: true })
  for (const entry of entries) {
    const entryPath = join(path, entry.name)
    if (entry.isDirectory()) normalizeTimestamps(entryPath)
    utimesSync(entryPath, ARCHIVE_TIMESTAMP, ARCHIVE_TIMESTAMP)
  }
  utimesSync(path, ARCHIVE_TIMESTAMP, ARCHIVE_TIMESTAMP)
}

/** Windows 源包没有 Unix 的 bin 目录，将完整安装树放入 bin 以保持 DLL/Lib 相对路径。 */
function normalizeWindowsRuntimeLayout(root: string): void {
  const bin = join(root, 'bin')
  mkdirSync(bin, { recursive: true })
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name === 'bin') continue
    renameSync(join(root, entry.name), join(bin, entry.name))
  }
}

function listArchiveEntries(root: string, relativePath = '.'): string[] {
  const absolutePath = relativePath === '.' ? root : join(root, relativePath)
  const entries = readdirSync(absolutePath, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
  const result: string[] = []
  for (const entry of entries) {
    const childPath = relativePath === '.' ? `./${entry.name}` : `${relativePath}/${entry.name}`
    if (entry.isDirectory()) result.push(...listArchiveEntries(root, childPath))
    else result.push(childPath)
  }
  return result
}

function asset(
  platform: FunctionalModulePlatform,
  arch: FunctionalModuleArchitecture,
  target: string,
  sha256Value: string,
): PythonRuntimeAsset {
  const archiveName = `cpython-${PYTHON_RUNTIME_VERSION}+${PYTHON_RUNTIME_RELEASE_TAG}-${target}-install_only.tar.gz`
  return {
    platform,
    arch,
    archiveName,
    url: `${PYTHON_RUNTIME_RELEASE_BASE_URL}/${encodeURIComponent(archiveName)}`,
    sha256: sha256Value,
  }
}

function pythonExecutableName(platform: FunctionalModulePlatform): string {
  return platform === 'win32' ? 'python.exe' : 'python'
}

function normalizeSha256(value: string, label: string): string {
  const normalized = value.trim().toLowerCase()
  if (!/^[a-f0-9]{64}$/.test(normalized)) throw new Error(`${label} 不合法：${value}`)
  return normalized
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function parsePlatform(value: string): FunctionalModulePlatform {
  if (value === 'darwin' || value === 'linux' || value === 'win32') return value
  throw new Error(`当前平台不支持 Python runtime 功能模块：${value}`)
}

function parseArchitecture(value: string): FunctionalModuleArchitecture {
  if (value === 'arm64' || value === 'x64') return value
  throw new Error(`当前架构不支持 Python runtime 功能模块：${value}`)
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  const value = index >= 0 ? process.argv[index + 1]?.trim() : undefined
  return value || undefined
}

async function main(): Promise<void> {
  const platform = parsePlatform(option('--platform') ?? process.platform)
  const arch = parseArchitecture(option('--arch') ?? process.arch)
  const output = resolve(
    option('--output')
      ?? `apps/electron/resources/python-runtime/${platform}-${arch}.tar.gz`,
  )
  const prepared = await preparePythonRuntimeModule({
    platform,
    arch,
    output,
    sourceArchivePath: option('--source-archive') ?? process.env.COPIS_PYTHON_RUNTIME_SOURCE_ARCHIVE?.trim(),
  })
  console.log(
    `[prepare:python-runtime-module] 已准备 Python v${prepared.version}: ${prepared.path} sha256=${prepared.sha256} size=${prepared.size}`,
  )
}

if (import.meta.main) await main()
