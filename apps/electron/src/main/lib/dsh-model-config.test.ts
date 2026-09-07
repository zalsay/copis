import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseDocument } from 'yaml'
import { getSettingsPath } from './config-paths'
import {
  COPIS_WORKING_CHANNEL_ID,
  COPIS_WORKING_DEEPSEEK_CHANNEL_ID,
  COPIS_WORKING_EXPERT_MODEL_ID,
  COPIS_WORKING_ZHIPU_CHANNEL_ID,
  ZHIPU_DEFAULT_MODEL_ID,
} from '@copis/shared'

let tempHome: string
const originalHome = process.env.HOME
const originalCopisDev = process.env.COPIS_DEV
const originalFetch = globalThis.fetch

mock.module('electron', () => ({
  app: {
    isPackaged: true,
    getPath: () => join(tempHome, 'Library', 'Application Support'),
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString('utf-8'),
  },
  nativeTheme: {
    themeSource: 'system',
    shouldUseDarkColors: false,
    on: () => {},
  },
  shell: {
    openExternal: async () => undefined,
  },
}))

mock.module('./working-api-service', () => ({
  getWorkingApiClient: () => ({ baseUrl: 'http://127.0.0.1:9000' }),
}))

mock.module('./http-api-server', () => ({
  getHttpApiInternalToken: () => 'test-internal-token',
}))

