import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'

mock.module('electron', () => ({
  app: { isPackaged: false },
}))

let memoryApiClient: typeof import('./memory-api-client').memoryApiClient
let MemoryApiClientError: typeof import('./memory-api-client').MemoryApiClientError

beforeAll(async () => {
  ({ memoryApiClient, MemoryApiClientError } = await import('./memory-api-client'))
})

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('Memory API client 边界', () => {
  test('Given workspaceSlug 含特殊字符 When请求 context Then使用 JSON body 且不拼接 SQL/path', async () => {
    let requestUrl = ''
    let requestBody: unknown
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requestUrl = String(input)
      requestBody = JSON.parse(String(init?.body)) as unknown
      return Response.json({ text: '', entries: [], generatedAt: 1 })
    }) as unknown as typeof fetch

    await memoryApiClient.context({ workspaceSlug: 'project/a', query: '中文 偏好', maxChars: 6000 })

    expect(requestUrl).toContain('/api/memory/context')
    expect(requestUrl).not.toContain('project/a')
    expect(requestBody).toEqual({ workspaceSlug: 'project/a', query: '中文 偏好', maxChars: 6000 })
  })

  test('Given API 返回 409 current When调用 rewrite Then保留结构化错误和当前 revision', async () => {
    globalThis.fetch = (async () => Response.json({
      error: '记忆 revision 冲突',
      code: 'memory_conflict',
      current: { id: 'memory-1', revision: 3, content: '服务端内容' },
    }, { status: 409 })) as unknown as typeof fetch

    let caught: unknown
    try {
      await memoryApiClient.rewrite('memory-1', {
        workspaceSlug: 'project-a',
        content: '本地内容',
        expectedRevision: 2,
      })
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(MemoryApiClientError)
    expect(caught).toMatchObject({ status: 409, code: 'memory_conflict', current: { revision: 3 } })
  })

  test('Given fetch 失败 When调用 context Then映射为 memory_service_unavailable', async () => {
    globalThis.fetch = (async () => { throw new Error('connection refused') }) as unknown as typeof fetch

    await expect(memoryApiClient.context({ query: 'test' })).rejects.toMatchObject({
      status: 503,
      code: 'memory_service_unavailable',
    })
  })
})
