import { expect, mock, test } from 'bun:test'

mock.module('electron', () => ({
  app: { isPackaged: true, getPath: () => '/tmp/copis-test-app-data' },
  BrowserWindow: class {}, WebContentsView: class {}, clipboard: {}, dialog: {},
  nativeImage: { createFromPath: () => ({}) }, nativeTheme: {}, powerMonitor: {}, powerSaveBlocker: {},
  screen: {}, shell: { openExternal: async () => {} },
  safeStorage: { isEncryptionAvailable: () => false, encryptString: (value: string) => Buffer.from(value), decryptString: (value: Buffer) => value.toString('utf8') },
}))
mock.module('./http-api-server', () => ({ HTTP_API_HOST: '127.0.0.1', HTTP_API_PORT: 51730, getHttpApiInternalToken: () => 'internal-test' }))

const { ChatRoomManagementClient } = await import('./chatroom-management-client')
const { ChatRoomReadinessError } = await import('./chatroom-readiness-coordinator')

test('已有房间的内部就绪查询只向 loopback 发送 GET 和内部令牌', async () => {
  const paths: string[] = []
  const client = new ChatRoomManagementClient({ baseUrl: 'http://127.0.0.1:51730', getToken: () => 'internal-test', fetchImpl: async (url, init) => {
    paths.push(`${init?.method}:${new URL(String(url)).pathname}`)
    expect(new Headers(init?.headers).get('x-copis-internal-token')).toBe('internal-test')
    return Response.json({ ready: true, epoch: 5, capabilityState: 'ready', mode: 'modern', socketGeneration: 7, snapshotReady: true, selectedCapabilities: ['agent-ready-v1'] })
  } })
  expect(await client.getRoomRealtimeStatus('room-1')).toEqual({ ready: true, epoch: 5, capabilityState: 'ready', mode: 'modern', socketGeneration: 7, snapshotReady: true, selectedCapabilities: ['agent-ready-v1'] })
  expect(paths).toEqual(['GET:/api/internal/chatrooms/rooms/room-1/status'])
})

test('Given active room detail contains public agents When reading the mention roster Then only validated enabled identity pairs are projected', async () => {
  const paths: string[] = []
  const client = new ChatRoomManagementClient({ baseUrl: 'http://127.0.0.1:51730', getToken: () => 'internal-test', fetchImpl: async (url, init) => {
    paths.push(`${init?.method}:${new URL(String(url)).pathname}`)
    expect(new Headers(init?.headers).get('x-copis-internal-token')).toBe('internal-test')
    expect(init?.signal).toBeInstanceOf(AbortSignal)
    return Response.json({ data: {
      room: { roomId: 'room-1', hostUserId: 7, status: 'active', privateRoomExtra: 'must be ignored' },
      members: [],
      agents: [
        { roomAgentId: 'agent-online', roomId: 'room-1', displayName: '在线 Agent', status: 'online', ownerUserId: 12, avatar: 'private-avatar', availability: 'unavailable', memoryShared: true },
        { roomAgentId: 'agent-disabled', roomId: 'room-1', displayName: 'Disabled', status: 'disabled', sourceWorkspaceId: 'private-workspace' },
        { roomAgentId: 'agent-offline', roomId: 'room-1', displayName: '离线 Agent', status: 'offline', channelId: 'private-channel', skillsShared: true },
      ],
    } })
  } })
  const signal = new AbortController().signal
  const getRoster = (client as unknown as {
    getRoomAgentRoster: (roomId: string, options?: { signal?: AbortSignal }) => Promise<unknown>
  }).getRoomAgentRoster

  expect(typeof getRoster).toBe('function')
  const roster = await getRoster.call(client, 'room-1', { signal })

  expect(roster).toEqual({
    roomId: 'room-1',
    hostUserId: '7',
    agents: [
      { roomAgentId: 'agent-online', displayName: '在线 Agent' },
      { roomAgentId: 'agent-offline', displayName: '离线 Agent' },
    ],
  })
  expect(paths).toEqual(['GET:/api/chatrooms/v2/rooms/room-1'])
})

