export interface ChatRoomDeltaFrameLimits {
  maxPerInvocation: number
  maxTotal: number
}

export const CHATROOM_DELTA_FRAME_DEFAULT_LIMITS: Readonly<ChatRoomDeltaFrameLimits> = Object.freeze({
  maxPerInvocation: 8192,
  maxTotal: 32768,
})

export interface ChatRoomDeltaFrameState {
  readonly frames: ReadonlyMap<string, ReadonlyMap<string, ReadonlyMap<string, string>>>
  readonly total: number
}

export type ChatRoomDeltaFrameDecision = 'append' | 'duplicate' | 'conflict' | 'capacity' | 'invalid'

export interface ChatRoomDeltaFrameInput {
  roomId: unknown
  invocationId: unknown
  frameId: unknown
  delta: unknown
}

export function createChatRoomDeltaFrameState(): ChatRoomDeltaFrameState {
  return { frames: new Map(), total: 0 }
}

function isValidLimits(limits: ChatRoomDeltaFrameLimits): boolean {
  return Number.isSafeInteger(limits.maxPerInvocation) && limits.maxPerInvocation >= 0
    && Number.isSafeInteger(limits.maxTotal) && limits.maxTotal >= 0
}

export function applyChatRoomDeltaFrame(
  state: ChatRoomDeltaFrameState,
  input: ChatRoomDeltaFrameInput,
  limits: Partial<ChatRoomDeltaFrameLimits> = {},
): { state: ChatRoomDeltaFrameState; decision: ChatRoomDeltaFrameDecision } {
  const effectiveLimits = { ...CHATROOM_DELTA_FRAME_DEFAULT_LIMITS, ...limits }
  if (!isValidLimits(effectiveLimits)
    || typeof input.roomId !== 'string' || input.roomId.length === 0
    || typeof input.invocationId !== 'string' || input.invocationId.length === 0
    || typeof input.frameId !== 'string' || !/^[0-9a-f]{32}$/.test(input.frameId)
    || typeof input.delta !== 'string') return { state, decision: 'invalid' }

  const invocationFrames = state.frames.get(input.roomId)?.get(input.invocationId)
  const existingDelta = invocationFrames?.get(input.frameId)
  if (existingDelta !== undefined) {
    return { state, decision: existingDelta === input.delta ? 'duplicate' : 'conflict' }
  }
  if (state.total >= effectiveLimits.maxTotal || (invocationFrames?.size ?? 0) >= effectiveLimits.maxPerInvocation) {
    return { state, decision: 'capacity' }
  }

  const frames = new Map(state.frames)
  const roomFrames = new Map(frames.get(input.roomId) ?? [])
  const nextInvocationFrames = new Map(invocationFrames ?? [])
  nextInvocationFrames.set(input.frameId, input.delta)
  roomFrames.set(input.invocationId, nextInvocationFrames)
  frames.set(input.roomId, roomFrames)
  return { state: { frames, total: state.total + 1 }, decision: 'append' }
}

export function clearChatRoomDeltaFrames(
  state: ChatRoomDeltaFrameState,
  input: { roomId: string; invocationId?: string },
): ChatRoomDeltaFrameState {
  const roomFrames = state.frames.get(input.roomId)
  if (!roomFrames) return state

  const frames = new Map(state.frames)
  if (input.invocationId !== undefined) {
    const invocationFrames = roomFrames.get(input.invocationId)
    if (!invocationFrames) return state
    const nextRoomFrames = new Map(roomFrames)
    nextRoomFrames.delete(input.invocationId)
    if (nextRoomFrames.size === 0) frames.delete(input.roomId)
    else frames.set(input.roomId, nextRoomFrames)
    return { frames, total: state.total - invocationFrames.size }
  }

  const removedFrames = [...roomFrames.values()].reduce((sum, invocationFrames) => sum + invocationFrames.size, 0)
  frames.delete(input.roomId)
  return { frames, total: state.total - removedFrames }
}
