import { describe, expect, test } from 'bun:test'
import { canonicalChatRoomReplyJson, computeChatRoomReplyDigest } from './chatroom-reply-digest'

describe('chatroom reply digest', () => {
  test('Given Go HTML separators and repeated IDs When digesting Then match the cross-language canonical bytes and SHA-256', () => {
    const input = {
      clientMessageId: 'reply-1',
      text: '<ok>&\u2028\u2029',
      attachmentIds: [],
      mentionedAgentIds: ['agent-1', 'agent-1'],
    }

    expect(canonicalChatRoomReplyJson(input)).toBe('{"attachmentIds":[],"clientMessageId":"reply-1","content":"\\u003cok\\u003e\\u0026\\u2028\\u2029","mentionAgentIds":["agent-1"]}')
    expect(computeChatRoomReplyDigest(input)).toBe('c7180d64124a0e45f9b8705c40d9729d985a08752092a86c557b4ef9dcd44c35')
  })

  test('Given invalid Unicode or Rust-forbidden control in reply data When digesting Then reject before producing ambiguous bytes', () => {
    expect(() => computeChatRoomReplyDigest({ clientMessageId: 'reply-1', text: '\ud800', attachmentIds: [], mentionedAgentIds: [] })).toThrow()
    expect(() => computeChatRoomReplyDigest({ clientMessageId: 'reply-1', text: 'reply\u0001', attachmentIds: [], mentionedAgentIds: [] })).toThrow()
  })
})