test('Given online, busy, and offline peers are all present When reading the roster Then readiness status does not remove public identities', async () => {
  const client = new ChatRoomManagementClient({
    baseUrl: 'http://127.0.0.1:51730',
    getToken: () => 'internal-test',
    fetchImpl: async () => Response.json({ data: {
      room: { roomId: 'room-1', hostUserId: 'user-1', status: 'active' },
      members: [],
      agents: [
        { roomAgentId: 'agent-online', roomId: 'room-1', displayName: 'Online', status: 'online' },
        { roomAgentId: 'agent-busy', roomId: 'room-1', displayName: 'Busy', status: 'busy' },
        { roomAgentId: 'agent-offline', roomId: 'room-1', displayName: 'Offline', status: 'offline' },
      ],
    } }),
  })
  const getRoster = (client as unknown as {
    getRoomAgentRoster: (roomId: string) => Promise<unknown>
  }).getRoomAgentRoster

  expect(await getRoster.call(client, 'room-1')).toEqual({
    roomId: 'room-1',
    hostUserId: 'user-1',
    agents: [
      { roomAgentId: 'agent-online', displayName: 'Online' },
      { roomAgentId: 'agent-busy', displayName: 'Busy' },
      { roomAgentId: 'agent-offline', displayName: 'Offline' },
    ],
  })
})

test('Given room detail roster is incomplete, duplicated, cross-room, oversized, or invalid When reading it Then reject instead of truncating or guessing', async () => {
  const invalidDetails = [
    { room: { roomId: 'room-1', hostUserId: 7, status: 'active' } },
    { room: { roomId: 'room-1', hostUserId: 7, status: 'archived' }, agents: [] },
    { room: { roomId: 'room-1', hostUserId: 7, status: 'active' }, agents: Array.from({ length: 4 }, (_, index) => ({ roomAgentId: `agent-${index}`, roomId: 'room-1', displayName: `Agent ${index}`, status: 'online' })) },
    { room: { roomId: 'room-1', hostUserId: 7, status: 'active' }, agents: [
      { roomAgentId: 'agent-1', roomId: 'room-1', displayName: 'One', status: 'online' },
      { roomAgentId: 'agent-1', roomId: 'room-1', displayName: 'Duplicate', status: 'busy' },
    ] },
    { room: { roomId: 'room-1', hostUserId: 7, status: 'active' }, agents: [
      { roomAgentId: 'agent-1', roomId: 'room-2', displayName: 'Foreign', status: 'online' },
    ] },
    { room: { roomId: 'room-1', hostUserId: 7, status: 'active' }, agents: [
      { roomAgentId: 'agent-1', roomId: 'room-1', displayName: 'Bad\nName', status: 'online' },
    ] },
    { room: { roomId: 'room-1', hostUserId: 7, status: 'active' }, agents: [
      { roomAgentId: 'agent-1', roomId: 'room-1', displayName: 'Agent', status: 'unknown' },
    ] },
  ]

  for (const detail of invalidDetails) {
    const client = new ChatRoomManagementClient({
      baseUrl: 'http://127.0.0.1:51730',
      getToken: () => 'internal-test',
      fetchImpl: async () => Response.json({ data: detail }),
    })
    const getRoster = (client as unknown as {
      getRoomAgentRoster: (roomId: string) => Promise<unknown>
    }).getRoomAgentRoster

    expect(typeof getRoster).toBe('function')
    await expect(getRoster.call(client, 'room-1')).rejects.toThrow()
  }
})

test('网关状态响应缺失 ready 时禁止作为已连接凭据', async () => {
  const client = new ChatRoomManagementClient({ baseUrl: 'http://127.0.0.1:51730', getToken: () => 'internal-test', fetchImpl: async () => Response.json({}) })
  await expect(client.getRoomRealtimeStatus('room-1')).rejects.toThrow('网关状态')
})

test('网关状态没有连接版本时不得证明 Agent 可以注册', async () => {
  const client = new ChatRoomManagementClient({ baseUrl: 'http://127.0.0.1:51730', getToken: () => 'internal-test', fetchImpl: async () => Response.json({ ready: true }) })
  await expect(client.getRoomRealtimeStatus('room-1')).rejects.toThrow('网关状态')
})

test('旧 Gateway 的 ready/epoch 响应被明确隔离为 legacy，而不猜测现代能力', async () => {
  const client = new ChatRoomManagementClient({ baseUrl: 'http://127.0.0.1:51730', getToken: () => 'internal-test', fetchImpl: async () => Response.json({ ready: true, epoch: 5 }) })
  expect(await client.getRoomRealtimeStatus('room-1')).toEqual({ ready: true, epoch: 5, capabilityState: 'legacy', mode: 'legacy', socketGeneration: 0, snapshotReady: true, selectedCapabilities: [] })
})

