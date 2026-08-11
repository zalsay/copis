import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { DEFAULT_RELEASE_API, OFFICECLI_RELEASE_TAG } from './prepare-officecli-module.ts'

const temporaryDirectories: string[] = []
const repoRoot = resolve(import.meta.dir, '..')

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true })
  }
})

describe('OfficeCLI 功能模块准备', () => {
  test('Given 默认使用指定的 GitHub 构建 When 准备 OfficeCLI Then 访问 v1.0.143 release', () => {
    expect(OFFICECLI_RELEASE_TAG).toBe('v1.0.143')
    expect(DEFAULT_RELEASE_API).toBe(
      'https://api.github.com/repos/iOfficeAI/OfficeCLI/releases/tags/v1.0.143',
    )
  })

  test('Given GitHub release 与 SHA256SUMS When 准备 darwin arm64 模块 Then 下载并校验官方二进制', async () => {
    const root = mkdtempSync(join(tmpdir(), 'copis-officecli-module-'))
    temporaryDirectories.push(root)
    const binary = Buffer.from('official-officecli-binary')
    const checksum = createHash('sha256').update(binary).digest('hex')
    let origin = ''
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname
        if (path === '/release') {
          return Response.json({
            tag_name: 'v1.0.143',
            assets: [
              {
                name: 'officecli-mac-arm64',
                browser_download_url: `${origin}/officecli-mac-arm64`,
              },
              {
                name: 'SHA256SUMS',
                browser_download_url: `${origin}/SHA256SUMS`,
              },
            ],
          })
        }
        if (path === '/officecli-mac-arm64') return new Response(binary)
        if (path === '/SHA256SUMS') return new Response(`${checksum}  officecli-mac-arm64\n`)
        return new Response('not found', { status: 404 })
      },
    })
    origin = `http://127.0.0.1:${server.port}`
    const output = join(root, 'officecli')

    try {
      const child = Bun.spawn([
        process.execPath,
        'scripts/prepare-officecli-module.ts',
        '--platform',
        'darwin',
        '--arch',
        'arm64',
        '--output',
        output,
      ], {
        cwd: repoRoot,
        env: { ...process.env, COPIS_OFFICECLI_RELEASE_API: `${origin}/release` },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const exitCode = await child.exited
      const logs = `${await new Response(child.stdout).text()}${await new Response(child.stderr).text()}`

      expect(exitCode).toBe(0)
      expect(logs).toContain('OfficeCLI v1.0.143')
      expect(readFileSync(output)).toEqual(binary)
    } finally {
      server.stop(true)
    }
  })

  test('Given SHA256SUMS 与二进制不一致 When 准备模块 Then 拒绝写入目标文件', async () => {
    const root = mkdtempSync(join(tmpdir(), 'copis-officecli-module-'))
    temporaryDirectories.push(root)
    const binary = Buffer.from('tampered-officecli-binary')
    let origin = ''
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname
        if (path === '/release') {
          return Response.json({
            tag_name: 'v1.0.143',
            assets: [
              {
                name: 'officecli-mac-arm64',
                browser_download_url: `${origin}/officecli-mac-arm64`,
              },
              {
                name: 'SHA256SUMS',
                browser_download_url: `${origin}/SHA256SUMS`,
              },
            ],
          })
        }
        if (path === '/officecli-mac-arm64') return new Response(binary)
        if (path === '/SHA256SUMS') return new Response(`${'0'.repeat(64)}  officecli-mac-arm64\n`)
        return new Response('not found', { status: 404 })
      },
    })
    origin = `http://127.0.0.1:${server.port}`
    const output = join(root, 'officecli')

    try {
      const child = Bun.spawn([
        process.execPath,
        'scripts/prepare-officecli-module.ts',
        '--platform',
        'darwin',
        '--arch',
        'arm64',
        '--output',
        output,
      ], {
        cwd: repoRoot,
        env: { ...process.env, COPIS_OFFICECLI_RELEASE_API: `${origin}/release` },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const exitCode = await child.exited
      const logs = `${await new Response(child.stdout).text()}${await new Response(child.stderr).text()}`

      expect(exitCode).not.toBe(0)
      expect(logs).toContain('SHA256 校验失败')
      expect(existsSync(output)).toBe(false)
    } finally {
      server.stop(true)
    }
  })

  test('Given 同一 GitHub release 的已验证缓存 When 准备模块 Then 复用缓存而不重复下载二进制', async () => {
    const root = mkdtempSync(join(tmpdir(), 'copis-officecli-module-'))
    temporaryDirectories.push(root)
    const binary = Buffer.from('cached-official-officecli-binary')
    const checksum = createHash('sha256').update(binary).digest('hex')
    const output = join(root, 'officecli')
    writeFileSync(output, binary)
    writeFileSync(
      `${output}.metadata.json`,
      `${JSON.stringify({ version: '1.0.143', assetName: 'officecli-mac-arm64', sha256: checksum })}\n`,
    )
    let origin = ''
    let assetRequests = 0
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname
        if (path === '/release') {
          return Response.json({
            tag_name: 'v1.0.143',
            assets: [
              {
                name: 'officecli-mac-arm64',
                browser_download_url: `${origin}/officecli-mac-arm64`,
              },
              {
                name: 'SHA256SUMS',
                browser_download_url: `${origin}/SHA256SUMS`,
              },
            ],
          })
        }
        assetRequests += 1
        return new Response('asset download must be skipped', { status: 500 })
      },
    })
    origin = `http://127.0.0.1:${server.port}`

    try {
      const child = Bun.spawn([
        process.execPath,
        'scripts/prepare-officecli-module.ts',
        '--platform',
        'darwin',
        '--arch',
        'arm64',
        '--output',
        output,
      ], {
        cwd: repoRoot,
        env: { ...process.env, COPIS_OFFICECLI_RELEASE_API: `${origin}/release` },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const exitCode = await child.exited

      expect(exitCode).toBe(0)
      expect(assetRequests).toBe(0)
      expect(readFileSync(output)).toEqual(binary)
    } finally {
      server.stop(true)
    }
  })

  test('Given GitHub release asset digest 与本地二进制匹配 When metadata 缺失 Then 通过 digest 补齐缓存而不下载 asset', async () => {
    const root = mkdtempSync(join(tmpdir(), 'copis-officecli-module-'))
    temporaryDirectories.push(root)
    const binary = Buffer.from('official-officecli-binary-with-github-digest')
    const checksum = createHash('sha256').update(binary).digest('hex')
    const output = join(root, 'officecli')
    writeFileSync(output, binary)
    let origin = ''
    let assetRequests = 0
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname
        if (path === '/release') {
          return Response.json({
            tag_name: 'v1.0.143',
            assets: [
              {
                name: 'officecli-mac-arm64',
                browser_download_url: `${origin}/officecli-mac-arm64`,
                digest: `sha256:${checksum}`,
              },
            ],
          })
        }
        assetRequests += 1
        return new Response('asset download must be skipped', { status: 500 })
      },
    })
    origin = `http://127.0.0.1:${server.port}`

    try {
      const child = Bun.spawn([
        process.execPath,
        'scripts/prepare-officecli-module.ts',
        '--platform',
        'darwin',
        '--arch',
        'arm64',
        '--output',
        output,
      ], {
        cwd: repoRoot,
        env: { ...process.env, COPIS_OFFICECLI_RELEASE_API: `${origin}/release` },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const exitCode = await child.exited

      expect(exitCode).toBe(0)
      expect(assetRequests).toBe(0)
      expect(existsSync(`${output}.metadata.json`)).toBe(true)
    } finally {
      server.stop(true)
    }
  })
})
