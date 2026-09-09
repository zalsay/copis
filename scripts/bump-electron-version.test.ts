import { describe, expect, test } from 'bun:test'
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { bumpElectronVersion, incrementPatchVersion, setElectronVersion, validateElectronVersion } from './bump-electron-version'

describe('Electron 应用版本递增', () => {
  test('Given 平台独立版本 When 递增或对齐 macOS Then 保留共享版本和其他平台版本', async () => {
    const root = mkdtempSync(join(tmpdir(), 'copis-platform-version-'))
    const packagePath = join(root, 'package.json')
    writeFileSync(packagePath, JSON.stringify({ version: '0.0.82', copis: { platformVersions: {
      'darwin-arm64': '0.0.83', 'win32-x64': '0.0.81',
    } } }))
    try {
      expect(await bumpElectronVersion(packagePath, 'darwin', 'arm64')).toBe('0.0.84')
      await setElectronVersion('0.0.85', packagePath, 'darwin', 'arm64')
      expect(JSON.parse(readFileSync(packagePath, 'utf8'))).toEqual({
        version: '0.0.82', copis: { platformVersions: {
          'darwin-arm64': '0.0.85', 'win32-x64': '0.0.81',
        } },
      })
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
  test('Given 三段式版本 When 使用 --new Then 只递增 patch 版本', () => {
    expect(incrementPatchVersion('0.0.65')).toBe('0.0.66')
    expect(incrementPatchVersion('1.12.9')).toBe('1.12.10')
  })

  test('Given 非三段式版本 When 递增 Then 拒绝更新', () => {
    expect(() => incrementPatchVersion('0.0.65-beta.1')).toThrow('三段式 semver')
    expect(() => incrementPatchVersion('0.0')).toThrow('三段式 semver')
  })

  test('Given 远端平台最低版本 When 设置 Electron 版本 Then 写入目标版本', async () => {
    const root = mkdtempSync(join(tmpdir(), 'copis-electron-version-'))
    const packagePath = join(root, 'package.json')
    writeFileSync(packagePath, JSON.stringify({ name: '@copis/electron', version: '0.0.67' }))
    try {
      await setElectronVersion('0.0.70', packagePath)
      expect(JSON.parse(readFileSync(packagePath, 'utf8')).version).toBe('0.0.70')
      expect(validateElectronVersion('0.0.70')).toBe('0.0.70')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
