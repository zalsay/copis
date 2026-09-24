import { expect, mock, test } from 'bun:test'

mock.module('electron', () => ({
  app: { isPackaged: true, getPath: () => '/tmp/copis-test-app-data' },
  BrowserWindow: class {}, WebContentsView: class {}, clipboard: {}, dialog: {},
  nativeImage: { createFromPath: () => ({}) }, nativeTheme: {}, powerMonitor: {}, powerSaveBlocker: {},
  screen: {}, shell: { openExternal: async () => {} },
  safeStorage: { isEncryptionAvailable: () => false, encryptString: (value: string) => Buffer.from(value), decryptString: (value: Buffer) => value.toString('utf8') },
}))

const { ChatRoomManagementClient } = await import('./chatroom-management-client')

test('已有房间的内部就绪查询只向 loopback 发送 GET 和内部令牌', async () => {
  const paths: string[] = []
  const client = new ChatRoomManagementClient({ baseUrl: 'http://127.0.0.1:51730', getToken: () => 'internal-test', fetchImpl: async (url, init) => {
    paths.push(`${init?.method}:${new URL(String(url)).pathname}`)
    expect(new Headers(init?.headers).get('x-copis-internal-token')).toBe('internal-test')
    return Response.json({ ready: true, epoch: 5 })
  } })
  expect(await client.getRoomRealtimeStatus('room-1')).toEqual({ ready: true, epoch: 5 })
  expect(paths).toEqual(['GET:/api/internal/chatrooms/rooms/room-1/status'])
})

test('网关状态响应缺失 ready 时禁止作为已连接凭据', async () => {
  const client = new ChatRoomManagementClient({ baseUrl: 'http://127.0.0.1:51730', getToken: () => 'internal-test', fetchImpl: async () => Response.json({}) })
  await expect(client.getRoomRealtimeStatus('room-1')).rejects.toThrow('网关状态')
})

test('网关状态没有连接版本时不得证明 Agent 可以注册', async () => {
  const client = new ChatRoomManagementClient({ baseUrl: 'http://127.0.0.1:51730', getToken: () => 'internal-test', fetchImpl: async () => Response.json({ ready: true }) })
  await expect(client.getRoomRealtimeStatus('room-1')).rejects.toThrow('网关状态')
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

test('注册响应丢失后从房间详情找回同名 Agent，并用设备租约验证归属', async () => {
  const paths: string[] = []
  const client = new ChatRoomManagementClient({ baseUrl: 'http://127.0.0.1:51730', getToken: () => 'internal-test', fetchImpl: async (url, init) => {
    const path = new URL(String(url)).pathname
    paths.push(`${init?.method}:${path}`)
    if (init?.method === 'GET') return Response.json({ data: { room: { roomId: 'room-1', hostUserId: 7, status: 'active' }, agents: [{ roomAgentId: 'server-agent-1', roomId: 'room-1', ownerUserId: 7, displayName: 'Grok' }] } })
    return Response.json({ data: { roomAgentId: 'server-agent-1', status: 'online' } })
  } })
  expect(await client.findRegisteredAgent({ roomId: 'room-1', displayName: 'Grok', deviceId: 'device-1', hostUserId: '7' })).toEqual({ agentId: 'server-agent-1', leaseVerified: true })
  expect(paths).toEqual(['GET:/api/chatrooms/v2/rooms/room-1', 'POST:/api/chatrooms/v2/rooms/room-1/agents/server-agent-1/lease'])
})

test('归属确认续租的响应丢失时仍返回候选 ID 以供定向补偿', async () => {
  const client = new ChatRoomManagementClient({ baseUrl: 'http://127.0.0.1:51730', getToken: () => 'internal-test', fetchImpl: async (_url, init) => init?.method === 'GET'
    ? Response.json({ data: { room: { roomId: 'room-1', hostUserId: 7, status: 'active' }, agents: [{ roomAgentId: 'server-agent-1', roomId: 'room-1', ownerUserId: 7, displayName: 'Grok' }] } })
    : new Response(null, { status: 502 }) })
  expect(await client.findRegisteredAgent({ roomId: 'room-1', displayName: 'Grok', deviceId: 'device-1', hostUserId: '7' })).toEqual({ agentId: 'server-agent-1', leaseVerified: false })
})

test('非法房间 ID 和缺失内部凭证均在请求前拒绝', async () => {
  let requests = 0
  const client = new ChatRoomManagementClient({ baseUrl: 'http://127.0.0.1:51730', getToken: () => '', fetchImpl: async () => { requests++; return Response.json({}) } })
  await expect(client.getRoomHostUserId('../other')).rejects.toThrow()
  await expect(client.getRoomHostUserId('room-1')).rejects.toThrow('尚未启动')
  expect(requests).toBe(0)
})
