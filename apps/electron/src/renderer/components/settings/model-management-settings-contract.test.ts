import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { workingModelCatalogToOptions } from '@copis/shared'

const settingsSource = readFileSync(join(import.meta.dir, 'ModelManagementSettings.tsx'), 'utf8')

describe('模型管理用户友好、保存与测试连接功能契约', () => {
  test('Given 模型管理设置源码 When 检查界面设计 Then 不包含复杂的自定义分类 CRUD，直接配置模型名称', () => {
    expect(settingsSource).not.toContain('新分类名称')
    expect(settingsSource).not.toContain('添加分类')
    expect(settingsSource).not.toContain('Composer 会按这里的分类分组')
    expect(settingsSource).toContain('label="模型名称"')
    expect(settingsSource).toContain('label="模型标识 (Model ID)"')
  })

  test('Given 模型管理设置源码 When 检查协议与思考深度选项 Then 使用用户友好的中文文案', () => {
    expect(settingsSource).toContain('OpenAI 兼容协议 (Responses)')
    expect(settingsSource).toContain('Anthropic 兼容协议 (Messages)')
    expect(settingsSource).toContain('关闭思考')
    expect(settingsSource).toContain('深度思考 (High - 推荐)')
    expect(settingsSource).toContain('API 密钥 (API Key)')
  })

  test('Given 未指定自定义分类的模型目录 When 转换为模型选项 Then 默认分组名称为「自定义模型」', () => {
    const options = workingModelCatalogToOptions({
      categories: [],
      models: [
        {
          id: 'custom-1',
          name: 'Claude 3.7 Sonnet',
          baseUrl: 'https://api.anthropic.com/v1',
          modelId: 'claude-3-7-sonnet-20250219',
          protocol: 'anthropic-messages',
          thinkingLevel: 'high',
          apiKeyConfigured: true,
        },
      ],
    })

    expect(options[0]?.groupName).toBe('自定义模型')
    expect(options[0]?.categoryName).toBe('自定义模型')
    expect(options[0]?.modelName).toBe('Claude 3.7 Sonnet')
  })

  test('Given 底部操作栏 When 查看按钮 Then 保存按钮文案为「保存」且其左侧包含「测试连接」按钮', () => {
    expect(settingsSource).toContain("'保存中...' : '保存'")
    expect(settingsSource).not.toContain('保存模型配置')
    expect(settingsSource).toContain("'测试中...' : '测试连接'")
    expect(settingsSource).toContain('handleTestConnection')
    expect(settingsSource).toContain('testWorkingModelConnection')
  })

  test('Given 非 VIP 用户状态 When 渲染提示 Then 引导文案清晰友好', () => {
    expect(settingsSource).toContain('自定义模型仅对 VIP 开放')
    expect(settingsSource).toContain('升级 VIP')
    expect(settingsSource).not.toContain('在 Composer 中使用')
  })
})
