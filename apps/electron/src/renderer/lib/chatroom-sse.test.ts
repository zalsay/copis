import { describe, expect, test } from 'bun:test'
import { ChatRoomSseClient, parseChatRoomSseFrame } from './chatroom-sse'
describe('chatRoomSse', () => {
  test('解析 event/data 多行帧', () => { expect(parseChatRoomSseFrame('event: message.created\ndata: {"type":"message.created",\ndata: "roomId":"r1"}\n\n')?.type).toBe('message.created') })
  test('多房间查询保留逗号且 close 会停止请求', async () => { const urls: string[] = []; const statuses: string[] = []; let resolve!: () => void; const api = new ChatRoomSseClient({ baseUrl: 'http://test', fetchImpl: async (url, init) => { urls.push(String(url)); await new Promise<void>((r) => { resolve = r; init?.signal?.addEventListener('abort', () => r()) }); throw new DOMException('aborted', 'AbortError') } }); api.onStatus((s) => statuses.push(s)); api.setRooms(['r1', 'r2']); await Promise.resolve(); expect(urls[0]).toContain('roomIds=r1,r2'); api.close(); resolve?.(); expect(statuses).toContain('offline') })
  test('缺少 type 的帧被丢弃', () => { expect(parseChatRoomSseFrame('event: message.created\ndata: {"payload":{}}\n\n')).toBeUndefined() })
})
