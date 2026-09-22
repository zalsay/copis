import { describe, expect, test } from 'bun:test'
import { ChatRoomSseClient, parseChatRoomSseFrame } from './chatroom-sse'
describe('chatRoomSse', () => {
  test('解析 event/data 多行帧', () => { expect(parseChatRoomSseFrame('event: message.created\ndata: {"type":"message.created",\ndata: "roomId":"r1"}\n\n')?.type).toBe('message.created') })
  test('close 会停止请求并触发 offline', async () => { const statuses: string[] = []; let resolve!: () => void; const api = new ChatRoomSseClient({ fetchImpl: async (_url, init) => { await new Promise<void>((r) => { resolve = r; init?.signal?.addEventListener('abort', () => r()) }); throw new DOMException('aborted', 'AbortError') } }); api.onStatus((s) => statuses.push(s)); api.setRooms(['r1']); await Promise.resolve(); api.close(); resolve?.(); expect(statuses).toContain('offline') })
})
