declare module 'ws' {
  import { EventEmitter } from 'node:events'
  import type { Server as HttpServer } from 'node:http'

  export class WebSocket extends EventEmitter {
    static readonly CONNECTING: number
    static readonly OPEN: number
    static readonly CLOSING: number
    static readonly CLOSED: number
    readonly readyState: number
    constructor(url: string, options?: { headers?: Record<string, string> })
    send(data: string | Buffer | ArrayBuffer | Uint8Array, cb?: (err?: Error) => void): void
    close(code?: number, reason?: string): void
    terminate(): void
  }

  export class WebSocketServer extends EventEmitter {
    constructor(options: { server?: HttpServer; port?: number })
    close(cb?: (err?: Error) => void): void
  }

  export type RawData = Buffer | ArrayBuffer | Buffer[]
  export default WebSocket
}
