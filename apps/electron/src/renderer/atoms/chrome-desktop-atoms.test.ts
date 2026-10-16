import { afterEach, describe, expect, mock, test } from 'bun:test'
import { createStore } from 'jotai'
import {
  chromeDesktopCaptureAttemptAtom,
  chromeDesktopMediaStreamAtom,
  chromeDesktopMediaStreamControlAtom,
  reserveChromeDesktopCaptureAtom,
  commitChromeDesktopCaptureAtom,
  stopChromeDesktopControlAtom,
} from './chrome-desktop-atoms'

afterEach(() => {
  Object.assign(globalThis, { window: undefined })
})

describe('Chrome Desktop capture 生命周期', () => {
  test('旧授权回包不能覆盖较新的 capture，也不能让旧失败停止新 control', async () => {
    const store = createStore()
    const oldAttempt = store.set(reserveChromeDesktopCaptureAtom, 'old') as number | null
    if (oldAttempt === null) throw new Error('授权尝试未建立')
    const oldStream = { getTracks: () => [{ stop: mock(() => {}) }] } as unknown as MediaStream
    const newAttempt = store.set(reserveChromeDesktopCaptureAtom, 'new') as number | null
    if (newAttempt === null) throw new Error('新授权尝试未建立')
    const newStream = { getTracks: () => [{ stop: mock(() => {}) }] } as unknown as MediaStream

    expect(store.set(commitChromeDesktopCaptureAtom, { attempt: oldAttempt, controlId: 'old', stream: oldStream })).toBe(false)
    expect(store.set(commitChromeDesktopCaptureAtom, { attempt: newAttempt, controlId: 'new', stream: newStream })).toBe(true)

    const stopControl = mock(async (_input: unknown) => {})
    Object.assign(globalThis, { window: { electronAPI: { chromeDesktop: { stopControl } } } })
    await store.set(stopChromeDesktopControlAtom, { sessionId: 'session', controlId: 'old' })

    expect(store.get(chromeDesktopMediaStreamAtom)).toBe(newStream)
    expect(store.get(chromeDesktopMediaStreamControlAtom)).toBe('new')
    expect(stopControl).toHaveBeenCalledWith({ sessionId: 'session', controlId: 'old' })
  })

  test('超时/取消使待处理授权代次失效，迟到 stream 被停止而非安装', () => {
    const store = createStore()
    const attempt = store.set(reserveChromeDesktopCaptureAtom, 'stale') as number | null
    if (attempt === null) throw new Error('授权尝试未建立')
    store.set(reserveChromeDesktopCaptureAtom, 'replacement')
    const trackStop = mock(() => {})
    const stream = { getTracks: () => [{ stop: trackStop }] } as unknown as MediaStream

    expect(store.set(commitChromeDesktopCaptureAtom, { attempt, controlId: 'stale', stream })).toBe(false)
    expect(trackStop).toHaveBeenCalledTimes(1)
    expect(store.get(chromeDesktopMediaStreamAtom)).toBeNull()
  })
})
