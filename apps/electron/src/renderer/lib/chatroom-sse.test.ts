import { describe, expect, test } from 'bun:test'
import { ChatRoomSseClient, parseChatRoomSseFrame } from './chatroom-sse'
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
describe('chatRoomSse', () => {
  test('解析 event/data 多行帧', () => { expect(parseChatRoomSseFrame('event: message.created\ndata: {"type":"message.created",\ndata: "roomId":"r1"}\n\n')?.type).toBe('message.created') })
  test('多房间查询保留逗号且 close 会停止请求', async () => { const urls: string[] = []; const statuses: string[] = []; let resolve!: () => void; const api = new ChatRoomSseClient({ baseUrl: 'http://test', fetchImpl: async (url, init) => { urls.push(String(url)); await new Promise<void>((r) => { resolve = r; init?.signal?.addEventListener('abort', () => r()) }); throw new DOMException('aborted', 'AbortError') } }); api.onStatus((s) => statuses.push(s)); api.setRooms(['r1', 'r2']); await Promise.resolve(); expect(urls[0]).toContain('roomIds=r1,r2'); api.close(); resolve?.(); expect(statuses).toContain('offline') })
  test('缺少 type 的帧被丢弃', () => { expect(parseChatRoomSseFrame('event: message.created\ndata: {"payload":{}}\n\n')).toBeUndefined() })
  test('重连前按每个房间游标补拉断线期间的持久事件并处理订阅窗口事件', async () => { let calls = 0; const received: number[] = []; const stream = (body: string) => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(body)); controller.close() } }), { headers: { 'Content-Type': 'text/event-stream' } }); const api = new ChatRoomSseClient({ baseUrl: 'http://test', fetchImpl: async (url) => { calls++; if (String(url).includes('/events?roomIds=')) return stream(calls === 1 ? 'data: {"type":"message.created","roomId":"r1","seq":1,"payload":{}}\n\n' : 'data: {"type":"message.created","roomId":"r1","seq":3,"payload":{}}\n\n'); if (String(url).includes('/invocations/terminal')) return response({ invocations: [], nextCursor: null }); return response({ data: [{ eventType: 'message.created', roomId: 'r1', seq: 2, payload: {} }] }) } }); api.onEvent((event) => { if (event.seq) received.push(event.seq) }); api.setRooms(['r1']); await new Promise((resolve) => setTimeout(resolve, 350)); api.close(); expect(calls).toBeGreaterThanOrEqual(3); expect(received).toEqual([1, 2, 3]) })
  test('恢复分页超过 500 条仍按序读取且有上限', async () => { let calls = 0; const stream = (body: string) => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(body)); controller.close() } }), { headers: { 'Content-Type': 'text/event-stream' } }); const received: number[] = []; const api = new ChatRoomSseClient({ baseUrl: 'http://test', fetchImpl: async (url) => { calls++; if (String(url).includes('/events?roomIds=')) return stream('data: {"type":"message.created","roomId":"r1","seq":1,"payload":{}}\n\n'); if (String(url).includes('/invocations/terminal')) return response({ invocations: [], nextCursor: null }); const after = Number(new URL(String(url)).searchParams.get('afterSeq')); const start = after + 1; const end = start + (start === 2 ? 499 : 1); return response({ data: Array.from({ length: end - start + 1 }, (_, index) => ({ eventType: 'message.created', roomId: 'r1', seq: start + index, payload: {} })) }) } }); api.onEvent((event) => { if (event.seq) received.push(event.seq) }); api.setRooms(['r1']); await new Promise((resolve) => setTimeout(resolve, 350)); api.close(); expect(Math.max(...received)).toBeGreaterThanOrEqual(501) })
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

  test('首次建立本地 SSE 后即使没有 ready 也分页恢复终态', async () => {
    const urls: string[] = []
    const recovered: unknown[] = []
    const stream = new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('')); } }), { headers: { 'Content-Type': 'text/event-stream' } })
    const api = new ChatRoomSseClient({ baseUrl: 'http://test', fetchImpl: async (url) => { urls.push(String(url)); if (String(url).includes('roomIds=')) return stream; return response({ invocations: [{ invocationId: 'i-done', roomId: 'r1', traceId: 't1', targetAgentId: 'a1', triggerMessageId: 'm1', depth: 0, status: 'completed' }, { invocationId: 'i-failed', roomId: 'r1', traceId: 't2', targetAgentId: 'a2', triggerMessageId: 'm2', depth: 1, status: 'rejected', failureCode: 'agent_offline' }], nextCursor: null }) } })
    api.onEvent((event) => recovered.push(event)); api.setRooms(['r1']); await new Promise((resolve) => setTimeout(resolve, 0)); api.close()
    expect(urls.some((url) => url.includes('/rooms/r1/invocations/terminal'))).toBe(true)
    expect(recovered).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'agent.completed', roomId: 'r1', payload: expect.objectContaining({ invocationId: 'i-done' }) }), expect.objectContaining({ type: 'agent.failed', roomId: 'r1', payload: expect.objectContaining({ invocationId: 'i-failed', failureCode: 'agent_offline' }) })]))
  })

  test('ready 晚于本地首轮查询时再次恢复，同一时刻触发则合并请求', async () => {
    let terminalCalls = 0
    let releaseReady!: () => void
    const stream = new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('')); releaseReady = () => { controller.enqueue(new TextEncoder().encode('data: {"type":"room.recovery_ready","roomId":"r1"}\n\n')) } } }), { headers: { 'Content-Type': 'text/event-stream' } })
    const api = new ChatRoomSseClient({ baseUrl: 'http://test', fetchImpl: async (url) => { if (String(url).includes('roomIds=')) return stream; terminalCalls += 1; return response({ invocations: [], nextCursor: null }) } })
    api.setRooms(['r1']); await new Promise((resolve) => setTimeout(resolve, 0)); expect(terminalCalls).toBe(1); releaseReady(); await new Promise((resolve) => setTimeout(resolve, 0)); api.close(); expect(terminalCalls).toBe(2)
  })

  test('ready 与首连恢复并发时共享同一个终态分页请求', async () => {
    let terminalCalls = 0
    let releaseTerminal!: () => void
    const stream = new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('data: {"type":"room.recovery_ready","roomId":"r1"}\n\n')) } }), { headers: { 'Content-Type': 'text/event-stream' } })
    const api = new ChatRoomSseClient({ baseUrl: 'http://test', fetchImpl: async (url) => { if (String(url).includes('roomIds=')) return stream; terminalCalls += 1; await new Promise<void>((resolve) => { releaseTerminal = resolve }); return response({ invocations: [], nextCursor: null }) } })
    api.setRooms(['r1']); await new Promise((resolve) => setTimeout(resolve, 0)); expect(terminalCalls).toBe(1); releaseTerminal(); await new Promise((resolve) => setTimeout(resolve, 0)); api.close(); expect(terminalCalls).toBe(1)
  })

  test('终态分页使用严格前进游标并拒绝重复游标和跨房间记录', async () => {
    const urls: string[] = []
    const statuses: string[] = []
    let streamCalls = 0
    const stream = () => new Response(new ReadableStream({ start(controller) { streamCalls += 1; controller.enqueue(new TextEncoder().encode('')); } }), { headers: { 'Content-Type': 'text/event-stream' } })
    const api = new ChatRoomSseClient({ baseUrl: 'http://test', fetchImpl: async (url) => { const value = String(url); urls.push(value); if (value.includes('roomIds=')) return stream(); const after = new URL(value).searchParams.get('after'); return response(after ? { invocations: [{ invocationId: 'cross', roomId: 'r2', traceId: 't', targetAgentId: 'a', triggerMessageId: 'm', depth: 0, status: 'failed' }], nextCursor: 'same' } : { invocations: [{ invocationId: 'i1', roomId: 'r1', traceId: 't', targetAgentId: 'a', triggerMessageId: 'm', depth: 0, status: 'failed' }], nextCursor: 'same' }) } })
    api.onStatus((status) => statuses.push(status)); api.setRooms(['r1']); await new Promise((resolve) => setTimeout(resolve, 300)); api.close()
    expect(urls.filter((url) => url.includes('/invocations/terminal'))).toHaveLength(2); expect(streamCalls).toBeGreaterThanOrEqual(2); expect(statuses).toContain('reconnecting')
  })

  test('终态补拉 HTTP 失败后连接重试，且失败轮次不派发为已同步', async () => {
    let streamCalls = 0
    const statuses: string[] = []
    const received: string[] = []
    const api = new ChatRoomSseClient({ baseUrl: 'http://test', fetchImpl: async (url) => { if (String(url).includes('roomIds=')) { streamCalls += 1; return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('')); } }), { headers: { 'Content-Type': 'text/event-stream' } }) } return response({ error: 'temporary' }, 503) } })
    api.onStatus((status) => statuses.push(status)); api.onEvent((event) => received.push(event.type)); api.setRooms(['r1']); await new Promise((resolve) => setTimeout(resolve, 320)); api.close()
    expect(statuses).toContain('reconnecting'); expect(streamCalls).toBeGreaterThanOrEqual(2); expect(received).not.toContain('agent.failed')
  })

  test('终态响应格式错误后连接重试且不派发不完整调用', async () => {
    let streamCalls = 0
    const statuses: string[] = []
    const received: string[] = []
    const api = new ChatRoomSseClient({ baseUrl: 'http://test', fetchImpl: async (url) => { if (String(url).includes('roomIds=')) { streamCalls += 1; return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('')) } }), { headers: { 'Content-Type': 'text/event-stream' } }) } return response({ invocations: [{ invocationId: 'bad', roomId: 'r1', traceId: 't', targetAgentId: 'a', triggerMessageId: 'm', depth: -1, status: 'completed' }], nextCursor: null }) } })
    api.onStatus((status) => statuses.push(status)); api.onEvent((event) => received.push(event.type)); api.setRooms(['r1']); await new Promise((resolve) => setTimeout(resolve, 320)); api.close()
    expect(statuses).toContain('reconnecting'); expect(streamCalls).toBeGreaterThanOrEqual(2); expect(received).not.toContain('agent.completed')
  })

  test('切换房间后旧 generation 的终态查询响应不能派发', async () => {
    let releaseOld!: () => void
    const received: string[] = []
    const api = new ChatRoomSseClient({ baseUrl: 'http://test', fetchImpl: async (url) => { const value = String(url); if (value.includes('roomIds=')) return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('')) } }), { headers: { 'Content-Type': 'text/event-stream' } }); if (value.includes('/rooms/r1/')) { await new Promise<void>((resolve) => { releaseOld = resolve }); return response({ invocations: [{ invocationId: 'old', roomId: 'r1', traceId: 't', targetAgentId: 'a', triggerMessageId: 'm', depth: 0, status: 'failed' }], nextCursor: null }) } return response({ invocations: [{ invocationId: 'new', roomId: 'r2', traceId: 't', targetAgentId: 'a', triggerMessageId: 'm', depth: 0, status: 'completed' }], nextCursor: null }) } })
    api.onEvent((event) => { if (event.type.startsWith('agent.')) received.push(String((event.payload as { invocationId?: string })?.invocationId)) }); api.setRooms(['r1']); await new Promise((resolve) => setTimeout(resolve, 0)); api.setRooms(['r2']); await new Promise((resolve) => setTimeout(resolve, 0)); releaseOld(); await new Promise((resolve) => setTimeout(resolve, 0)); api.close()
    expect(received).toEqual(['new'])
  })

  test('本地 SSE 重连即使远端没有再次 ready 仍重新补拉终态', async () => {
    let streamCalls = 0
    let terminalCalls = 0
    const api = new ChatRoomSseClient({ baseUrl: 'http://test', fetchImpl: async (url) => { if (String(url).includes('roomIds=')) { streamCalls += 1; return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('')); controller.close() } }), { headers: { 'Content-Type': 'text/event-stream' } }) } terminalCalls += 1; return response({ invocations: [], nextCursor: null }) } })
    api.setRooms(['r1']); await new Promise((resolve) => setTimeout(resolve, 260)); expect(terminalCalls).toBeGreaterThanOrEqual(1); api.close(); expect(streamCalls).toBeGreaterThanOrEqual(2); expect(terminalCalls).toBeGreaterThanOrEqual(2)
  })
})
