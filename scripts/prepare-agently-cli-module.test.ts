import { describe, expect, test } from 'bun:test'
import {
  AGENTLY_CLI_PACKAGE,
  AGENTLY_CLI_VERSION,
  AGENTLY_CLI_INTEGRITY,
  AGENTLY_CLI_ENTRYPOINT,
} from './prepare-agently-cli-module'

describe('Agent QQ 邮箱 CLI 功能模块准备', () => {
  test('使用官方 npm 包并固定版本', () => {
    expect(AGENTLY_CLI_PACKAGE).toBe('@tencent-qqmail/agently-cli')
    expect(AGENTLY_CLI_VERSION).toBe('1.0.17')
    expect(AGENTLY_CLI_ENTRYPOINT).toBe('bin/agently-cli')
    expect(AGENTLY_CLI_INTEGRITY).toMatch(/^sha512-/)
  })
})
