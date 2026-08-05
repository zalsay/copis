import { describe, expect, test } from 'bun:test'
import type { FunctionalModuleStatus } from '@copis/shared'
import {
  FUNCTIONAL_MODULE_DEFINITIONS,
  createEmptyFunctionalModuleStatus,
  getFunctionalModuleStateText,
} from './functional-module-ui'

describe('功能模块设置页模型', () => {
  test('模块列表同时包含 Rust API 和 OfficeCLI', () => {
    expect(FUNCTIONAL_MODULE_DEFINITIONS.map((item) => item.name)).toEqual(['rust-http-api', 'officecli'])
    expect(FUNCTIONAL_MODULE_DEFINITIONS.find((item) => item.name === 'rust-http-api')?.required).toBe(true)
    expect(FUNCTIONAL_MODULE_DEFINITIONS.find((item) => item.name === 'officecli')?.required).toBe(true)
  })

  test('状态文案覆盖错误、更新、已安装和未安装', () => {
    const status = createEmptyFunctionalModuleStatus(FUNCTIONAL_MODULE_DEFINITIONS[0]!)
    expect(getFunctionalModuleStateText(status)).toBe('未安装')
    expect(getFunctionalModuleStateText({ ...status, installed: true, version: '0.1.0' })).toBe('v0.1.0 已安装')
    expect(getFunctionalModuleStateText({
      ...status,
      installed: true,
      version: '0.1.0',
      updateAvailable: true,
      availableVersion: '0.2.0',
    })).toBe('v0.1.0 已安装，可更新到 v0.2.0')
    expect(getFunctionalModuleStateText({ ...status, error: 'manifest 地址未配置' })).toBe('manifest 地址未配置')
  })

  test('空状态符合共享状态契约', () => {
    const status: FunctionalModuleStatus = createEmptyFunctionalModuleStatus(FUNCTIONAL_MODULE_DEFINITIONS[1]!)
    expect(status).toMatchObject({
      name: 'officecli',
      displayName: 'OfficeCLI',
      installed: false,
      required: true,
      error: null,
    })
  })
})
