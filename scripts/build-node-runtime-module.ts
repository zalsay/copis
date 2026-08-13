#!/usr/bin/env bun
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { execFileSync } from 'node:child_process'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { gzipSync } from 'node:zlib'

interface NodeRuntimeSource {
  nodePath: string
  npmDirectory: string
  version: string
}

const NODE_RUNTIME_MAJOR = 24
const ARCHIVE_TIMESTAMP = new Date(0)
const output = resolve(option('--output') ?? 'apps/electron/resources/node-runtime/node-runtime.tar.gz')
const sourceRoot = option('--source') ?? process.env.COPIS_NODE_RUNTIME_SOURCE
const source = resolveNodeRuntimeSource(sourceRoot)
const staging = mkdtempSync(join(tmpdir(), 'copis-node-runtime-'))

try {
  const bin = join(staging, 'bin')
  const npmDirectory = join(staging, 'lib', 'node_modules', 'npm')
  mkdirSync(bin, { recursive: true })
  mkdirSync(dirname(npmDirectory), { recursive: true })
  cpSync(source.nodePath, join(bin, nodeFileName()), {
    force: true,
    dereference: true,
    preserveTimestamps: true,
  })
  if (process.platform === 'darwin') {
    bundleMacRuntimeLibraries(source.nodePath, join(bin, nodeFileName()), join(staging, 'lib'))
  }
  cpSync(source.npmDirectory, npmDirectory, {
    recursive: true,
    force: true,
    dereference: true,
    preserveTimestamps: true,
  })
  writeNpmLauncher(bin)
  normalizeTimestamps(staging)
  const archiveEntriesPath = join(staging, '.archive-entries')
  writeFileSync(archiveEntriesPath, `${listArchiveEntries(staging).join('\n')}\n`, 'utf8')
  const tarPath = join(staging, 'node-runtime.tar')

  mkdirSync(dirname(output), { recursive: true })
  execFileSync('tar', ['--format', 'ustar', '-cf', tarPath, '-C', staging, '-T', archiveEntriesPath], {
    stdio: 'inherit',
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  })
  compressDeterministicTar(tarPath, output)
  console.log(`[build:node-runtime-module] 已生成 ${output}（Node.js v${source.version}）`)
} finally {
  rmSync(staging, { recursive: true, force: true })
}

function resolveNodeRuntimeSource(configuredRoot: string | undefined): NodeRuntimeSource {
  const nodePath = configuredRoot
    ? findNodeInRoot(resolve(configuredRoot))
    : resolveSystemNodePath()
  const root = nodeRuntimeRoots(nodePath)
    .find((candidate) => npmDirectoryInRoot(candidate) !== undefined)
  if (!root) {
    throw new Error(`未找到与 Node.js 配套的 npm 目录: ${nodePath}`)
  }
  const npmDirectory = npmDirectoryInRoot(root)
  if (!npmDirectory) throw new Error(`未找到与 Node.js 配套的 npm 目录: ${root}`)
  return { nodePath, npmDirectory, version: nodeRuntimeVersion(nodePath) }
}

function nodeRuntimeVersion(nodePath: string): string {
  let version: string
  try {
    version = execFileSync(nodePath, ['--version'], { encoding: 'utf8' }).trim()
  } catch (error) {
    throw new Error(`无法读取 Node.js runtime 版本: ${nodePath}`, { cause: error })
  }
  const major = /^v?(\d+)\./.exec(version)?.[1]
  if (Number(major) !== NODE_RUNTIME_MAJOR) {
    throw new Error(`Node.js runtime 必须使用 Node.js ${NODE_RUNTIME_MAJOR}，当前为 ${version || '未知版本'}`)
  }
  return version.replace(/^v/, '')
}

function resolveSystemNodePath(): string {
  const node = execFileSync('node', ['-p', 'process.execPath'], { encoding: 'utf8' }).trim()
  if (!node || !existsSync(node)) throw new Error('构建 Node.js runtime 模块时未找到 Node.js')
  return resolve(node)
}

