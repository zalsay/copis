import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentToolMeta } from '@copis/shared'

let configPath = ''
mock.module('electron', () => ({
  app: { isPackaged: true, getPath: () => '/tmp/copis-agent-tool-config-test' },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString('utf8'),
  },
}))
mock.module('./config-paths', () => ({
  getChatToolsConfigPath: () => configPath,
  getWorkingAuthPath: () => join(tempDir, 'working-auth.json'),
}))
mock.module('./attachment-service', () => ({
  saveAttachment: () => ({ id: 'attachment', localPath: 'attachment' }),
  readAttachmentAsBase64: () => '',
  isImageAttachment: () => false,
}))
mock.module('./working-auth-store', () => ({
  getWorkingTokenStore: () => ({
    getToken: () => 'working-token',
    getUser: () => ({ id: 'working-user' }),
  }),
}))

type AgentToolConfigModule = typeof import('./agent-tool-config')
type AgentToolRegistryModule = typeof import('./agent-tool-registry')

let config: AgentToolConfigModule
let registry: AgentToolRegistryModule
let tempDir = ''

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'copis-agent-tool-config-'))
  configPath = join(tempDir, 'chat-tools.json')
  config = await import('./agent-tool-config')
  registry = await import('./agent-tool-registry')
})

beforeEach(() => {
  rmSync(configPath, { force: true })
})

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

describe('Agent 工具配置', () => {
  test('读取并写回 chat-tools.json 时保留开关、凭据和自定义 HTTP 工具', () => {
    const customTool: AgentToolMeta = {
      id: 'weather-http',
      name: '天气查询',
      description: '读取天气信息',
      params: [{ name: 'city', type: 'string', description: '城市', required: true }],
      category: 'custom',
      executorType: 'http',
      httpConfig: {
        urlTemplate: 'https://example.test/weather?city={{city}}',
        method: 'GET',
      },
    }
    writeFileSync(configPath, JSON.stringify({
      toolStates: { 'web-search': { enabled: true } },
      toolCredentials: { 'web-search': { apiKey: 'tavily-key' } },
      customTools: [customTool],
    }), 'utf-8')

    expect(config.getAgentToolsConfig()).toMatchObject({
      toolStates: { 'web-search': { enabled: true } },
      toolCredentials: { 'web-search': { apiKey: 'tavily-key' } },
      customTools: [customTool],
    })

    config.updateAgentToolState('web-search', { enabled: false })
    config.updateAgentToolCredentials('nano-banana', { apiKey: 'gemini-key' })
    config.addCustomAgentTool(customTool)

    expect(existsSync(configPath)).toBe(true)
    expect(JSON.parse(readFileSync(configPath, 'utf-8'))).toMatchObject({
      toolStates: {
        'web-search': { enabled: false },
        'nano-banana': { enabled: false },
        'weather-http': { enabled: false },
      },
      toolCredentials: {
        'web-search': { apiKey: 'tavily-key' },
        'nano-banana': { apiKey: 'gemini-key' },
      },
      customTools: [customTool],
    })
    expect(config.getAgentToolCredentials('nano-banana')).toEqual({ apiKey: 'gemini-key' })
  })

  test('凭据存在时注册表报告 web-search 和 Copis 图片生成可用', () => {
    config.updateAgentToolCredentials('web-search', { apiKey: 'tavily-key' })
    config.updateAgentToolCredentials('nano-banana', { apiKey: 'gemini-key' })

    const tools = registry.getAllAgentToolInfos()
    expect(tools.find((tool) => tool.meta.id === 'web-search')).toMatchObject({ available: true })
    expect(tools.find((tool) => tool.meta.id === 'nano-banana')).toMatchObject({ available: true })
  })
})
