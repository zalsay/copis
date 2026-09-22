import type { ChatRoomConnectionStatus, ChatRoomEventEnvelope } from '@copis/shared'
import { RENDERER_HTTP_API_BASE_URL } from './http-api-base-url'
import { withHttpApiWebToken } from './http-api-web-token'

export type ChatRoomSseListener = (event: ChatRoomEventEnvelope) => void
export type ChatRoomSseStatusListener = (status: ChatRoomConnectionStatus) => void
type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export function parseChatRoomSseFrame(frame: string): ChatRoomEventEnvelope | undefined {
  const data: string[] = []
  for (const line of frame.split(/\r?\n/)) {
    if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
  }
  if (!data.length) return undefined
  try { const parsed = JSON.parse(data.join('\n')) as Record<string, unknown>; if (typeof parsed !== 'object' || parsed === null || typeof parsed.type !== 'string' || !parsed.type) return undefined; return { type: parsed.type, roomId: typeof parsed.roomId === 'string' ? parsed.roomId : undefined, seq: typeof parsed.seq === 'number' ? parsed.seq : undefined, latestSeq: typeof parsed.latestSeq === 'number' ? parsed.latestSeq : undefined, payload: parsed.payload } } catch { return undefined }
}

export class ChatRoomSseClient {
  private readonly listeners = new Set<ChatRoomSseListener>()
  private readonly statusListeners = new Set<ChatRoomSseStatusListener>()
  private readonly fetchImpl: FetchLike
  private readonly baseUrl: string
  private controller: AbortController | undefined
  private roomIds = new Set<string>()
  private stopped = false
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined
  private attempt = 0
  private hasConnected = false
  private readonly cursors = new Map<string, number>()
  private readonly buffered = new Map<string, ChatRoomEventEnvelope[]>()
  private readonly recovering = new Set<string>()
  private generation = 0
  constructor(options: { fetchImpl?: FetchLike; baseUrl?: string } = {}) { this.fetchImpl = options.fetchImpl ?? fetch; this.baseUrl = options.baseUrl ?? RENDERER_HTTP_API_BASE_URL }
  onEvent(listener: ChatRoomSseListener): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  onStatus(listener: ChatRoomSseStatusListener): () => void { this.statusListeners.add(listener); return () => this.statusListeners.delete(listener) }
  subscribe(roomIds: Iterable<string>): () => void { for (const id of roomIds) this.roomIds.add(id); this.start(); return () => { for (const id of roomIds) this.roomIds.delete(id); if (!this.roomIds.size) this.close() } }
  setRooms(roomIds: Iterable<string>): void { const values = [...roomIds]; if (values.some((id) => id.includes(','))) throw new Error('聊天室 ID 不允许包含逗号') ; const next = new Set(values); const changed = next.size !== this.roomIds.size || [...next].some((id) => !this.roomIds.has(id)); this.roomIds = next; if (!this.roomIds.size) { this.close(); return } this.stopped = false; if (changed && this.controller) { this.controller.abort(); this.controller = undefined; this.generation += 1 } this.start() }
  resume(): void { if (!this.roomIds.size) return; this.stopped = false; this.attempt = 0; this.start() }
  private status(status: ChatRoomConnectionStatus): void { for (const listener of this.statusListeners) listener(status) }
  private start(): void { if (this.controller || this.stopped || !this.roomIds.size) return; this.stopped = false; this.controller = new AbortController(); const generation = ++this.generation; this.status(this.attempt ? 'reconnecting' : 'connecting'); void this.connect(this.controller, generation) }
  private isCurrent(controller: AbortController, generation: number): boolean { return this.controller === controller && this.generation === generation && !this.stopped }
  private async connect(controller: AbortController, generation: number): Promise<void> {
    const query = [...this.roomIds].join(',');
    let recoveryFailure = false
    let liveBuffering = false
    const liveBuffer: ChatRoomEventEnvelope[] = []
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/api/chatrooms/v2/events?roomIds=${query}`, withHttpApiWebToken({ headers: { Accept: 'text/event-stream' }, signal: controller.signal }))
      if (response.status === 401 || response.status === 403) { this.status('auth_expired'); return }
      if (!response.ok || !response.body) throw new Error(`SSE HTTP ${response.status}`)
      this.attempt = 0; const hadConnected = this.hasConnected; this.hasConnected = true; this.status('connected'); const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = ''
      const readLive = async (): Promise<void> => { while (!controller.signal.aborted && this.isCurrent(controller, generation)) { const part = await reader.read(); if (part.done) break; buffer += decoder.decode(part.value, { stream: true }); const frames = buffer.split(/\r?\n\r?\n/); buffer = frames.pop() ?? ''; for (const frame of frames) { const event = parseChatRoomSseFrame(frame); if (event) { if (liveBuffering) liveBuffer.push(event); else this.receive(event, controller, generation) } } } }
      const livePromise = readLive()
      if (hadConnected) {
        liveBuffering = true
        let recoveryFailed = false
        try { await this.recoverRooms(controller, generation) } catch { recoveryFailed = true; recoveryFailure = true; this.failConnection(controller, generation); throw new Error('聊天室事件恢复失败') }
        finally { liveBuffering = false; const queued = liveBuffer.splice(0); if (!recoveryFailed) for (const event of queued) this.receive(event, controller, generation) }
      }
      await livePromise
      if (!controller.signal.aborted) throw new Error('SSE disconnected')
    } catch (error) { if ((!controller.signal.aborted || recoveryFailure) && !this.stopped) this.scheduleReconnect() }
    finally { if (this.controller === controller) this.controller = undefined }
  }
  private async recoverRooms(controller: AbortController, generation: number): Promise<void> { for (const roomId of this.roomIds) { if (!this.isCurrent(controller, generation)) return; await this.recoverRoom(roomId, controller, generation) } }
  private normalizeRecoveryEvent(value: unknown, expectedRoomId: string): ChatRoomEventEnvelope | undefined { if (typeof value !== 'object' || value === null) return undefined; const raw = value as Record<string, unknown>; const type = typeof raw.eventType === 'string' ? raw.eventType : undefined; const roomId = typeof raw.roomId === 'string' ? raw.roomId : undefined; const seq = typeof raw.seq === 'number' && Number.isSafeInteger(raw.seq) && raw.seq > 0 ? raw.seq : undefined; if (!type || !roomId || roomId !== expectedRoomId || seq === undefined) return undefined; return { type, roomId, seq, payload: raw.payload } }
  private async recoverRoom(roomId: string, controller: AbortController, generation: number): Promise<void> { const recoveryKey = `${generation}:${roomId}`; if (this.recovering.has(recoveryKey)) return; this.recovering.add(recoveryKey); try { let afterSeq = this.cursors.get(roomId) ?? 0; let exhausted = true; for (let page = 0; page < 100; page += 1) { if (!this.isCurrent(controller, generation) || !this.roomIds.has(roomId)) return; const response = await this.fetchImpl(`${this.baseUrl}/api/chatrooms/v2/rooms/${encodeURIComponent(roomId)}/events?afterSeq=${afterSeq}&limit=500`, withHttpApiWebToken({ headers: { Accept: 'application/json' }, signal: controller.signal })); if (!response.ok) throw new Error(`聊天室事件补拉失败（${response.status}）`); const raw = await response.json() as unknown; const root = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : {}; const values = Array.isArray(root.data) ? root.data : Array.isArray(root.events) ? root.events : Array.isArray(raw) ? raw : []; if (!values.length) { exhausted = false; break } let pageLast = afterSeq; for (const value of values) { const event = this.normalizeRecoveryEvent(value, roomId); if (!event) throw new Error('聊天室事件恢复响应包含无效事件'); if ((event.seq ?? 0) > pageLast) pageLast = event.seq!; const cursor = this.cursors.get(roomId) ?? 0; if (event.seq! <= cursor) continue; if (event.seq! > cursor + 1) throw new Error('聊天室事件恢复出现序列缺口'); this.receive(event, controller, generation) } if (pageLast <= afterSeq) throw new Error('聊天室事件恢复序列未前进'); if (values.length < 500) { exhausted = false; break } afterSeq = pageLast } if (exhausted) throw new Error('聊天室事件恢复达到分页上限，请重新同步'); const pending = (this.buffered.get(roomId) ?? []).sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0)); this.buffered.delete(roomId); for (const event of pending) this.receive(event, controller, generation) } finally { this.recovering.delete(recoveryKey) } }
  private receive(event: ChatRoomEventEnvelope, controller: AbortController, generation: number): void { if (!this.isCurrent(controller, generation)) return; const roomId = event.roomId; if (roomId && !this.roomIds.has(roomId)) return; if (!roomId || event.seq === undefined) { for (const listener of this.listeners) listener(event); return } const cursor = this.cursors.get(roomId) ?? 0; if (event.seq <= cursor) return; if (event.seq > cursor + 1) { const list = this.buffered.get(roomId) ?? []; list.push(event); this.buffered.set(roomId, list); void this.recoverRoom(roomId, controller, generation).then(() => { if (!this.isCurrent(controller, generation)) return; const pending = (this.buffered.get(roomId) ?? []).sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0)); this.buffered.delete(roomId); for (const item of pending) this.receive(item, controller, generation) }).catch(() => this.failConnection(controller, generation, roomId)); return } this.cursors.set(roomId, event.seq); for (const listener of this.listeners) listener(event) }
  private failConnection(controller: AbortController, generation: number, roomId?: string): void { if (!this.isCurrent(controller, generation)) return; if (roomId) this.buffered.delete(roomId); else this.buffered.clear(); controller.abort(); this.controller = undefined; this.scheduleReconnect() }
  private scheduleReconnect(): void { if (this.stopped || this.reconnectTimer) return; this.status('reconnecting'); const delay = Math.min(5000, 250 * 2 ** Math.min(this.attempt++, 4)); this.reconnectTimer = setTimeout(() => { this.reconnectTimer = undefined; this.start() }, delay) }
  close(): void { this.stopped = true; this.generation += 1; if (this.reconnectTimer) clearTimeout(this.reconnectTimer); this.reconnectTimer = undefined; this.controller?.abort(); this.controller = undefined; this.buffered.clear(); this.status('offline') }
}
