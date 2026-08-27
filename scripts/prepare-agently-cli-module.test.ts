import { describe, expect, test } from 'bun:test'
import {
  AGENTLY_CLI_PACKAGE,
  AGENTLY_CLI_VERSION,
  getAgentlyCliEntrypoint,
  getAgentlyCliPackageIntegrity,
  getAgentlyCliPlatformPackage,
} from './prepare-agently-cli-module'

describe('Agent QQ 邮箱 CLI 功能模块准备', () => {
  test('使用官方平台原生包并固定 Windows x64 版本', () => {
    expect(AGENTLY_CLI_PACKAGE).toBe('@tencent-qqmail/agently-cli')
    expect(AGENTLY_CLI_VERSION).toBe('1.0.17')
    expect(getAgentlyCliPlatformPackage('win32', 'x64')).toBe('@tencent-qqmail/agently-cli-win32-x64')
    expect(getAgentlyCliEntrypoint('win32')).toBe('bin/agently-cli.exe')
  })

  test('为各平台使用对应入口并要求已配置官方完整性', () => {
    expect(getAgentlyCliEntrypoint('darwin')).toBe('bin/agently-cli')
    expect(getAgentlyCliEntrypoint('linux')).toBe('bin/agently-cli')
    expect(getAgentlyCliPackageIntegrity('@tencent-qqmail/agently-cli-win32-x64')).toMatch(/^sha512-/)
    expect(() => getAgentlyCliPackageIntegrity('@tencent-qqmail/agently-cli-unknown')).toThrow('完整性')
  })
})
