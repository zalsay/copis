import { expect, test } from 'bun:test'
import {
  CHATROOM_IPC_CHANNELS,
  isChatRoomAgentInvocation,
  isChatRoomAgentOutput,
  normalizeChatRoomContextMessageCount,
} from './chatroom'

test('Given 结构化 Agent 输出 When 校验 Then 只接受三个固定字段的有界对象', () => {
  expect(isChatRoomAgentOutput({ text: '完成', mentionedAgentIds: ['agent-b'], attachmentIds: [] })).toBe(true)
  expect(isChatRoomAgentOutput({ text: '完成', mentionedAgentIds: '@agent-b', attachmentIds: [] })).toBe(false)
  expect(isChatRoomAgentOutput({ text: '完成', mentionedAgentIds: [], attachmentIds: [], token: 'secret' })).toBe(false)
  expect(isChatRoomAgentOutput({ text: '完成', mentionedAgentIds: [''], attachmentIds: [] })).toBe(false)
  expect(isChatRoomAgentOutput({ text: '完成', mentionedAgentIds: ['a', 'b', 'c', 'd'], attachmentIds: [] })).toBe(false)
  expect(isChatRoomAgentOutput({ text: 'x'.repeat(200_001), mentionedAgentIds: [], attachmentIds: [] })).toBe(false)
})

test('Given 上下文数量越界 When 归一化 Then 限制在 1 到 200 且默认 50', () => {
  expect(normalizeChatRoomContextMessageCount(undefined)).toBe(50)
  expect(normalizeChatRoomContextMessageCount(0)).toBe(1)
  expect(normalizeChatRoomContextMessageCount(500)).toBe(200)
})

test('Given invocation 包含协议外字段 When 通过 Rust bridge 校验 Then 拒绝未知字段', () => {
  const invocation = {
    invocationId: 'inv-1',
    roomId: 'room-1',
    traceId: 'trace-1',
    targetAgentId: 'agent-a',
    triggerMessageId: 'message-1',
    depth: 0,
    sender: { type: 'user' as const, id: 'user-1', displayName: '主理人' },
    messages: [],
    receivedAt: Date.now(),
  }
  expect(isChatRoomAgentInvocation(invocation)).toBe(true)
  expect(isChatRoomAgentInvocation({ ...invocation, token: 'secret' })).toBe(false)
})

test('Given Chatroom IPC 常量 When 读取 Then 通道只覆盖 Main 本地能力', () => {
  expect(CHATROOM_IPC_CHANNELS.PROVISION_AGENT).toBe('chatrooms:provision-agent')
  expect(Object.values(CHATROOM_IPC_CHANNELS)).not.toContain('chatrooms:send-message')
})
