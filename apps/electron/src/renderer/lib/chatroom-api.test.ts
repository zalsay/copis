import { describe, expect, test } from 'bun:test'
import { createChatRoomApi, ChatRoomApiError, ChatRoomProvisionError, provisionChatRoomAgents } from './chatroom-api'

test('发送消息保留服务端调用身份及离线结果，但不泄漏设备字段', async () => {
  const api = createChatRoomApi({ baseUrl: 'http://test', fetchImpl: async () => Response.json({ data: { message: { roomId: 'r1', messageId: 'm1', content: '你好' }, invocations: [{ invocationId: 'i1', roomId: 'r1', targetAgentId: 'a1', triggerMessageId: 'm1', traceId: 't1', depth: 0, status: 'created', deviceIdHash: 'secret-device' }], events: [{ eventType: 'agent.offline', roomId: 'r1', seq: 4, payload: { agentId: 'a2', messageId: 'm1', failureCode: 'lease_expired' } }] } }) })
  const result = await api.sendMessage({ roomId: 'r1', content: '你好', mentionAgentIds: ['a1', 'a2'], attachmentIds: [] })
  expect(result.invocations?.[0]).toMatchObject({ invocationId: 'i1', targetAgentId: 'a1', triggerMessageId: 'm1', status: 'created' })
  expect(result.events?.[0]).toMatchObject({ type: 'agent.offline', payload: { failureCode: 'lease_expired' } })
  expect(JSON.stringify(result)).not.toContain('secret-device')
})

