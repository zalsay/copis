import { describe, expect, test } from 'bun:test'
import { normalizeChatRoomMessage } from './chatroom-api'

describe('normalizeChatRoomMessage', () => {
  test('兼容 edu-api ChatRoomV2MessageResponse 的用户发送者字段', () => {
    const message = normalizeChatRoomMessage({
      messageId: 'm-user', roomId: 'room-1', seq: 4, senderType: 'user', senderUserId: 27,
      content: '请 Agent 处理', mentionAgentIds: ['agent-a'], attachmentIds: [], clientMessageId: 'c-1', depth: 0,
      createdAt: '2026-09-22T10:00:00Z',
    })
    expect(message).toMatchObject({ senderType: 'user', senderId: '27', content: '请 Agent 处理' })
  })

  test('兼容 edu-api ChatRoomV2MessageResponse 的 Agent 发送者字段', () => {
    const message = normalizeChatRoomMessage({
      messageId: 'm-agent', roomId: 'room-1', seq: 5, senderType: 'agent', senderAgentId: 'agent-a',
      content: '已完成', mentionAgentIds: [], attachmentIds: [], clientMessageId: 'c-2', traceId: 'trace-1', depth: 1,
      createdAt: '2026-09-22T10:00:01Z',
    })
    expect(message).toMatchObject({ senderType: 'agent', senderId: 'agent-a', traceId: 'trace-1', content: '已完成' })
  })
})
