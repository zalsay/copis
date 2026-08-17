import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { classifyModelLatency } from './model-latency'

describe('模型首 token 延迟分级', () => {
  test('Given 8 秒内 When 分类 Then 低延迟', () => {
    expect(classifyModelLatency(312.5)).toBe('low')
    expect(classifyModelLatency(7999)).toBe('low')
  })

  test('Given 8-12 秒 When 分类 Then 中等延迟', () => {
    expect(classifyModelLatency(8000)).toBe('medium')
    expect(classifyModelLatency(9500)).toBe('medium')
    expect(classifyModelLatency(11999)).toBe('medium')
  })

  test('Given 12 秒及以上 When 分类 Then 高延迟', () => {
    expect(classifyModelLatency(12000)).toBe('high')
    expect(classifyModelLatency(15558)).toBe('high')
  })

  test('Given 无数据或非法值 When 分类 Then 未知', () => {
    expect(classifyModelLatency(undefined)).toBe('unknown')
    expect(classifyModelLatency(Number.NaN)).toBe('unknown')
  })

  test('Given Composer 模型选择器 When 渲染模型项 Then 每个模型显示三格延迟信号', () => {
    const source = readFileSync(join(import.meta.dir, 'ModelSelector.tsx'), 'utf8')
    expect(source).toContain('getWorkingModelLatencies()')
    expect(source).toContain('<ModelLatencySignal')
    expect(source).toContain('latencies[option.modelId]')
  })
})
