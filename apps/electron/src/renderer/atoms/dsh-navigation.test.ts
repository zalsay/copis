import { expect, test } from 'bun:test'
import { createStore } from 'jotai'
import { pendingDshNewSessionsAtom, requestDshNewSessionAtom, acknowledgeDshNewSessionAtom } from './dsh-navigation'

test('冷启动或重载不丢请求，仅匹配队首的客户端回执才能消费一次', () => {
  const store = createStore()
  store.set(requestDshNewSessionAtom); store.set(requestDshNewSessionAtom)
  const [first, second] = store.get(pendingDshNewSessionsAtom)
  expect(first).toBeTruthy(); expect(second).not.toBe(first)
  store.set(acknowledgeDshNewSessionAtom, second!)
  expect(store.get(pendingDshNewSessionsAtom)).toEqual([first, second])
  store.set(acknowledgeDshNewSessionAtom, first!); store.set(acknowledgeDshNewSessionAtom, first!)
  expect(store.get(pendingDshNewSessionsAtom)).toEqual([second])
  store.set(acknowledgeDshNewSessionAtom, second!)
  expect(store.get(pendingDshNewSessionsAtom)).toEqual([])
})
