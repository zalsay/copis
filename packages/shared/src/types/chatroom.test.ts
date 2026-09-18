import { expect, test } from 'bun:test'
import {
  CHATROOM_IPC_CHANNELS,
  isChatRoomAgentInvocation,
  isChatRoomAgentOutput,
  isChatRoomPermissionResponse,
  isProvisionChatRoomAgentInput,
  isRemoveChatRoomAgentInput,
  isSyncChatRoomAgentSkillsInput,
  isUpdateChatRoomAgentInput,
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

test('Given Renderer provision 输入 When 校验 Then 严格限制字段和基础值', () => {
  const input = {
    roomId: 'room-1',
    sourceWorkspaceId: 'workspace-1',
    displayName: '分析 Agent',
    channelId: 'channel-1',
    modelId: 'model-1',
    contextMessageCount: 50,
    memorySharingEnabled: false,
    skillSharingEnabled: true,
  }
  expect(isProvisionChatRoomAgentInput(input)).toBe(true)
  expect(isProvisionChatRoomAgentInput({ ...input, displayName: ' ' })).toBe(false)
  expect(isProvisionChatRoomAgentInput({ ...input, contextMessageCount: 1.5 })).toBe(false)
  expect(isProvisionChatRoomAgentInput({ ...input, memorySharingEnabled: 'false' })).toBe(false)
  expect(isProvisionChatRoomAgentInput({ ...input, runtimeContext: '/Users/private' })).toBe(false)
})

test('Given Renderer update 输入 When 没有实际更新字段或包含敏感字段 Then 拒绝', () => {
  const base = { roomId: 'room-1', roomAgentId: 'agent-1' }
  expect(isUpdateChatRoomAgentInput(base)).toBe(false)
  expect(isUpdateChatRoomAgentInput({ ...base, contextMessageCount: 200 })).toBe(true)
  expect(isUpdateChatRoomAgentInput({ ...base, modelId: 'model-1', path: '/Users/private' })).toBe(false)
  expect(isUpdateChatRoomAgentInput({ ...base, contextMessageCount: 201 })).toBe(false)
})

test('Given Renderer remove/sync/permission 输入 When 校验 Then 仅接受严格 DTO', () => {
  expect(isRemoveChatRoomAgentInput({ roomId: 'room-1', roomAgentId: 'agent-1' })).toBe(true)
  expect(isRemoveChatRoomAgentInput({ roomId: 'room-1', roomAgentId: '' })).toBe(false)
  expect(isSyncChatRoomAgentSkillsInput({ roomId: 'room-1', roomAgentId: 'agent-1', path: '/tmp' })).toBe(false)
  expect(isSyncChatRoomAgentSkillsInput({ roomId: 'room-1', roomAgentId: 'agent-1' })).toBe(true)
  expect(isChatRoomPermissionResponse({ requestId: 'request-1', behavior: 'allow' })).toBe(true)
  expect(isChatRoomPermissionResponse({ requestId: 'request-1', behavior: 'allow', alwaysAllow: true })).toBe(false)
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
  expect(isChatRoomAgentInvocation({ ...invocation, depth: 2 })).toBe(true)
  expect(isChatRoomAgentInvocation({ ...invocation, depth: 3 })).toBe(true)
  expect(isChatRoomAgentInvocation({ ...invocation, depth: 4 })).toBe(false)
  expect(isChatRoomAgentInvocation({ ...invocation, receivedAt: 1.5 })).toBe(false)
  expect(isChatRoomAgentInvocation({ ...invocation, receivedAt: -1 })).toBe(false)
  expect(isChatRoomAgentInvocation({ ...invocation, receivedAt: Number.NaN })).toBe(false)
})

test('Given Chatroom IPC 常量 When 读取 Then 通道只覆盖 Main 本地能力', () => {
  expect(CHATROOM_IPC_CHANNELS.PROVISION_AGENT).toBe('chatrooms:provision-agent')
  expect(Object.values(CHATROOM_IPC_CHANNELS)).not.toContain('chatrooms:send-message')
})
