import { describe, expect, test } from 'bun:test'
import type { SDKMessage } from '@copis/shared'
import { attachAgentRunDuration } from './agent-rpc-duration'

describe('Agent RPC duration', () => {
  test('Given a result message When the run finishes Then it stores the elapsed duration without mutating the input', () => {
    const message = {
      type: 'result',
      subtype: 'success',
      usage: { input_tokens: 10, output_tokens: 4 },
    } as unknown as SDKMessage

    const result = attachAgentRunDuration(message, 1_000, 4_250)

    expect(result).toEqual({ ...message, _durationMs: 3_250 })
    expect(result).not.toBe(message)
    expect((message as Record<string, unknown>)._durationMs).toBeUndefined()
  })

  test('Given a non-result message When the run finishes Then it is returned unchanged', () => {
    const message = {
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'hello' }] },
    } as unknown as SDKMessage

    expect(attachAgentRunDuration(message, 1_000, 4_250)).toBe(message)
  })
})
