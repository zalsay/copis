import { describe, expect, mock, test } from 'bun:test'

mock.module('electron', () => ({
  app: { isPackaged: true, getPath: () => '/tmp/copis-test-app-data' },
  BrowserWindow: class {},
  WebContentsView: class {},
  clipboard: {},
  dialog: {},
  nativeImage: { createFromPath: () => ({}) },
  nativeTheme: {},
  powerMonitor: {},
  powerSaveBlocker: {},
  screen: {},
  shell: { openExternal: async () => {} },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString('utf8'),
  },
}))

const { HttpChatRoomRustApiClient } = await import('./chatroom-rust-client')

type RecordedRequest = { input: RequestInfo | URL; init?: RequestInit }

function createClient(
  requests: RecordedRequest[],
  options: { token?: string | null; response?: Response } = {},
) {
  return new HttpChatRoomRustApiClient({
    fetchImpl: async (input, init) => {
      requests.push({ input, init })
      return options.response ?? new Response(null, { status: 204 })
    },
    getToken: () => options.token === undefined ? 'internal-test' : options.token,
  })
}

describe('HttpChatRoomRustApiClient', () => {
  test('Given 五个状态回传 When 请求 Rust Then 只访问 loopback 冻结路径并携带 internal token', async () => {
    const requests: RecordedRequest[] = []
    const client = createClient(requests)

    await client.reportAccepted({ invocationId: 'inv-1' })
    await client.reportRunning({ invocationId: 'inv-1' })
    await client.reportDelta({ invocationId: 'inv-1', delta: '你好' })
    await client.reportCompleted({
      invocationId: 'inv-1',
      output: { text: '完成', mentionedAgentIds: [], attachmentIds: [] },
    })
    await client.reportFailed({ invocationId: 'inv-1', code: 'internal_error', message: '失败' })

    expect(requests.map((request) => String(request.input))).toEqual([
      'http://127.0.0.1:51730/api/internal/chatrooms/invocations/inv-1/accepted',
      'http://127.0.0.1:51730/api/internal/chatrooms/invocations/inv-1/running',
      'http://127.0.0.1:51730/api/internal/chatrooms/invocations/inv-1/delta',
      'http://127.0.0.1:51730/api/internal/chatrooms/invocations/inv-1/completed',
      'http://127.0.0.1:51730/api/internal/chatrooms/invocations/inv-1/failed',
    ])
    for (const request of requests) {
      expect(request.init?.method).toBe('POST')
      expect(request.init?.headers).toEqual(expect.objectContaining({
        Accept: 'application/json',
        'X-Copis-Internal-Token': 'internal-test',
        'Content-Type': 'application/json',
      }))
      const serialized = JSON.stringify(request.init?.body ?? '')
      expect(serialized).not.toContain('working-jwt')
      expect(serialized).not.toContain('public-token')
    }
  })

  test('Given invocationId 不符合路径组件 When 回传 Then 在 fetch 前拒绝', async () => {
    const requests: RecordedRequest[] = []
    const client = createClient(requests)

    await expect(client.reportRunning({ invocationId: 'inv/escape' })).rejects.toThrow('invocationId 参数不正确')
    await expect(client.reportFailed({ invocationId: '', code: 'internal_error', message: 'x' })).rejects.toThrow('invocationId 参数不正确')
    expect(requests).toHaveLength(0)
  })

  test('Given delta UTF-8 恰好 16 KiB When 回传 Then 接受；超出一个字节时在 fetch 前拒绝', async () => {
    const requests: RecordedRequest[] = []
    const client = createClient(requests)
    const exactlyAtLimit = `${'你'.repeat(5461)}a`
    expect(Buffer.byteLength(exactlyAtLimit, 'utf8')).toBe(16 * 1024)

    await client.reportDelta({ invocationId: 'inv-1', delta: exactlyAtLimit })
    await expect(client.reportDelta({ invocationId: 'inv-1', delta: `${exactlyAtLimit}b` })).rejects.toThrow('delta 参数过大')
    expect(requests).toHaveLength(1)
  })

  test('Given internal token 为空或全空白 When 请求 Rust Then 在 fetch 前拒绝', async () => {
    const requests: RecordedRequest[] = []
    const empty = createClient(requests, { token: '' })
    const blank = createClient(requests, { token: ' \t\n' })

    await expect(empty.reportAccepted({ invocationId: 'inv-1' })).rejects.toThrow('Rust HTTP API 尚未启动')
    await expect(blank.reportAccepted({ invocationId: 'inv-1' })).rejects.toThrow('Rust HTTP API 尚未启动')
    expect(requests).toHaveLength(0)
  })

  test('Given 非 loopback baseUrl When 创建客户端 Then 立即拒绝外部或 localhost 地址', () => {
    expect(() => new HttpChatRoomRustApiClient({ baseUrl: 'http://localhost:51730' })).toThrow('Rust HTTP API 必须使用 loopback 地址')
    expect(() => new HttpChatRoomRustApiClient({ baseUrl: 'https://evil.example.test:51730' })).toThrow('Rust HTTP API 必须使用 loopback 地址')
    expect(() => new HttpChatRoomRustApiClient({ baseUrl: 'http://127.0.0.1:51730/internal' })).toThrow('Rust HTTP API 必须使用 loopback 地址')
  })

  test('Given Main 提供 invocation 上下文 When 完成回传 Then 严格映射 Rust 所需字段', async () => {
    const requests: RecordedRequest[] = []
    const client = new HttpChatRoomRustApiClient({
      fetchImpl: async (input, init) => {
        requests.push({ input, init })
        return new Response(null, { status: 204 })
      },
      getToken: () => 'internal-test',
      getInvocationContext: () => ({ roomId: 'room-1', agentId: 'agent-a', deviceId: 'device-1', clientMessageId: 'message-1' }),
    })

    await client.reportAccepted({ invocationId: 'inv-1' })
    await client.reportCompleted({ invocationId: 'inv-1', output: { text: '完成', mentionedAgentIds: ['agent-b'], attachmentIds: [] } })

    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
      invocationId: 'inv-1', roomId: 'room-1', agentId: 'agent-a', deviceId: 'device-1',
    })
    expect(JSON.parse(String(requests[1]?.init?.body))).toEqual({
      invocationId: 'inv-1', roomId: 'room-1', agentId: 'agent-a', deviceId: 'device-1',
      content: '完成', mentionAgentIds: ['agent-b'], attachmentIds: [], clientMessageId: 'message-1',
    })
  })

  test('Given Rust 返回超大敏感错误 When 请求失败 Then 只读取有限内容并先脱敏再抛出', async () => {
    const secret = 'internal-test-secret'
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`token=${secret}&path=/Users/private/secret.txt ${'x'.repeat(20_000)}`))
        controller.close()
      },
    })
    const requests: RecordedRequest[] = []
    const client = createClient(requests, {
      token: secret,
      response: new Response(stream, { status: 500 }),
    })

    let error: unknown
    try {
      await client.reportAccepted({ invocationId: 'inv-1' })
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).not.toContain(secret)
    expect((error as Error).message).not.toContain('/Users/private/secret.txt')
    expect((error as Error).message.length).toBeLessThan(700)
    if (!(error instanceof Error)) {
      throw new Error('预期客户端抛出 Error')
    }
  })
})
