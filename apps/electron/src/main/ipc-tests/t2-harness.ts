import { mock } from 'bun:test'

type Handler = (...args: unknown[]) => unknown

export function createIpcHarness() {
  const handlers = new Map<string, Handler>()
  const listeners = new Map<string, Handler>()
  return {
    ipcMain: {
      handle: mock((channel: string, handler: Handler) => { handlers.set(channel, handler) }),
      on: mock((channel: string, handler: Handler) => { listeners.set(channel, handler) }),
    },
    invoke(channel: string, ...args: unknown[]) {
      const handler = handlers.get(channel)
      if (!handler) throw new Error(`未注册 IPC: ${channel}`)
      return handler(...args)
    },
    emit(channel: string, ...args: unknown[]) {
      const listener = listeners.get(channel)
      if (!listener) throw new Error(`未注册监听: ${channel}`)
      return listener(...args)
    },
  }
}
