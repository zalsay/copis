import { describe, expect, test } from 'bun:test'
import {
  COPIS_WORKING_MODEL_SOURCE_TYPE_HEADER,
  COPIS_WORKING_MODEL_SOURCE_TYPE_COPIS_AGENT,
  COPIS_WORKING_DEEPSEEK_CHANNEL_ID,
  COPIS_WORKING_DEEPSEEK_FAST_MODEL_ID,
} from '@copis/shared'
import {
  buildModel,
  buildPiRequestHeaders,
  getWorkingCustomResponsesThinkingLevelMap,
} from './pi-model-registry'

describe('Pi 模型请求头（Working 计费来源）', () => {
  test('Given 普通 openai-responses 渠道 When 构建请求头 Then 不注入自定义头', () => {
    expect(buildPiRequestHeaders('openai-responses', 'token')).toBeUndefined()
  })

  test('Given Copis Working 渠道 When 构建请求头 Then 注入 copis-agent-model 计费来源', () => {
    const headers = buildPiRequestHeaders('openai-responses', 'jwt', {
      [COPIS_WORKING_MODEL_SOURCE_TYPE_HEADER]: COPIS_WORKING_MODEL_SOURCE_TYPE_COPIS_AGENT,
    })
    expect(headers).toEqual({
      [COPIS_WORKING_MODEL_SOURCE_TYPE_HEADER]: COPIS_WORKING_MODEL_SOURCE_TYPE_COPIS_AGENT,
    })
  })

  test('Given Anthropic 渠道 When 同时传入计费来源 Then 与 Authorization 合并', () => {
    const headers = buildPiRequestHeaders('anthropic', 'key', {
      [COPIS_WORKING_MODEL_SOURCE_TYPE_HEADER]: COPIS_WORKING_MODEL_SOURCE_TYPE_COPIS_AGENT,
    })
    expect(headers).toEqual({
      Authorization: 'Bearer key',
      [COPIS_WORKING_MODEL_SOURCE_TYPE_HEADER]: COPIS_WORKING_MODEL_SOURCE_TYPE_COPIS_AGENT,
    })
  })

  test('Given 自定义 Responses 渠道 When 获取思考深度映射 Then off 使用 none 且保留所有 Composer 档位', () => {
    expect(getWorkingCustomResponsesThinkingLevelMap()).toEqual({
      off: 'none',
      minimal: 'minimal',
      low: 'low',
      medium: 'medium',
      high: 'high',
      xhigh: 'xhigh',
      max: 'max',
    })
  })

  test('Given 内置 DeepSeek v4 Flash When 注册 Pi 模型 Then 保留图片输入能力', async () => {
    let registeredModel: { input: string[] } | undefined
    const modelRuntime = {
      registerProvider: (_name: string, provider: { models: { input: string[] }[] }) => {
        registeredModel = provider.models[0]
      },
      getModel: () => registeredModel,
    }
    const sdk = {
      ModelRuntime: {
        create: async () => modelRuntime,
      },
    }

    const { model } = await buildModel(sdk as never, {
      apiKey: 'token',
      baseUrl: 'http://127.0.0.1:51730/api/internal/working-model/v1',
      channelId: COPIS_WORKING_DEEPSEEK_CHANNEL_ID,
      model: COPIS_WORKING_DEEPSEEK_FAST_MODEL_ID,
      permissionMode: 'bypassPermissions',
      piAgentDir: '/tmp/pi',
      piSessionDir: '/tmp/pi/sessions',
      prompt: '读取图片',
      provider: 'openai-responses',
      sessionId: 'deepseek-flash-image-input',
      systemPrompt: 'test',
    })

    expect(model.input).toEqual(['text', 'image'])
  })
})