function findNodeInRoot(root: string): string {
  for (const candidate of [join(root, 'bin', nodeFileName()), join(root, nodeFileName())]) {
    if (isFile(candidate)) return candidate
  }
  throw new Error(`Node.js runtime 源目录缺少 ${nodeFileName()}: ${root}`)
}

function nodeRuntimeRoots(nodePath: string): string[] {
  const nodeDirectory = dirname(nodePath)
  return [nodeDirectory, dirname(nodeDirectory)]
}

function npmDirectoryInRoot(root: string): string | undefined {
  for (const candidate of [join(root, 'lib', 'node_modules', 'npm'), join(root, 'node_modules', 'npm')]) {
    if (isDirectory(candidate)) return candidate
  }
  return undefined
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

function listArchiveEntries(root: string, relativePath = '.'): string[] {
  const absolutePath = relativePath === '.' ? root : join(root, relativePath)
  const entries = readdirSync(absolutePath, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
  const result: string[] = []
  for (const entry of entries) {
    const childPath = relativePath === '.' ? `./${entry.name}` : `${relativePath}/${entry.name}`
    if (entry.isDirectory()) {
      result.push(...listArchiveEntries(root, childPath))
    } else {
      result.push(childPath)
    }
  }
  return result
}

function compressDeterministicTar(tarPath: string, output: string): void {
  const temporaryOutput = `${output}.${process.pid}.tmp`
  try {
    // Node zlib 在 Windows 上不依赖外部 gzip 可执行文件。
    writeFileSync(temporaryOutput, gzipSync(readFileSync(tarPath), { mtime: 0 }))
    renameSync(temporaryOutput, output)
  } finally {
    if (existsSync(temporaryOutput)) rmSync(temporaryOutput, { force: true })
  }
}

function writeNpmLauncher(bin: string): void {
  if (process.platform === 'win32') {
    writeFileSync(
      join(bin, 'npm.cmd'),
      '@echo off\r\n"%~dp0node.exe" "%~dp0..\\lib\\node_modules\\npm\\bin\\npm-cli.js" %*\r\n',
      'utf8',
    )
    return
  }
  writeFileSync(
    join(bin, 'npm'),
    '#!/bin/sh\nSCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexec "$SCRIPT_DIR/node" "$SCRIPT_DIR/../lib/node_modules/npm/bin/npm-cli.js" "$@"\n',
    { encoding: 'utf8', mode: 0o755 },
  )
}

interface MacRuntimeLibrary {
  sourcePath: string
  bundledPath: string
}

/** 将 Homebrew Node 的动态库收进模块，避免正式 App 依赖构建机路径。 */
function bundleMacRuntimeLibraries(sourceNodePath: string, bundledNodePath: string, bundledLibDirectory: string): void {
  const libraries = new Map<string, MacRuntimeLibrary>()
  const pending = [sourceNodePath]
  mkdirSync(bundledLibDirectory, { recursive: true })

  while (pending.length > 0) {
    const currentPath = pending.pop()!
    for (const dependency of macDynamicDependencies(currentPath)) {
      const dependencyPath = resolveMacDynamicDependency(currentPath, dependency)
      if (!dependencyPath || isMacSystemLibrary(dependencyPath)) continue
      const canonicalPath = realpathSync(dependencyPath)
      const bundledPath = join(bundledLibDirectory, basename(canonicalPath))
      const existing = libraries.get(canonicalPath)
      if (existing) continue
      const conflicting = [...libraries.values()].find((library) => library.bundledPath === bundledPath)
      if (conflicting && conflicting.sourcePath !== canonicalPath) {
        throw new Error(`macOS 动态库文件名冲突：${conflicting.sourcePath} 与 ${canonicalPath}`)
      }
      cpSync(canonicalPath, bundledPath, { force: true, dereference: true, preserveTimestamps: true })
      libraries.set(canonicalPath, { sourcePath: canonicalPath, bundledPath })
      pending.push(canonicalPath)
    }
  }

  const bundledFiles = [
    ...libraries.values(),
    { sourcePath: sourceNodePath, bundledPath: bundledNodePath },
  ]
  for (const library of bundledFiles) {
    rewriteMacDynamicDependencies(library.sourcePath, library.bundledPath, libraries)
    if (library.bundledPath.endsWith('.dylib')) {
      execFileSync('install_name_tool', ['-id', `@rpath/${basename(library.bundledPath)}`, library.bundledPath])
    }
    execFileSync('codesign', ['--force', '--sign', '-', library.bundledPath], { stdio: 'ignore' })
  }
}

function macDynamicDependencies(path: string): string[] {
  const output = execFileSync('otool', ['-L', path], { encoding: 'utf8' })
  return output
    .split('\n')
    .slice(1)
    .map((line) => /^\s*(\S+)/.exec(line)?.[1])
    .filter((dependency): dependency is string => Boolean(dependency))
}

function macRuntimePaths(path: string): string[] {
  const output = execFileSync('otool', ['-l', path], { encoding: 'utf8' })
  return [...output.matchAll(/cmd LC_RPATH[\s\S]*?path (\S+) \(offset \d+\)/g)].map((match) => match[1]!)
}

function resolveMacDynamicDependency(ownerPath: string, dependency: string): string | undefined {
  if (dependency.startsWith('/')) return existsSync(dependency) ? dependency : undefined
  if (dependency.startsWith('@loader_path/')) {
    const path = join(dirname(ownerPath), dependency.slice('@loader_path/'.length))
    return existsSync(path) ? path : undefined
  }
  if (dependency.startsWith('@executable_path/')) {
    const path = join(dirname(ownerPath), dependency.slice('@executable_path/'.length))
    return existsSync(path) ? path : undefined
  }
  if (dependency.startsWith('@rpath/')) {
    const relativePath = dependency.slice('@rpath/'.length)
    for (const rpath of macRuntimePaths(ownerPath)) {
      const expanded = rpath
        .replace('@loader_path', dirname(ownerPath))
        .replace('@executable_path', dirname(ownerPath))
      const path = join(expanded, relativePath)
      if (existsSync(path)) return path
    }
  }
  return undefined
}

function isMacSystemLibrary(path: string): boolean {
  return path.startsWith('/usr/lib/')
    || path.startsWith('/System/Library/')
    || path.startsWith('/System/Volumes/Preboot/Cryptexes/OS/')
}

function rewriteMacDynamicDependencies(
  sourcePath: string,
  bundledPath: string,
  libraries: ReadonlyMap<string, MacRuntimeLibrary>,
): void {
  const changes: string[] = []
  for (const dependency of macDynamicDependencies(sourcePath)) {
    const dependencyPath = resolveMacDynamicDependency(sourcePath, dependency)
    if (!dependencyPath || isMacSystemLibrary(dependencyPath)) continue
    const canonicalPath = realpathSync(dependencyPath)
    const bundled = libraries.get(canonicalPath)
    if (!bundled) throw new Error(`macOS 动态库未被打包：${dependency} (${sourcePath})`)
    changes.push(dependency, `@rpath/${basename(bundled.bundledPath)}`)
  }
  if (changes.length > 0) {
    const argumentsList: string[] = []
    for (let index = 0; index < changes.length; index += 2) {
      argumentsList.push('-change', changes[index]!, changes[index + 1]!)
    }
    execFileSync('install_name_tool', [...argumentsList, bundledPath])
  }
}

function nodeFileName(): string {
  return process.platform === 'win32' ? 'node.exe' : 'node'
}

function isFile(path: string): boolean {
  return existsSync(path) && statSync(path).isFile()
}

function isDirectory(path: string): boolean {
  return existsSync(path) && statSync(path).isDirectory()
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  const value = index >= 0 ? process.argv[index + 1]?.trim() : undefined
  return value || undefined
}