test('delta-frame-only 网关状态可解析且保持 legacy 模式', async () => {
  const client = new ChatRoomManagementClient({
    baseUrl: 'http://127.0.0.1:51730',
    getToken: () => 'internal-test',
    fetchImpl: async () => Response.json({ ready: true, epoch: 5, capabilityState: 'ready', mode: 'legacy', socketGeneration: 7, snapshotReady: true, selectedCapabilities: ['agent-delta-frame-id-v1'] }),
  })
  expect(await client.getRoomRealtimeStatus('room-1')).toEqual({
    ready: true,
    epoch: 5,
    capabilityState: 'ready',
    mode: 'legacy',
    socketGeneration: 7,
    snapshotReady: true,
    selectedCapabilities: ['agent-delta-frame-id-v1'],
  })
})

test('ready 与 ACK 配对时允许同时协商 delta-frame 能力', async () => {
  const client = new ChatRoomManagementClient({
    baseUrl: 'http://127.0.0.1:51730',
    getToken: () => 'internal-test',
    fetchImpl: async () => Response.json({ ready: true, epoch: 5, capabilityState: 'ready', mode: 'modern', socketGeneration: 7, snapshotReady: true, selectedCapabilities: ['agent-ready-v1', 'invocation-ack-v1', 'agent-delta-frame-id-v1'] }),
  })
  expect(await client.getRoomRealtimeStatus('room-1')).toEqual({
    ready: true,
    epoch: 5,
    capabilityState: 'ready',
    mode: 'modern',
    socketGeneration: 7,
    snapshotReady: true,
    selectedCapabilities: ['agent-ready-v1', 'invocation-ack-v1', 'agent-delta-frame-id-v1'],
  })
})

test('网关状态仍拒绝未知能力值', async () => {
  const client = new ChatRoomManagementClient({
    baseUrl: 'http://127.0.0.1:51730',
    getToken: () => 'internal-test',
    fetchImpl: async () => Response.json({ ready: true, epoch: 5, capabilityState: 'ready', mode: 'legacy', socketGeneration: 7, snapshotReady: true, selectedCapabilities: ['future-capability-v9'] }),
  })
  await expect(client.getRoomRealtimeStatus('room-1')).rejects.toThrow('聊天室网关状态响应不正确')
})

test('主进程经 Rust AuthSession 验证房间并注册远端 Agent，使用服务端 ID', async () => {
  const paths: string[] = []
  const client = new ChatRoomManagementClient({
    baseUrl: 'http://127.0.0.1:51730', getToken: () => 'internal-test',
    fetchImpl: async (url, init) => {
      const path = new URL(String(url)).pathname
      paths.push(`${init?.method}:${path}`)
      expect(new Headers(init?.headers).get('x-copis-internal-token')).toBe('internal-test')
      if (init?.method === 'GET') return Response.json({ data: { room: { roomId: 'room-1', hostUserId: 7, status: 'active' }, members: [], agents: [] } })
      if (init?.method === 'POST') {
        if (path.endsWith('/lease')) {
          expect(JSON.parse(String(init.body))).toEqual({ deviceId: 'device-1' })
          return Response.json({ data: { roomAgentId: 'server-agent-1', status: 'online' } })
        }
        expect(JSON.parse(String(init.body))).toEqual({ displayName: 'Grok', deviceId: 'device-1' })
        return Response.json({ data: { agent: { roomAgentId: 'server-agent-1', roomId: 'room-1', ownerUserId: 7, displayName: 'Grok', status: 'offline' }, event: {} } })
      }
      return new Response(null, { status: 204 })
    },
  })
  expect(await client.getRoomHostUserId('room-1')).toBe('7')
  expect(await client.registerAgent({ roomId: 'room-1', displayName: 'Grok', deviceId: 'device-1', hostUserId: '7' })).toBe('server-agent-1')
  await client.renewAgentLease('room-1', 'server-agent-1', 'device-1')
  await client.unregisterAgent('room-1', 'server-agent-1')
  expect(paths).toEqual([
    'GET:/api/chatrooms/v2/rooms/room-1',
    'POST:/api/chatrooms/v2/rooms/room-1/agents',
    'POST:/api/chatrooms/v2/rooms/room-1/agents/server-agent-1/lease',
    'DELETE:/api/chatrooms/v2/rooms/room-1/agents/server-agent-1',
  ])
})

