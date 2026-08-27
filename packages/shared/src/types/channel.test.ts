import { describe, expect, test } from 'bun:test'
import {
  PROVIDER_LABELS,
  ZHIPU_COMPOSER_GROUP_NAME,
  ZHIPU_DEFAULT_MODEL_ID,
  ZHIPU_DEFAULT_MODEL_NAME,
  withDefaultProviderModels,
} from './channel'

describe('渠道默认模型选项', () => {
  test('Given zhipu 渠道没有模型 When 补齐默认模型 Then 使用 Z.ai 分组和 GLM 5.3 Flash', () => {
    expect(PROVIDER_LABELS.zhipu).toBe('智谱 AI')
    expect(ZHIPU_COMPOSER_GROUP_NAME).toBe('Z.ai（智谱）')
    expect(withDefaultProviderModels('zhipu', [])).toEqual([{
      id: ZHIPU_DEFAULT_MODEL_ID,
      name: ZHIPU_DEFAULT_MODEL_NAME,
      enabled: true,
      source: 'manual',
    }])
  })

  test('Given zhipu 渠道已经配置默认模型 When 补齐默认模型 Then 不重复添加', () => {
    const configured = {
      id: ZHIPU_DEFAULT_MODEL_ID,
      name: '用户自定义名称',
      enabled: false,
      source: 'manual' as const,
    }

    expect(withDefaultProviderModels('zhipu', [configured])).toEqual([configured])
  })
})
