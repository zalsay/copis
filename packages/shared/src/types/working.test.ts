import { describe, expect, test } from 'bun:test'
import {
  COPIS_WORKING_CHANNEL_ID,
  COPIS_WORKING_DEEPSEEK_CHANNEL_ID,
  COPIS_WORKING_DEEPSEEK_FAST_MODEL_ID,
  COPIS_WORKING_DEEPSEEK_PRO_MODEL_ID,
  COPIS_WORKING_ZHIPU_CHANNEL_ID,
  COPIS_WORKING_FAST_MODEL_ID,
  COPIS_WORKING_EXPERT_MODEL_ID,
  COPIS_WORKING_GLOBAL_MODEL_ID,
  BUILTIN_CHANNEL_DEFINITIONS,
  createBuiltinChannels,
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
  test('Given 内置渠道定义 When 构造渠道 Then Copis、DeepSeek、Z.ai 共享 endpoint 且分组只描述名称和模型', () => {
    const groups = BUILTIN_CHANNEL_DEFINITIONS.groups
    const channels = createBuiltinChannels('http://127.0.0.1:9000/')

    expect(Object.keys(groups)).toEqual([
      COPIS_WORKING_CHANNEL_ID,
      COPIS_WORKING_DEEPSEEK_CHANNEL_ID,
      COPIS_WORKING_ZHIPU_CHANNEL_ID,
    ])
    expect(Object.values(groups).every((group) => Object.keys(group).sort().join(',') === 'models,name')).toBe(true)
    expect(BUILTIN_CHANNEL_DEFINITIONS.common).toMatchObject({
      provider: 'openai-responses',
      endpointPath: '/api/internal/working-model/v1',
      channelEnabled: true,
      modelEnabled: true,
    })
    expect(new Set(channels.map((channel) => channel.baseUrl))).toEqual(new Set([
      'http://127.0.0.1:9000/api/internal/working-model/v1',
    ]))
    expect(channels.map((channel) => channel.name)).toEqual(['内置模型', 'DeepSeek', 'Z.ai（智谱）'])
    expect(channels.find((channel) => channel.id === COPIS_WORKING_ZHIPU_CHANNEL_ID)?.models).toEqual([
      {
        id: 'glm-5.3-flash',
        name: 'GLM 5.3 Flash(智谱家族性价比之王)',
        enabled: true,
        source: 'manual',
      },
    ])
  })

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
      COPIS_WORKING_GLOBAL_MODEL_ID,
    ])
    expect(channel.models.map((model) => model.name)).toEqual([
      '快速',
      '通识',
    ])
    expect(channel.models.some((model) => model.id === COPIS_WORKING_EXPERT_MODEL_ID)).toBe(false)
    expect(workingModeToModelId('fast')).toBe(COPIS_WORKING_FAST_MODEL_ID)
    expect(workingModeToModelId('expert')).toBe(COPIS_WORKING_EXPERT_MODEL_ID)
  })

  test('Given DeepSeek 虚拟渠道 When 构造模型列表 Then 暴露 v4 Flash 快速与 v4 Pro 专业模型并复用 Working endpoint', () => {
    const channel = createCopisWorkingDeepSeekChannel('http://127.0.0.1:9000/module/edu-api/')

    expect(channel.id).toBe(COPIS_WORKING_DEEPSEEK_CHANNEL_ID)
    expect(channel.name).toBe('DeepSeek')
    expect(channel.provider).toBe('openai-responses')
    expect(channel.baseUrl).toBe('http://127.0.0.1:9000/module/edu-api/api/internal/working-model/v1')
    expect(channel.models).toEqual([
      {
        id: COPIS_WORKING_DEEPSEEK_FAST_MODEL_ID,
        name: '快速',
        enabled: true,
        source: 'manual',
      },
      {
        id: COPIS_WORKING_DEEPSEEK_PRO_MODEL_ID,
        name: '专业',
        enabled: true,
        source: 'manual',
      },
    ])
  })

  test('Given Copis 内置渠道 ID When 构造渠道 Then 只接受三个受支持的虚拟渠道', () => {
    expect(isCopisWorkingChannelId(COPIS_WORKING_CHANNEL_ID)).toBe(true)
    expect(isCopisWorkingChannelId(COPIS_WORKING_DEEPSEEK_CHANNEL_ID)).toBe(true)
    expect(isCopisWorkingChannelId(COPIS_WORKING_ZHIPU_CHANNEL_ID)).toBe(true)
    expect(isCopisWorkingChannelId('user-channel')).toBe(false)
    expect(createCopisWorkingChannelForId('http://127.0.0.1:9000', 'user-channel')).toBeUndefined()
    expect(createCopisWorkingChannelForId('http://127.0.0.1:9000', 'toString')).toBeUndefined()
    expect(createCopisWorkingChannelForId('http://127.0.0.1:9000', COPIS_WORKING_DEEPSEEK_CHANNEL_ID)?.models[0]?.id)
      .toBe(COPIS_WORKING_DEEPSEEK_FAST_MODEL_ID)
    expect(createCopisWorkingChannelForId('http://127.0.0.1:9000', COPIS_WORKING_ZHIPU_CHANNEL_ID)?.name)
      .toBe('Z.ai（智谱）')
  })
})
