import { describe, expect, test } from 'bun:test'
import { createRustBashToolOperations, createRustFileToolOperations } from './pi-rust-file-tools'

function response(body: unknown, status = 200): Response {
  return new Response(body === undefined ? undefined : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('Pi Rust 文件工具桥接', () => {
  test('Given Pi 调用读写操作 When 发送到 Rust Then 请求只包含会话和文件操作数据', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    const operations = createRustFileToolOperations({
      sessionId: 'session-1',
      baseUrl: 'http://127.0.0.1:51730',
      fileToken: 'test-token',
      fetchImpl: async (url, init) => {
        requests.push({ url: String(url), init })
        const target = new URL(String(url)).pathname
        if (target.endsWith('/read')) {
          return response({ contentBase64: Buffer.from('原内容').toString('base64'), revision: 'r1' })
        }
        if (target.endsWith('/write')) return response({ revision: 'r2' })
        return response(undefined, 204)
      },
    })

    await operations.edit.access('/workspace/note.md')
    const content = await operations.edit.readFile('/workspace/note.md')
    await operations.edit.writeFile('/workspace/note.md', `${content.toString('utf8')}\n更新`)

    expect(content.toString('utf8')).toBe('原内容')
    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      '/api/internal/agent/files/access',
      '/api/internal/agent/files/read',
      '/api/internal/agent/files/write',
    ])
    const writeBody = JSON.parse(String(requests[2]?.init?.body)) as Record<string, unknown>
    expect(writeBody).toEqual({
      sessionId: 'session-1',
      path: '/workspace/note.md',
      content: '原内容\n更新',
      expectedRevision: 'r1',
    })
    expect((requests[2]?.init?.headers as Record<string, string>)['x-copis-agent-file-token']).toBe('test-token')
    expect(writeBody).not.toHaveProperty('readRoots')
    expect(writeBody).not.toHaveProperty('writeRoots')
  })

  test('Given Rust 拒绝越界路径 When Pi 执行操作 Then 直接返回拒绝错误', async () => {
    const operations = createRustFileToolOperations({
      sessionId: 'session-1',
      fileToken: 'test-token',
      fetchImpl: async () => response({ error: '路径超出授权范围', code: 'path_not_allowed' }, 403),
    })

    await expect(operations.read.access('/outside/secret.txt')).rejects.toThrow('path_not_allowed')
  })

  test('Given Pi 执行项目构建命令 When 转发到 Rust Then 使用会话能力令牌与受控工作目录', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    const operations = createRustBashToolOperations({
      sessionId: 'session-1',
      baseUrl: 'http://127.0.0.1:51730',
      fileToken: 'test-token',
      fetchImpl: async (url, init) => {
        requests.push({ url: String(url), init })
        return response({ output: 'build complete\n', outputTruncated: false, exitCode: 0, timedOut: false })
      },
    })
    const output: Buffer[] = []

    const result = await operations.exec('npm run build', '/workspace/project', {
      onData: (data) => output.push(data),
      timeout: 30,
    })

    expect(result).toEqual({ exitCode: 0 })
    expect(Buffer.concat(output).toString('utf8')).toBe('build complete\n')
    expect(new URL(requests[0]!.url).pathname).toBe('/api/internal/agent/shell')
    expect(JSON.parse(String(requests[0]!.init?.body))).toEqual({
      sessionId: 'session-1', command: 'npm run build', cwd: '/workspace/project', timeoutMs: 30_000,
    })
    expect((requests[0]!.init?.headers as Record<string, string>)['x-copis-agent-file-token']).toBe('test-token')
  })
})
