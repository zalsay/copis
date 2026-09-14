import { describe, expect, test } from 'bun:test'
import {
  CODEX_CLI_VERSION,
  CODEX_CLI_ENTRYPOINT,
  resolveSourceCodexBinary,
  readCodexCliVersion,
} from './prepare-codex-cli-module'

describe('专业模式 (codex-cli) 功能模块准备', () => {
  test('定义标准版本与入口', () => {
    expect(CODEX_CLI_VERSION).toBe('0.154.0')
    expect(CODEX_CLI_ENTRYPOINT).toBe('bin/codex')
  })

  test('支持从自定义路径、环境变量或系统常用路径解析二进制', () => {
    const resolved = resolveSourceCodexBinary()
    if (resolved) {
      expect(typeof resolved).toBe('string')
      expect(readCodexCliVersion(resolved)).toMatch(/^\d+\.\d+\.\d+/)
    }
  })
})
