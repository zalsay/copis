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
  constructor(options: { fetchImpl?: FetchLike; baseUrl?: string } = {}) { this.fetchImpl = options.fetchImpl ?? fetch; this.baseUrl = options.baseUrl ?? RENDERER_HTTP_API_BASE_URL }
  onEvent(listener: ChatRoomSseListener): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  onStatus(listener: ChatRoomSseStatusListener): () => void { this.statusListeners.add(listener); return () => this.statusListeners.delete(listener) }
  subscribe(roomIds: Iterable<string>): () => void { for (const id of roomIds) this.roomIds.add(id); this.start(); return () => { for (const id of roomIds) this.roomIds.delete(id); if (!this.roomIds.size) this.close() } }
  setRooms(roomIds: Iterable<string>): void { const values = [...roomIds]; if (values.some((id) => id.includes(','))) throw new Error('聊天室 ID 不允许包含逗号') ; const next = new Set(values); const changed = next.size !== this.roomIds.size || [...next].some((id) => !this.roomIds.has(id)); this.roomIds = next; if (!this.roomIds.size) { this.close(); return } this.stopped = false; if (changed && this.controller) { this.controller.abort(); this.controller = undefined } this.start() }
  resume(): void { if (!this.roomIds.size) return; this.stopped = false; this.attempt = 0; this.start() }
  private status(status: ChatRoomConnectionStatus): void { for (const listener of this.statusListeners) listener(status) }
  private start(): void { if (this.controller || this.stopped || !this.roomIds.size) return; this.stopped = false; this.controller = new AbortController(); this.status(this.attempt ? 'reconnecting' : 'connecting'); void this.connect(this.controller) }
  private async connect(controller: AbortController): Promise<void> {
    const query = [...this.roomIds].join(',');
    try {
      if (this.hasConnected) await this.recoverRooms(controller)
      if (controller.signal.aborted || this.stopped) return
      const response = await this.fetchImpl(`${this.baseUrl}/api/chatrooms/v2/events?roomIds=${query}`, withHttpApiWebToken({ headers: { Accept: 'text/event-stream' }, signal: controller.signal }))
      if (response.status === 401 || response.status === 403) { this.status('auth_expired'); return }
      if (!response.ok || !response.body) throw new Error(`SSE HTTP ${response.status}`)
      this.attempt = 0; this.hasConnected = true; this.status('connected'); const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = ''
      while (!controller.signal.aborted) { const part = await reader.read(); if (part.done) break; buffer += decoder.decode(part.value, { stream: true }); const frames = buffer.split(/\r?\n\r?\n/); buffer = frames.pop() ?? ''; for (const frame of frames) { const event = parseChatRoomSseFrame(frame); if (event) this.receive(event, controller) } }
      if (!controller.signal.aborted) throw new Error('SSE disconnected')
    } catch (error) { if (!controller.signal.aborted && !this.stopped) this.scheduleReconnect() }
    finally { if (this.controller === controller) this.controller = undefined }
  }
  private async recoverRooms(controller: AbortController): Promise<void> { for (const roomId of this.roomIds) { if (controller.signal.aborted) return; await this.recoverRoom(roomId, controller) } }
  private async recoverRoom(roomId: string, controller: AbortController): Promise<void> { const afterSeq = this.cursors.get(roomId) ?? 0; const response = await this.fetchImpl(`${this.baseUrl}/api/chatrooms/v2/rooms/${encodeURIComponent(roomId)}/events?afterSeq=${afterSeq}&limit=500`, withHttpApiWebToken({ headers: { Accept: 'application/json' }, signal: controller.signal })); if (!response.ok) throw new Error(`聊天室事件补拉失败（${response.status}）`); const raw = await response.json() as unknown; const root = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : {}; const values = Array.isArray(root.data) ? root.data : Array.isArray(root.events) ? root.events : Array.isArray(raw) ? raw : []; for (const value of values) { const event = value as ChatRoomEventEnvelope; if (event && event.type) this.receive(event, controller) } }
  private receive(event: ChatRoomEventEnvelope, controller: AbortController): void { const roomId = event.roomId; if (!roomId || event.seq === undefined) { for (const listener of this.listeners) listener(event); return } const cursor = this.cursors.get(roomId) ?? 0; if (event.seq <= cursor) return; if (event.seq > cursor + 1) { const list = this.buffered.get(roomId) ?? []; list.push(event); this.buffered.set(roomId, list); void this.recoverRoom(roomId, controller).then(() => { const pending = (this.buffered.get(roomId) ?? []).sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0)); this.buffered.delete(roomId); for (const item of pending) this.receive(item, controller) }).catch(() => undefined); return } this.cursors.set(roomId, event.seq); for (const listener of this.listeners) listener(event) }
  private scheduleReconnect(): void { this.status('reconnecting'); const delay = Math.min(5000, 250 * 2 ** Math.min(this.attempt++, 4)); this.reconnectTimer = setTimeout(() => { this.reconnectTimer = undefined; this.start() }, delay) }
  close(): void { this.stopped = true; if (this.reconnectTimer) clearTimeout(this.reconnectTimer); this.reconnectTimer = undefined; this.controller?.abort(); this.controller = undefined; this.status('offline') }
}
