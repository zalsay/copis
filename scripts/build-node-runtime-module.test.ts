import { afterEach, describe, expect, test } from 'bun:test'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
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
  const nodePath = join(root, 'bin', process.platform === 'win32' ? 'node.exe' : 'node')
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

function extractArchive(archive: string, output: string): void {
  const result = Bun.spawnSync(['tar', '-xzf', archive, '-C', output])
  expect(result.exitCode).toBe(0)
}

describe('Node.js runtime 模块构建', () => {
  const testOnUnix = process.platform === 'win32' ? test.skip : test

  testOnUnix('Given Node.js 22 源 When 构建运行时 Then 拒绝生成归档', () => {
    const root = mkdtempSync(join(tmpdir(), 'copis-node-runtime-build-'))
    tempRoots.push(root)

    const result = runBuild(createNodeRuntimeSource('v22.19.0'), join(root, 'node-runtime.tar.gz'))

    expect(result.exitCode).not.toBe(0)
    expect(result.output).toContain('必须使用 Node.js 24')
  })

  testOnUnix('Given Node.js 24 源 When 构建运行时 Then 生成归档', () => {
    const root = mkdtempSync(join(tmpdir(), 'copis-node-runtime-build-'))
    tempRoots.push(root)
    const output = join(root, 'node-runtime.tar.gz')

    const result = runBuild(createNodeRuntimeSource('v24.19.0'), output)

    expect(result.exitCode).toBe(0)
    expect(existsSync(output)).toBe(true)
  })

  testOnUnix('Given 相同 Node.js 24 源 When 跨秒连续构建运行时 Then 生成相同 SHA256 归档', async () => {
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

  const testOnMac = process.platform === 'darwin' ? test : test.skip
  testOnMac('Given macOS 的系统 Node.js 24 When 构建并解压运行时 Then 归档内 Node.js 不依赖构建机的 Homebrew 动态库', () => {
    const root = mkdtempSync(join(tmpdir(), 'copis-node-runtime-build-'))
    tempRoots.push(root)
    const output = join(root, 'node-runtime.tar.gz')
    const extracted = join(root, 'extracted')
    mkdirSync(extracted)
    const systemNodePath = execFileSync('node', ['-p', 'process.execPath'], { encoding: 'utf8' }).trim()
    const systemRuntimeRoot = dirname(dirname(systemNodePath))
    const systemNodeVersion = execFileSync(systemNodePath, ['--version'], { encoding: 'utf8' }).trim()

    const result = runBuild(systemRuntimeRoot, output)

    expect(result.exitCode).toBe(0)
    extractArchive(output, extracted)
    expect(readdirSync(join(extracted, 'lib')).some((entry) => /^libnode.*\.dylib$/.test(entry))).toBe(true)

    const bundledNode = join(extracted, 'bin', 'node')
    const nodeVersion = spawnSync(bundledNode, ['--version'], {
      env: { PATH: '/usr/bin:/bin', DYLD_LIBRARY_PATH: '' },
      timeout: 30_000,
      encoding: 'utf8',
    })
    expect(nodeVersion.status).toBe(0)
    expect(nodeVersion.stdout.trim()).toBe(systemNodeVersion)

    const linkedLibraries = Bun.spawnSync(['otool', '-L', bundledNode])
    expect(linkedLibraries.exitCode).toBe(0)
    expect(new TextDecoder().decode(linkedLibraries.stdout)).not.toContain('/opt/homebrew/')
  }, 60_000)
})
