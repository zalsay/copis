import { describe, expect, test } from 'bun:test'
import {
  applyFunctionalModuleVersionLocks,
  excludeUnchangedLockedModules,
  loadFunctionalModuleVersionLocks,
} from './functional-module-version-lock'

const locks = loadFunctionalModuleVersionLocks()

describe('功能模块版本锁', () => {
  test('Given 版本锁配置 When 读取 Then 固定 Node runtime 与支付宝模块版本', () => {
    expect(locks).toEqual({ 'node-runtime': '24.19.4', 'alipay-bot': '0.3.40' })
  })

  test('Given 部署参数包含动态版本 When 应用版本锁 Then 始终使用配置版本', () => {
    const modules = applyFunctionalModuleVersionLocks([
      { module: 'node-runtime', version: '24.19.1', platform: 'darwin', arch: 'arm64', binaryPath: '/tmp/node.tar.gz', required: true },
      { module: 'alipay-bot', version: '0.3.41', platform: 'darwin', arch: 'arm64', binaryPath: '/tmp/alipay.tar.gz', required: true },
    ], locks)

    expect(modules.map((module) => module.version)).toEqual(['24.19.4', '0.3.40'])
  })

  test('Given COS 中版本高于锁定配置 When deploy Then 不回退或更新锁定模块', () => {
    const modules = applyFunctionalModuleVersionLocks([
      { module: 'node-runtime', version: 'ignored', platform: 'darwin', arch: 'arm64', binaryPath: '/tmp/node.tar.gz', required: true },
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
})
