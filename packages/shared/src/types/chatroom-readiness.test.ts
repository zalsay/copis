import { afterAll, describe, expect, test } from 'bun:test'
import {
  parseChatRoomCommandAck,
  parseChatRoomCapabilities,
  parseChatRoomReadyCommand,
} from './chatroom'

let networkAttempts = 0
const originalFetch = globalThis.fetch
globalThis.fetch = (() => {
  networkAttempts += 1
  throw new Error('聊天室 wire contract 单测禁止网络请求')
}) as unknown as typeof fetch

afterAll(() => {
  globalThis.fetch = originalFetch
  expect(networkAttempts).toBe(0)
})

describe('chatroom readiness wire contract', () => {
  test('只接受不携带认证主体的 ready/unready 命令', () => {
    expect(parseChatRoomReadyCommand({
      type: 'agent.ready',
      roomId: 'room-1',
      payload: { requestId: 'req-1', roomAgentId: 'agent-1' },
    })).toEqual({
      type: 'agent.ready', roomId: 'room-1',
      payload: { requestId: 'req-1', roomAgentId: 'agent-1' },
    })
    expect(parseChatRoomReadyCommand({
      type: 'agent.ready', roomId: 'room-1',
      payload: { requestId: 'req-1', roomAgentId: 'agent-1', ownerUserId: '7' },
    })).toBeUndefined()
  })

  test('ACK 必须完整且拒绝未知字段', () => {
    expect(parseChatRoomCommandAck({
      type: 'command.ack', roomId: 'room-1',
      payload: { requestId: 'req-1', command: 'agent.ready', ok: true },
    })).toEqual({
      type: 'command.ack', roomId: 'room-1',
      payload: { requestId: 'req-1', command: 'agent.ready', ok: true },
    })
    expect(parseChatRoomCommandAck({
      type: 'command.ack', roomId: 'room-1',
      payload: { requestId: 'req-1', command: 'agent.ready', ok: true, extra: 1 },
    })).toBeUndefined()
    expect(parseChatRoomCommandAck({
      type: 'command.ack', roomId: 'room-2',
      payload: { requestId: 'req-1', command: 'agent.ready', ok: true },
    }, 'room-1')).toBeUndefined()
    for (const field of ['invocationId', 'status', 'errorCode'] as const) {
      expect(parseChatRoomCommandAck({ type: 'command.ack', roomId: 'room-1', payload: {
        requestId: 'req-1', command: 'agent.ready', ok: true, [field]: null,
      } })).toBeUndefined()
      expect(parseChatRoomCommandAck({ type: 'command.ack', roomId: 'room-1', payload: {
        requestId: 'req-1', command: 'agent.ready', ok: true, [field]: '',
      } })).toBeUndefined()
    }
    expect(parseChatRoomCommandAck({ type: 'command.ack', roomId: 'room-1', payload: {
      requestId: 'req-1', command: 'agent.ready', ok: true, status: ['running'],
    } })).toBeUndefined()
    expect(parseChatRoomReadyCommand({ type: 'agent.ready', roomId: `r${'界'.repeat(22)}`, payload: {
      requestId: 'req-1', roomAgentId: 'agent-1',
    } })).toBeUndefined()
    expect(parseChatRoomReadyCommand({ type: 'agent.ready', roomId: 'room-1', payload: {
      requestId: 'req\u0085id', roomAgentId: 'agent-1',
    } })).toBeUndefined()
  })

  test('能力列表只启用已知能力，未知值忽略', () => {
    expect(parseChatRoomCapabilities({ capabilities: ['agent-ready-v1', 'future-v9', 'invocation-ack-v1'] }))
      .toEqual(['agent-ready-v1', 'invocation-ack-v1'])
    expect(parseChatRoomCapabilities({ capabilities: [], extra: true })).toBeUndefined()
    expect(parseChatRoomCapabilities({ capabilities: [null] })).toBeUndefined()
  })

  test('已知 delta frame capability 仅声明接收格式', () => {
    expect(parseChatRoomCapabilities({ capabilities: [
      'agent-ready-v1', 'invocation-ack-v1', 'agent-delta-frame-id-v1', 'future-v9',
    ] })).toEqual([
      'agent-ready-v1', 'invocation-ack-v1', 'agent-delta-frame-id-v1',
    ])
  })

  test('ACK command/status allowlist 与服务端契约一致', () => {
    expect(parseChatRoomCommandAck({ type: 'command.ack', roomId: 'room-1', payload: {
      requestId: 'req-1', command: 'agent.running', ok: true, status: 'running', invocationId: 'inv-1',
    } })).toBeDefined()
    expect(parseChatRoomCommandAck({ type: 'command.ack', roomId: 'room-1', payload: {
      requestId: 'req-1', command: 'agent.running', ok: true, status: 'unknown',
    } })).toBeUndefined()
  })
})
