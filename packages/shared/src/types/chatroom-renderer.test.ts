import { expect, test } from 'bun:test'
import type {
  ChatRoomCreateInput,
  ChatRoomDownloadRequest,
  ChatRoomElectronAPI,
  ChatRoomMessage,
  ChatRoomSendMessageInput,
  ChatRoomTransferResult,
  ChatRoomTransferState,
} from './chatroom'
import {
  CHATROOM_IPC_CHANNELS,
  normalizeChatRoomShareCode,
} from './chatroom'

test('Given 用户输入小写分享码 When 进入 Renderer 边界 Then 规范化为大写四位码', () => {
  expect(normalizeChatRoomShareCode('a7k2')).toBe('A7K2')
  expect(normalizeChatRoomShareCode(' A7k2 ')).toBe('A7K2')
  expect(normalizeChatRoomShareCode('a7k')).toBeUndefined()
  expect(normalizeChatRoomShareCode('a7k20')).toBeUndefined()
  expect(normalizeChatRoomShareCode('a7-2')).toBeUndefined()
})

test('Given 创建聊天室 When 构造请求 Then DTO 只有名称和分享码', () => {
  const input: ChatRoomCreateInput = { name: '项目讨论', shareCode: 'A7K2' }
  expect(Object.keys(input).sort()).toEqual(['name', 'shareCode'])
})

test('Given 一条消息 mention 两个 Agent When 发送 Then 输入不携带服务端链路字段', () => {
  const input: ChatRoomSendMessageInput = {
    roomId: 'room-1',
    content: '@agent-a @agent-b 并行分析',
    mentionAgentIds: ['agent-a', 'agent-b'],
    attachmentIds: [],
    clientMessageId: 'client-message-1',
  }
  expect(Object.keys(input).sort()).toEqual([
    'attachmentIds',
    'clientMessageId',
    'content',
    'mentionAgentIds',
    'roomId',
  ])
  expect(input).not.toHaveProperty('traceId')
  expect(input).not.toHaveProperty('parentMessageId')
  expect(input).not.toHaveProperty('depth')

  const message: ChatRoomMessage = {
    messageId: 'message-1',
    roomId: input.roomId,
    seq: 1,
    senderType: 'user',
    senderId: 'user-1',
    content: input.content,
    mentionAgentIds: input.mentionAgentIds,
    attachmentIds: input.attachmentIds,
    clientMessageId: input.clientMessageId,
    traceId: 'trace-1',
    parentMessageId: 'message-0',
    depth: 1,
    createdAt: '2026-09-22T00:00:00.000Z',
  }
  expect(message.traceId).toBe('trace-1')
  expect(message.depth).toBe(1)
})

test('Given 文件传输状态 When 发送到 Renderer Then 可带原始文件名但不带敏感路径或凭据', () => {
  const state: ChatRoomTransferState = {
    transferId: 'transfer-1',
    attachmentId: 'attachment-1',
    roomId: 'room-1',
    originalName: '方案.pdf',
    phase: 'uploading' as const,
    progress: 0.5,
  }
  expect(Object.keys(state).sort()).toEqual([
    'attachmentId',
    'originalName',
    'phase',
    'progress',
    'roomId',
    'transferId',
  ])
  expect(state).not.toHaveProperty('filePath')
  expect(state).not.toHaveProperty('objectKey')
  expect(state).not.toHaveProperty('sts')
  expect(state).not.toHaveProperty('tmpSecretKey')

  const download: ChatRoomDownloadRequest = {
    transferId: state.transferId,
    roomId: state.roomId,
    attachmentId: state.attachmentId!,
    target: 'user',
  }
  const result: ChatRoomTransferResult = {
    transferId: download.transferId,
    attachmentId: download.attachmentId,
    originalName: state.originalName,
    phase: 'ready',
  }
  expect(result).not.toHaveProperty('filePath')
  expect(result).not.toHaveProperty('objectKey')
})

test('Given 聊天室 IPC 通道 When 读取 Then 保留 provisionAgent 并扩展传输通道', () => {
  expect(CHATROOM_IPC_CHANNELS.PROVISION_AGENT).toBe('chatrooms:provision-agent')
  expect(CHATROOM_IPC_CHANNELS.SELECT_AND_UPLOAD).toBe('chatrooms:select-and-upload')
  expect(CHATROOM_IPC_CHANNELS.START_DOWNLOAD).toBe('chatrooms:start-download')
  expect(CHATROOM_IPC_CHANNELS.CANCEL_TRANSFER).toBe('chatrooms:cancel-transfer')
  expect(CHATROOM_IPC_CHANNELS.TRANSFER_PROGRESS).toBe('chatrooms:transfer-progress')
  expect(Object.keys(CHATROOM_IPC_CHANNELS)).toContain('PROVISION_AGENT')
})

test('Given 既有聊天室 Electron API When 扩展传输能力 Then provisionAgent 仍然可用', () => {
  const api: Pick<ChatRoomElectronAPI, 'provisionAgent'> = {
    provisionAgent: async () => ({
      roomAgentId: 'agent-1',
      displayName: '分析 Agent',
      sourceWorkspaceId: 'workspace-1',
      channelId: 'channel-1',
      contextMessageCount: 50,
      memorySharingEnabled: false,
      skillSharingEnabled: false,
      archived: false,
    }),
  }
  expect(typeof api.provisionAgent).toBe('function')
})
