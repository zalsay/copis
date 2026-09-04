import { describe, expect, test } from 'bun:test'
import {
  DSH_PACKAGE,
  DSH_PACKAGE_VERSION,
  DSH_VERSION,
  DSH_INTEGRITY,
  DSH_ENTRYPOINT,
} from './prepare-dsh-module'

describe('dsh 运行环境功能模块准备', () => {
  test('使用官方 npm 包并固定版本与入口', () => {
    expect(DSH_PACKAGE).toBe('@deepseek-ai/dsh')
    expect(DSH_PACKAGE_VERSION).toBe('0.1.2-rc.1')
    expect(DSH_VERSION).toBe('0.1.2')
    expect(DSH_ENTRYPOINT).toBe('bin/dsh')
    expect(DSH_INTEGRITY).toMatch(/^sha512-/)
  })
})