const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
describe('chatRoomApi', () => {
  test('已有房间添加 Agent 离线失败时不误称聊天室刚创建', async () => {
    const previous = globalThis.window
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { electronAPI: { chatrooms: { provisionAgent: async () => { throw new Error('agent_offline') } } } } })
    const room = { roomId: 'existing-room', name: '已有房间', role: 'host' as const, status: 'active' as const, memberCount: 1, unreadCount: 0, connectionStatus: 'connected' as const }
    const agent = { sourceWorkspaceId: 'workspace-grok', displayName: 'grok', channelId: 'channel-1' }
    try {
      const failure = await provisionChatRoomAgents(room, [agent], { operation: 'add' }).catch((error) => error as ChatRoomProvisionError)
      expect(failure).toBeInstanceOf(ChatRoomProvisionError)
      if (!(failure instanceof ChatRoomProvisionError)) throw new Error('预期添加 Agent 失败')
      expect(failure.message).toContain('Agent「grok」添加失败')
      expect(failure.message).not.toContain('聊天室已创建')
    } finally { Object.defineProperty(globalThis, 'window', { configurable: true, value: previous }) }
  })
  test('已创建房间可仅配置未完成的 Agent，不再次提交房间创建', async () => {
    const previous = globalThis.window
    const calls: string[] = []
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { electronAPI: { chatrooms: { provisionAgent: async (input: { displayName: string }) => { calls.push(input.displayName); if (input.displayName === 'Agent B' && calls.filter((name) => name === 'Agent B').length === 1) throw new Error('暂时失败') } } } } })
    const room = { roomId: 'room-created', name: '房间', role: 'host' as const, status: 'active' as const, memberCount: 1, unreadCount: 0, connectionStatus: 'offline' as const }
    const agents = ['Agent A', 'Agent B'].map((displayName) => ({ sourceWorkspaceId: displayName, displayName, channelId: 'c', contextMessageCount: 50, memorySharingEnabled: false, skillSharingEnabled: false }))
    try {
      const error = await provisionChatRoomAgents(room, agents).catch((failure) => failure as ChatRoomProvisionError)
      expect(error).toBeInstanceOf(ChatRoomProvisionError)
      if (!(error instanceof ChatRoomProvisionError)) throw new Error('预期 Agent 配置失败')
      expect(error.succeededCount).toBe(1)
      await provisionChatRoomAgents(room, agents.slice(error.succeededCount))
      expect(calls).toEqual(['Agent A', 'Agent B', 'Agent B'])
    } finally { Object.defineProperty(globalThis, 'window', { configurable: true, value: previous }) }
  })
  test('列表保留服务端主理人 ID，供侧栏选择删除或退出', async () => {
    const api = createChatRoomApi({ baseUrl: 'http://test', fetchImpl: async () => response({ data: [{ roomId: 'room-1', name: '协作室', hostUserId: 7 }] }) })
    expect(await api.listRooms()).toMatchObject([{ roomId: 'room-1', hostUserId: '7' }])
  })

  test('加入成员退出房间使用 Rust 网关 POST leave 路由', async () => {
    const calls: Array<{ url: string; method: string }> = []
    const api = createChatRoomApi({ baseUrl: 'http://test', fetchImpl: async (url, init) => {
      calls.push({ url: String(url), method: init?.method ?? 'GET' })
      return response({ data: { roomId: 'room-1' } })
    } })
    await api.leaveRoom('room-1')
    expect(calls).toEqual([{ url: 'http://test/api/chatrooms/v2/rooms/room-1/leave', method: 'POST' }])
  })

  test('edu-api data 信封中的房间列表和创建结果保留真实 roomId', async () => {
    const requests: Array<{ url: string; method: string }> = []
    const api = createChatRoomApi({ baseUrl: 'http://test', fetchImpl: async (url, init) => {
      requests.push({ url: String(url), method: init?.method ?? 'GET' })
      const room = { roomId: 'room-real', name: '协作室', shareCode: 'AB12', status: 'active' }
      return response({ data: init?.method === 'POST' ? room : [room] })
    } })
    expect((await api.listRooms()).map((room) => room.roomId)).toEqual(['room-real'])
    expect((await api.createRoom({ name: '协作室', shareCode: 'AB12' })).roomId).toBe('room-real')
    expect(requests).toEqual([
      { url: 'http://test/api/chatrooms/v2/rooms', method: 'GET' },
      { url: 'http://test/api/chatrooms/v2/rooms', method: 'POST' },
    ])
  })

  test('加入和房间详情解开 edu-api data 信封', async () => {
    const room = { roomId: 'room-real', name: '协作室', status: 'active' }
    const api = createChatRoomApi({ baseUrl: 'http://test', fetchImpl: async (_url, init) => response({ data: init?.method === 'POST'
      ? room
      : { room, members: [{ userId: 'user-1', displayName: '主理人', role: 'host' }], agents: [] } }) })
    expect((await api.joinRoom({ shareCode: 'A7K2' })).roomId).toBe('room-real')
    await expect(api.getRoom('room-real')).resolves.toMatchObject({ room: { roomId: 'room-real' }, members: [{ userId: 'user-1' }] })
  })

  test('服务端 roomAgentId 映射为可 @ 的 Agent ID', async () => {
    const api = createChatRoomApi({ baseUrl: 'http://test', fetchImpl: async () => response({ data: { room: { roomId: 'room-1', name: '房间', hostUserId: 7 }, members: [], agents: [{ roomAgentId: 'server-agent-1', roomId: 'room-1', ownerUserId: 7, displayName: 'Grok', status: 'online' }] } }) })
    const detail = await api.getRoom('room-1')
    expect(detail.agents).toMatchObject([{ agentId: 'server-agent-1', displayName: 'Grok', status: 'online' }])
  })

  test('创建响应缺少 roomId 时不返回可打开的空房间', async () => {
    const api = createChatRoomApi({ fetchImpl: async () => response({ data: { name: '无效房间' } }) })
    await expect(api.createRoom({ name: '无效房间', shareCode: 'AB12' })).rejects.toMatchObject({ code: 'invalid_room_response' })
  })

  test('空 roomId 的详情请求在 fetch 前拒绝，避免 /rooms/ 路由', async () => {
    let fetchCount = 0
    const api = createChatRoomApi({ fetchImpl: async () => { fetchCount++; return response({}) } })
    await expect(api.getRoom('')).rejects.toBeInstanceOf(ChatRoomApiError)
    expect(fetchCount).toBe(0)
  })

  test('加入请求将小写分享码转为大写并直接调用 join', async () => {
    const calls: RequestInit[] = []; const api = createChatRoomApi({ baseUrl: 'http://test', fetchImpl: async (_url, init) => { calls.push(init ?? {}); return response({ room: { roomId: 'r1', name: 'R' } }) } })
    await api.joinRoom({ shareCode: 'a9z0' }); expect(JSON.parse(String(calls[0]?.body))).toEqual({ shareCode: 'A9Z0' })
  })
  test('创建请求只发送 name/shareCode，并按本地 Agent 配置顺序 provision', async () => { let body = ''; const provisioned: unknown[] = []; const original = globalThis.window; Object.defineProperty(globalThis, 'window', { configurable: true, value: { electronAPI: { chatrooms: { provisionAgent: async (input: unknown) => { provisioned.push(input); return {} } } } } }); const api = createChatRoomApi({ baseUrl: 'http://test', fetchImpl: async (_url, init) => { body = String(init?.body); return response({ roomId: 'r1', name: 'R' }) } }); await api.createRoom({ name: 'R', shareCode: 'AB12' }, [{ sourceWorkspaceId: 'ws', displayName: 'Agent', channelId: 'channel', contextMessageCount: 50, memorySharingEnabled: true, skillSharingEnabled: false }]); expect(JSON.parse(body)).toEqual({ name: 'R', shareCode: 'AB12' }); expect(provisioned[0]).toMatchObject({ sourceWorkspaceId: 'ws', displayName: 'Agent', channelId: 'channel', memorySharingEnabled: true }); Object.defineProperty(globalThis, 'window', { configurable: true, value: original }) })
  test('创建成功后 provision 失败保留已创建房间且不再次 POST', async () => { let postCount = 0; const original = globalThis.window; Object.defineProperty(globalThis, 'window', { configurable: true, value: { electronAPI: { chatrooms: { provisionAgent: async (input: { displayName: string }) => { if (input.displayName === '失败 Agent') throw new Error('配置不可用'); return {} } } } } }); const api = createChatRoomApi({ baseUrl: 'http://test', fetchImpl: async () => { postCount++; return response({ roomId: 'r1', name: 'R' }) } }); await expect(api.createRoom({ name: 'R', shareCode: 'AB12' }, [{ sourceWorkspaceId: 'ok', displayName: '正常 Agent', channelId: 'c', contextMessageCount: 50, memorySharingEnabled: false, skillSharingEnabled: false }, { sourceWorkspaceId: 'bad', displayName: '失败 Agent', channelId: 'c', contextMessageCount: 50, memorySharingEnabled: false, skillSharingEnabled: false }])).rejects.toBeInstanceOf(ChatRoomProvisionError); expect(postCount).toBe(1); Object.defineProperty(globalThis, 'window', { configurable: true, value: original }) })
  test('每个 Agent provision 成功后立即报告进度', async () => {
    const original = globalThis.window
    let releaseSecond!: () => void
    const secondReady = new Promise<void>((resolve) => { releaseSecond = resolve })
    const progress: Array<{ completed: number; total: number; agentName: string }> = []
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { electronAPI: { chatrooms: { provisionAgent: async (input: { displayName: string }) => { if (input.displayName === '第二 Agent') await secondReady; return {} } } } } })
    const api = createChatRoomApi({ baseUrl: 'http://test', fetchImpl: async () => response({ roomId: 'r1', name: 'R' }) })
    const creation = api.createRoom({ name: 'R', shareCode: 'AB12' }, [
      { sourceWorkspaceId: 'one', displayName: '第一 Agent', channelId: 'c', contextMessageCount: 50, memorySharingEnabled: false, skillSharingEnabled: false },
      { sourceWorkspaceId: 'two', displayName: '第二 Agent', channelId: 'c', contextMessageCount: 50, memorySharingEnabled: false, skillSharingEnabled: false },
      { sourceWorkspaceId: 'three', displayName: '第三 Agent', channelId: 'c', contextMessageCount: 50, memorySharingEnabled: false, skillSharingEnabled: false },
    ], { onProvisionProgress: (value) => progress.push(value) })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(progress).toEqual([{ completed: 0, total: 3, agentName: '' }, { completed: 1, total: 3, agentName: '第一 Agent' }])
    releaseSecond()
    await creation
    expect(progress.map(({ completed, total }) => `${completed}/${total}`)).toEqual(['0/3', '1/3', '2/3', '3/3'])
    Object.defineProperty(globalThis, 'window', { configurable: true, value: original })
  })

  test('provision 部分失败报告已成功数量且创建请求只发送一次', async () => {
    let postCount = 0
    const original = globalThis.window
    const progress: Array<{ completed: number; total: number; agentName: string }> = []
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { electronAPI: { chatrooms: { provisionAgent: async (input: { displayName: string }) => { if (input.displayName === '失败 Agent') throw new Error('配置不可用'); return {} } } } } })
    const api = createChatRoomApi({ baseUrl: 'http://test', fetchImpl: async () => { postCount++; return response({ roomId: 'r1', name: 'R' }) } })
    const error = await api.createRoom({ name: 'R', shareCode: 'AB12' }, [
      { sourceWorkspaceId: 'one', displayName: '正常 Agent', channelId: 'c', contextMessageCount: 50, memorySharingEnabled: false, skillSharingEnabled: false },
      { sourceWorkspaceId: 'bad', displayName: '失败 Agent', channelId: 'c', contextMessageCount: 50, memorySharingEnabled: false, skillSharingEnabled: false },
      { sourceWorkspaceId: 'three', displayName: '未执行 Agent', channelId: 'c', contextMessageCount: 50, memorySharingEnabled: false, skillSharingEnabled: false },
    ], { onProvisionProgress: (value) => progress.push(value) }).catch((value) => value as ChatRoomProvisionError)
    expect(error).toBeInstanceOf(ChatRoomProvisionError)
    expect((error as ChatRoomProvisionError).succeededCount).toBe(1)
    expect((error as ChatRoomProvisionError).totalCount).toBe(3)
    expect(progress).toEqual([{ completed: 0, total: 3, agentName: '' }, { completed: 1, total: 3, agentName: '正常 Agent' }])
    expect(postCount).toBe(1)
    Object.defineProperty(globalThis, 'window', { configurable: true, value: original })
  })
  test('主理人控制使用 Rust gateway 的真实路由', async () => {
    const calls: Array<{ url: string; method: string }> = []
    const api = createChatRoomApi({ baseUrl: 'http://test', fetchImpl: async (url, init) => { calls.push({ url: String(url), method: init?.method ?? 'GET' }); return response({}) } })
    await api.archiveRoom('r/1'); await api.restoreRoom('r/1'); await api.removeMember('r/1', 'u/2'); await api.deleteRoom('r/1')
    expect(calls).toEqual([
      { url: 'http://test/api/chatrooms/v2/rooms/r%2F1/archive', method: 'POST' },
      { url: 'http://test/api/chatrooms/v2/rooms/r%2F1/restore', method: 'POST' },
      { url: 'http://test/api/chatrooms/v2/rooms/r%2F1/members/u%2F2', method: 'DELETE' },
      { url: 'http://test/api/chatrooms/v2/rooms/r%2F1', method: 'DELETE' },
    ])
  })
  test('HTTP 非 2xx 映射稳定 code 且不把内部响应原样抛出', async () => { const api = createChatRoomApi({ baseUrl: 'http://test', fetchImpl: async () => response({ code: 'secret_code', token: 'secret' }, 503) }); await expect(api.listRooms()).rejects.toMatchObject({ code: 'secret_code', status: 503 }); await expect(api.listRooms()).rejects.not.toHaveProperty('payload') })
  test('无效分享码在 fetch 前拒绝', async () => { let count = 0; const api = createChatRoomApi({ fetchImpl: async () => { count++; return response({}) } }); await expect(api.joinRoom({ shareCode: 'bad' })).rejects.toBeInstanceOf(ChatRoomApiError); expect(count).toBe(0) })
  test('历史消息按 edu-api sender/text wire 映射为聊天室消息 DTO', async () => {
    const api = createChatRoomApi({ baseUrl: 'http://test', fetchImpl: async () => response({ data: [{ messageId: 'm-1', sender: { type: 'user', id: 'u-1', displayName: '小明' }, text: '你好', createdAt: 1720000000000, mentionedAgentIds: ['a-1'], attachmentIds: ['att-1'] }] }) })
    await expect(api.getMessages('room-1')).resolves.toEqual({ messages: [{ messageId: 'm-1', roomId: 'room-1', seq: 0, senderType: 'user', senderId: 'u-1', content: '你好', mentionAgentIds: ['a-1'], attachmentIds: ['att-1'], clientMessageId: '', depth: 0, createdAt: '1720000000000' }] })
  })
  test('发送响应按 edu-api sender/text wire 映射且不把原始字段泄漏给调用方', async () => {
    const api = createChatRoomApi({ baseUrl: 'http://test', fetchImpl: async () => response({ data: { messageId: 'm-2', sender: { type: 'agent', id: 'a-1', displayName: '助理' }, text: '已完成', createdAt: 1720000000001, mentionedAgentIds: [], attachmentIds: [] } }) })
    await expect(api.sendMessage({ roomId: 'room-1', content: '开始', mentionAgentIds: [], attachmentIds: [], clientMessageId: 'c-1' })).resolves.toMatchObject({ messageId: 'm-2', senderType: 'agent', senderId: 'a-1', content: '已完成', createdAt: '1720000000001' })
  })
  test('兼容 edu-api ChatRoomV2MessageResponse 的用户发送者字段', async () => {
    const api = createChatRoomApi({ baseUrl: 'http://test', fetchImpl: async () => response({ data: [{ messageId: 'm-user', roomId: 'room-1', seq: 4, senderType: 'user', senderUserId: 27, content: '请 Agent 处理', mentionAgentIds: [], attachmentIds: [], clientMessageId: 'c-1', depth: 0, createdAt: '2026-09-22T10:00:00Z' }] }) })
    await expect(api.getMessages('room-1')).resolves.toMatchObject({ messages: [{ senderType: 'user', senderId: '27', content: '请 Agent 处理', seq: 4 }] })
  })
  test('兼容 edu-api ChatRoomV2MessageResponse 的 Agent 发送者字段', async () => {
    const api = createChatRoomApi({ baseUrl: 'http://test', fetchImpl: async () => response({ data: [{ messageId: 'm-agent', roomId: 'room-1', seq: 5, senderType: 'agent', senderAgentId: 'agent-a', content: '已完成', mentionAgentIds: [], attachmentIds: [], clientMessageId: 'c-2', traceId: 'trace-1', depth: 1, createdAt: '2026-09-22T10:00:01Z' }] }) })
    await expect(api.getMessages('room-1')).resolves.toMatchObject({ messages: [{ senderType: 'agent', senderId: 'agent-a', traceId: 'trace-1', content: '已完成' }] })
  })
})
