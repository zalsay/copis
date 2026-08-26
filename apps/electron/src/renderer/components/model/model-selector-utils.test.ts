import { describe, expect, test } from 'bun:test'
import {
  createCopisWorkingChannel,
  createCopisWorkingDeepSeekChannel,
  COPIS_WORKING_CHANNEL_ID,
  COPIS_WORKING_DEEPSEEK_CHANNEL_ID,
  COPIS_WORKING_DEEPSEEK_FAST_MODEL_ID,
  COPIS_WORKING_DEEPSEEK_PRO_MODEL_ID,
  COPIS_WORKING_GLOBAL_MODEL_ID,
} from '@copis/shared'
import { buildModelOptions } from './model-selector-utils'

describe('模型选择器内置渠道', () => {
  test('Given Copis 和 DeepSeek 虚拟渠道 When 构建模型选项 Then 保留两个分类及 Copis 通识 / DeepSeek v4 Flash / Pro', () => {
    const options = buildModelOptions([
      createCopisWorkingChannel('http://127.0.0.1:9000'),
      createCopisWorkingDeepSeekChannel('http://127.0.0.1:9000'),
    ])

    expect(new Set(options.map((option) => option.channelId))).toEqual(new Set([
      COPIS_WORKING_CHANNEL_ID,
      COPIS_WORKING_DEEPSEEK_CHANNEL_ID,
    ]))
    expect(options.find((option) => option.modelId === COPIS_WORKING_GLOBAL_MODEL_ID)).toMatchObject({
      channelId: COPIS_WORKING_CHANNEL_ID,
      channelName: '内置模型',
      modelName: '通识',
      provider: 'openai-responses',
    })
    expect(options.find((option) => option.modelId === COPIS_WORKING_DEEPSEEK_FAST_MODEL_ID)).toMatchObject({
      channelId: COPIS_WORKING_DEEPSEEK_CHANNEL_ID,
      channelName: 'DeepSeek',
      modelName: '快速',
      provider: 'openai-responses',
    })
    expect(options.find((option) => option.modelId === COPIS_WORKING_DEEPSEEK_PRO_MODEL_ID)).toMatchObject({
      channelId: COPIS_WORKING_DEEPSEEK_CHANNEL_ID,
      channelName: 'DeepSeek',
      modelName: '专业',
      provider: 'openai-responses',
    })
  })
})
