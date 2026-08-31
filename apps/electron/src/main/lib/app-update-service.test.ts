import { afterEach, describe, expect, mock, test } from 'bun:test'

const fetchMock = mock(async (..._args: Parameters<typeof fetch>) => new Response('{}', { status: 200 }))

mock.module('electron', () => ({
  app: {
    isPackaged: true,
    getVersion: () => '0.0.68',
  },
}))

mock.module('./http-api-server', () => ({
  getHttpApiInternalToken: () => 'internal-token',
}))

const originalFetch = globalThis.fetch
globalThis.fetch = fetchMock as unknown as typeof fetch
const appUpdateService = await import('./app-update-service')

afterEach(() => {
  fetchMock.mockClear()
})

describe('主程序更新检查请求', () => {
  test('根据当前运行平台和架构请求对应更新条目', async () => {
    await appUpdateService.checkAppUpdateViaRustApi()

    const requestUrl = new URL(String(fetchMock.mock.calls[0]?.[0]))
    expect(requestUrl.searchParams.get('client_version')).toBe('0.0.68')
    expect(requestUrl.searchParams.get('platform')).toBe(process.platform)
    expect(requestUrl.searchParams.get('arch')).toBe(process.arch)
  })
})

afterEach(() => {
  globalThis.fetch = originalFetch
})
