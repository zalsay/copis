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

test('Given displayName 含 FEFF/NBSP 和多字节边界 When canonicalize Then uses shared edge trim and UTF-8 limit', async () => {
  const { canonicalizeChatRoomAgentDisplayName } = await import('./chatroom')
  expect(canonicalizeChatRoomAgentDisplayName('\uFEFF\u00A0 Agent \uFEFF')).toBe('Agent')
  expect(canonicalizeChatRoomAgentDisplayName('\uD800')).toBeUndefined()
  expect(canonicalizeChatRoomAgentDisplayName('\uDC00')).toBeUndefined()
  expect(canonicalizeChatRoomAgentDisplayName('😀')).toBe('😀')
  expect(canonicalizeChatRoomAgentDisplayName('界'.repeat(42))).toBe('界'.repeat(42))
  expect(canonicalizeChatRoomAgentDisplayName('界'.repeat(43))).toBeUndefined()
  expect(canonicalizeChatRoomAgentDisplayName('Agent\u0001')).toBeUndefined()
})

test('Given 结构化 Agent 输出 When 校验 Then 只接受三个固定字段的有界对象', () => {
  expect(isChatRoomAgentOutput({ text: '完成', mentionedAgentIds: ['agent-b'], attachmentIds: [] })).toBe(true)
  expect(isChatRoomAgentOutput({ text: '完成', mentionedAgentIds: '@agent-b', attachmentIds: [] })).toBe(false)
  expect(isChatRoomAgentOutput({ text: '完成', mentionedAgentIds: [], attachmentIds: [], token: 'secret' })).toBe(false)
  expect(isChatRoomAgentOutput({ text: '完成', mentionedAgentIds: [''], attachmentIds: [] })).toBe(false)
  expect(isChatRoomAgentOutput({ text: '完成', mentionedAgentIds: ['a', 'b', 'c', 'd'], attachmentIds: [] })).toBe(false)
  expect(isChatRoomAgentOutput({ text: 'x'.repeat(200_001), mentionedAgentIds: [], attachmentIds: [] })).toBe(false)
})

test('Given DTO 通过原型/不可枚举/Symbol 注入未知字段 When 校验 Then 拒绝非 own plain 字段', () => {
  const inheritedProvision = Object.create({ roomId: 'room-1' })
  Object.assign(inheritedProvision, {
    sourceWorkspaceId: 'workspace-1',
    displayName: '分析 Agent',
    channelId: 'channel-1',
  })
  expect(isProvisionChatRoomAgentInput(inheritedProvision)).toBe(false)

  const inheritedRemove = Object.create({ roomAgentId: 'agent-1' })
  inheritedRemove.roomId = 'room-1'
  expect(isRemoveChatRoomAgentInput(inheritedRemove)).toBe(false)

  const inheritedInvocation = Object.create({ roomId: 'room-1' })
  Object.assign(inheritedInvocation, {
    invocationId: 'inv-1',
    traceId: 'trace-1',
    targetAgentId: 'agent-a',
    triggerMessageId: 'message-1',
    depth: 0,
    sender: { type: 'user', id: 'user-1', displayName: '主理人' },
    messages: [],
    receivedAt: 0,
  })
  expect(isChatRoomAgentInvocation(inheritedInvocation)).toBe(false)

  const inheritedOutput = Object.create({ text: '完成' })
  Object.assign(inheritedOutput, { mentionedAgentIds: [], attachmentIds: [] })
  expect(isChatRoomAgentOutput(inheritedOutput)).toBe(false)

  const nonEnumerableOutput = { text: '完成', mentionedAgentIds: [], attachmentIds: [] }
  Object.defineProperty(nonEnumerableOutput, 'token', { value: 'secret', enumerable: false })
  expect(isChatRoomAgentOutput(nonEnumerableOutput)).toBe(false)

  const symbol = Symbol('runtimeContext')
  const symbolOutput = { text: '完成', mentionedAgentIds: [], attachmentIds: [] }
  Object.defineProperty(symbolOutput, symbol, { value: '/Users/private', enumerable: false })
  expect(isChatRoomAgentOutput(symbolOutput)).toBe(false)

  const nullPrototypeOutput = Object.assign(Object.create(null), {
    text: '完成',
    mentionedAgentIds: [],
    attachmentIds: [],
  })
  expect(isChatRoomAgentOutput(nullPrototypeOutput)).toBe(true)
  expect(isChatRoomAgentOutput(JSON.parse('{"text":"完成","mentionedAgentIds":[],"attachmentIds":[]}'))).toBe(true)
})

test('Given DTO 中包含稀疏数组或非索引数组字段 When 校验 Then 拒绝 holes 和额外 own keys', () => {
  const mentionedAgentIds = [] as string[]
  mentionedAgentIds.length = 1
  expect(isChatRoomAgentOutput({ text: '完成', mentionedAgentIds, attachmentIds: [] })).toBe(false)

  const attachmentIds = ['attachment-1']
  Object.defineProperty(attachmentIds, 'secret', { value: 'token', enumerable: false })
  expect(isChatRoomAgentOutput({ text: '完成', mentionedAgentIds: [], attachmentIds })).toBe(false)

  const messages = [] as unknown[]
  messages.length = 1
  const invocation = {
    invocationId: 'inv-1',
    roomId: 'room-1',
    traceId: 'trace-1',
    targetAgentId: 'agent-a',
    triggerMessageId: 'message-1',
    depth: 0,
    sender: { type: 'user' as const, id: 'user-1', displayName: '主理人' },
    messages,
    receivedAt: 0,
  }
  expect(isChatRoomAgentInvocation(invocation)).toBe(false)

  const invocationChain = [] as Array<{ agentId: string; invocationId: string }>
  invocationChain.length = 1
  expect(
    isChatRoomAgentInvocation({
      ...invocation,
      messages: [
        {
          messageId: 'message-1',
          sender: { type: 'user' as const, id: 'user-1', displayName: '主理人' },
          text: '触发',
          createdAt: 0,
          invocationChain,
        },
      ],
      sender: { type: 'user' as const, id: 'user-1', displayName: '主理人' },
    }),
  ).toBe(false)
})

