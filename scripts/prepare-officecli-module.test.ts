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

  test('Given COS manifest 的 OfficeCLI 版本与构建版本相同 When 准备模块 Then 从 COS 复用模块且不请求 GitHub', async () => {
    const root = mkdtempSync(join(tmpdir(), 'copis-officecli-module-'))
    temporaryDirectories.push(root)
    const binary = Buffer.from('cos-officecli-binary')
    const checksum = createHash('sha256').update(binary).digest('hex')
    let origin = ''
    let releaseRequests = 0
    let binaryRequests = 0
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname
        if (path === '/manifest') {
          return Response.json({
            schema: 1,
            channel: 'stable',
            platforms: {
              'darwin-arm64': {
                modules: {
                  officecli: {
                    version: '1.0.143',
                    url: `${origin}/officecli`,
                    sha256: checksum,
                    size: binary.byteLength,
                    format: 'binary',
                    entrypoint: 'bin/officecli',
                    required: true,
                  },
                },
              },
            },
          })
        }
        if (path === '/release') {
          releaseRequests += 1
          return new Response('GitHub request must be skipped', { status: 503 })
        }
        if (path === '/officecli') {
          binaryRequests += 1
          return new Response(binary)
        }
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
        '--release-api-url',
        `${origin}/release`,
        '--public-manifest-url',
        `${origin}/manifest`,
      ], {
        cwd: repoRoot,
        env: process.env,
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const exitCode = await child.exited
      const logs = `${await new Response(child.stdout).text()}${await new Response(child.stderr).text()}`

      expect(exitCode).toBe(0)
      expect(releaseRequests).toBe(0)
      expect(binaryRequests).toBe(1)
      expect(logs).toContain('OfficeCLI v1.0.143')
      expect(readFileSync(output)).toEqual(binary)
    } finally {
      server.stop(true)
    }
  })

  test('Given COS manifest 的 OfficeCLI 版本与构建版本不同 When 准备模块 Then 回退 GitHub release', async () => {
    const root = mkdtempSync(join(tmpdir(), 'copis-officecli-module-'))
    temporaryDirectories.push(root)
    const binary = Buffer.from('github-officecli-binary-after-cos-version-change')
    const checksum = createHash('sha256').update(binary).digest('hex')
    let origin = ''
    let releaseRequests = 0
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname
        if (path === '/manifest') {
          return Response.json({
            schema: 1,
            channel: 'stable',
            platforms: {
              'darwin-arm64': {
                modules: {
                  officecli: {
                    version: '1.0.144',
                    url: `${origin}/cos-officecli`,
                    sha256: '0'.repeat(64),
                    size: 1,
                    format: 'binary',
                    entrypoint: 'bin/officecli',
                    required: true,
                  },
                },
              },
            },
          })
        }
        if (path === '/release') {
          releaseRequests += 1
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
        '--release-api-url',
        `${origin}/release`,
        '--public-manifest-url',
        `${origin}/manifest`,
      ], {
        cwd: repoRoot,
        env: process.env,
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const exitCode = await child.exited

      expect(exitCode).toBe(0)
      expect(releaseRequests).toBe(1)
      expect(readFileSync(output)).toEqual(binary)
    } finally {
      server.stop(true)
    }
  })

  test('Given GitHub release API 返回 403 与限流信息 When 准备模块 Then 输出完整 HTTP 诊断', async () => {
    const root = mkdtempSync(join(tmpdir(), 'copis-officecli-module-'))
    temporaryDirectories.push(root)
    let origin = ''
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname
        if (path === '/release') {
          return new Response('{"message":"API rate limit exceeded"}', {
            status: 403,
            headers: {
              'content-type': 'application/json',
              'x-ratelimit-limit': '60',
              'x-ratelimit-remaining': '0',
              'x-ratelimit-used': '60',
              'x-ratelimit-reset': '1786934746',
              'x-github-request-id': 'test-request-id',
            },
          })
        }
        return new Response('not found', { status: 404 })
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
        join(root, 'officecli'),
      ], {
        cwd: repoRoot,
        env: { ...process.env, COPIS_OFFICECLI_RELEASE_API: `${origin}/release` },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const exitCode = await child.exited
      const logs = `${await new Response(child.stdout).text()}${await new Response(child.stderr).text()}`

      expect(exitCode).not.toBe(0)
      expect(logs).toContain('读取 OfficeCLI GitHub release 失败: HTTP 403')
      expect(logs).toContain(`URL: ${origin}/release`)
      expect(logs).toContain('响应类型: application/json')
      expect(logs).toContain('GitHub rate limit: remaining=0/60, used=60, reset=1786934746')
      expect(logs).toContain('GitHub request id: test-request-id')
      expect(logs).toContain('响应体: {"message":"API rate limit exceeded"}')
    } finally {
      server.stop(true)
    }
  })

  test('Given GitHub release API 无法连接 When 准备模块 Then 输出网络异常与请求地址', async () => {
    const root = mkdtempSync(join(tmpdir(), 'copis-officecli-module-'))
    temporaryDirectories.push(root)
    const releaseUrl = 'http://127.0.0.1:1/release'
    const env = { ...process.env, COPIS_OFFICECLI_RELEASE_API: releaseUrl }
    for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) {
      delete env[key]
    }

    const child = Bun.spawn([
      process.execPath,
      'scripts/prepare-officecli-module.ts',
      '--platform',
      'darwin',
      '--arch',
      'arm64',
      '--output',
      join(root, 'officecli'),
    ], {
      cwd: repoRoot,
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const exitCode = await child.exited
    const logs = `${await new Response(child.stdout).text()}${await new Response(child.stderr).text()}`

    expect(exitCode).not.toBe(0)
    expect(logs).toContain('读取 OfficeCLI GitHub release 失败')
    expect(logs).toContain(`URL: ${releaseUrl}`)
    expect(logs).toContain('请求异常:')
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

  test('Given 同一 GitHub release 的已验证缓存 When 准备模块 Then 复用缓存且不请求 release 或二进制', async () => {
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
    let releaseRequests = 0
    let assetRequests = 0
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname
        if (path === '/release') {
          releaseRequests += 1
          return new Response('release request must be skipped', { status: 503 })
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
      expect(releaseRequests).toBe(0)
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
