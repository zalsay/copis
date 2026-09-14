import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { resolveElectronVersion } from '../../../scripts/electron-platform-version'
import {
  cleanupStaleWindowsUnpackedDirectories,
  createPackagingPlan,
  rotateStaleWindowsUnpackedDirectory,
} from './package-electron-builder'

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

  test('Given Windows 存在旧解包目录 When 开始新打包 Then 先轮换目录避免清理锁冲突', () => {
    const appDir = mkdtempSync(resolve(tmpdir(), 'copis-builder-'))
    const unpackedDir = resolve(appDir, 'out', 'win-unpacked')
    mkdirSync(resolve(unpackedDir, 'resources'), { recursive: true })
    writeFileSync(resolve(unpackedDir, 'resources', 'app.asar'), '旧产物')

    try {
      const rotatedDir = rotateStaleWindowsUnpackedDirectory(appDir, 'win32', 123)

      expect(rotatedDir).toBe(resolve(appDir, 'out', '.win-unpacked-stale-123'))
      expect(existsSync(unpackedDir)).toBe(false)
      expect(readFileSync(resolve(rotatedDir!, 'resources', 'app.asar'), 'utf8')).toBe('旧产物')
    } finally {
      rmSync(appDir, { recursive: true, force: true })
    }
  })

  test('Given 非 Windows 打包 When 存在同名目录 Then 不改动该目录', () => {
    const appDir = mkdtempSync(resolve(tmpdir(), 'copis-builder-'))
    const unpackedDir = resolve(appDir, 'out', 'win-unpacked')
    mkdirSync(unpackedDir, { recursive: true })

    try {
      expect(rotateStaleWindowsUnpackedDirectory(appDir, 'darwin', 123)).toBeNull()
      expect(existsSync(unpackedDir)).toBe(true)
    } finally {
      rmSync(appDir, { recursive: true, force: true })
    }
  })

  test('Given 曾有多次 Windows 打包失败 When 新打包成功 Then 清理全部临时目录且保留无关目录', () => {
    const appDir = mkdtempSync(resolve(tmpdir(), 'copis-builder-'))
    const outDir = resolve(appDir, 'out')
    const staleDirs = ['.win-unpacked-stale-111', '.win-unpacked-stale-222-333']
    for (const name of [...staleDirs, 'win-unpacked-prev-manual']) mkdirSync(resolve(outDir, name), { recursive: true })

    try {
      cleanupStaleWindowsUnpackedDirectories(appDir)

      for (const name of staleDirs) expect(existsSync(resolve(outDir, name))).toBe(false)
      expect(existsSync(resolve(outDir, 'win-unpacked-prev-manual'))).toBe(true)
    } finally {
      rmSync(appDir, { recursive: true, force: true })
    }
  })
})
