import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { AppSettings } from '../../types'

const tempDir = mkdtempSync(join(tmpdir(), 'copis-working-model-catalog-'))
const catalogPath = join(tempDir, 'working-model-catalog.json')
let settings: AppSettings = { themeMode: 'dark' }

mock.module('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`cipher:${value}`),
    decryptString: (value: Buffer) => value.toString('utf8').replace(/^cipher:/, ''),
  },
}))

mock.module('./config-paths', () => ({
  getWorkingModelCatalogPath: () => catalogPath,
}))

mock.module('./settings-service', () => ({
  getSettings: () => settings,
  updateSettings: (updates: Partial<AppSettings>) => {
    settings = { ...settings, ...updates }
    return settings
  },
}))

const {
  getWorkingCustomModelRuntime,
  getWorkingModelCatalog,
  saveWorkingModelCatalog,
} = await import('./working-model-catalog')

function makeCatalog(modelId: string, apiKey: string) {
  return {
    categories: [{ id: 'writing', name: '写作' }],
    models: [{
      id: `model-${modelId}`,
      name: `模型 ${modelId}`,
      categoryId: 'writing',
      baseUrl: 'https://models.example.com/v1',
      modelId,
      protocol: 'openai-responses' as const,
      thinkingLevel: 'high' as const,
      apiKey,
    }],
  }
}

beforeEach(() => {
  settings = { themeMode: 'dark' }
  rmSync(catalogPath, { force: true })
})

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

describe('VIP 自定义模型账号分桶存储', () => {
  test('Given 两个 Working 账号 When 分别保存模型 Then 目录和密钥不会互相覆盖', () => {
    saveWorkingModelCatalog(makeCatalog('model-a', 'secret-a'), true, 'account-a')
    saveWorkingModelCatalog(makeCatalog('model-b', 'secret-b'), true, 'account-b')

    expect(getWorkingModelCatalog(true, 'account-a').models[0]?.modelId).toBe('model-a')
    expect(getWorkingModelCatalog(true, 'account-b').models[0]?.modelId).toBe('model-b')
    expect(getWorkingCustomModelRuntime('copis-custom-model-model-a', true, 'account-a').apiKey).toBe('secret-a')
    expect(getWorkingCustomModelRuntime('copis-custom-model-model-b', true, 'account-b').apiKey).toBe('secret-b')

    const persisted = readFileSync(catalogPath, 'utf8')
    expect(persisted).not.toContain('secret-a')
    expect(persisted).not.toContain('secret-b')
  })
})
