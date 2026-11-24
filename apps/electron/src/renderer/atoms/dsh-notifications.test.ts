import { expect, test } from 'bun:test'
import { createStore } from 'jotai'
import { applyDshNotificationEventAtom, unviewedDshSessionIdsAtom } from './dsh-notifications'

test('Given DSH 和 Agent 使用不同的未读集合 When DSH 重复完成或被查看 Then 只计一次且逐会话清除', () => {
  const store = createStore()
  const complete = { type: 'COPIS_DSH_SESSION_COMPLETED' as const, sessionId: 'a', title: '测试', completionSeq: 10, viewed: false, windowFocused: false }
  expect(store.set(applyDshNotificationEventAtom, complete)).toBe(true)
  expect(store.set(applyDshNotificationEventAtom, complete)).toBe(false)
  store.set(applyDshNotificationEventAtom, { ...complete, sessionId: 'b' })
  expect([...store.get(unviewedDshSessionIdsAtom)]).toEqual(['a', 'b'])
  store.set(applyDshNotificationEventAtom, { type: 'COPIS_DSH_SESSION_VIEWED', sessionId: 'a' })
  expect([...store.get(unviewedDshSessionIdsAtom)]).toEqual(['b'])
  expect(store.set(applyDshNotificationEventAtom, complete)).toBe(false)
  expect(store.set(applyDshNotificationEventAtom, { ...complete, completionSeq: 9 })).toBe(false)
  expect(store.set(applyDshNotificationEventAtom, { ...complete, completionSeq: 11, viewed: true })).toBe(true)
  expect([...store.get(unviewedDshSessionIdsAtom)]).toEqual(['b'])
})
