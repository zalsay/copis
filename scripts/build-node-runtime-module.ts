#!/usr/bin/env bun
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

interface NodeRuntimeSource {
  nodePath: string
  npmDirectory: string
}

const output = resolve(option('--output') ?? 'apps/electron/resources/node-runtime/node-runtime.tar.gz')
const sourceRoot = option('--source') ?? process.env.COPIS_NODE_RUNTIME_SOURCE
const source = resolveNodeRuntimeSource(sourceRoot)
const staging = mkdtempSync(join(tmpdir(), 'copis-node-runtime-'))

try {
  const bin = join(staging, 'bin')
  const npmDirectory = join(staging, 'lib', 'node_modules', 'npm')
  mkdirSync(bin, { recursive: true })
  mkdirSync(dirname(npmDirectory), { recursive: true })
  cpSync(source.nodePath, join(bin, nodeFileName()), { force: true, dereference: true })
  cpSync(source.npmDirectory, npmDirectory, { recursive: true, force: true, dereference: true })
  writeNpmLauncher(bin)

  mkdirSync(dirname(output), { recursive: true })
  execFileSync('tar', ['-czf', output, '-C', staging, '.'], {
    stdio: 'inherit',
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  })
  console.log(`[build:node-runtime-module] 已生成 ${output}`)
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
  return { nodePath, npmDirectory }
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
