import { describe, expect, test } from 'bun:test'
import { isChromeDesktopComponentMetadata } from './chrome-desktop'

const metadata = { name: 'chrome-desktop-cli', version: '0.1.0', platform: 'darwin', arch: 'arm64', protocolVersion: 1, entrypoint: 'mcc', helper: 'macos-chrome-helper' }
const expected = { version: '0.1.0', arch: 'arm64' }
describe('Chrome组件安装与执行共用元数据契约', () => {
  test('Given 协议1且版本架构匹配 When 校验 Then 允许并兼容额外说明字段', () => {
    expect(isChromeDesktopComponentMetadata(metadata, expected)).toBe(true)
    expect(isChromeDesktopComponentMetadata({ ...metadata, minimumOsVersion: '14.0' }, expected)).toBe(true)
    expect(isChromeDesktopComponentMetadata({ ...metadata, arch: 'x64' }, { ...expected, arch: 'x64' })).toBe(true)
  })
  test('Given MCC官方归档保留旧默认入口 When 校验 Then 兼容元数据但不改变Copis执行入口', () => {
    expect(isChromeDesktopComponentMetadata({ ...metadata, entrypoint: 'copis-chrome' }, expected)).toBe(true)
  })
  for (const value of [null, [], 'not-json', {}, ...[
    { name: 'other' }, { version: '0.2.0' }, { platform: 'linux' }, { arch: 'x64' },
    { protocolVersion: 2 }, { protocolVersion: '1' }, { entrypoint: '../copis-chrome' },
    { helper: '/tmp/helper' }, { helper: undefined },
  ].map(patch => ({ ...metadata, ...patch }))]) {
    test(`Given 错误元数据${JSON.stringify(value)} When 激活/执行前校验 Then 拒绝`, () => {
      expect(isChromeDesktopComponentMetadata(value, expected)).toBe(false)
    })
  }
  test('Given 期望架构或版本为空/不支持 When 内容碰巧相等 Then 仍拒绝', () => {
    expect(isChromeDesktopComponentMetadata({ ...metadata, version: '' }, { version: '', arch: 'arm64' })).toBe(false)
    expect(isChromeDesktopComponentMetadata({ ...metadata, arch: 'riscv64' }, { version: '0.1.0', arch: 'riscv64' })).toBe(false)
  })
})
