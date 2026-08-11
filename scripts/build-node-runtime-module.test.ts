import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const tempRoots: string[] = []
const repoRoot = resolve(import.meta.dir, '..')

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop()!, { recursive: true, force: true })
  }
})

function createNodeRuntimeSource(version: string): string {
  const root = mkdtempSync(join(tmpdir(), 'copis-node-runtime-source-'))
  tempRoots.push(root)
  const nodePath = join(root, 'bin', 'node')
  mkdirSync(join(root, 'bin'), { recursive: true })
  mkdirSync(join(root, 'lib', 'node_modules', 'npm'), { recursive: true })
  writeFileSync(
    nodePath,
    `#!/bin/sh\nif [ "$1" = "--version" ]; then\n  echo "${version}"\nfi\n`,
    { encoding: 'utf8', mode: 0o755 },
  )
  writeFileSync(join(root, 'lib', 'node_modules', 'npm', 'package.json'), '{"name":"npm"}\n', 'utf8')
  return root
}

function runBuild(source: string, output: string): { exitCode: number; output: string } {
  const result = Bun.spawnSync([
    process.execPath,
    'scripts/build-node-runtime-module.ts',
    '--source',
    source,
    '--output',
    output,
  ], { cwd: repoRoot })
  return {
    exitCode: result.exitCode,
    output: `${new TextDecoder().decode(result.stdout)}${new TextDecoder().decode(result.stderr)}`,
  }
}

describe('Node.js runtime 模块构建', () => {
  test('Given Node.js 22 源 When 构建运行时 Then 拒绝生成归档', () => {
    const root = mkdtempSync(join(tmpdir(), 'copis-node-runtime-build-'))
    tempRoots.push(root)

    const result = runBuild(createNodeRuntimeSource('v22.19.0'), join(root, 'node-runtime.tar.gz'))

    expect(result.exitCode).not.toBe(0)
    expect(result.output).toContain('必须使用 Node.js 24')
  })

  test('Given Node.js 24 源 When 构建运行时 Then 生成归档', () => {
    const root = mkdtempSync(join(tmpdir(), 'copis-node-runtime-build-'))
    tempRoots.push(root)
    const output = join(root, 'node-runtime.tar.gz')

    const result = runBuild(createNodeRuntimeSource('v24.19.0'), output)

    expect(result.exitCode).toBe(0)
    expect(existsSync(output)).toBe(true)
  })

  test('Given 相同 Node.js 24 源 When 跨秒连续构建运行时 Then 生成相同 SHA256 归档', async () => {
    const root = mkdtempSync(join(tmpdir(), 'copis-node-runtime-build-'))
    tempRoots.push(root)
    const source = createNodeRuntimeSource('v24.19.0')
    const firstOutput = join(root, 'first.tar.gz')
    const secondOutput = join(root, 'second.tar.gz')

    expect(runBuild(source, firstOutput).exitCode).toBe(0)
    await Bun.sleep(1_100)
    expect(runBuild(source, secondOutput).exitCode).toBe(0)

    const firstSha256 = createHash('sha256').update(readFileSync(firstOutput)).digest('hex')
    const secondSha256 = createHash('sha256').update(readFileSync(secondOutput)).digest('hex')
    expect(secondSha256).toBe(firstSha256)
  })
})
