import { describe, expect, mock, test } from 'bun:test'

mock.module('electron', () => ({
  app: {
    isPackaged: true,
    getPath: () => '/tmp',
  },
  BrowserWindow: class {},
  BaseWindow: class {},
  WebContentsView: class {},
  clipboard: {},
  dialog: {},
  nativeImage: { createFromPath: () => ({}) },
  nativeTheme: {},
  powerMonitor: {},
  powerSaveBlocker: {},
  screen: {},
  shell: {},
  ipcMain: { handle: () => {} },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString('utf-8'),
  },
}))

describe('钉钉 OAuth 凭证换取服务', () => {
  test('Given 未配置 Client ID When 换取凭证 Then 返回友好的未配置错误', async () => {
    const { exchangeDingTalkAuthCode } = await import('./dingtalk-oauth-service')
    const result = await exchangeDingTalkAuthCode({
      authCode: 'mock-code',
      clientId: '',
      clientSecret: '',
    })

    expect(result.success).toBe(false)
    expect(result.message).toContain('未配置钉钉 Client ID')
  })

  test('Given 缺少 Client Secret When 换取凭证 Then 返回友好的 Secret 缺失错误', async () => {
    const { exchangeDingTalkAuthCode } = await import('./dingtalk-oauth-service')
    const result = await exchangeDingTalkAuthCode({
      authCode: 'mock-code',
      clientId: 'ding-mock-id',
      clientSecret: '',
    })

    expect(result.success).toBe(false)
    expect(result.message).toContain('未配置钉钉 Client Secret')
  })
})
