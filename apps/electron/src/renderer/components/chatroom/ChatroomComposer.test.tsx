import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import type { ChatRoomTransferState } from '@copis/shared'
import { subscribeChatRoomTransferProgress } from './ChatroomComposer'

const source = readFileSync(new URL('./ChatroomComposer.tsx', import.meta.url), 'utf8')

describe('聊天室输入行为契约', () => {
  test('消息只提交结构化 Agent ID 和客户端消息 ID', () => {
    expect(source).toContain('mentionAgentIds')
    expect(source).toContain('clientMessageId')
    expect(source).not.toContain('traceId:')
    expect(source).not.toContain('parentMessageId:')
    expect(source).not.toContain('depth:')
  })
  test('离线 Agent 不会进入提及候选，也不会排队发送', () => {
    expect(source).toContain("agent.status === 'offline'")
    expect(source).toContain('消息不会排队')
  })
  test('挂载卸载后 transfer listener 不会累积', () => {
    const listeners = new Set<(state: ChatRoomTransferState) => void>()
    const subscribe = (callback: (state: ChatRoomTransferState) => void): (() => void) => { listeners.add(callback); return () => listeners.delete(callback) }
    const updates: ChatRoomTransferState[] = []
    const firstCleanup = subscribeChatRoomTransferProgress('room-1', (state) => updates.push(state), subscribe)
    firstCleanup()
    subscribeChatRoomTransferProgress('room-1', (state) => updates.push(state), subscribe)
    const state = { transferId: 'transfer-1', roomId: 'room-1', phase: 'ready', progress: 1 } as ChatRoomTransferState
    for (const listener of listeners) listener(state)
    expect(listeners.size).toBe(1)
    expect(updates).toHaveLength(1)
  })
})
