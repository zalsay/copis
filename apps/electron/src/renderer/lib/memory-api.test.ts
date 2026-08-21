import { afterEach, describe, expect, test } from 'bun:test'
import { installHttpApiBridge } from './http-api-bridge'
import { memoryApi } from './memory-api'

describe('浏览器模式 Memory API', () => {
  const originalFetch = globalThis.fetch
  const runtime = globalThis as typeof globalThis & { window?: Window & typeof globalThis }
  const originalWindow = runtime.window

  afterEach(() => {
    globalThis.fetch = originalFetch
    runtime.window = originalWindow
  })

  test('Given浏览器 bridge 已启用 When读取 Memory Then请求同源 /api 代理', async () => {
    const requestedUrls: string[] = []
    runtime.window = {} as Window & typeof globalThis
    globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
      requestedUrls.push(String(input))
      return Response.json({ entries: [], total: 0, limit: 50 })
    }) as unknown as typeof fetch

    installHttpApiBridge()
    await memoryApi.list({ workspaceSlug: 'default', limit: 50 })

    expect(requestedUrls).toEqual(['/api/memory?workspaceSlug=default&limit=50'])
  })
})
