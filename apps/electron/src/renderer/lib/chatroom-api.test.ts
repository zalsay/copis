import { describe, expect, test } from 'bun:test'
import { createChatRoomApi, ChatRoomApiError } from './chatroom-api'

const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
describe('chatRoomApi', () => {
  test('加入请求将小写分享码转为大写并直接调用 join', async () => {
    const calls: RequestInit[] = []; const api = createChatRoomApi({ baseUrl: 'http://test', fetchImpl: async (_url, init) => { calls.push(init ?? {}); return response({ room: { roomId: 'r1', name: 'R' } }) } })
    await api.joinRoom({ shareCode: 'a9z0' }); expect(JSON.parse(String(calls[0]?.body))).toEqual({ shareCode: 'A9Z0' })
  })
  test('创建请求只发送 name/shareCode，并按本地 Agent 配置顺序 provision', async () => { let body = ''; const provisioned: unknown[] = []; const original = globalThis.window; Object.defineProperty(globalThis, 'window', { configurable: true, value: { electronAPI: { chatrooms: { provisionAgent: async (input: unknown) => { provisioned.push(input); return {} } } } } }); const api = createChatRoomApi({ baseUrl: 'http://test', fetchImpl: async (_url, init) => { body = String(init?.body); return response({ roomId: 'r1', name: 'R' }) } }); await api.createRoom({ name: 'R', shareCode: 'AB12' }, [{ sourceWorkspaceId: 'ws', displayName: 'Agent', channelId: 'channel', contextMessageCount: 50, memorySharingEnabled: true, skillSharingEnabled: false }]); expect(JSON.parse(body)).toEqual({ name: 'R', shareCode: 'AB12' }); expect(provisioned[0]).toMatchObject({ sourceWorkspaceId: 'ws', displayName: 'Agent', channelId: 'channel', memorySharingEnabled: true }); Object.defineProperty(globalThis, 'window', { configurable: true, value: original }) })
  test('HTTP 非 2xx 映射稳定 code 且不把内部响应原样抛出', async () => { const api = createChatRoomApi({ baseUrl: 'http://test', fetchImpl: async () => response({ code: 'secret_code', token: 'secret' }, 503) }); await expect(api.listRooms()).rejects.toMatchObject({ code: 'secret_code', status: 503 }); await expect(api.listRooms()).rejects.not.toHaveProperty('payload') })
  test('无效分享码在 fetch 前拒绝', async () => { let count = 0; const api = createChatRoomApi({ fetchImpl: async () => { count++; return response({}) } }); await expect(api.joinRoom({ shareCode: 'bad' })).rejects.toBeInstanceOf(ChatRoomApiError); expect(count).toBe(0) })
})
