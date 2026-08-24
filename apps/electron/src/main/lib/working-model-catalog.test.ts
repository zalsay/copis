import { describe, expect, mock, test } from 'bun:test'

mock.module('electron', () => ({
  app: {
    isPackaged: true,
    getPath: () => '/mock/app/support',
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString('utf8'),
  },
  shell: {
    openExternal: async () => undefined,
  },
}))

const {
  assertWorkingCustomModelSelection,
  filterWorkingModelCatalogUpdate,
  getWorkingCustomModelRuntime,
  getWorkingModelCatalog,
  redactWorkingModelCatalog,
  saveWorkingModelCatalog,
  testWorkingCustomModelConnection,
} = await import('./working-model-catalog')

describe('VIP 自定义模型目录主进程门禁', () => {
  test('Given 非 VIP 用户 When 读取或保存目录 Then 统一返回 vip_required', () => {
    expect(() => getWorkingModelCatalog(false)).toThrowError({
      name: 'WorkingModelCatalogAccessError',
      message: '仅 VIP 用户可使用模型管理',
    })
    expect(() => saveWorkingModelCatalog({ models: [], categories: [] }, false)).toThrowError({
      name: 'WorkingModelCatalogAccessError',
      message: '仅 VIP 用户可使用模型管理',
    })
  })

  test('Given 未显式提供 VIP 状态 When 访问目录 Then 默认拒绝', () => {
    expect(() => getWorkingModelCatalog(undefined as unknown as boolean)).toThrowError({
      name: 'WorkingModelCatalogAccessError',
      message: '仅 VIP 用户可使用模型管理',
    })
  })

  test('Given 非 VIP 用户 When 使用自定义模型渠道运行 Then 在解析运行配置前拒绝', () => {
    expect(() => getWorkingCustomModelRuntime('copis-custom-model-1', false)).toThrowError({
      name: 'WorkingModelCatalogAccessError',
      message: '仅 VIP 用户可使用模型管理',
    })
  })

  test('Given 非 VIP 用户 When 持久化自定义模型选择 Then 在写入前拒绝', () => {
    expect(() => assertWorkingCustomModelSelection('copis-custom-ghost', 'ghost', false, 'account-1')).toThrowError({
      name: 'WorkingModelCatalogAccessError',
      message: '仅 VIP 用户可使用模型管理',
    })
    expect(() => filterWorkingModelCatalogUpdate({
      agentChannelId: 'copis-custom-ghost',
      agentModelId: 'ghost',
    }, false, 'account-1')).toThrowError({
      name: 'WorkingModelCatalogAccessError',
      message: '仅 VIP 用户可使用模型管理',
    })
  })

  test('Given VIP 用户选择已不存在的自定义模型 When 持久化 Then 拒绝过期选择', () => {
    expect(() => assertWorkingCustomModelSelection('copis-custom-ghost', 'ghost', true, 'account-1')).toThrow('自定义模型不存在')
  })

  test('Given 模型目录属于其他 Working 账号 When 读取设置 Then 隐藏目录与密钥状态', () => {
    const settings = {
      themeMode: 'dark' as const,
      workingModelCatalogOwnerId: 'account-1',
      workingModelCatalog: {
        categories: [],
        models: [{
          id: 'model-1',
          name: '模型一',
          baseUrl: 'https://models.example.com/v1',
          modelId: 'vendor/model-1',
          protocol: 'openai-responses' as const,
          thinkingLevel: 'high' as const,
          apiKeyConfigured: true,
        }],
      },
      workingModelApiKeys: { 'model-1': 'encrypted-secret' },
    }

    expect(redactWorkingModelCatalog(settings, true, 'account-2')).toEqual({ themeMode: 'dark' })
    expect(redactWorkingModelCatalog(settings, true, 'account-1')).toMatchObject({
      themeMode: 'dark',
      workingModelCatalog: {
        models: [{ id: 'model-1', apiKeyConfigured: true }],
      },
    })
    expect(redactWorkingModelCatalog(settings, true, 'account-1')).not.toHaveProperty('workingModelApiKeys')
  })

  test('Given 非 VIP 用户 When 测试自定义模型连接 Then 统一抛出 vip_required', async () => {
    await expect(testWorkingCustomModelConnection({
      protocol: 'openai-responses',
      baseUrl: 'https://api.openai.com/v1',
      modelId: 'gpt-4o',
      apiKey: 'sk-test',
    }, false)).rejects.toThrow('仅 VIP 用户可使用模型管理')
  })

  test('Given 未提供 API Key 且未保存过密钥 When 测试连接 Then 返回提示错误', async () => {
    const result = await testWorkingCustomModelConnection({
      protocol: 'openai-responses',
      baseUrl: 'https://api.openai.com/v1',
      modelId: 'gpt-4o',
    }, true, 'account-1')

    expect(result.success).toBe(false)
    expect(result.message).toContain('请先填写 API 密钥')
  })
})
