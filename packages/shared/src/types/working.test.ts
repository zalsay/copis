import { describe, expect, test } from 'bun:test'
import {
  COPIS_WORKING_CHANNEL_ID,
  COPIS_WORKING_FAST_MODEL_ID,
  COPIS_WORKING_EXPERT_MODEL_ID,
  createCopisWorkingChannel,
  isWorkingMode,
  normalizeWorkingMode,
  workingModeToModelId,
  WORKING_MODES,
} from './working'

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

  test('Given Working 模式 When 构造本地渠道 Then 通过 edu-api Responses endpoint 使用服务端 alias', () => {
    const channel = createCopisWorkingChannel('http://127.0.0.1:9000/module/edu-api/')

    expect(channel.id).toBe(COPIS_WORKING_CHANNEL_ID)
    expect(channel.provider).toBe('openai-responses')
    expect(channel.baseUrl).toBe('http://127.0.0.1:9000/module/edu-api/api/internal/working-model/v1')
    expect(channel.apiKey).toBe('')
    expect(channel.models.map((model) => model.id)).toEqual([
      COPIS_WORKING_FAST_MODEL_ID,
      COPIS_WORKING_EXPERT_MODEL_ID,
    ])
    expect(workingModeToModelId('fast')).toBe(COPIS_WORKING_FAST_MODEL_ID)
    expect(workingModeToModelId('expert')).toBe(COPIS_WORKING_EXPERT_MODEL_ID)
  })
})
