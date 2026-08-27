import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import * as os from 'node:os'
import { join } from 'node:path'
import { COPIS_WORKING_CHANNEL_ID, COPIS_WORKING_DEEPSEEK_CHANNEL_ID, COPIS_WORKING_ZHIPU_CHANNEL_ID } from '@copis/shared'

type ChannelManagerModule = typeof import('./channel-manager')

let channelManager: ChannelManagerModule
let tempHome: string
const originalHome = process.env.HOME
const originalCopisDev = process.env.COPIS_DEV

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
  shell: {
    openExternal: async () => undefined,
  },
}))

mock.module('node:os', () => ({
  ...os,
  homedir: () => tempHome,
}))

mock.module('./working-api-service', () => ({
  getWorkingApiClient: () => ({ baseUrl: 'http://127.0.0.1:9000' }),
}))

function channelsPath(): string {
  return join(tempHome, '.copis', 'channels.json')
}

function writeChannels(channels: unknown[]): void {
  mkdirSync(join(tempHome, '.copis'), { recursive: true })
  writeFileSync(channelsPath(), JSON.stringify({ version: 2, channels }, null, 2), 'utf-8')
}

beforeAll(async () => {
  tempHome = mkdtempSync(join(os.tmpdir(), 'copis-channel-manager-'))
  process.env.HOME = tempHome
  process.env.COPIS_DEV = '0'
  channelManager = await import('./channel-manager')
})

beforeEach(() => {
  rmSync(join(tempHome, '.copis'), { recursive: true, force: true })
})

afterAll(() => {
  if (originalHome === undefined) delete process.env.HOME
  else process.env.HOME = originalHome
  if (originalCopisDev === undefined) delete process.env.COPIS_DEV
  else process.env.COPIS_DEV = originalCopisDev
  rmSync(tempHome, { recursive: true, force: true })
})

describe('统一渠道列表', () => {
  test('Given 只有用户自定义渠道 When 调用 listChannels Then 返回三个内置渠道和用户渠道且不写入 DeepSeek 预设', () => {
    writeChannels([{
      id: 'custom-zhipu',
      name: '我的智谱渠道',
      provider: 'zhipu',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      apiKey: 'encrypted-key',
      models: [],
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    }])

    const channels = channelManager.listChannels()

    expect(channels.map((channel) => channel.id)).toEqual([
      COPIS_WORKING_CHANNEL_ID,
      COPIS_WORKING_DEEPSEEK_CHANNEL_ID,
      COPIS_WORKING_ZHIPU_CHANNEL_ID,
      'custom-zhipu',
    ])
    expect(channels.find((channel) => channel.id === 'custom-zhipu')?.models[0]?.id).toBe('glm-5.3-flash')
    expect(JSON.parse(readFileSync(channelsPath(), 'utf-8')).channels).toHaveLength(1)
    expect(JSON.parse(readFileSync(channelsPath(), 'utf-8')).channels[0].provider).toBe('zhipu')
  })

  test('Given 内置渠道 ID When 查询渠道 Then getChannelById 返回同一份内置渠道定义', () => {
    writeChannels([])

    expect(channelManager.getChannelById(COPIS_WORKING_ZHIPU_CHANNEL_ID)).toMatchObject({
      id: COPIS_WORKING_ZHIPU_CHANNEL_ID,
      name: 'Z.ai（智谱）',
      baseUrl: 'http://127.0.0.1:9000/api/internal/working-model/v1',
    })
    expect(existsSync(channelsPath())).toBe(true)
    expect(JSON.parse(readFileSync(channelsPath(), 'utf-8')).channels).toHaveLength(0)
  })

  test('Given 内置渠道 ID When 解析运行时凭据 Then 返回空凭据并保持配置文件为空', async () => {
    writeChannels([])

    await expect(channelManager.resolveChannelRuntimeApiKey(COPIS_WORKING_ZHIPU_CHANNEL_ID)).resolves.toBe('')
    expect(JSON.parse(readFileSync(channelsPath(), 'utf-8')).channels).toHaveLength(0)
  })
})
