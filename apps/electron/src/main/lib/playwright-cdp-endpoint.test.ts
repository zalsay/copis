import { describe, expect, mock, test } from 'bun:test'

const appendSwitch = mock(() => undefined)

mock.module('electron', () => ({
  app: {
    commandLine: { appendSwitch },
    getPath: () => '/tmp/copis-cdp-test',
  },
}))

const { configurePlaywrightCdpEndpoint, getPlaywrightCdpEndpoint } = await import('./playwright-cdp-endpoint')

describe('主进程 Playwright CDP endpoint', () => {
  test('在 ready 前配置临时端口并从 DevToolsActivePort 读取地址', async () => {
    configurePlaywrightCdpEndpoint()

    expect(appendSwitch).toHaveBeenCalledWith('remote-debugging-address', '127.0.0.1')
    expect(appendSwitch).toHaveBeenCalledWith('remote-debugging-port', '0')
    await expect(getPlaywrightCdpEndpoint({
      userDataPath: '/tmp/copis-cdp-test',
      readFileImpl: async () => '43123\n/devtools/browser/test',
    })).resolves.toBe('http://127.0.0.1:43123')
  })

  test('忽略非法端口并在有界重试后失败', async () => {
    await expect(getPlaywrightCdpEndpoint({
      userDataPath: '/tmp/copis-cdp-invalid',
      timeoutMs: 5,
      retryIntervalMs: 1,
      readFileImpl: async () => '0\n',
    })).rejects.toThrow('CDP endpoint')
  })
})
