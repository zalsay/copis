import { describe, expect, test } from 'bun:test'
import { resolveCopisClientVersion } from './copis-client-version'

describe('Copis 按系统客户端版本解析', () => {
  test('Given 配置了多个系统版本 When 校验 Windows x64 核心模块 Then 使用 win32-x64 版本而非通用版本', () => {
    const version = resolveCopisClientVersion({
      copis: {
        platformVersions: {
          'darwin-arm64': '0.0.93',
          'win32-x64': '0.0.89',
        },
      },
    }, '0.0.84', 'win32', 'x64')

    expect(version).toBe('0.0.89')
  })

  test('Given 当前系统未配置或版本格式不合法 When 解析客户端版本 Then 回退到应用通用版本', () => {
    expect(resolveCopisClientVersion({ copis: { platformVersions: {} } }, '0.0.84', 'linux', 'x64'))
      .toBe('0.0.84')
    expect(resolveCopisClientVersion({ copis: { platformVersions: { 'win32-x64': 'invalid' } } }, '0.0.84', 'win32', 'x64'))
      .toBe('0.0.84')
  })
})
