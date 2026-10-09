import { describe, expect, test } from 'bun:test'
import { applyChatRoomDeltaFrame, CHATROOM_DELTA_FRAME_DEFAULT_LIMITS, clearChatRoomDeltaFrames, createChatRoomDeltaFrameState } from './chatroom-delta-frames'

const frame = (overrides: Partial<{ roomId: unknown; invocationId: unknown; frameId: unknown; delta: unknown }> = {}) => ({
  roomId: 'r1', invocationId: 'i1', frameId: 'a'.repeat(32), delta: '哈', ...overrides,
})

describe('chatroom delta frame identity', () => {
  test('同身份同内容只识别一次，不同身份的相同文本都保留且旧 state 不变', () => {
    const empty = createChatRoomDeltaFrameState()
    const first = applyChatRoomDeltaFrame(empty, frame())
    const duplicate = applyChatRoomDeltaFrame(first.state, frame())
    const distinct = applyChatRoomDeltaFrame(first.state, frame({ frameId: 'b'.repeat(32) }))

    expect(first.decision).toBe('append')
    expect(duplicate.decision).toBe('duplicate')
    expect(duplicate.state).toBe(first.state)
    expect(distinct.decision).toBe('append')
    expect(empty.total).toBe(0)
    expect(first.state.total).toBe(1)
    expect(distinct.state.total).toBe(2)
  })

  test('相同 frameId 改变 delta 时返回冲突且不覆盖原身份', () => {
    const first = applyChatRoomDeltaFrame(createChatRoomDeltaFrameState(), frame())
    const conflict = applyChatRoomDeltaFrame(first.state, frame({ delta: '改内容' }))

    expect(conflict.decision).toBe('conflict')
    expect(conflict.state).toBe(first.state)
    expect(conflict.state.total).toBe(1)
  })

  test('达到 invocation 或全局容量时不驱逐已有身份，也不允许重放重新追加', () => {
    const limits = { maxPerInvocation: 1, maxTotal: 2 }
    const first = applyChatRoomDeltaFrame(createChatRoomDeltaFrameState(), frame(), limits)
    const same = applyChatRoomDeltaFrame(first.state, frame(), limits)
    const perInvocationFull = applyChatRoomDeltaFrame(first.state, frame({ frameId: 'b'.repeat(32) }), limits)
    const secondInvocation = applyChatRoomDeltaFrame(first.state, frame({ invocationId: 'i2' }), limits)
    const totalFull = applyChatRoomDeltaFrame(secondInvocation.state, frame({ invocationId: 'i3' }), limits)

    expect(same.decision).toBe('duplicate')
    expect(perInvocationFull.decision).toBe('capacity')
    expect(secondInvocation.decision).toBe('append')
    expect(totalFull.decision).toBe('capacity')
    expect(totalFull.state.total).toBe(2)
    expect(applyChatRoomDeltaFrame(totalFull.state, frame(), limits).decision).toBe('duplicate')
  })

  test('拒绝无效房间、调用、帧 ID 或 delta，而不改变 state', () => {
    const state = createChatRoomDeltaFrameState()
    const invalidFrames = [
      frame({ roomId: '' }),
      frame({ invocationId: '' }),
      frame({ frameId: 'A'.repeat(32) }),
      frame({ frameId: 'a'.repeat(31) }),
      frame({ delta: 1 }),
    ]

    for (const invalid of invalidFrames) {
      const result = applyChatRoomDeltaFrame(state, invalid)
      expect(result.decision).toBe('invalid')
      expect(result.state).toBe(state)
    }
  })

  test('按调用或房间清理身份并返回独立 state', () => {
    let state = createChatRoomDeltaFrameState()
    state = applyChatRoomDeltaFrame(state, frame()).state
    state = applyChatRoomDeltaFrame(state, frame({ invocationId: 'i2' })).state
    state = applyChatRoomDeltaFrame(state, frame({ roomId: 'r2' })).state

    const oneInvocation = clearChatRoomDeltaFrames(state, { roomId: 'r1', invocationId: 'i1' })
    const oneRoom = clearChatRoomDeltaFrames(oneInvocation, { roomId: 'r1' })

    expect(state.total).toBe(3)
    expect(oneInvocation.total).toBe(2)
    expect(oneRoom.total).toBe(1)
    expect(oneRoom.frames.has('r2')).toBe(true)
  })

  test('生产默认容量保持每调用 8192、全局 32768', () => {
    expect(CHATROOM_DELTA_FRAME_DEFAULT_LIMITS).toEqual({ maxPerInvocation: 8192, maxTotal: 32768 })
  })
})
