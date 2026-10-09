import { EventEmitter } from 'node:events'
import { expect, test } from 'bun:test'
import { watchChatRoomReadinessConfig } from './chatroom-readiness-config-watcher'

class FixtureWatcher extends EventEmitter {
  closed = false
  close(): void { this.closed = true }
  unref(): this { return this }
}

test('watch init failure triggers a config refresh and bounded retry reattaches', async () => {
  let attempts = 0
  let refreshes = 0
  let watcher!: FixtureWatcher
  const stop = watchChatRoomReadinessConfig({
    directory: '/fixture/config',
    onChanged: () => { refreshes++ },
    retryBaseMs: 2,
    retryMaxMs: 8,
    debounceMs: 0,
    watchDirectory: () => {
      attempts++
      if (attempts === 1) throw new Error('fixture watcher init failure')
      watcher = new FixtureWatcher()
      return watcher as never
    },
  })
  await new Promise((resolve) => setTimeout(resolve, 10))
  expect(attempts).toBeGreaterThan(1)
  expect(attempts).toBeLessThan(7)
  expect(refreshes).toBeGreaterThan(0)
  expect(watcher.closed).toBe(false)
  stop()
  expect(watcher.closed).toBe(true)
})

test('watch runtime error refreshes config, retries attachment, and dispose cancels retry and callbacks', async () => {
  const watchers: FixtureWatcher[] = []
  let refreshes = 0
  const stop = watchChatRoomReadinessConfig({
    directory: '/fixture/config',
    onChanged: () => { refreshes++ },
    retryBaseMs: 2,
    retryMaxMs: 8,
    debounceMs: 0,
    watchDirectory: () => {
      const watcher = new FixtureWatcher()
      watchers.push(watcher)
      return watcher as never
    },
  })
  watchers[0]!.emit('error', new Error('fixture watcher error'))
  await new Promise((resolve) => setTimeout(resolve, 10))
  expect(watchers.length).toBeGreaterThan(1)
  expect(watchers.length).toBeLessThan(7)
  expect(refreshes).toBeGreaterThan(0)
  const callbacksBeforeDispose = refreshes
  stop()
  for (const watcher of watchers) watcher.emit('change', 'channels.json')
  await new Promise((resolve) => setTimeout(resolve, 5))
  expect(watchers.every((watcher) => watcher.closed)).toBe(true)
  expect(refreshes).toBe(callbacksBeforeDispose)
})

test('a readiness config filename triggers refresh but unrelated files are ignored', async () => {
  const watcher = new FixtureWatcher()
  let onFsEvent!: (event: string, filename: string | Buffer | null) => void
  let refreshes = 0
  const stop = watchChatRoomReadinessConfig({
    directory: '/fixture/config',
    onChanged: () => { refreshes++ },
    debounceMs: 0,
    watchDirectory: (_directory, listener) => { onFsEvent = listener; return watcher as never },
  })
  onFsEvent('rename', 'unrelated.json')
  await new Promise((resolve) => setTimeout(resolve, 2))
  expect(refreshes).toBe(0)
  onFsEvent('rename', 'channels.json')
  await new Promise((resolve) => setTimeout(resolve, 2))
  expect(refreshes).toBe(1)
  stop()
})
