import { describe, expect, test } from 'bun:test'
import { createChatRoomApi, ChatRoomApiError, ChatRoomProvisionError } from './chatroom-api'

const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
describe('chatRoomApi', () => {
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
})
