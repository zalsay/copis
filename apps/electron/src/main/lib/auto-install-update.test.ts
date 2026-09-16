import { describe, expect, test } from 'bun:test'
import {
  WINDOWS_NSIS_UPDATE_ARGUMENTS,
  doesInstallerHandleAppRestart,
  planAutoInstall,
} from './auto-install-update'

describe('主程序更新自动安装计划', () => {
  test('Given macOS DMG When 安装更新 Then 使用 DMG 自动安装', () => {
    expect(planAutoInstall('/tmp/Copis-0.0.63-arm64.dmg', 'darwin')).toBe('dmg')
  })

  test('Given Windows NSIS 安装包 When 安装更新 Then 使用 NSIS 升级安装器', () => {
    expect(planAutoInstall('C:\\Downloads\\Copis Setup 0.0.63.exe', 'win32')).toBe('nsis')
  })

  test('Given Windows NSIS 自动更新 When 启动安装器 Then 显示原生进度且交由安装器启动新版本', () => {
    expect(WINDOWS_NSIS_UPDATE_ARGUMENTS).toEqual(['--updated', '--force-run'])
    expect(WINDOWS_NSIS_UPDATE_ARGUMENTS).not.toContain('/S')
    expect(doesInstallerHandleAppRestart('nsis')).toBe(true)
    expect(doesInstallerHandleAppRestart('dmg')).toBe(false)
  })

  test('Given 平台与安装包类型不匹配 When 安装更新 Then 标记为不支持', () => {
    expect(planAutoInstall('/tmp/Copis-0.0.63-arm64.dmg', 'win32')).toBe('unsupported')
    expect(planAutoInstall('/tmp/Copis-0.0.63-arm64.zip', 'darwin')).toBe('unsupported')
  })
})
