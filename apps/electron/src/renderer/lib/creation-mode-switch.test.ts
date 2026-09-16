import { describe, expect, test } from 'bun:test'
import { shouldDisableCreationModeSwitch } from './creation-mode-switch'

describe('创造模式切换开关', () => {
  test('Given 开发构建 When 判断创造模式入口 Then 保持可用', () => {
    expect(shouldDisableCreationModeSwitch(false)).toBe(false)
  })

  test('Given 生产构建 When 判断创造模式入口 Then 禁用所有切换入口', () => {
    expect(shouldDisableCreationModeSwitch(true)).toBe(true)
  })
})
