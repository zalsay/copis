import { describe, expect, mock, test } from 'bun:test'
import { FileApiClient, FileApiError } from './file-api-client'

function withFetchProperties<T extends (...args: never[]) => Promise<Response>>(fetchMock: T): T & Pick<typeof fetch, 'preconnect'> {
  return Object.assign(fetchMock, { preconnect: fetch.preconnect })
}

describe('FileApiClient', () => {
  test('Given 文本读取 When 调用 Then 使用 JSON body 而不把路径放进 URL', async () => {
    const fetchMock = mock(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('http://127.0.0.1:4321/api/files/read-text')
      expect(init?.method).toBe('POST')
      expect(JSON.parse(String(init?.body))).toEqual({ path: '/workspace/notes.md', sessionId: 'session-1' })
      return new Response(JSON.stringify({ resolvedPath: '/workspace/notes.md', content: '# 计划', revision: 'v1' }), { status: 200 })
    })
    const client = new FileApiClient(withFetchProperties(fetchMock))
    client.setBaseUrl('http://127.0.0.1:4321/')

    await expect(client.readText({ path: '/workspace/notes.md', sessionId: 'session-1' })).resolves.toEqual({
      resolvedPath: '/workspace/notes.md',
      content: '# 计划',
      revision: 'v1',
    })
  })

  test('Given 写入 revision 冲突 When 调用 Then 保留 409 与 write_conflict', async () => {
    const fetchMock = mock(async () => new Response(
      JSON.stringify({ error: '文件已被外部修改', code: 'write_conflict' }),
      { status: 409 },
    ))
    const client = new FileApiClient(withFetchProperties(fetchMock))

    try {
      await client.writeText({ path: '/workspace/notes.md', content: '新内容', expectedRevision: 'old' })
      throw new Error('expected write_conflict')
    } catch (error) {
      expect(error).toBeInstanceOf(FileApiError)
      expect((error as FileApiError).status).toBe(409)
      expect((error as FileApiError).code).toBe('write_conflict')
    }
  })

  test('Given 非 JSON 错误响应 When 调用 Then 返回稳定的 API 错误', async () => {
    const fetchMock = mock(async () => new Response('Service unavailable', { status: 503 }))
    const client = new FileApiClient(withFetchProperties(fetchMock))

    await expect(client.readText({ path: '/workspace/notes.md' })).rejects.toMatchObject({
      status: 503,
      code: 'internal_error',
    })
  })
})
