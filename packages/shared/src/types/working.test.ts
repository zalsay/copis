import { describe, expect, test } from 'bun:test'
import { isWorkingMode, normalizeWorkingMode, WORKING_MODES } from './working'

describe('Working 模式契约', () => {
  test('Given 合法模式 When 校验 Then 保留 fast 和 expert', () => {
    expect(WORKING_MODES).toEqual(['fast', 'expert'])
    expect(isWorkingMode('fast')).toBe(true)
    expect(isWorkingMode('expert')).toBe(true)
  })

  test('Given 非法或缺失模式 When 归一化 Then 回退到 fast', () => {
    expect(normalizeWorkingMode(undefined)).toBe('fast')
    expect(normalizeWorkingMode('unknown')).toBe('fast')
    expect(normalizeWorkingMode('expert')).toBe('expert')
  })
})
