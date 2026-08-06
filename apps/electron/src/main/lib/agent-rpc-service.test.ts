import { describe, expect, mock, test } from 'bun:test'

mock.module('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => '/tmp/copis-agent-rpc-test',
  },
  BrowserWindow: class {},
  clipboard: {},
  dialog: {},
  nativeImage: { createFromPath: () => ({}) },
  nativeTheme: {},
  powerMonitor: {},
  powerSaveBlocker: {},
  shell: { openExternal: async () => {} },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString('utf8'),
  },
}))

const { parseAgentRpcInput } = await import('./agent-rpc-service')

describe('Agent RPC mention 参数', () => {
  test('Given HTTP 请求包含 Skill mention When解析 Then保留原始 slug 并去重', () => {
    const input = parseAgentRpcInput({
      sessionId: 'session-1',
      userMessage: '生成周报',
      mentionedSkills: [' automation ', 'automation', '', 42],
      mentionedMcpServers: ['planning'],
    })

    expect(input.mentionedSkills).toEqual(['automation'])
    expect(input.mentionedMcpServers).toEqual(['planning'])
  })
})
