import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let configPath = ''
let settingsPath = ''
let settings: Record<string, unknown> = {}

mock.module('../config-paths', () => ({
  getChatToolsConfigPath: () => configPath,
  getSettingsPath: () => settingsPath,
}))
mock.module('../settings-service', () => ({
  getSettings: () => settings,
  updateSettings: () => settings,
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
  test('Nano Banana 开启且有凭据时标记为可用', () => {
    const server = catalog.listBuiltinMcpServers().find((item) => item.id === 'nano-banana')

    expect(server).toMatchObject({ enabled: true, available: true })
    expect(server?.name).toBe('nano_banana')
  })

  test('Nano Banana 未开启时保留目录项但标记为不可用', () => {
    settings = { builtinMcpEnabledIds: [], builtinMcpDisabledIds: [] }

    const server = catalog.listBuiltinMcpServers().find((item) => item.id === 'nano-banana')

    expect(server).toMatchObject({
      enabled: false,
      available: false,
      availabilityReason: '默认关闭，可手动开启',
    })
  })
})
