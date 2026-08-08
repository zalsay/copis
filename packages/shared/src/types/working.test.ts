import { describe, expect, test } from 'bun:test'
import {
  COPIS_WORKING_CHANNEL_ID,
  COPIS_WORKING_DEEPSEEK_CHANNEL_ID,
  COPIS_WORKING_DEEPSEEK_FAST_MODEL_ID,
  COPIS_WORKING_FAST_MODEL_ID,
  COPIS_WORKING_EXPERT_MODEL_ID,
  createCopisWorkingChannelForId,
  createCopisWorkingDeepSeekChannel,
  createCopisWorkingChannel,
  isCopisWorkingChannelId,
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
    expect(channel.name).toBe('内置模型')
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

  test('Given DeepSeek 虚拟渠道 When 构造模型列表 Then 暴露 v4 Flash 快速模型并复用 Working endpoint', () => {
    const channel = createCopisWorkingDeepSeekChannel('http://127.0.0.1:9000/module/edu-api/')

    expect(channel.id).toBe(COPIS_WORKING_DEEPSEEK_CHANNEL_ID)
    expect(channel.name).toBe('DeepSeek')
    expect(channel.provider).toBe('openai-responses')
    expect(channel.baseUrl).toBe('http://127.0.0.1:9000/module/edu-api/api/internal/working-model/v1')
    expect(channel.models).toEqual([{
      id: COPIS_WORKING_DEEPSEEK_FAST_MODEL_ID,
      name: '快速',
      enabled: true,
      source: 'manual',
    }])
  })

  test('Given Copis 内置渠道 ID When 构造渠道 Then 只接受两个受支持的虚拟渠道', () => {
    expect(isCopisWorkingChannelId(COPIS_WORKING_CHANNEL_ID)).toBe(true)
    expect(isCopisWorkingChannelId(COPIS_WORKING_DEEPSEEK_CHANNEL_ID)).toBe(true)
    expect(isCopisWorkingChannelId('user-channel')).toBe(false)
    expect(createCopisWorkingChannelForId('http://127.0.0.1:9000', 'user-channel')).toBeUndefined()
    expect(createCopisWorkingChannelForId('http://127.0.0.1:9000', COPIS_WORKING_DEEPSEEK_CHANNEL_ID)?.models[0]?.id)
      .toBe(COPIS_WORKING_DEEPSEEK_FAST_MODEL_ID)
  })
})