describe('dsh-model-config', () => {
  let modelConfigModule: typeof import('./dsh-model-config')
  let channelManagerModule: typeof import('./channel-manager')

  beforeAll(async () => {
    tempHome = mkdtempSync(join(tmpdir(), 'copis-test-dsh-model-'))
    process.env.HOME = tempHome
    process.env.COPIS_DEV = '1'
    process.env.DEEPSEEK_API_KEY = 'sk-test-deepseek-env'
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === 'http://127.0.0.1:9000/api/internal/dsh-model-capability') {
        expect(new Headers(init?.headers).get('X-Copis-Internal-Token')).toBe('test-internal-token')
        expect(JSON.parse(String(init?.body))).toEqual({ reasoningEffort: 'high' })
        return Response.json({ capability: 'dsh-test-capability' })
      }
      throw new Error(`未预期的 DSH capability 请求: ${String(input)}`)
    }) as typeof fetch

    modelConfigModule = await import('./dsh-model-config')
    channelManagerModule = await import('./channel-manager')
  })

  afterAll(() => {
    process.env.HOME = originalHome
    globalThis.fetch = originalFetch
    if (originalCopisDev === undefined) {
      delete process.env.COPIS_DEV
    } else {
      process.env.COPIS_DEV = originalCopisDev
    }
    rmSync(tempHome, { recursive: true, force: true })
  })

  test('Given 默认未配置渠道或 DeepSeek 内置渠道 When 统一解析模型配置 Then 默认生成 copis 自定义 provider 并映射 DeepSeek 闪电模型', async () => {
    const config = await modelConfigModule.resolveDshUnifiedModelConfig({
      channelId: COPIS_WORKING_DEEPSEEK_CHANNEL_ID,
    })

    expect(config.providerRoute).toBe(COPIS_WORKING_DEEPSEEK_CHANNEL_ID)
    expect(config.displayName).toBe('DeepSeek')
    expect(config.defaultModelId).toBe('deepseek-v4-flash')
    expect(config.protocol).toBe('openai-responses')
    expect(config.baseURL).toBe('http://127.0.0.1:9000/api/internal/working-model/v1')
    expect(config.apiKeyEnv).toBe('COPIS_DSH_WORKING_CAPABILITY')
    expect(config.env.COPIS_DSH_WORKING_CAPABILITY).toBe('dsh-test-capability')
    expect(config.credentialsRefs).toEqual({})
    expect(config.models.some((m) => m.id === 'deepseek-v4-flash')).toBe(true)
  })

  test('Given 选中 copis-working 渠道 When 统一解析模型配置 Then 自定义 provider 映射为 Working 端点与对应模型', async () => {
    const config = await modelConfigModule.resolveDshUnifiedModelConfig({
      channelId: COPIS_WORKING_CHANNEL_ID,
      modelId: COPIS_WORKING_EXPERT_MODEL_ID,
    })

    expect(config.providerRoute).toBe(COPIS_WORKING_CHANNEL_ID)
    expect(config.displayName).toBe('Copis 内置模型')
    expect(config.defaultModelId).toBe(COPIS_WORKING_EXPERT_MODEL_ID)
    expect(config.protocol).toBe('openai-responses')
    expect(config.baseURL).toContain('/api/internal/working-model/v1')
    expect(config.apiKey).toBe('dsh-test-capability')
    expect(config.models.map((m) => m.id)).toEqual(['fast', COPIS_WORKING_EXPERT_MODEL_ID, 'global'])
  })

  test('Given 选中 copis-working-zhipu 渠道 When 统一解析模型配置 Then 映射为智谱对应默认模型', async () => {
    const config = await modelConfigModule.resolveDshUnifiedModelConfig({
      channelId: COPIS_WORKING_ZHIPU_CHANNEL_ID,
    })

    expect(config.providerRoute).toBe(COPIS_WORKING_ZHIPU_CHANNEL_ID)
    expect(config.displayName).toBe('智谱 AI')
    expect(config.defaultModelId).toBe(ZHIPU_DEFAULT_MODEL_ID)
    expect(config.protocol).toBe('openai-responses')
    expect(config.apiKey).toBe('dsh-test-capability')
  })

  test('Given 用户添加的第三方 OpenAI 兼容渠道 When 统一解析模型配置 Then 自定义 provider 继承其端点、密钥与模型', async () => {
    // 动态添加一个测试渠道
    const channel = channelManagerModule.createChannel({
      name: 'Custom OpenCode',
      provider: 'openai',
      baseUrl: 'https://api.custom-ai.com/v1',
      apiKey: 'sk-custom-secret-key',
      enabled: true,
      models: [
        { id: 'custom-model-1', name: 'Custom Model 1', enabled: true },
        { id: 'custom-model-2', name: 'Custom Model 2', enabled: true },
      ],
    })

    const config = await modelConfigModule.resolveDshUnifiedModelConfig({
      channelId: channel.id,
      modelId: 'custom-model-2',
    })

    expect(config.providerRoute).toBe('copis')
    expect(config.displayName).toBe('Copis (Custom OpenCode)')
    expect(config.defaultModelId).toBe('custom-model-2')
    expect(config.protocol).toBe('openai-responses')
    expect(config.baseURL).toBe('https://api.custom-ai.com/v1')
    expect(config.apiKey).toBe('sk-custom-secret-key')
    expect(config.env.COPIS_API_KEY).toBe('sk-custom-secret-key')
    expect(config.credentialsRefs.COPIS_API_KEY).toBe('sk-custom-secret-key')
  })

  test('Given 已删除的外部渠道 When 统一解析模型配置 Then 回退到 Copis 内置 DeepSeek 而不写入 DeepSeek 官方配置', async () => {
    const config = await modelConfigModule.resolveDshUnifiedModelConfig({
      channelId: 'deleted-external-channel',
    })

    expect(config.providerRoute).toBe(COPIS_WORKING_DEEPSEEK_CHANNEL_ID)
    expect(config.displayName).toBe('DeepSeek')
    expect(config.baseURL).toBe('http://127.0.0.1:9000/api/internal/working-model/v1')
    expect(config.apiKeyEnv).toBe('COPIS_DSH_WORKING_CAPABILITY')
    expect(config.credentialsRefs).toEqual({})
  })

  test('Given 统一模型配置 When 执行 applyDshModelConfig Then settings.yaml、.credentials.yaml 与 cordis.patch.yml 均被正确写入且默认启用 copis provider', async () => {
    const testDshDir = mkdtempSync(join(tmpdir(), 'copis-test-dsh-apply-'))
    try {
      // 准备已有 .credentials.yaml 包含已有 grant
      const credFile = join(testDshDir, '.credentials.yaml')
      writeFileSync(credFile, 'version: 1\nrecords:\n  client-connection/browser-session:\n    kind: grant\n', 'utf-8')

      const config: import('./dsh-model-config').DshUnifiedModelConfig = {
        providerRoute: 'copis',
        displayName: 'Copis (DeepSeek)',
        defaultModelId: 'deepseek-v4-flash',
        protocol: 'openai-responses',
        baseURL: 'https://api.deepseek.com',
        apiKey: 'sk-apply-test-key',
        apiKeyEnv: 'COPIS_API_KEY',
        models: [
          { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash' },
          { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' },
        ],
        env: { COPIS_API_KEY: 'sk-apply-test-key', DEEPSEEK_API_KEY: 'sk-apply-test-key' },
        credentialsRefs: { COPIS_API_KEY: 'sk-apply-test-key', DEEPSEEK_API_KEY: 'sk-apply-test-key' },
      }

      modelConfigModule.applyDshModelConfig(config, testDshDir, 'copis')

      // 1. 验证 settings.yaml
      const settingsFile = join(testDshDir, 'settings.yaml')
      expect(existsSync(settingsFile)).toBe(true)
      const settingsDoc = parseDocument(readFileSync(settingsFile, 'utf-8')).toJS()
      expect(settingsDoc['agent-default-model']).toEqual({
        provider: 'copis',
        model: 'deepseek-v4-flash',
      })
      expect(settingsDoc['llm-pi-ai']?.providers?.copis).toBeDefined()
      expect(settingsDoc['llm-pi-ai'].providers.copis.displayName).toBe('Copis (DeepSeek)')
      expect(settingsDoc['llm-pi-ai'].providers.copis.api).toBe('openai-responses')
      expect(settingsDoc['llm-pi-ai'].providers.copis.baseURL).toBe('https://api.deepseek.com')
      expect(settingsDoc['llm-pi-ai'].providers.copis.apiKeyEnv).toBe('COPIS_API_KEY')

      // 2. 验证 .credentials.yaml
      const credDoc = parseDocument(readFileSync(credFile, 'utf-8')).toJS()
      expect(credDoc.version).toBe(1)
      expect(credDoc.records['client-connection/browser-session']?.kind).toBe('grant')
      expect(credDoc.refs.COPIS_API_KEY).toBe('sk-apply-test-key')
      expect(credDoc.refs.DEEPSEEK_API_KEY).toBe('sk-apply-test-key')

      // 3. 验证 cordis.patch.yml
      const patchFile = join(testDshDir, 'profiles', 'copis', 'cordis.patch.yml')
      expect(existsSync(patchFile)).toBe(true)
      const patchDoc = parseDocument(readFileSync(patchFile, 'utf-8')).toJS()
      expect(Array.isArray(patchDoc)).toBe(true)
      const defaultModelPatch = patchDoc.find((item: any) => item?.id === 'agent-default-model')
      expect(defaultModelPatch?.config?.provider).toBe('copis')
      expect(defaultModelPatch?.config?.model).toBe('deepseek-v4-flash')
      expect(patchDoc.find((item: any) => item?.id === 'llm-deepseek')?.disabled).toBe(true)
    } finally {
      rmSync(testDshDir, { recursive: true, force: true })
    }
  })

  test('Given settings.yaml 含重复 YAML 键 When 同步模型配置 Then 输出文档恢复为合法且唯一的配置', () => {
    const testDshDir = mkdtempSync(join(tmpdir(), 'copis-test-dsh-duplicate-settings-'))
    try {
      writeFileSync(join(testDshDir, 'settings.yaml'), [
        'llm-pi-ai:',
        '  providers:',
        '    copis-working-deepseek:',
        '      displayName: DeepSeek',
        '      defaultContextWindow: 990000',
        '      models: []',
        '      defaultContextWindow: 990000',
      ].join('\n') + '\n', 'utf-8')

      modelConfigModule.applyDshModelConfig({
        providerRoute: COPIS_WORKING_DEEPSEEK_CHANNEL_ID,
        displayName: 'DeepSeek',
        defaultModelId: 'deepseek-v4-flash',
        protocol: 'openai-responses',
        baseURL: 'http://127.0.0.1:9000/api/internal/working-model/v1',
        apiKey: 'capability',
        apiKeyEnv: 'COPIS_DSH_WORKING_CAPABILITY',
        models: [{ id: 'deepseek-v4-flash', name: '快速' }],
        env: { COPIS_DSH_WORKING_CAPABILITY: 'capability' },
        credentialsRefs: {},
      }, testDshDir, 'copis')

      const settingsFile = join(testDshDir, 'settings.yaml')
      const parsed = parseDocument(readFileSync(settingsFile, 'utf-8'))
      expect(parsed.errors).toHaveLength(0)
      expect(parsed.toJS()['llm-pi-ai'].providers['copis-working-deepseek'].defaultContextWindow).toBe(990_000)
    } finally {
      rmSync(testDshDir, { recursive: true, force: true })
    }
  })

  test('Given Copis 当前 Agent 默认配置 When 同步到 DSH Then settings 与 Cordis profile 均保存完整且无密钥的默认快照', () => {
    const testDshDir = mkdtempSync(join(tmpdir(), 'copis-test-dsh-defaults-'))
    const originalSettings = existsSync(getSettingsPath()) ? readFileSync(getSettingsPath(), 'utf-8') : undefined
    try {
      writeFileSync(getSettingsPath(), JSON.stringify({
        agentChannelId: 'channel-current',
        agentModelId: 'model-current',
        agentChannelIds: ['channel-current', 'channel-backup'],
        agentWorkspaceId: 'workspace-current',
        agentRuntime: 'pi',
        defaultMemoryPolicy: 'visible',
        windowsShellPreference: 'wsl',
        agentThinking: { type: 'enabled' },
        agentEffort: 'high',
        defaultOpenAIThinkingLevel: 'high',
        agentMaxBudgetUsd: 12.5,
        agentMaxTurns: 36,
        browserWorkflowEnabled: false,
        builtinMcpDisabledIds: ['filesystem'],
        builtinMcpEnabledIds: ['nano-banana'],
        gitAttributionEnabled: false,
      }), 'utf-8')

      modelConfigModule.applyDshModelConfig({
        providerRoute: 'copis',
        displayName: 'Copis Test',
        defaultModelId: 'model-current',
        protocol: 'openai-completions',
        baseURL: 'https://api.example.com/v1',
        apiKey: 'sk-must-not-be-in-defaults',
        apiKeyEnv: 'COPIS_API_KEY',
        models: [{ id: 'model-current', name: 'Current model' }],
        env: { COPIS_API_KEY: 'sk-must-not-be-in-defaults' },
        credentialsRefs: { COPIS_API_KEY: 'sk-must-not-be-in-defaults' },
      }, testDshDir, 'copis')

      const dshSettings = parseDocument(readFileSync(join(testDshDir, 'settings.yaml'), 'utf-8')).toJS()
      const expectedDefaults = {
        agent: {
          channelId: 'channel-current',
          modelId: 'model-current',
          channelIds: ['channel-current', 'channel-backup'],
          workspaceId: 'workspace-current',
          runtime: 'pi',
          thinking: { type: 'enabled' },
          effort: 'high',
          openAIThinkingLevel: 'high',
          maxBudgetUsd: 12.5,
          maxTurns: 36,
          permissionMode: 'bypassPermissions',
        },
        memoryPolicy: 'visible',
        windowsShellPreference: 'wsl',
        browserWorkflowEnabled: true,
        builtinMcp: {
          disabledIds: ['filesystem'],
          enabledIds: ['nano-banana'],
        },
        gitAttributionEnabled: false,
      }

      expect(dshSettings['copis-defaults']).toEqual(expectedDefaults)
      expect(JSON.stringify(dshSettings['copis-defaults'])).not.toContain('sk-must-not-be-in-defaults')

      const patchItems = parseDocument(readFileSync(join(testDshDir, 'profiles', 'copis', 'cordis.patch.yml'), 'utf-8')).toJS()
      expect(patchItems.find((item: { id?: string }) => item.id === 'copis-defaults')?.config).toEqual(expectedDefaults)
    } finally {
      if (originalSettings === undefined) {
        rmSync(getSettingsPath(), { force: true })
      } else {
        writeFileSync(getSettingsPath(), originalSettings, 'utf-8')
      }
      rmSync(testDshDir, { recursive: true, force: true })
    }
  })

  test('Given Copis Agent 默认设置更新 When 判断是否同步 DSH Then Agent 相关字段触发而纯 UI 字段不触发', () => {
    expect(modelConfigModule.shouldSyncDshCopisDefaults({ agentMaxTurns: 48 })).toBe(true)
    expect(modelConfigModule.shouldSyncDshCopisDefaults({ defaultMemoryPolicy: 'visible' })).toBe(true)
    expect(modelConfigModule.shouldSyncDshCopisDefaults({ builtinMcpEnabledIds: ['nano-banana'] })).toBe(true)
    expect(modelConfigModule.shouldSyncDshCopisDefaults({ themeMode: 'dark' })).toBe(false)
    expect(modelConfigModule.shouldSyncDshCopisDefaults({ mainWindowState: { width: 1200, height: 800, x: 0, y: 0, isMaximized: false } })).toBe(false)
  })

  test('Given Copis 思考设置 When 签发 DSH capability Then 使用与 Pi 一致的 Responses effort', () => {
    expect(modelConfigModule.resolveDshWorkingReasoningEffort({
      agentThinking: { type: 'disabled' },
      agentEffort: 'high',
    })).toBe('none')
    expect(modelConfigModule.resolveDshWorkingReasoningEffort({
      agentThinking: { type: 'adaptive' },
      agentEffort: 'high',
    })).toBe('high')
    expect(modelConfigModule.resolveDshWorkingReasoningEffort({
      agentThinking: { type: 'adaptive' },
      agentEffort: 'max',
    })).toBe('xhigh')
  })

  test('Given DSH Working capability When 生成 Composer 模型路由 Then 三组内建模型独立可选且 capability 不会持久化', () => {
    const providers = modelConfigModule.resolveDshWorkingProviderConfigs({
      baseURL: 'http://127.0.0.1:51730/api/internal/working-model/v1',
      capability: 'dsh-capability',
    })

    expect(providers.map((provider) => provider.providerRoute)).toEqual([
      'copis-working',
      'copis-working-deepseek',
      'copis-working-zhipu',
    ])
    expect(providers.find((provider) => provider.providerRoute === 'copis-working')?.models.map((model) => model.id))
      .toEqual(['fast', 'export', 'global'])
    expect(providers.find((provider) => provider.providerRoute === 'copis-working')?.models.map((model) => model.name))
      .toEqual([
        '快速(速度快，思考能力一般)',
        '专家(全球领先，知识面广，深度思考，消耗更多钻石)',
        '通识(通晓世界知识，适合教育、探索等场景)',
      ])
    expect(providers.find((provider) => provider.providerRoute === 'copis-working-deepseek')?.models.map((model) => model.id))
      .toEqual(['deepseek-v4-flash', 'deepseek-v4-pro'])
    expect(providers.find((provider) => provider.providerRoute === 'copis-working-deepseek')?.models.map((model) => model.name))
      .toEqual([
        '快速(v4 Flash，思考速度快，不支持图片识别)',
        '专业(v4Pro，DeepSeek 最强模型，不支持图片识别)',
      ])
    expect(providers.find((provider) => provider.providerRoute === 'copis-working-deepseek')?.defaultContextWindow)
      .toBe(990_000)
    expect(providers.find((provider) => provider.providerRoute === 'copis-working')?.defaultContextWindow).toBeUndefined()
    expect(providers.find((provider) => provider.providerRoute === 'copis-working-zhipu')?.defaultContextWindow).toBeUndefined()
    expect(providers.find((provider) => provider.providerRoute === 'copis-working-zhipu')?.models.map((model) => model.id))
      .toEqual([ZHIPU_DEFAULT_MODEL_ID])
    expect(providers.find((provider) => provider.providerRoute === 'copis-working-zhipu')?.models.map((model) => model.name))
      .toEqual(['GLM 5.3 Flash(智谱家族性价比之王)'])
    expect(providers.map((provider) => provider.displayName)).toEqual([
      'Copis 内置模型',
      'DeepSeek',
      '智谱 AI',
    ])
    expect(providers.every((provider) => provider.apiKeyEnv === 'COPIS_DSH_WORKING_CAPABILITY')).toBe(true)
    expect(providers.every((provider) => provider.env.COPIS_DSH_WORKING_CAPABILITY === 'dsh-capability')).toBe(true)
    expect(providers.every((provider) => Object.keys(provider.credentialsRefs).length === 0)).toBe(true)
  })

  test('Given 旧版 copis 路由与 Working 默认模型 When 写入设置 Then Composer 仅保留三组内建模型且不落盘 capability', () => {
    const testDshDir = mkdtempSync(join(tmpdir(), 'copis-test-dsh-working-'))
    try {
      writeFileSync(join(testDshDir, 'settings.yaml'), `llm-pi-ai:\n  providers:\n    copis:\n      displayName: Copis (legacy)\n      api: openai-responses\n      baseURL: http://127.0.0.1:51730/api/internal/working-model/v1\n    deepseek:\n      displayName: DeepSeek 官方\n      api: openai-responses\n      baseURL: https://api.deepseek.com\n`, 'utf-8')
      const providers = modelConfigModule.resolveDshWorkingProviderConfigs({
        baseURL: 'http://127.0.0.1:51730/api/internal/working-model/v1',
        capability: 'dsh-capability-not-persisted',
      })
      modelConfigModule.applyDshModelConfig({
        providerRoute: COPIS_WORKING_DEEPSEEK_CHANNEL_ID,
        displayName: 'DeepSeek',
        defaultModelId: 'deepseek-v4-flash',
        protocol: 'openai-responses',
        baseURL: 'http://127.0.0.1:51730/api/internal/working-model/v1',
        apiKey: 'dsh-capability-not-persisted',
        apiKeyEnv: 'COPIS_DSH_WORKING_CAPABILITY',
        models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash' }],
        env: { COPIS_DSH_WORKING_CAPABILITY: 'dsh-capability-not-persisted' },
        credentialsRefs: {},
        providerConfigs: providers,
      } as any, testDshDir, 'copis')

      const settings = parseDocument(readFileSync(join(testDshDir, 'settings.yaml'), 'utf-8')).toJS()
      expect(Object.keys(settings['llm-pi-ai'].providers).sort()).toEqual([
        'copis-working',
        'copis-working-deepseek',
        'copis-working-zhipu',
      ])
      expect(settings['llm-pi-ai'].providers['copis-working'].apiKeyEnv).toBe('COPIS_DSH_WORKING_CAPABILITY')
      expect(settings['llm-pi-ai'].providers['copis-working-deepseek'].defaultContextWindow).toBe(990_000)
      expect(readFileSync(join(testDshDir, '.credentials.yaml'), 'utf-8')).not.toContain('dsh-capability-not-persisted')
    } finally {
      rmSync(testDshDir, { recursive: true, force: true })
    }
  })
})
