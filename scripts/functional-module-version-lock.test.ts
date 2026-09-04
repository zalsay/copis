import { describe, expect, test } from 'bun:test'
import {
  applyFunctionalModuleVersionLocks,
  excludeUnchangedLockedModules,
  loadFunctionalModuleVersionLocks,
} from './functional-module-version-lock'

const locks = loadFunctionalModuleVersionLocks()

describe('功能模块版本锁', () => {
  test('Given 版本锁配置 When 读取 Then 固定 Node/Python runtime、支付宝、Playwright Core 与 Agent QQ 邮箱 CLI 版本', () => {
    expect(locks).toEqual({
      'node-runtime': '24.19.4',
      'python-runtime': '3.12.14',
      'alipay-bot': '0.3.40',
      'playwright-core': '1.62.1',
      'agently-cli': '1.0.17',
      dsh: '0.1.2',
    })
  })

  test('Given 部署参数包含动态版本 When 应用版本锁 Then 始终使用配置版本', () => {
    const modules = applyFunctionalModuleVersionLocks([
      { module: 'node-runtime', version: '24.19.1', platform: 'darwin', arch: 'arm64', binaryPath: '/tmp/node.tar.gz', required: true },
      { module: 'python-runtime', version: '3.12.1', platform: 'darwin', arch: 'arm64', binaryPath: '/tmp/python.tar.gz', required: true },
      { module: 'alipay-bot', version: '0.3.41', platform: 'darwin', arch: 'arm64', binaryPath: '/tmp/alipay.tar.gz', required: true },
    ], locks)

    expect(modules.map((module) => module.version)).toEqual(['24.19.4', '3.12.14', '0.3.40'])
  })

  test('Given COS 中版本高于锁定配置 When deploy Then 不回退或更新锁定模块', () => {
    const modules = applyFunctionalModuleVersionLocks([
      { module: 'node-runtime', version: 'ignored', platform: 'darwin', arch: 'arm64', binaryPath: '/tmp/node.tar.gz', required: true },
      { module: 'python-runtime', version: 'ignored', platform: 'darwin', arch: 'arm64', binaryPath: '/tmp/python.tar.gz', required: true },
      { module: 'alipay-bot', version: 'ignored', platform: 'darwin', arch: 'arm64', binaryPath: '/tmp/alipay.tar.gz', required: true },
      { module: 'rust-http-api', version: '0.0.60', platform: 'darwin', arch: 'arm64', binaryPath: '/tmp/rust', required: true },
    ], locks)

    const manifest = {
      schema: 1,
      channel: 'stable',
      platforms: {
        'darwin-arm64': {
          modules: {
            'node-runtime': { version: '24.19.5', url: 'https://example/node', sha256: 'a'.repeat(64), size: 1, format: 'tar.gz' as const, entrypoint: 'bin/node', required: true },
            'python-runtime': { version: '3.12.15', url: 'https://example/python', sha256: 'c'.repeat(64), size: 1, format: 'tar.gz' as const, entrypoint: 'bin/python', required: true },
            'alipay-bot': { version: '0.3.41', url: 'https://example/alipay', sha256: 'b'.repeat(64), size: 1, format: 'tar.gz' as const, entrypoint: 'bin/alipay-bot', required: true },
          },
        },
      },
    }
    expect(excludeUnchangedLockedModules(modules, manifest, 'darwin', 'arm64', locks).map((module) => module.module))
      .toEqual(['rust-http-api'])
  })

  test('Given 配置版本高于 COS 当前版本 When deploy Then 允许发布锁定模块', () => {
    const modules = [{ module: 'node-runtime' as const, version: '24.19.2', platform: 'darwin' as const, arch: 'arm64' as const, binaryPath: '/tmp/node.tar.gz', required: true }]
    const upgradedLocks = { ...locks, 'node-runtime': '24.19.2' }
    const manifest = {
      schema: 1,
      channel: 'stable',
      platforms: {
        'darwin-arm64': {
          modules: {
            'node-runtime': { version: '24.19.1', url: 'https://example/node', sha256: 'a'.repeat(64), size: 1, format: 'tar.gz' as const, entrypoint: 'bin/node', required: true },
          },
        },
      },
    }

    expect(excludeUnchangedLockedModules(modules, manifest, 'darwin', 'arm64', upgradedLocks)).toEqual(modules)
  })

  test('Given COS 中 Agent QQ 邮箱 CLI 同版本但仍是旧 exe When deploy Then 允许迁移到新版归档', () => {
    const modules = [{
      module: 'agently-cli' as const,
      version: 'ignored',
      platform: 'win32' as const,
      arch: 'x64' as const,
      binaryPath: '/tmp/agently-cli.tar.gz',
      format: 'tar.gz' as const,
      entrypoint: 'bin/agently-cli.cmd',
      required: true,
    }]
    const manifest = {
      schema: 1,
      channel: 'stable',
      platforms: {
        'win32-x64': {
          modules: {
            'agently-cli': {
              version: '1.0.17',
              url: 'https://example/agently-cli-1.0.17.exe',
              sha256: 'a'.repeat(64),
              size: 1,
              format: 'binary' as const,
              entrypoint: 'bin/agently-cli.exe',
              required: true,
            },
          },
        },
      },
    }

    expect(excludeUnchangedLockedModules(modules, manifest, 'win32', 'x64', locks)).toEqual(modules)
  })
})