test('Given context optional 字段为 own undefined When 校验 Then 拒绝未定义值', () => {
  const baseMessage = {
    messageId: 'message-1',
    sender: { type: 'user' as const, id: 'user-1', displayName: '主理人' },
    text: '触发',
    createdAt: 0,
  }
  const baseInvocation = {
    invocationId: 'inv-1',
    roomId: 'room-1',
    traceId: 'trace-1',
    targetAgentId: 'agent-a',
    triggerMessageId: 'message-1',
    depth: 0,
    sender: baseMessage.sender,
    receivedAt: 0,
  }
  expect(isChatRoomAgentInvocation({ ...baseInvocation, messages: [baseMessage] })).toBe(true)
  expect(
    isChatRoomAgentInvocation({
      ...baseInvocation,
      messages: [{ ...baseMessage, attachmentIds: undefined }],
    }),
  ).toBe(false)
  expect(
    isChatRoomAgentInvocation({
      ...baseInvocation,
      messages: [{ ...baseMessage, mentionedAgentIds: undefined }],
    }),
  ).toBe(false)
  expect(
    isChatRoomAgentInvocation({
      ...baseInvocation,
      messages: [{ ...baseMessage, invocationChain: undefined }],
    }),
  ).toBe(false)
})

test('Given invocation 上下文为空或未关联触发消息 When 通过 Rust bridge 校验 Then 拒绝', () => {
  const sender = { type: 'user' as const, id: 'user-1', displayName: '主理人' }
  const base = {
    invocationId: 'inv-1',
    roomId: 'room-1',
    traceId: 'trace-1',
    targetAgentId: 'agent-a',
    triggerMessageId: 'message-1',
    depth: 0,
    sender,
    receivedAt: 0,
  }
  expect(isChatRoomAgentInvocation({ ...base, messages: [] })).toBe(false)
  expect(isChatRoomAgentInvocation({
    ...base,
    messages: [{ messageId: 'message-2', sender, text: '其他消息', createdAt: 0 }],
  })).toBe(false)
  expect(isChatRoomAgentInvocation({
    ...base,
    messages: [{ messageId: 'message-1', sender: { ...sender, id: 'user-2' }, text: '触发', createdAt: 0 }],
  })).toBe(false)
})

test('Given 聊天室 Agent displayName When 校验 Then 按 trim 后 UTF-8 128 字节且拒绝所有 control', () => {
  const sender = { type: 'user' as const, id: 'user-1', displayName: '主理人' }
  const base = {
    invocationId: 'inv-1', roomId: 'room-1', traceId: 'trace-1', targetAgentId: 'agent-a',
    triggerMessageId: 'message-1', depth: 0, sender, receivedAt: 0,
    messages: [{ messageId: 'message-1', sender, text: '触发', createdAt: 0 }],
  }
  expect(isChatRoomAgentInvocation({ ...base, sender: { ...sender, displayName: `  ${'界'.repeat(42)}  ` }, messages: [{ ...base.messages[0], sender: { ...sender, displayName: `  ${'界'.repeat(42)}  ` } }] })).toBe(true)
  expect(isChatRoomAgentInvocation({ ...base, sender: { ...sender, displayName: '界'.repeat(43) }, messages: [{ ...base.messages[0], sender: { ...sender, displayName: '界'.repeat(43) } }] })).toBe(false)
  for (const control of ['\n', '\t', '\u0000', '\u0085']) {
    const named = { ...sender, displayName: `Agent${control}` }
    expect(isChatRoomAgentInvocation({ ...base, sender: named, messages: [{ ...base.messages[0], sender: named }] })).toBe(false)
  }
})

test('Given Object.prototype 被临时污染 When context 缺少 optional own 字段 Then 仍按缺失字段处理', () => {
  const pollutedKeys = ['attachmentIds', 'mentionedAgentIds', 'invocationChain'] as const
  const originalDescriptors = new Map<string, PropertyDescriptor | undefined>()
  const baseMessage = {
    messageId: 'message-1',
    sender: { type: 'user' as const, id: 'user-1', displayName: '主理人' },
    text: '触发',
    createdAt: 0,
  }
  const invocation = {
    invocationId: 'inv-1',
    roomId: 'room-1',
    traceId: 'trace-1',
    targetAgentId: 'agent-a',
    triggerMessageId: 'message-1',
    depth: 0,
    sender: baseMessage.sender,
    messages: [baseMessage],
    receivedAt: 0,
  }

  try {
    for (const key of pollutedKeys) {
      originalDescriptors.set(key, Object.getOwnPropertyDescriptor(Object.prototype, key))
      Object.defineProperty(Object.prototype, key, {
        configurable: true,
        enumerable: false,
        value: ['inherited-secret'],
      })
    }
    expect(isChatRoomAgentInvocation(invocation)).toBe(true)
  } finally {
    for (const key of pollutedKeys) {
      const descriptor = originalDescriptors.get(key)
      if (descriptor) Object.defineProperty(Object.prototype, key, descriptor)
      else delete (Object.prototype as Record<string, unknown>)[key]
    }
  }
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
    messages: [{
      messageId: 'message-1',
      sender: { type: 'user' as const, id: 'user-1', displayName: '主理人' },
      text: '触发',
      createdAt: 0,
    }],
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
