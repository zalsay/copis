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

const context = {
  roomId: 'room-1',
  agentId: 'agent-a',
  deviceId: 'device-1',
  clientMessageId: 'message-1',
}

function createClient(
  requests: RecordedRequest[],
  options: {
    token?: string | null
    response?: Response
    getInvocationContext?: (invocationId: string) => typeof context
  } = {},
) {
  return new HttpChatRoomRustApiClient({
    fetchImpl: async (input, init) => {
      requests.push({ input, init })
      return options.response ?? new Response(null, { status: 204 })
    },
    getToken: () => options.token === undefined ? 'internal-test' : options.token,
    getInvocationContext: options.getInvocationContext ?? (() => context),
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
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
      roomId: 'room-1', invocationId: 'inv-1', agentId: 'agent-a', deviceId: 'device-1',
    })
    expect(JSON.parse(String(requests[1]?.init?.body))).toEqual({
      roomId: 'room-1', invocationId: 'inv-1',
    })
    expect(JSON.parse(String(requests[2]?.init?.body))).toEqual({
      roomId: 'room-1', invocationId: 'inv-1', delta: '你好',
    })
    expect(JSON.parse(String(requests[3]?.init?.body))).toEqual({
      roomId: 'room-1', invocationId: 'inv-1', content: '完成',
      mentionAgentIds: [], attachmentIds: [], clientMessageId: 'message-1',
    })
    expect(JSON.parse(String(requests[4]?.init?.body))).toEqual({
      roomId: 'room-1', invocationId: 'inv-1', failureCode: 'internal_error', message: '失败',
    })
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

  test('Given delta 含 Rust 禁止控制字符 When 回传 Then 在 fetch 前拒绝且允许换行制表符', async () => {
    const requests: RecordedRequest[] = []
    const client = createClient(requests)

    await expect(client.reportDelta({ invocationId: 'inv-1', delta: '有效\u0001内容' }))
      .rejects.toThrow('delta 参数不正确')
    await client.reportDelta({ invocationId: 'inv-1', delta: '第一行\n\t第二行\r' })
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

  test('Given resolver 缺失、抛错或返回非法 context When 回传 Then 在 fetch 前 fail closed', async () => {
    const requests: RecordedRequest[] = []
    const missing = new HttpChatRoomRustApiClient({
      fetchImpl: async (input, init) => {
        requests.push({ input, init })
        return new Response(null, { status: 204 })
      },
      getToken: () => 'internal-test',
    })
    const throwing = createClient(requests, { getInvocationContext: () => { throw new Error('token=secret /Users/private') } })
    const invalid = createClient(requests, { getInvocationContext: () => ({ ...context, roomId: '../escape' }) })

    await expect(missing.reportAccepted({ invocationId: 'inv-1' })).rejects.toThrow('聊天室回传上下文不可用')
    await expect(throwing.reportRunning({ invocationId: 'inv-1' })).rejects.toThrow('聊天室回传上下文不可用')
    await expect(invalid.reportFailed({ invocationId: 'inv-1', code: 'internal_error', message: '失败' })).rejects.toThrow('聊天室回传上下文不可用')
    expect(requests).toHaveLength(0)
  })

  test('Given JS caller 伪造 room/device 字段 When 回传 Then 只能使用 resolver context 且 body 不含额外字段', async () => {
    const requests: RecordedRequest[] = []
    const client = createClient(requests)
    await client.reportAccepted({
      invocationId: 'inv-1',
      roomId: 'attacker-room',
      agentId: 'attacker-agent',
      deviceId: 'attacker-device',
    } as never)

    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
      roomId: 'room-1', invocationId: 'inv-1', agentId: 'agent-a', deviceId: 'device-1',
    })
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
      getInvocationContext: () => context,
    })

    await client.reportAccepted({ invocationId: 'inv-1' })
    await client.reportCompleted({ invocationId: 'inv-1', output: { text: '完成', mentionedAgentIds: ['agent-b'], attachmentIds: [] } })

    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
      invocationId: 'inv-1', roomId: 'room-1', agentId: 'agent-a', deviceId: 'device-1',
    })
    expect(JSON.parse(String(requests[1]?.init?.body))).toEqual({
      invocationId: 'inv-1', roomId: 'room-1',
      content: '完成', mentionAgentIds: ['agent-b'], attachmentIds: [], clientMessageId: 'message-1',
    })
  })

  test('Given Rust protocol 各字段达到边界 When 回传 Then 64 字节 ID 接受而超限在 fetch 前拒绝', async () => {
    const requests: RecordedRequest[] = []
    const id64 = 'a'.repeat(64)
    const id65 = 'a'.repeat(65)
    const device128 = 'd'.repeat(128)
    const clientMessage128 = 'm'.repeat(128)
    const boundaryContext = {
      roomId: id64,
      agentId: id64,
      deviceId: device128,
      clientMessageId: clientMessage128,
    }
    const client = createClient(requests, { getInvocationContext: () => boundaryContext })

    await client.reportAccepted({ invocationId: id64 })
    await client.reportCompleted({
      invocationId: id64,
      output: { text: '完成', mentionedAgentIds: [], attachmentIds: [id64] },
    })
    expect(requests).toHaveLength(2)

    const cases: Array<[
      string,
      () => Promise<void>,
    ]> = [
      ['roomId', () => new HttpChatRoomRustApiClient({
        fetchImpl: async (input, init) => {
          requests.push({ input, init })
          return new Response(null, { status: 204 })
        },
        getToken: () => 'internal-test',
        getInvocationContext: () => ({ ...boundaryContext, roomId: id65 }),
      }).reportAccepted({ invocationId: 'inv-1' })],
      ['agentId', () => new HttpChatRoomRustApiClient({
        fetchImpl: async (input, init) => {
          requests.push({ input, init })
          return new Response(null, { status: 204 })
        },
        getToken: () => 'internal-test',
        getInvocationContext: () => ({ ...boundaryContext, agentId: id65 }),
      }).reportAccepted({ invocationId: 'inv-1' })],
      ['deviceId', () => new HttpChatRoomRustApiClient({
        fetchImpl: async (input, init) => {
          requests.push({ input, init })
          return new Response(null, { status: 204 })
        },
        getToken: () => 'internal-test',
        getInvocationContext: () => ({ ...boundaryContext, deviceId: `${device128}d` }),
      }).reportAccepted({ invocationId: 'inv-1' })],
      ['clientMessageId', () => new HttpChatRoomRustApiClient({
        fetchImpl: async (input, init) => {
          requests.push({ input, init })
          return new Response(null, { status: 204 })
        },
        getToken: () => 'internal-test',
        getInvocationContext: () => ({ ...boundaryContext, clientMessageId: `${clientMessage128}m` }),
      }).reportCompleted({
        invocationId: 'inv-1',
        output: { text: '完成', mentionedAgentIds: [], attachmentIds: [] },
      })],
      ['invocationId', () => client.reportRunning({ invocationId: id65 })],
    ]
    for (const [field, attempt] of cases) {
      await expect(attempt()).rejects.toThrow(field === 'invocationId' ? 'invocationId 参数不正确' : '聊天室回传上下文不可用')
    }
    expect(requests).toHaveLength(2)
  })

  test('Given output ID 是多字节 UTF-8 When 达到 protocol 64 字节边界 Then 接受而 65 字节拒绝', async () => {
    const requests: RecordedRequest[] = []
    const client = createClient(requests)
    const id64Bytes = `${'你'.repeat(21)}a`
    const id65Bytes = `${id64Bytes}b`
    expect(Buffer.byteLength(id64Bytes, 'utf8')).toBe(64)
    expect(Buffer.byteLength(id65Bytes, 'utf8')).toBe(65)

    await client.reportCompleted({
      invocationId: 'inv-1',
      output: { text: '完成', mentionedAgentIds: [id64Bytes], attachmentIds: [] },
    })
    await expect(client.reportCompleted({
      invocationId: 'inv-1',
      output: { text: '完成', mentionedAgentIds: [id65Bytes], attachmentIds: [] },
    })).rejects.toThrow('聊天室输出参数不正确')
    await expect(client.reportCompleted({
      invocationId: 'inv-1',
      output: { text: '完成', mentionedAgentIds: [], attachmentIds: [id65Bytes] },
    })).rejects.toThrow('聊天室输出参数不正确')
    expect(requests).toHaveLength(1)
  })

  test('Given completed output 含未知字段或非法 mention/attachment ID When 回传 Then 在 fetch 前拒绝', async () => {
    const requests: RecordedRequest[] = []
    const client = createClient(requests)
    const validOutput = { text: '完成', mentionedAgentIds: [], attachmentIds: [] }

    await expect(client.reportCompleted({
      invocationId: 'inv-1',
      output: { ...validOutput, token: 'forged' } as never,
    })).rejects.toThrow('聊天室输出参数不正确')
    await expect(client.reportCompleted({
      invocationId: 'inv-1',
      output: { ...validOutput, mentionedAgentIds: ['agent/id'] },
    })).rejects.toThrow('聊天室输出参数不正确')
    await expect(client.reportCompleted({
      invocationId: 'inv-1',
      output: { ...validOutput, attachmentIds: ['attachment id'] },
    })).rejects.toThrow('聊天室输出参数不正确')
    expect(requests).toHaveLength(0)
  })

  test('Given completed text 在 Rust 64 KiB 边界 When 回传 Then 精确边界接受且超出一个字节前拒绝', async () => {
    const requests: RecordedRequest[] = []
    const client = createClient(requests)
    const asciiAtLimit = 'a'.repeat(64 * 1024)
    const unicodeAtLimit = `${'你'.repeat(21845)}a`
    expect(Buffer.byteLength(unicodeAtLimit, 'utf8')).toBe(64 * 1024)

    await client.reportCompleted({
      invocationId: 'inv-1',
      output: { text: asciiAtLimit, mentionedAgentIds: [], attachmentIds: [] },
    })
    await client.reportCompleted({
      invocationId: 'inv-1',
      output: { text: unicodeAtLimit, mentionedAgentIds: [], attachmentIds: [] },
    })
    await expect(client.reportCompleted({
      invocationId: 'inv-1',
      output: { text: `${asciiAtLimit}b`, mentionedAgentIds: [], attachmentIds: [] },
    })).rejects.toThrow('聊天室文本参数不正确')
    await expect(client.reportCompleted({
      invocationId: 'inv-1',
      output: { text: `${unicodeAtLimit}b`, mentionedAgentIds: [], attachmentIds: [] },
    })).rejects.toThrow('聊天室文本参数不正确')
    expect(requests).toHaveLength(2)
  })

  test('Given completed text 为空或包含 Rust 禁止控制字符 When 回传 Then 在 fetch 前拒绝', async () => {
    const requests: RecordedRequest[] = []
    const client = createClient(requests)

    await expect(client.reportCompleted({
      invocationId: 'inv-1',
      output: { text: ' \n\t ', mentionedAgentIds: [], attachmentIds: [] },
    })).rejects.toThrow('聊天室文本参数不正确')
    await expect(client.reportCompleted({
      invocationId: 'inv-1',
      output: { text: '有效\u0001文本', mentionedAgentIds: [], attachmentIds: [] },
    })).rejects.toThrow('聊天室文本参数不正确')
    expect(requests).toHaveLength(0)
  })

  test('Given failed report 使用未知 failureCode 或非法 message When 回传 Then 在 fetch 前拒绝', async () => {
    const requests: RecordedRequest[] = []
    const client = createClient(requests)
    const exactlyAtLimit = 'a'.repeat(64 * 1024)
    const unicodeAtLimit = `${'你'.repeat(21845)}a`
    expect(Buffer.byteLength(unicodeAtLimit, 'utf8')).toBe(64 * 1024)

    await expect(client.reportFailed({ invocationId: 'inv-1', code: 'not_a_failure_code' as never, message: '失败' }))
      .rejects.toThrow('failureCode 参数不正确')
    await expect(client.reportFailed({ invocationId: 'inv-1', code: 'internal_error', message: ' \n\t ' }))
      .rejects.toThrow('聊天室文本参数不正确')
    await expect(client.reportFailed({ invocationId: 'inv-1', code: 'internal_error', message: '失败\u0001原因' }))
      .rejects.toThrow('聊天室文本参数不正确')
    await client.reportFailed({ invocationId: 'inv-1', code: 'internal_error', message: exactlyAtLimit })
    await client.reportFailed({ invocationId: 'inv-1', code: 'internal_error', message: unicodeAtLimit })
    await expect(client.reportFailed({ invocationId: 'inv-1', code: 'internal_error', message: `${exactlyAtLimit}b` }))
      .rejects.toThrow('聊天室文本参数不正确')
    await expect(client.reportFailed({ invocationId: 'inv-1', code: 'internal_error', message: `${unicodeAtLimit}b` }))
      .rejects.toThrow('聊天室文本参数不正确')
    expect(requests).toHaveLength(2)
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

  test('Given 错误响应 UTF-8 字符被拆成多块 When 请求失败 Then 有界读取仍保留完整字符', async () => {
    const encoded = new TextEncoder().encode('错误：请重试')
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of encoded) controller.enqueue(new Uint8Array([byte]))
        controller.close()
      },
    })
    const client = createClient([], { response: new Response(stream, { status: 500 }) })

    await expect(client.reportAccepted({ invocationId: 'inv-1' })).rejects.toThrow('错误：请重试')
  })
})
