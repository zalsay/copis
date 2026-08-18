import { describe, expect, test } from 'bun:test'
import {
  normalizeWorkingModelCatalogInput,
  toWorkingModelCatalogView,
  workingModelCatalogToOptions,
  workingCustomModelProtocolToProvider,
} from './working-model-catalog'

function makeModel(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'model-1',
    name: '模型一',
    baseUrl: 'https://models.example.com/v1',
    modelId: 'vendor/model-1',
    protocol: 'openai-responses',
    thinkingLevel: 'high',
    ...overrides,
  }
}

describe('VIP 自定义模型目录工具契约', () => {
  test('Given 未指定协议 When 归一化模型 Then 默认使用 openai-responses 且允许切换 anthropic-messages', () => {
    const { protocol: _protocol, ...withoutProtocol } = makeModel()
    const defaulted = normalizeWorkingModelCatalogInput({ models: [withoutProtocol], categories: [] })
    const anthropic = normalizeWorkingModelCatalogInput({
      models: [makeModel({ protocol: 'anthropic-messages' })],
      categories: [],
    })

    expect(defaulted.models[0]?.protocol).toBe('openai-responses')
    expect(anthropic.models[0]?.protocol).toBe('anthropic-messages')
    expect(workingCustomModelProtocolToProvider('openai-responses')).toBe('openai-responses')
    expect(workingCustomModelProtocolToProvider('anthropic-messages')).toBe('anthropic-compatible')
  })

  test('Given 自定义 Messages 模型 When 转换为模型选项 Then 使用 anthropic-compatible provider', () => {
    const catalog = toWorkingModelCatalogView(
      normalizeWorkingModelCatalogInput({
        categories: [],
        models: [makeModel({ protocol: 'anthropic-messages', apiKey: 'secret' })],
      }),
      { 'model-1': 'encrypted-secret' },
    )

    expect(workingModelCatalogToOptions(catalog)[0]?.provider).toBe('anthropic-compatible')
  })

  test('Given 自定义分类 ID 与内置渠道 ID 相同 When 转换为模型选项 Then 分组键保持自定义命名空间', () => {
    const catalog = toWorkingModelCatalogView(
      normalizeWorkingModelCatalogInput({
        categories: [{ id: 'copis-working', name: '自定义分类' }],
        models: [makeModel({ categoryId: 'copis-working', apiKey: 'secret' })],
      }),
      { 'model-1': 'encrypted-secret' },
    )

    expect(workingModelCatalogToOptions(catalog)[0]?.groupKey).toBe('custom:category:copis-working')
  })

  test('Given 分类 ID 使用未分类保留字 When 转换选项 Then 不与未分类分组冲突', () => {
    const catalog = toWorkingModelCatalogView(
      normalizeWorkingModelCatalogInput({
        categories: [{ id: '__uncategorized__', name: '自定义分类' }],
        models: [
          makeModel({ id: 'categorized', categoryId: '__uncategorized__', apiKey: 'secret-1' }),
          makeModel({ id: 'uncategorized', categoryId: undefined, apiKey: 'secret-2' }),
        ],
      }),
      { categorized: 'encrypted-secret-1', uncategorized: 'encrypted-secret-2' },
    )

    const options = workingModelCatalogToOptions(catalog)
    expect(options[0]?.groupKey).toBe('custom:category:__uncategorized__')
    expect(options[1]?.groupKey).toBe('custom:uncategorized')
  })

  test('Given 带空白的模型目录 When 归一化 Then 规范化地址、模型 ID、思考深度和分类名称', () => {
    const normalized = normalizeWorkingModelCatalogInput({
      categories: [{ id: ' category-main ', name: '  研究模型  ' }],
      models: [makeModel({
        categoryId: ' category-main ',
        baseUrl: '  https://models.example.com/v1  ',
        modelId: '  vendor/model-1  ',
        thinkingLevel: ' high ',
      })],
    })

    expect(normalized.categories).toEqual([{ id: 'category-main', name: '研究模型' }])
    expect(normalized.models[0]).toMatchObject({
      categoryId: 'category-main',
      baseUrl: 'https://models.example.com/v1',
      modelId: 'vendor/model-1',
      thinkingLevel: 'high',
    })
  })

  test('Given 非法 Base URL、模型 ID、思考深度或分类名称 When 归一化 Then 拒绝输入', () => {
    const invalidCases: Array<[string, unknown, RegExp]> = [
      ['Base URL', { models: [makeModel({ baseUrl: 'ftp://models.example.com/v1' })], categories: [] }, /Base URL/],
      ['模型 ID', { models: [makeModel({ modelId: '   ' })], categories: [] }, /模型 ID/],
      ['协议', { models: [makeModel({ protocol: 'chat-completions' })], categories: [] }, /协议/],
      ['thinkingLevel', { models: [makeModel({ thinkingLevel: 'turbo' })], categories: [] }, /thinkingLevel/],
      ['分类名称', { models: [], categories: [{ id: 'category-main', name: '   ' }] }, /分类名称/],
    ]

    for (const [label, input, message] of invalidCases) {
      expect(() => normalizeWorkingModelCatalogInput(input), label).toThrow(message)
    }
  })

  test('Given 保存输入包含 API key When 生成 renderer-facing catalog view Then 只暴露 apiKeyConfigured', () => {
    const normalized = normalizeWorkingModelCatalogInput({
      categories: [],
      models: [makeModel({ apiKey: '  renderer-secret  ' })],
    })
    const configuredView = toWorkingModelCatalogView(normalized, { 'model-1': 'encrypted-secret' })
    const unconfiguredView = toWorkingModelCatalogView(normalized, {})
    const configuredModel = configuredView.models[0]!
    const unconfiguredModel = unconfiguredView.models[0]!

    expect(configuredModel.apiKeyConfigured).toBe(true)
    expect(unconfiguredModel.apiKeyConfigured).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(configuredModel, 'apiKey')).toBe(false)
    expect(JSON.stringify(configuredView)).not.toContain('renderer-secret')
    expect(JSON.stringify(configuredView)).not.toContain('encrypted-secret')
  })

  test('Given 共享纯工具没有 VIP 状态 When 校验目录并生成 view Then 保持目录契约，真实非 VIP 读写门禁待主进程导出后补测', () => {
    const normalized = normalizeWorkingModelCatalogInput({
      categories: [],
      models: [makeModel({ apiKey: 'secret' })],
    })
    const view = toWorkingModelCatalogView(normalized, {})

    expect(view.models).toHaveLength(1)
    expect(view.models[0]?.apiKeyConfigured).toBe(false)
  })

})
