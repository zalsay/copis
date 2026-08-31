import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import * as os from 'node:os'
import { join } from 'node:path'

type FeishuConfigModule = typeof import('./feishu-config')
type ConfigPathsModule = typeof import('./config-paths')

let feishuConfig: FeishuConfigModule
let configPaths: ConfigPathsModule
let tempHome: string
const originalHome = process.env.HOME
const originalCopisDev = process.env.COPIS_DEV

mock.module('electron', () => ({
  app: {
    isPackaged: true,
    getPath: () => join(process.env.HOME ?? tempHome, 'Library', 'Application Support'),
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString('utf-8'),
  },
}))

mock.module('node:os', () => ({
  ...os,
  homedir: () => tempHome,
}))

beforeAll(async () => {
  tempHome = mkdtempSync(join(os.tmpdir(), 'copis-feishu-config-'))
  process.env.HOME = tempHome
  process.env.COPIS_DEV = '0'
  configPaths = await import('./config-paths')
  feishuConfig = await import('./feishu-config')
})

beforeEach(() => {
  rmSync(join(tempHome, '.copis'), { recursive: true, force: true })
  mkdirSync(join(tempHome, '.copis'), { recursive: true })
})

afterAll(() => {
  if (originalHome === undefined) {
    delete process.env.HOME
  } else {
    process.env.HOME = originalHome
  }
  if (originalCopisDev === undefined) {
    delete process.env.COPIS_DEV
  } else {
    process.env.COPIS_DEV = originalCopisDev
  }
  rmSync(tempHome, { recursive: true, force: true })
})

describe('飞书 Bot 配置', () => {
  test('Given 本地已有相同 App ID 的 Bot When 保存扫码结果 Then 更新原 Bot 而不是创建重复 Bot', () => {
    const first = feishuConfig.saveFeishuBotConfig({
      name: '原有智能体',
      enabled: true,
      appId: 'cli_existing-agent',
      appSecret: 'old-secret',
    })

    const updated = feishuConfig.saveFeishuBotConfig({
      name: '原有智能体（已绑定）',
      enabled: true,
      appId: ' cli_existing-agent ',
      appSecret: 'new-secret',
    })

    expect(updated.id).toBe(first.id)
    expect(feishuConfig.getFeishuMultiBotConfig().bots).toHaveLength(1)
    expect(feishuConfig.getFeishuBotById(first.id)?.name).toBe('原有智能体（已绑定）')
    expect(readFileSync(configPaths.getFeishuConfigPath(), 'utf8')).toContain('cli_existing-agent')
  })
})
