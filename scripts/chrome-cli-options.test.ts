import { describe, expect, test } from 'bun:test'
import { getChromeCliOption } from './chrome-cli-options'

describe('Chrome组件短/长参数兼容', () => {
  for (const name of ['archive','version'] as const) {
    test(`Given ${name}短或长参数 When 读取 Then 使用同一配置`, () => {
      expect(getChromeCliOption(name,[`--chrome-cli-${name}`,'chosen'])).toBe('chosen')
      expect(getChromeCliOption(name,[`--chrome-desktop-cli-${name}`,'chosen'])).toBe('chosen')
      expect(getChromeCliOption(name,[])).toBeUndefined()
    })
    test(`Given ${name}别名值相同 When 同时提供 Then 允许`, () => {
      expect(getChromeCliOption(name,[`--chrome-cli-${name}`,'same',`--chrome-desktop-cli-${name}`,'same'])).toBe('same')
    })
    test(`Given ${name}别名冲突 When 同时提供 Then 不隐式选择错误归档或版本`, () => {
      expect(()=>getChromeCliOption(name,[`--chrome-cli-${name}`,'one',`--chrome-desktop-cli-${name}`,'two'])).toThrow('冲突')
    })
    test(`Given ${name}缺值 When 后面是其他flag Then 明确拒绝`, () => {
      expect(()=>getChromeCliOption(name,[`--chrome-cli-${name}`])).toThrow('缺少')
      expect(()=>getChromeCliOption(name,[`--chrome-desktop-cli-${name}`,'--platform','darwin'])).toThrow('缺少')
    })
  }
})
