import { describe, expect, test } from 'bun:test'
import {
  createCopisWorkingChannel,
  createCopisWorkingDeepSeekChannel,
  createBuiltinChannels,
  COPIS_WORKING_CHANNEL_ID,
  COPIS_WORKING_DEEPSEEK_CHANNEL_ID,
  COPIS_WORKING_CHANNEL_IDS,
  COPIS_WORKING_DEEPSEEK_FAST_MODEL_ID,
  COPIS_WORKING_DEEPSEEK_PRO_MODEL_ID,
  COPIS_WORKING_GLOBAL_MODEL_ID,
  ZHIPU_DEFAULT_MODEL_ID,
  ZHIPU_DEFAULT_MODEL_NAME,
} from '@copis/shared'
import type { Channel } from '@copis/shared'
import { buildModelOptions } from './model-selector-utils'

describe('模型选择器内置渠道', () => {
  test('Given 主进程返回内置渠道 When 构建 Composer 模型选项 Then 展示 Z.ai 分组与 GLM 5.3 Flash', () => {
    const options = buildModelOptions(
      createBuiltinChannels('http://127.0.0.1:9000'),
      undefined,
      [...COPIS_WORKING_CHANNEL_IDS],
      undefined,
      { includeProviders: ['zhipu'], useComposerProviderLabels: true },
    )

    expect(options).toContainEqual({
      channelId: 'copis-working-zhipu',
      channelName: 'Z.ai（智谱）',
      modelId: ZHIPU_DEFAULT_MODEL_ID,
      modelName: ZHIPU_DEFAULT_MODEL_NAME,
      provider: 'openai-responses',
    })
  })

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

  test('Given 已配置但没有模型的 zhipu 渠道 When 构建普通模型选项 Then 保留用户配置的渠道名称', () => {
    const channel: Channel = {
      id: 'zhipu-channel',
      name: '我的智谱渠道',
      provider: 'zhipu',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      apiKey: 'encrypted-key',
      models: [],
      enabled: true,
      createdAt: 0,
      updatedAt: 0,
    }

    expect(buildModelOptions([channel])).toContainEqual({
      channelId: 'zhipu-channel',
      channelName: '我的智谱渠道',
      modelId: ZHIPU_DEFAULT_MODEL_ID,
      modelName: ZHIPU_DEFAULT_MODEL_NAME,
      provider: 'zhipu',
    })
  })

  test('Given 已配置但没有模型的 zhipu 渠道 When 构建 Composer 模型选项 Then 允许渠道并展示 Z.ai 分组', () => {
    const channel: Channel = {
      id: 'zhipu-channel',
      name: '我的智谱渠道',
      provider: 'zhipu',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      apiKey: 'encrypted-key',
      models: [],
      enabled: true,
      createdAt: 0,
      updatedAt: 0,
    }

    expect(buildModelOptions(
      [channel],
      undefined,
      ['copis-working'],
      undefined,
      { includeProviders: ['zhipu'], useComposerProviderLabels: true },
    )).toContainEqual({
      channelId: 'zhipu-channel',
      channelName: 'Z.ai（智谱）',
      modelId: ZHIPU_DEFAULT_MODEL_ID,
      modelName: ZHIPU_DEFAULT_MODEL_NAME,
      provider: 'zhipu',
    })
  })
})
