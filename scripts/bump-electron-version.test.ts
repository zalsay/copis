import { describe, expect, test } from 'bun:test'
import { incrementPatchVersion } from './bump-electron-version'

describe('Electron 应用版本递增', () => {
  test('Given 三段式版本 When 使用 --new Then 只递增 patch 版本', () => {
    expect(incrementPatchVersion('0.0.65')).toBe('0.0.66')
    expect(incrementPatchVersion('1.12.9')).toBe('1.12.10')
  })

  test('Given 非三段式版本 When 递增 Then 拒绝更新', () => {
    expect(() => incrementPatchVersion('0.0.65-beta.1')).toThrow('三段式 semver')
    expect(() => incrementPatchVersion('0.0')).toThrow('三段式 semver')
  })
})
