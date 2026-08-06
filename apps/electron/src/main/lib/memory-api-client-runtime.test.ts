import { afterEach, describe, expect, test } from 'bun:test'
import { createMemoryApiClient, resolveMemoryApiBaseUrl } from './memory-api-client-runtime'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('Bun Worker Memory API client', () => {
  test('不依赖 Electron，并按 Worker 注入的端口请求', async () => {
    expect(resolveMemoryApiBaseUrl({ configuredPort: '51741', isPackaged: false }))
      .toBe('http://127.0.0.1:51741')

    let requestedUrl = ''
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requestedUrl = String(input)
      return Response.json({ text: '', entries: [], generatedAt: 1 })
    }) as typeof fetch

    const client = createMemoryApiClient('http://127.0.0.1:51741')
    await client.context({ query: 'test' })
    expect(requestedUrl).toBe('http://127.0.0.1:51741/api/memory/context')
  })
})
