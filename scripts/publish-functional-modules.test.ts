import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FunctionalModuleManifest } from '@copis/shared'
import { mergeFunctionalModuleManifests } from './functional-module-manifest-merge'
import {
  buildFunctionalModuleBinaryInputs,
  requireExistingOfficeCli,
  requireExistingNodeRuntime,
  requireExistingRustApi,
  writePublishedManifest,
} from './publish-functional-modules'

describe('功能模块发布脚本 --rust', () => {
  test('自动升版后将最终 manifest 写回本地构建目录', () => {
    const root = mkdtempSync(join(tmpdir(), 'copis-functional-module-manifest-'))
    const output = join(root, 'nested', 'manifest.json')
    const body = Buffer.from('{"version":"0.0.37"}\n')

    try {
      writePublishedManifest(output, body)
      expect(readFileSync(output)).toEqual(body)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('Rust-only 输入只包含 Rust，不触碰本地 OfficeCLI 路径', () => {
    const modules = buildFunctionalModuleBinaryInputs({
      rustOnly: true,
      rustBinary: '/tmp/copis-http-api-server',
      rustVersion: '0.2.0',
      officeCliBinary: '/tmp/officecli-does-not-exist',
      officeCliVersion: '1.0.143',
      platform: 'darwin',
      arch: 'arm64',
    })

    expect(modules).toHaveLength(1)
    expect(modules[0]).toMatchObject({ module: 'rust-http-api', binaryPath: '/tmp/copis-http-api-server' })
  })

  test('OfficeCLI-only 输入只包含 OfficeCLI，不触碰本地 Rust 路径', () => {
    const modules = buildFunctionalModuleBinaryInputs({
      rustOnly: false,
      officeCliOnly: true,
      rustBinary: '/tmp/rust-api-does-not-exist',
      rustVersion: '0.2.0',
      officeCliBinary: '/tmp/officecli',
      officeCliVersion: '1.0.143',
      platform: 'darwin',
      arch: 'arm64',
    })

    expect(modules).toHaveLength(1)
    expect(modules[0]).toMatchObject({ module: 'officecli', binaryPath: '/tmp/officecli' })
  })

  test('Node runtime-only 输入使用 tar.gz 归档并保留稳定入口', () => {
    const modules = buildFunctionalModuleBinaryInputs({
      rustOnly: false,
      officeCliOnly: false,
      nodeRuntimeOnly: true,
      rustBinary: '/tmp/rust-api-does-not-exist',
      rustVersion: '0.2.0',
      officeCliBinary: '/tmp/officecli-does-not-exist',
      officeCliVersion: '1.0.143',
      nodeRuntimeArchive: '/tmp/node-runtime.tar.gz',
      nodeRuntimeVersion: '22.21.1',
      platform: 'darwin',
      arch: 'arm64',
    })

    expect(modules).toEqual([expect.objectContaining({
      module: 'node-runtime',
      format: 'tar.gz',
      entrypoint: 'bin/node',
      binaryPath: '/tmp/node-runtime.tar.gz',
    })])
  })

  test('Node runtime-only 发布要求 COS 已有 Rust 与 OfficeCLI', () => {
    const manifest: FunctionalModuleManifest = {
      schema: 1,
      channel: 'stable',
      platforms: {
        'darwin-arm64': {
          modules: {
            'rust-http-api': {
              version: '0.2.0', url: 'https://download.example.com/rust', sha256: 'a'.repeat(64), size: 1,
              format: 'binary', entrypoint: 'bin/copis-http-api-server', required: true,
            },
            officecli: {
              version: '1.0.143', url: 'https://download.example.com/office', sha256: 'b'.repeat(64), size: 1,
              format: 'binary', entrypoint: 'bin/officecli', required: true,
            },
          },
        },
      },
    }

    requireExistingOfficeCli(manifest, 'darwin', 'arm64')
    requireExistingRustApi(manifest, 'darwin', 'arm64')
    expect(() => requireExistingNodeRuntime(manifest, 'darwin', 'arm64')).toThrow('缺少 node-runtime')
  })

  test('Rust-only 发布允许远端暂时缺少 Node runtime', () => {
    const manifest: FunctionalModuleManifest = {
      schema: 1,
      channel: 'stable',
      platforms: {
        'darwin-arm64': {
          modules: {
            officecli: {
              version: '1.0.143',
              url: 'https://download.example.com/officecli',
              sha256: 'b'.repeat(64),
              size: 1,
              format: 'binary',
              entrypoint: 'bin/officecli',
              required: true,
            },
          },
        },
      },
    }

    expect(requireExistingNodeRuntime(manifest, 'darwin', 'arm64', { allowMissing: true })).toBe(false)
  })

  test('合并 Rust 发布时保留远端当前平台的 OfficeCLI artifact', () => {
    const officeCli = {
      version: '1.0.143',
      url: 'https://download.example.com/officecli-1.0.143',
      sha256: 'b'.repeat(64),
      size: 1,
      format: 'binary' as const,
      entrypoint: 'bin/officecli',
      required: true,
    }
    const existing: FunctionalModuleManifest = {
      schema: 1,
      channel: 'stable',
      platforms: {
        'darwin-arm64': { modules: { officecli: officeCli } },
      },
    }
    const incoming: FunctionalModuleManifest = {
      schema: 1,
      channel: 'stable',
      platforms: {
        'darwin-arm64': {
          modules: {
            'rust-http-api': {
              version: '0.2.0',
              url: 'https://download.example.com/rust-http-api-0.2.0',
              sha256: 'a'.repeat(64),
              size: 1,
              format: 'binary',
              entrypoint: 'bin/copis-http-api-server',
              required: true,
            },
          },
        },
      },
    }

    requireExistingOfficeCli(existing, 'darwin', 'arm64')
    const merged = mergeFunctionalModuleManifests(existing, incoming)

    expect(merged.platforms['darwin-arm64']?.modules.officecli).toEqual(officeCli)
  })

  test('合并 OfficeCLI 发布时保留远端当前平台的 Rust API artifact', () => {
    const rustApi = {
      version: '0.2.0',
      url: 'https://download.example.com/rust-http-api-0.2.0',
      sha256: 'a'.repeat(64),
      size: 1,
      format: 'binary' as const,
      entrypoint: 'bin/copis-http-api-server',
      required: true,
    }
    const existing: FunctionalModuleManifest = {
      schema: 1,
      channel: 'stable',
      platforms: {
        'darwin-arm64': { modules: { 'rust-http-api': rustApi } },
      },
    }
    const incoming: FunctionalModuleManifest = {
      schema: 1,
      channel: 'stable',
      platforms: {
        'darwin-arm64': {
          modules: {
            officecli: {
              version: '1.0.143',
              url: 'https://download.example.com/officecli-1.0.143',
              sha256: 'b'.repeat(64),
              size: 1,
              format: 'binary',
              entrypoint: 'bin/officecli',
              required: true,
            },
          },
        },
      },
    }

    requireExistingRustApi(existing, 'darwin', 'arm64')
    const merged = mergeFunctionalModuleManifests(existing, incoming)

    expect(merged.platforms['darwin-arm64']?.modules['rust-http-api']).toEqual(rustApi)
  })

  test('远端当前平台缺少 OfficeCLI 时在上传前给出明确错误', async () => {
    const root = mkdtempSync(join(tmpdir(), 'copis-functional-module-rust-only-'))
    const server = Bun.serve({
      port: 0,
      fetch() {
        return Response.json({
          schema: 1,
          channel: 'stable',
          platforms: {
            'darwin-arm64': {
              modules: {
                'rust-http-api': {
                  version: '0.1.0',
                  url: 'https://download.example.com/rust-http-api-0.1.0',
                  sha256: 'a'.repeat(64),
                  size: 1,
                  format: 'binary',
                  entrypoint: 'bin/copis-http-api-server',
                  required: true,
                },
              },
            },
          },
        })
      },
    })
    try {
      const rustBinary = join(root, 'copis-http-api-server')
      writeFileSync(rustBinary, 'rust-api-binary')
      const child = Bun.spawn([
        'bun',
        'run',
        'scripts/publish-functional-modules.ts',
        '--rust',
        '--platform',
        'darwin',
        '--arch',
        'arm64',
        '--bucket-url',
        'https://bucket.cos.ap-shanghai.myqcloud.com',
        '--public-base-url',
        `http://127.0.0.1:${server.port}/copis/modules`,
      ], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          COS_SECRET_ID: 'test-id',
          COS_SECRET_KEY: 'test-key',
          COPIS_RUST_HTTP_API_BINARY: rustBinary,
          COPIS_OFFICECLI_BINARY: join(root, 'officecli-does-not-exist'),
        },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [stdout, stderr] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      const output = `${stdout}\n${stderr}`

      expect(child.exitCode).not.toBe(0)
      expect(output).toContain('COS manifest 当前平台/架构缺少 officecli')
    } finally {
      server.stop(true)
      rmSync(root, { recursive: true, force: true })
    }
  })
})
