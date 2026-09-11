import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let configPath = ''
let settingsPath = ''
let settings: Record<string, unknown> = {}

mock.module('electron', () => ({
  app: { isPackaged: false },
}))

mock.module('../config-paths', () => ({
  getChatToolsConfigPath: () => configPath,
  getSettingsPath: () => settingsPath,
}))
mock.module('../settings-service', () => ({
  getSettings: () => settings,
  updateSettings: () => settings,
}))
mock.module('../working-auth-store', () => ({
  getWorkingTokenStore: () => ({
    getToken: () => 'working-token',
    getUser: () => ({ id: 'working-user' }),
  }),
}))

type BuiltinMcpCatalogModule = typeof import('./catalog')
let catalog: BuiltinMcpCatalogModule
let tempDir = ''

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'copis-builtin-mcp-catalog-'))
  configPath = join(tempDir, 'chat-tools.json')
  settingsPath = join(tempDir, 'settings.json')
  catalog = await import('./catalog')
})

beforeEach(() => {
  settings = { builtinMcpEnabledIds: ['nano-banana'], builtinMcpDisabledIds: [] }
  writeFileSync(configPath, JSON.stringify({
    toolStates: { 'nano-banana': { enabled: true } },
    toolCredentials: { 'nano-banana': { apiKey: 'gemini-key' } },
    customTools: [],
  }), 'utf-8')
})

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

describe('内置 MCP Agent 能力目录', () => {
  test('Copis 图片生成 已从内置 MCP 列表中移除', () => {
    const server = catalog.listBuiltinMcpServers().find((item) => item.id === 'nano-banana')
    expect(server).toBeUndefined()
  })

  test('定时任务内置 MCP 默认启用且可用', () => {
    const server = catalog.listBuiltinMcpServers().find((item) => item.id === 'automation')
    expect(server).toMatchObject({ enabled: true, available: true })
    expect(server?.name).toBe('automation')
  })

  test('协作子 Agent 在未指定工作区时提示需要先选择项目', () => {
    const withoutWorkspace = catalog.listBuiltinMcpServers().find((item) => item.id === 'collaboration')
    expect(withoutWorkspace).toMatchObject({
      enabled: true,
      available: false,
      availabilityReason: '需要先选择项目',
    })

    const withWorkspace = catalog.listBuiltinMcpServers({ workspaceSlug: 'demo' }).find((item) => item.id === 'collaboration')
    expect(withWorkspace).toMatchObject({
      enabled: true,
      available: true,
    })
  })
})