test('远端注册响应缺少服务端 Agent ID 时不把未知 ID 写入本地', async () => {
  const client = new ChatRoomManagementClient({ baseUrl: 'http://127.0.0.1:51730', getToken: () => 'internal-test', fetchImpl: async () => Response.json({ data: { agent: { roomId: 'room-1', ownerUserId: 7, displayName: 'Grok' } } }) })
  await expect(client.registerAgent({ roomId: 'room-1', displayName: 'Grok', deviceId: 'device-1', hostUserId: '7' })).rejects.toThrow('Agent ID')
})

test('management recovery lookup requires an operation ID and never offers a name-based claim path', async () => {
  let requests = 0
  const client = new ChatRoomManagementClient({ baseUrl: 'http://127.0.0.1:51730', getToken: () => 'internal-test', fetchImpl: async () => { requests++; return Response.json({}) } })
  await expect((client.lookupManagementOperation as any)({ roomId: 'room-1', displayName: 'Grok', deviceId: '223e4567-e89b-42d3-a456-426614174000', hostUserId: '7' })).rejects.toThrow('操作 ID')
  expect(requests).toBe(0)
})

test('Given v1 operation 已固定且能力查询暂时返回 404 When 查同 operation 状态 Then 仍按原 operation ID 恢复准确回执且不重新探测或注册', async () => {
  const calls: string[] = []
  const operationId = '123e4567-e89b-42d3-a456-426614174000'
  const client = new ChatRoomManagementClient({ baseUrl: 'http://127.0.0.1:51730', getToken: () => 'internal-test', fetchImpl: async (url, init) => {
    const path = new URL(String(url)).pathname
    calls.push(`${init?.method}:${path}`)
    if (path.endsWith('/agent-management/capabilities')) return Response.json({}, { status: 404 })
    if (path.endsWith('/agent-management/operations/status')) return Response.json({ data: {
      version: 1, operationId, roomId: 'room-1', roomAgentId: 'agent-recovered', ownerUserId: 7,
      action: 'register', status: 'registered', displayName: 'Grok', memoryShared: false, skillsShared: false,
    } })
    throw new Error(`unexpected management mutation: ${path}`)
  } })

  const status = await client.lookupManagementOperation({
    roomId: 'room-1', displayName: 'Grok', deviceId: '223e4567-e89b-42d3-a456-426614174000',
    hostUserId: '7', operationId, mode: 'v1',
  })

  expect(status).toMatchObject({ mode: 'v1', receipt: { operationId, roomAgentId: 'agent-recovered' } })
  expect(calls).toEqual(['POST:/api/internal/chatrooms/rooms/room-1/agent-management/operations/status'])
})

test('非法房间 ID 和缺失内部凭证均在请求前拒绝', async () => {
  let requests = 0
  const client = new ChatRoomManagementClient({ baseUrl: 'http://127.0.0.1:51730', getToken: () => '', fetchImpl: async () => { requests++; return Response.json({}) } })
  await expect(client.getRoomHostUserId('../other')).rejects.toThrow()
  await expect(client.getRoomHostUserId('room-1')).rejects.toThrow('尚未启动')
  expect(requests).toBe(0)
})

