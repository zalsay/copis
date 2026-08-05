import { describe, expect, test } from 'bun:test'
import {
  getStartupActions,
  getStartupModuleRows,
  getStartupModuleRowsForMode,
  getStartupPhaseLabel,
} from './functional-module-startup-ui'

describe('登录后功能模块更新页模型', () => {
  test('health 阶段显示最后 5% 的 API 检查文案', () => {
    expect(getStartupPhaseLabel({ phase: 'health', progress: 0.97 })).toBe('正在检查本地 API')
  })

  test('模块状态顺序固定为 Rust API 和 OfficeCLI', () => {
    expect(getStartupModuleRows().map((row) => row.name)).toEqual(['rust-http-api', 'officecli'])
  })

  test('开发模式不展示模块更新行，只保留 API health 检查', () => {
    expect(getStartupModuleRowsForMode(true)).toEqual([])
    expect(getStartupModuleRowsForMode(false)).toEqual(getStartupModuleRows())
  })

  test('失败状态只能重试，不能生成继续进入操作', () => {
    expect(getStartupActions('error')).toEqual(['retry'])
    expect(getStartupActions('health')).toEqual([])
  })
})
