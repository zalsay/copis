import { describe, expect, test } from 'bun:test'
import {
  FunctionalModuleIncompatibleClientError,
  getFunctionalModuleManifestUrl,
  isFunctionalModuleIncompatibleClientError,
  parseFunctionalModuleManifest,
} from './functional-module-manifest'

const manifest = {
  schema: 1,
  channel: 'stable',
  client: { minVersion: '0.16.13' },
  platforms: {
    'darwin-arm64': {
      modules: {
        officecli: {
          version: '1.2.3',
          url: 'https://download.example/officecli-1.2.3',
          sha256: 'a'.repeat(64),
          size: 12,
          format: 'binary',
          entrypoint: 'bin/officecli',
          required: false,
        },
        'rust-http-api': {
          version: '0.2.0',
          url: 'https://download.example/rust-http-api-0.2.0',
          sha256: 'b'.repeat(64),
          size: 24,
          format: 'binary',
          entrypoint: 'bin/copis-http-api-server',
          required: true,
        },
      },
    },
    'linux-x64': {
      modules: {
        'rust-http-api': {
          version: '0.2.1',
          url: 'https://download.example/linux-rust-http-api-0.2.1',
          sha256: 'c'.repeat(64),
          size: 25,
          format: 'binary',
          entrypoint: 'bin/copis-http-api-server',
          required: true,
        },
      },
    },
  },
}

function manifestJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ ...manifest, ...overrides })
}

describe('COS 功能模块 manifest 解析', () => {
  test('运行时环境变量可以覆盖构建时注入的 manifest 地址', () => {
    const previous = process.env.COPIS_FUNCTIONAL_MODULE_MANIFEST_URL
    process.env.COPIS_FUNCTIONAL_MODULE_MANIFEST_URL = 'https://runtime.example.com/manifest.json'
    try {
      expect(getFunctionalModuleManifestUrl()).toBe('https://runtime.example.com/manifest.json')
    } finally {
      if (previous === undefined) delete process.env.COPIS_FUNCTIONAL_MODULE_MANIFEST_URL
      else process.env.COPIS_FUNCTIONAL_MODULE_MANIFEST_URL = previous
    }
  })

  test('当前平台返回 OfficeCLI 和 Rust API 的完整 artifact', () => {
    const artifacts = parseFunctionalModuleManifest(manifestJson(), '0.16.17', 'darwin', 'arm64')

    expect(artifacts).toHaveLength(2)
    expect(artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'officecli',
        version: '1.2.3',
        platform: 'darwin',
        arch: 'arm64',
        size: 12,
        format: 'binary',
        required: false,
      }),
      expect.objectContaining({
        name: 'rust-http-api',
        version: '0.2.0',
        entrypoint: 'bin/copis-http-api-server',
        required: true,
      }),
    ]))
  })

  test('只选择当前平台，不跨平台复用二进制', () => {
    const artifacts = parseFunctionalModuleManifest(manifestJson(), '0.16.17', 'linux', 'x64')

    expect(artifacts).toHaveLength(1)
    expect(artifacts[0]).toMatchObject({
      name: 'rust-http-api',
      version: '0.2.1',
      platform: 'linux',
      arch: 'x64',
    })
  })

  test('manifest 缺少当前平台时拒绝安装', () => {
    expect(() => parseFunctionalModuleManifest(manifestJson(), '0.16.17', 'win32', 'x64'))
      .toThrow('没有当前平台的功能模块')
  })

  test('当前 Copis 版本低于 manifest 门槛时抛出结构化版本不兼容错误', () => {
    let capturedError: unknown
    try {
      parseFunctionalModuleManifest(manifestJson(), '0.16.12', 'darwin', 'arm64')
    } catch (error) {
      capturedError = error
    }

    expect(capturedError).toBeInstanceOf(FunctionalModuleIncompatibleClientError)
    expect(isFunctionalModuleIncompatibleClientError(capturedError)).toBe(true)
    if (isFunctionalModuleIncompatibleClientError(capturedError)) {
      expect(capturedError.clientVersion).toBe('0.16.12')
      expect(capturedError.minClientVersion).toBe('0.16.13')
      expect(capturedError.message).toBe('Copis 版本过低，需要至少 0.16.13')
    }
  })

  test('非版本不兼容错误不会被误判为 FunctionalModuleIncompatibleClientError', () => {
    let capturedError: unknown
    try {
      parseFunctionalModuleManifest(manifestJson(), '0.16.17', 'win32', 'x64')
    } catch (error) {
      capturedError = error
    }

    expect(capturedError).toBeInstanceOf(Error)
    expect(isFunctionalModuleIncompatibleClientError(capturedError)).toBe(false)
  })

  test('优先使用当前平台的最低版本，不被其他平台门槛误伤', () => {
    const platformManifest = {
      ...manifest,
      client: { minVersion: '0.0.70' },
      platforms: {
        ...manifest.platforms,
        'darwin-arm64': {
          ...manifest.platforms['darwin-arm64'],
          minClientVersion: '0.0.67',
        },
        'linux-x64': {
          ...manifest.platforms['linux-x64'],
          minClientVersion: '0.0.70',
        },
      },
    }

    expect(() => parseFunctionalModuleManifest(JSON.stringify(platformManifest), '0.0.67', 'darwin', 'arm64'))
      .not.toThrow()
    expect(() => parseFunctionalModuleManifest(JSON.stringify(platformManifest), '0.0.67', 'linux', 'x64'))
      .toThrow('需要至少 0.0.70')
  })

  test('拒绝 HTTP 远程 URL', () => {
    const platform = {
      ...manifest.platforms['darwin-arm64'],
      modules: {
        ...manifest.platforms['darwin-arm64'].modules,
        officecli: {
          ...manifest.platforms['darwin-arm64'].modules.officecli,
          url: 'http://download.example/officecli',
        },
      },
    }
    expect(() => parseFunctionalModuleManifest(manifestJson({ platforms: { 'darwin-arm64': platform } }), '0.16.17', 'darwin', 'arm64'))
      .toThrow('模块 URL 必须使用 HTTPS')
  })

  test('拒绝不安全的 entrypoint 和不完整 SHA256', () => {
    const platform = {
      ...manifest.platforms['darwin-arm64'],
      modules: {
        ...manifest.platforms['darwin-arm64'].modules,
        officecli: {
          ...manifest.platforms['darwin-arm64'].modules.officecli,
          sha256: 'bad',
          entrypoint: '../officecli',
        },
      },
    }
    expect(() => parseFunctionalModuleManifest(manifestJson({ platforms: { 'darwin-arm64': platform } }), '0.16.17', 'darwin', 'arm64'))
      .toThrow('sha256')
  })

  test('拒绝负数 size 和不支持的 format', () => {
    const platform = {
      ...manifest.platforms['darwin-arm64'],
      modules: {
        ...manifest.platforms['darwin-arm64'].modules,
        officecli: {
          ...manifest.platforms['darwin-arm64'].modules.officecli,
          size: -1,
          format: 'zip',
        },
      },
    }
    expect(() => parseFunctionalModuleManifest(manifestJson({ platforms: { 'darwin-arm64': platform } }), '0.16.17', 'darwin', 'arm64'))
      .toThrow('模块 size 不合法')
  })
})