test('现代 ready API 只发空 body 并要求同 socket generation 的私有 ACK', async () => {
  const calls: Array<{ path: string; body: unknown }> = []
  const client = new ChatRoomManagementClient({ baseUrl: 'http://127.0.0.1:51730', getToken: () => 'internal-test', fetchImpl: async (url, init) => {
    const path = new URL(String(url)).pathname
    calls.push({ path, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    return path.endsWith('/status')
      ? Response.json({ ready: true, epoch: 5, capabilityState: 'ready', mode: 'modern', socketGeneration: 7, snapshotReady: true, selectedCapabilities: ['agent-ready-v1'] })
      : Response.json({ data: { outcome: 'confirmed', mode: 'agent-ready-v1', source: 'private-ack', roomId: 'room-1', roomAgentId: 'agent-1', command: 'agent.ready', requestId: 'req-1', generation: 7 } })
  } })
  expect(await client.getRoomRealtimeStatus('room-1')).toEqual({ ready: true, epoch: 5, capabilityState: 'ready', mode: 'modern', socketGeneration: 7, snapshotReady: true, selectedCapabilities: ['agent-ready-v1'] })
  expect(await client.readyAgent('room-1', 'agent-1')).toMatchObject({ outcome: 'confirmed', generation: 7 })
  expect(calls).toEqual([
    { path: '/api/internal/chatrooms/rooms/room-1/status', body: undefined },
    { path: '/api/internal/chatrooms/rooms/room-1/agents/agent-1/ready', body: {} },
  ])
})

test('ready 路由 503 保留 Unknown 分类而不被错误消息降成配置拒绝', async () => {
  const client = new ChatRoomManagementClient({ baseUrl: 'http://127.0.0.1:51730', getToken: () => 'internal-test', fetchImpl: async () => Response.json({ error: { code: 'lifecycle_unavailable' } }, { status: 503 }) })
  await expect(client.readyAgent('room-1', 'agent-1')).rejects.toBeInstanceOf(ChatRoomReadinessError)
  await expect(client.readyAgent('room-1', 'agent-1')).rejects.toMatchObject({ outcome: 'Unknown', code: 'lifecycle_unavailable' })
})

test('status 查询的 403 归类为 Rejected，不能被当作瞬时网络重试', async () => {
  const client = new ChatRoomManagementClient({ baseUrl: 'http://127.0.0.1:51730', getToken: () => 'internal-test', fetchImpl: async () => Response.json({ error: { code: 'not_authenticated' } }, { status: 403 }) })
  await expect(client.getRoomRealtimeStatus('room-1')).rejects.toMatchObject({ outcome: 'Rejected', code: 'not_authenticated' })
})

test('Gateway 顶层 machine code 与 HTTP status 原样保留，错误文案不作分类依据', async () => {
  const client = new ChatRoomManagementClient({ baseUrl: 'http://127.0.0.1:51730', getToken: () => 'internal-test', fetchImpl: async () => Response.json({ error: 'stale_connection', code: 'lifecycle_rejected' }, { status: 409 }) })
  await expect(client.readyAgent('room-1', 'agent-1')).rejects.toMatchObject({ outcome: 'Rejected', code: 'lifecycle_rejected', httpStatus: 409 })
})

test('401 authentication rejection retains its status so explicit re-auth can release only that block', async () => {
  const client = new ChatRoomManagementClient({ baseUrl: 'http://127.0.0.1:51730', getToken: () => 'internal-test', fetchImpl: async () => Response.json({ error: 'Please login', code: 'not_authenticated' }, { status: 401 }) })
  await expect(client.readyAgent('room-1', 'agent-1')).rejects.toMatchObject({ outcome: 'Rejected', code: 'not_authenticated', httpStatus: 401 })
})

test('Given management v1 is supported When probing capabilities Then only the readonly Main route selects the protocol', async () => {
  const paths: string[] = []
  const client = new ChatRoomManagementClient({ baseUrl: 'http://127.0.0.1:51730', getToken: () => 'internal-test', fetchImpl: async (url, init) => {
    paths.push(`${init?.method}:${new URL(String(url)).pathname}`)
    expect(new Headers(init?.headers).get('x-copis-internal-token')).toBe('internal-test')
    return Response.json({ data: { version: 1 } })
  } })
  expect(await client.probeAgentManagementVersion()).toBe(true)
  expect(paths).toEqual(['GET:/api/internal/chatrooms/agent-management/capabilities'])
})

test('Given old server returns 404 only for management capabilities When probing Then select legacy without issuing a mutation', async () => {
  const paths: string[] = []
  const client = new ChatRoomManagementClient({ baseUrl: 'http://127.0.0.1:51730', getToken: () => 'internal-test', fetchImpl: async (url, init) => {
    paths.push(`${init?.method}:${new URL(String(url)).pathname}`)
    return Response.json({ error: { code: 'not_found', message: 'not found' } }, { status: 404 })
  } })
  expect(await client.probeAgentManagementVersion()).toBe(false)
  expect(paths).toEqual(['GET:/api/internal/chatrooms/agent-management/capabilities'])
})

test('Given management capability request is unauthorized or unavailable When probing Then do not downgrade to legacy', async () => {
  for (const status of [401, 503]) {
    const client = new ChatRoomManagementClient({ baseUrl: 'http://127.0.0.1:51730', getToken: () => 'internal-test', fetchImpl: async () => Response.json({ error: { code: 'not_ready', message: 'not ready' } }, { status }) })
    await expect(client.probeAgentManagementVersion()).rejects.toThrow()
  }
})

test('Given one journaled register operation When submitting Then use Main-only v1 route and require its fully bound receipt', async () => {
  const calls: Array<{ path: string; method: string; body: unknown }> = []
  const receipt = { version: 1, operationId: '123e4567-e89b-42d3-a456-426614174000', roomId: 'room-1', roomAgentId: 'agent-1', ownerUserId: 7, action: 'register', status: 'registered', displayName: 'Grok', memoryShared: false, skillsShared: false } as const
  const client = new ChatRoomManagementClient({ baseUrl: 'http://127.0.0.1:51730', getToken: () => 'internal-test', fetchImpl: async (url, init) => {
    expect(new Headers(init?.headers).get('x-copis-internal-token')).toBe('internal-test')
    calls.push({ path: new URL(String(url)).pathname, method: String(init?.method), body: init?.body ? JSON.parse(String(init.body)) : undefined })
    return Response.json({ data: receipt })
  } })
  await expect(client.registerAgent({ roomId: 'room-1', displayName: 'Grok', deviceId: '223e4567-e89b-42d3-a456-426614174000', hostUserId: '7', operationId: receipt.operationId })).resolves.toEqual(receipt)
  expect(calls).toEqual([{ path: '/api/internal/chatrooms/rooms/room-1/agent-management/operations', method: 'POST', body: { action: 'register', operationId: receipt.operationId, deviceId: '223e4567-e89b-42d3-a456-426614174000', displayName: 'Grok', memoryShared: false, skillsShared: false } }])
})

test('Given a receipt conflicts with the journaled sharing settings When register returns Then reject it as an invalid operation receipt', async () => {
  const receipt = { data: { version: 1, operationId: '123e4567-e89b-42d3-a456-426614174000', roomId: 'room-1', roomAgentId: 'agent-1', ownerUserId: 7, action: 'register', status: 'registered', displayName: 'Grok', memoryShared: false, skillsShared: false } }
  const client = new ChatRoomManagementClient({ baseUrl: 'http://127.0.0.1:51730', getToken: () => 'internal-test', fetchImpl: async () => Response.json(receipt) })
  await expect(client.registerAgent({ roomId: 'room-1', displayName: 'Grok', deviceId: '223e4567-e89b-42d3-a456-426614174000', hostUserId: '7', operationId: '123e4567-e89b-42d3-a456-426614174000', memoryShared: true })).rejects.toMatchObject({ code: 'invalid_management_receipt' })
})

test('Given receipt actor or operation binding differs When register returns Then reject it before exposing an Agent ID', async () => {
  const receipt = { data: { version: 1, operationId: '123e4567-e89b-42d3-a456-426614174000', roomId: 'room-1', roomAgentId: 'agent-1', ownerUserId: 8, action: 'register', status: 'registered', displayName: 'Grok', memoryShared: false, skillsShared: false } }
  const client = new ChatRoomManagementClient({ baseUrl: 'http://127.0.0.1:51730', getToken: () => 'internal-test', fetchImpl: async () => Response.json(receipt) })
  await expect(client.registerAgent({ roomId: 'room-1', displayName: 'Grok', deviceId: '223e4567-e89b-42d3-a456-426614174000', hostUserId: '7', operationId: '123e4567-e89b-42d3-a456-426614174000' })).rejects.toMatchObject({ code: 'invalid_management_receipt' })
})

test('Given a status operation returns not-found When querying Then only management_operation_not_found is a safe retry signal', async () => {
  const client = new ChatRoomManagementClient({ baseUrl: 'http://127.0.0.1:51730', getToken: () => 'internal-test', fetchImpl: async (url) => {
    if (new URL(String(url)).pathname.endsWith('/capabilities')) return Response.json({ data: { version: 1 } })
    return Response.json({ error: { code: 'management_operation_not_found', message: 'not found' } }, { status: 404 })
  } })
  await expect(client.lookupManagementOperation({ roomId: 'room-1', displayName: 'ignored', deviceId: '223e4567-e89b-42d3-a456-426614174000', hostUserId: '7', operationId: '123e4567-e89b-42d3-a456-426614174000' })).resolves.toEqual({ mode: 'v1', receipt: undefined })
})

test('Given a status 404 has an unrelated machine code When querying Then preserve it as unknown instead of treating it as not-found', async () => {
  const client = new ChatRoomManagementClient({ baseUrl: 'http://127.0.0.1:51730', getToken: () => 'internal-test', fetchImpl: async (url) => {
    if (new URL(String(url)).pathname.endsWith('/capabilities')) return Response.json({ data: { version: 1 } })
    return Response.json({ error: { code: 'room_not_found', message: 'not found' } }, { status: 404 })
  } })
  await expect(client.lookupManagementOperation({ roomId: 'room-1', displayName: 'ignored', deviceId: '223e4567-e89b-42d3-a456-426614174000', hostUserId: '7', operationId: '123e4567-e89b-42d3-a456-426614174000' })).rejects.toMatchObject({ httpStatus: 404, code: 'room_not_found' })
})

test('Given v1 removal status is not-found but mutation returns 204 When compensating Then do not clear the journal as confirmed', async () => {
  const client = new ChatRoomManagementClient({ baseUrl: 'http://127.0.0.1:51730', getToken: () => 'internal-test', fetchImpl: async (url) => {
    if (new URL(String(url)).pathname.endsWith('/capabilities')) return Response.json({ data: { version: 1 } })
    if (new URL(String(url)).pathname.endsWith('/status')) return Response.json({ error: { code: 'management_operation_not_found', message: 'missing' } }, { status: 404 })
    return new Response(null, { status: 204 })
  } })
  await expect(client.unregisterAgent('room-1', 'agent-1', { operationId: '123e4567-e89b-42d3-a456-426614174000', deviceId: '223e4567-e89b-42d3-a456-426614174000', hostUserId: '7', mode: 'v1' })).rejects.toMatchObject({ code: 'invalid_management_receipt' })
})

test('共享更新在响应丢失后按同 operation 查询，body 仅含设备和 operation ID', async () => {
  const operationId = '123e4567-e89b-42d3-a456-426614174000'
  const paths: string[] = []
  const bodies: unknown[] = []
  const receipt = {
    version: 1, operationId, roomId: 'room-1', roomAgentId: 'agent-1', ownerUserId: 7,
    action: 'update-sharing', status: 'updated', displayName: 'Grok', memoryShared: true, skillsShared: false,
  }
  const client = new ChatRoomManagementClient({ baseUrl: 'http://127.0.0.1:51730', getToken: () => 'internal-test', fetchImpl: async (url, init) => {
    const path = new URL(String(url)).pathname
    paths.push(`${init?.method}:${path}`)
    if (init?.body) bodies.push(JSON.parse(String(init.body)))
    if (path.endsWith('/capabilities')) return Response.json({ data: { version: 1 } })
    if (path.endsWith('/status')) return Response.json({ data: receipt })
    throw new Error(`unexpected request: ${path}`)
  } })
  expect(await (client as any).updateAgentSharing({
    roomId: 'room-1', roomAgentId: 'agent-1', operationId,
    deviceId: '223e4567-e89b-42d3-a456-426614174000', hostUserId: '7', mode: 'v1', memoryShared: true, skillsShared: false,
  })).toEqual(receipt)
  expect(paths).toEqual([
    'POST:/api/internal/chatrooms/rooms/room-1/agent-management/operations/status',
  ])
  expect(bodies).toEqual([{ operationId, deviceId: '223e4567-e89b-42d3-a456-426614174000' }])
})

test('已固定 v1 的共享操作在恢复时不重新探测能力', async () => {
  const paths: string[] = []
  const receipt = { version: 1 as const, operationId: '123e4567-e89b-42d3-a456-426614174000', roomId: 'room-1', roomAgentId: 'agent-1', ownerUserId: 7,
    action: 'update-sharing' as const, status: 'updated' as const, displayName: 'Grok', memoryShared: true, skillsShared: false }
  const client = new ChatRoomManagementClient({ baseUrl: 'http://127.0.0.1:51730', getToken: () => 'internal-test', fetchImpl: async (url) => {
    const path = new URL(String(url)).pathname
    paths.push(path)
    if (path.endsWith('/capabilities')) return new Response(null, { status: 404 })
    return Response.json({ data: receipt })
  } })
  await expect(client.updateAgentSharing({
    roomId: 'room-1', roomAgentId: 'agent-1', operationId: '123e4567-e89b-42d3-a456-426614174000',
    deviceId: '223e4567-e89b-42d3-a456-426614174000', hostUserId: '7', mode: 'v1', memoryShared: true, skillsShared: false,
  })).resolves.toEqual(receipt)
  expect(paths).toEqual(['/api/internal/chatrooms/rooms/room-1/agent-management/operations/status'])
})

test('已固定 legacy 后，精确 DELETE 的 2xx 才作为 legacy remove 成功', async () => {
  const paths: string[] = []
  const client = new ChatRoomManagementClient({ baseUrl: 'http://127.0.0.1:51730', getToken: () => 'internal-test', fetchImpl: async (url, init) => {
    paths.push(`${init?.method}:${new URL(String(url)).pathname}`)
    return new Response(null, { status: init?.method === 'GET' ? 404 : 204 })
  } })
  await expect(client.unregisterAgent('room-1', 'agent-1', {
    operationId: '123e4567-e89b-42d3-a456-426614174000', deviceId: '223e4567-e89b-42d3-a456-426614174000', hostUserId: '7', mode: 'legacy',
  })).resolves.toEqual({ mode: 'legacy', outcome: 'confirmed', roomId: 'room-1', roomAgentId: 'agent-1' })
  expect(paths).toEqual(['DELETE:/api/chatrooms/v2/rooms/room-1/agents/agent-1'])
})

test('旧版能力已确认后 DELETE 网络错误标记 legacy_remove_unknown，不能当作成功', async () => {
  const client = new ChatRoomManagementClient({ baseUrl: 'http://127.0.0.1:51730', getToken: () => 'internal-test', fetchImpl: async (url, init) => {
    if (init?.method === 'GET') return new Response(null, { status: 404 })
    throw new Error('connection lost')
  } })
  await expect(client.unregisterAgent('room-1', 'agent-1', {
    operationId: '123e4567-e89b-42d3-a456-426614174000', deviceId: '223e4567-e89b-42d3-a456-426614174000', hostUserId: '7', mode: 'legacy',
  })).rejects.toMatchObject({ code: 'legacy_remove_unknown' })
})

test('已固定 v1 的 remove 在恢复时不重新探测能力或降级', async () => {
  const operationId = '123e4567-e89b-42d3-a456-426614174000'
  const paths: string[] = []
  const receipt = { version: 1, operationId, roomId: 'room-1', roomAgentId: 'agent-1', ownerUserId: 7,
    action: 'remove', status: 'removed', displayName: 'Grok', memoryShared: false, skillsShared: false }
  const client = new ChatRoomManagementClient({ baseUrl: 'http://127.0.0.1:51730', getToken: () => 'internal-test', fetchImpl: async (url, init) => {
    const path = new URL(String(url)).pathname
    paths.push(`${init?.method}:${path}`)
    if (path.endsWith('/capabilities')) return new Response(null, { status: 404 })
    if (path.endsWith('/status')) return Response.json({ data: receipt })
    throw new Error(`unexpected mutation request: ${path}`)
  } })
  await expect((client as any).unregisterAgent('room-1', 'agent-1', {
    operationId, deviceId: '223e4567-e89b-42d3-a456-426614174000', hostUserId: '7', mode: 'v1',
  })).resolves.toEqual(receipt)
  expect(paths).toEqual(['POST:/api/internal/chatrooms/rooms/room-1/agent-management/operations/status'])
})

test('首次明确固定 legacy 后直走精确旧 CRUD，不在 adapter 再探测', async () => {
  const paths: string[] = []
  const client = new ChatRoomManagementClient({ baseUrl: 'http://127.0.0.1:51730', getToken: () => 'internal-test', fetchImpl: async (url, init) => {
    paths.push(`${init?.method}:${new URL(String(url)).pathname}`)
    return new Response(null, { status: 204 })
  } })
  await expect((client as any).unregisterAgent('room-1', 'agent-1', {
    operationId: '123e4567-e89b-42d3-a456-426614174000',
    deviceId: '223e4567-e89b-42d3-a456-426614174000', hostUserId: '7', mode: 'legacy',
  })).resolves.toEqual({ mode: 'legacy', outcome: 'confirmed', roomId: 'room-1', roomAgentId: 'agent-1' })
  expect(paths).toEqual(['DELETE:/api/chatrooms/v2/rooms/room-1/agents/agent-1'])
})
