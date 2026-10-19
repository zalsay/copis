import { describe, expect, test } from 'bun:test'
import { createStore } from 'jotai'
import type { FunctionalModuleStatus } from '@copis/shared'
import { functionalModuleStatusesAtom } from './functional-modules'
import { hasUpdateAtom, updateStatusAtom } from './updater'

function moduleStatus(overrides: Partial<FunctionalModuleStatus> = {}): FunctionalModuleStatus {
  return {
    name: 'chrome-desktop-cli', displayName: 'Chrome 桌面自动化', installed: false,
    version: null, path: null, availableVersion: '1.2.0', updateAvailable: true,
    required: false, error: null, ...overrides,
  }
}

describe('关于/更新导航提醒', () => {
  test('已安装的可选 Chrome 组件有新版时显示提醒', () => {
    const store = createStore()
    store.set(functionalModuleStatusesAtom, { 'chrome-desktop-cli': moduleStatus({ installed: true, version: '1.1.0' }) })

    expect(store.get(hasUpdateAtom)).toBe(true)
  })

  test('未安装且仅可选的组件有可用版本时不显示强制更新提醒', () => {
    const store = createStore()
    store.set(functionalModuleStatusesAtom, { 'chrome-desktop-cli': moduleStatus() })

    expect(store.get(hasUpdateAtom)).toBe(false)
  })

  test('必要组件未安装但状态报告需要更新时保留提醒', () => {
    const store = createStore()
    store.set(functionalModuleStatusesAtom, { 'node-runtime': moduleStatus({ name: 'node-runtime', required: true }) })

    expect(store.get(hasUpdateAtom)).toBe(true)
  })

  test('主程序更新提醒与组件提醒保持兼容', () => {
    const store = createStore()
    store.set(updateStatusAtom, { status: 'available' })

    expect(store.get(hasUpdateAtom)).toBe(true)
  })
})
