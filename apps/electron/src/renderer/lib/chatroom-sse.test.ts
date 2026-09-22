import { describe, expect, test } from 'bun:test'
import { ChatRoomSseClient, parseChatRoomSseFrame } from './chatroom-sse'
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
describe('chatRoomSse', () => {
  test('解析 event/data 多行帧', () => { expect(parseChatRoomSseFrame('event: message.created\ndata: {"type":"message.created",\ndata: "roomId":"r1"}\n\n')?.type).toBe('message.created') })
  test('多房间查询保留逗号且 close 会停止请求', async () => { const urls: string[] = []; const statuses: string[] = []; let resolve!: () => void; const api = new ChatRoomSseClient({ baseUrl: 'http://test', fetchImpl: async (url, init) => { urls.push(String(url)); await new Promise<void>((r) => { resolve = r; init?.signal?.addEventListener('abort', () => r()) }); throw new DOMException('aborted', 'AbortError') } }); api.onStatus((s) => statuses.push(s)); api.setRooms(['r1', 'r2']); await Promise.resolve(); expect(urls[0]).toContain('roomIds=r1,r2'); api.close(); resolve?.(); expect(statuses).toContain('offline') })
  test('缺少 type 的帧被丢弃', () => { expect(parseChatRoomSseFrame('event: message.created\ndata: {"payload":{}}\n\n')).toBeUndefined() })
  test('重连前按每个房间游标补拉断线期间的持久事件并处理订阅窗口事件', async () => { let calls = 0; const received: number[] = []; const stream = (body: string) => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(body)); controller.close() } }), { headers: { 'Content-Type': 'text/event-stream' } }); const api = new ChatRoomSseClient({ baseUrl: 'http://test', fetchImpl: async (url) => { calls++; if (String(url).includes('/events?roomIds=')) return stream(calls === 1 ? 'data: {"type":"message.created","roomId":"r1","seq":1,"payload":{}}\n\n' : 'data: {"type":"message.created","roomId":"r1","seq":3,"payload":{}}\n\n'); return response({ data: [{ eventType: 'message.created', roomId: 'r1', seq: 2, payload: {} }] }) } }); api.onEvent((event) => { if (event.seq) received.push(event.seq) }); api.setRooms(['r1']); await new Promise((resolve) => setTimeout(resolve, 350)); api.close(); expect(calls).toBeGreaterThanOrEqual(3); expect(received).toEqual([1, 2, 3]) })
  test('恢复分页超过 500 条仍按序读取且有上限', async () => { let calls = 0; const stream = (body: string) => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(body)); controller.close() } }), { headers: { 'Content-Type': 'text/event-stream' } }); const received: number[] = []; const api = new ChatRoomSseClient({ baseUrl: 'http://test', fetchImpl: async (url) => { calls++; if (String(url).includes('/events?roomIds=')) return stream('data: {"type":"message.created","roomId":"r1","seq":1,"payload":{}}\n\n'); const after = Number(new URL(String(url)).searchParams.get('afterSeq')); const start = after + 1; const end = start + (start === 2 ? 499 : 1); return response({ data: Array.from({ length: end - start + 1 }, (_, index) => ({ eventType: 'message.created', roomId: 'r1', seq: start + index, payload: {} })) }) } }); api.onEvent((event) => { if (event.seq) received.push(event.seq) }); api.setRooms(['r1']); await new Promise((resolve) => setTimeout(resolve, 350)); api.close(); expect(Math.max(...received)).toBeGreaterThanOrEqual(501) })
  test('401 后 auth 恢复可显式 resume', async () => { let calls = 0; const api = new ChatRoomSseClient({ baseUrl: 'http://test', fetchImpl: async () => { calls++; return calls === 1 ? new Response(null, { status: 401 }) : new Response(null, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }) } }); api.setRooms(['r1']); await Promise.resolve(); api.resume(); await Promise.resolve(); expect(calls).toBe(2); api.close() })
  test('移除房间后旧连接迟到事件不会再分发', async () => {
    let release!: () => void
    const stream = new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('')); release = () => { controller.enqueue(new TextEncoder().encode('data: {"type":"message.created","roomId":"old","seq":1,"payload":{}}\\n\\n')); controller.close() } } }), { headers: { 'Content-Type': 'text/event-stream' } })
    const received: string[] = []
    const api = new ChatRoomSseClient({ baseUrl: 'http://test', fetchImpl: async () => stream })
    api.onEvent((event) => received.push(event.roomId ?? ''))
    api.setRooms(['old']); await Promise.resolve(); api.setRooms([]); release(); await new Promise((resolve) => setTimeout(resolve, 0)); expect(received).toEqual([])
  })
  test('恢复连续满页达到上限时显式进入重连并再次尝试', async () => {
    let streamCalls = 0
    const statuses: string[] = []
    const stream = () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('data: {"type":"message.created","roomId":"r1","seq":1,"payload":{}}\\n\\n')); controller.close() } }), { headers: { 'Content-Type': 'text/event-stream' } })
    const api = new ChatRoomSseClient({ baseUrl: 'http://test', fetchImpl: async (url) => { if (String(url).includes('roomIds=')) { streamCalls += 1; return stream() } const after = Number(new URL(String(url)).searchParams.get('afterSeq')); return response({ data: Array.from({ length: 500 }, (_, index) => ({ eventType: 'message.created', roomId: 'r1', seq: after + index + 1, payload: {} })) }) } })
    api.onStatus((status) => statuses.push(status)); api.setRooms(['r1']); await new Promise((resolve) => setTimeout(resolve, 500)); api.close(); expect(statuses).toContain('reconnecting'); expect(streamCalls).toBeGreaterThanOrEqual(2)
  })
  test('实时缺口恢复失败时中止旧连接并重连，且不提前释放缺口事件', async () => {
    let streamCalls = 0
    const statuses: string[] = []
    const received: number[] = []
    const stream = (seq: number) => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(`data: {"type":"message.created","roomId":"r1","seq":${seq},"payload":{}}\n\n`)); controller.close() } }), { headers: { 'Content-Type': 'text/event-stream' } })
    const api = new ChatRoomSseClient({ baseUrl: 'http://test', fetchImpl: async (url) => { if (String(url).includes('roomIds=')) { streamCalls += 1; return stream(streamCalls === 1 ? 1 : 3) } return response({ error: 'temporary failure' }, 500) } })
    api.onStatus((status) => statuses.push(status)); api.onEvent((event) => { if (event.seq) received.push(event.seq) }); api.setRooms(['r1']); await new Promise((resolve) => setTimeout(resolve, 420)); api.close(); expect(statuses).toContain('reconnecting'); expect(streamCalls).toBeGreaterThanOrEqual(2); expect(received).toEqual([1])
  })
  test('切换订阅房间时旧 generation 的恢复结果不会污染新连接', async () => {
    const urls: string[] = []
    const received: string[] = []
    let releaseRecovery!: () => void
    let recoveryCalls = 0
    let streamCalls = 0
    const stream = (roomId: string, seq: number) => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(`data: {"type":"message.created","roomId":"${roomId}","seq":${seq},"payload":{}}\n\n`)); controller.close() } }), { headers: { 'Content-Type': 'text/event-stream' } })
    const api = new ChatRoomSseClient({ baseUrl: 'http://test', fetchImpl: async (url) => { const value = String(url); urls.push(value); if (value.includes('roomIds=')) { streamCalls += 1; return stream(value.includes('r2') ? 'r2' : 'r1', 1) } recoveryCalls += 1; if (recoveryCalls === 1) { await new Promise<void>((resolve) => { releaseRecovery = resolve }); return response({ data: [{ eventType: 'message.created', roomId: 'r1', seq: 2, payload: {} }] }) } return response({ data: [] }) } })
    api.onEvent((event) => { if (event.roomId) received.push(event.roomId) }); api.setRooms(['r1']); await new Promise((resolve) => setTimeout(resolve, 300)); api.setRooms(['r2']); releaseRecovery(); await new Promise((resolve) => setTimeout(resolve, 10)); api.close(); expect(streamCalls).toBeGreaterThanOrEqual(2); expect(urls.some((url) => url.includes('roomIds=r2'))).toBe(true); expect(received).toEqual(['r1', 'r2'])
  })
})
