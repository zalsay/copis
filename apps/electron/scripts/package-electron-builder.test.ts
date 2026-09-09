import { describe, expect, test } from 'bun:test'
import { resolveElectronVersion } from '../../../scripts/electron-platform-version'
import { createPackagingPlan } from './package-electron-builder'

const metadata = { version: '0.0.80', copis: { platformVersions: {
  'darwin-arm64': '0.0.83', 'darwin-x64': '0.0.81', 'win32-x64': '0.0.82',
} } }

describe('平台独立打包', () => {
  test('Given 多个平台版本 When 按目标打包 Then 安装包与渲染进程使用同一版本', () => {
    for (const [flag, arch, version] of [
      ['--mac', 'arm64', '0.0.83'], ['--mac', 'x64', '0.0.81'],
      ['--win', 'x64', '0.0.82'], ['--linux', 'x64', '0.0.80'],
    ]) {
      const plan = createPackagingPlan([flag!, `--${arch}`, '--publish', 'never'], metadata)
      expect(plan.version).toBe(version)
      expect(plan.builderArgs).toContain(`--config.extraMetadata.version=${version}`)
      expect(plan.builderArgs).toContain('--publish')
      expect(plan.builderArgs).toContain('never')
      expect(plan.rendererEnv.COPIS_BUILD_APP_VERSION).toBe(version)
    }
    expect(metadata.version).toBe('0.0.80')
  })

  test('Given 缺少目标平台配置 When 解析 Then 使用共享版本；错误配置不能静默兜底', () => {
    expect(resolveElectronVersion(metadata, 'linux', 'arm64')).toBe('0.0.80')
    expect(() => resolveElectronVersion({ ...metadata, copis: { platformVersions: { 'darwin-arm64': 'bad' } } }, 'darwin', 'arm64')).toThrow()
    expect(() => resolveElectronVersion(metadata, 'mac', 'arm64')).toThrow()
  })

  test('Given 同次请求不同架构或版本覆盖 When 打包 Then 拒绝混用版本', () => {
    expect(() => createPackagingPlan(['--mac', '--arm64', '--x64'], metadata)).toThrow()
    expect(() => createPackagingPlan(['--mac', '--config.extraMetadata.version=9.0.0'], metadata)).toThrow()
  })
})
