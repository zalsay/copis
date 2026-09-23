import { describe, expect, test } from 'bun:test'
import { parseHTML } from 'linkedom'
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { Provider } from 'jotai'
import { createStore } from 'jotai/vanilla'
import { createChatRoomApi } from '@/lib/chatroom-api'
import {
  chatRoomApplyEventAtom,
  chatRoomInvocationsAtom,
  chatRoomSendMessageAtom,
  chatRoomSendStatesAtom,
  chatRoomSetTransferAtom,
  chatRoomTransfersAtom,
  chatRoomDraftsAtom,
} from '@/atoms/chatroom-atoms'
import { ChatroomComposer } from './ChatroomComposer'

function response(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
}

function room(status = 'active') {
  return { roomId: 'room-1', name: '协作房间', role: 'host', status, memberCount: 1, unreadCount: 0, connectionStatus: 'connected' }
}

describe('聊天室跨 API、状态与转移的集成行为', () => {
  test('创建会规范化分享码并可直接加入同一房间', async () => {
    const calls: Array<{ url: string; body?: unknown }> = []
    const api = createChatRoomApi({ baseUrl: 'http://test', fetchImpl: async (url, init) => {
      calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined })
      return calls.length === 1 ? response({ room: { ...room(), shareCode: 'A7K2' } }) : response({ room: { ...room(), role: 'member', shareCode: undefined } })
    } })
    const created = await api.createRoom({ name: '协作房间', shareCode: 'a7k2' })
    const joined = await api.joinRoom({ shareCode: 'a7k2' })
    expect(created.shareCode).toBe('A7K2')
    expect(joined.roomId).toBe(created.roomId)
    expect(calls.map((call) => call.body)).toEqual([{ name: '协作房间', shareCode: 'A7K2' }, { shareCode: 'A7K2' }])
  })

  test('一条消息触发两个并行 Agent 时，两个 invocation 状态按 roomId 独立落入 Jotai', () => {
    const store = createStore()
    for (const [invocationId, targetAgentId] of [['i-a', 'agent-a'], ['i-b', 'agent-b']]) {
      store.set(chatRoomApplyEventAtom, { type: 'agent.delta', roomId: 'room-1', payload: { invocationId, targetAgentId, traceId: 'trace-1', depth: 0, delta: '处理中' } })
    }
    const invocations = store.get(chatRoomInvocationsAtom).get('room-1')
    expect(invocations?.size).toBe(2)
    expect([...invocations!.values()].map((item) => item.targetAgentId).sort()).toEqual(['agent-a', 'agent-b'])
  })

  test('Renderer 接收 Agent-to-Agent 深度停止事件时保留原因且不虚构第四次调用', () => {
    // depth guard 的实际产生由 Main coordinator 覆盖；本集成场景验证网关事件到 Renderer 的投影。
    const store = createStore()
    store.set(chatRoomApplyEventAtom, { type: 'agent.failed', roomId: 'room-1', payload: { invocationId: 'i-depth', targetAgentId: 'agent-c', traceId: 'trace-1', depth: 3, failureCode: 'invocation_depth_exceeded' } })
    const invocation = store.get(chatRoomInvocationsAtom).get('room-1')?.get('i-depth')
    expect(invocation).toMatchObject({ traceId: 'trace-1', depth: 3, failureCode: 'invocation_depth_exceeded', status: 'failed' })
    expect(store.get(chatRoomInvocationsAtom).get('room-1')).toHaveProperty('size', 1)
  })

  test('Agent 离线立即失败，发送状态不建立排队队列', async () => {
    const store = createStore()
    const api = { sendMessage: async () => { throw new Error('agent_offline') } }
    await expect(store.set(chatRoomSendMessageAtom, { api, roomId: 'room-1', content: '@agent-a 继续', mentionAgentIds: ['agent-a'], attachmentIds: [], clientMessageId: 'client-1' })).rejects.toThrow('agent_offline')
    expect(store.get(chatRoomSendStatesAtom).get('client-1')).toMatchObject({ status: 'failed' })
    expect(store.get(chatRoomSendStatesAtom).size).toBe(1)
  })

  test('附件只有 finalize 后才进入 ready，失败阶段不显示为可发送附件', () => {
    const store = createStore()
    store.set(chatRoomSetTransferAtom, { transferId: 'transfer-1', roomId: 'room-1', phase: 'validating', progress: 0.9, attachmentId: 'att-1' })
    expect(store.get(chatRoomTransfersAtom).get('transfer-1')?.phase).toBe('validating')
    store.set(chatRoomSetTransferAtom, { transferId: 'transfer-1', roomId: 'room-1', phase: 'ready', progress: 1, attachmentId: 'att-1', originalName: '报告.pdf' })
    expect(store.get(chatRoomTransfersAtom).get('transfer-1')).toMatchObject({ phase: 'ready', progress: 1, attachmentId: 'att-1' })
  })

  test('归档房间禁用发送和上传，恢复后由房间状态重新允许', async () => {
    const methods: string[] = []
    let status = 'active'
    const api = createChatRoomApi({ baseUrl: 'http://test', fetchImpl: async (_url, init) => {
      methods.push(init?.method ?? 'GET')
      if (init?.method === 'POST') status = methods.at(-1) === 'POST' && status === 'active' ? 'archived' : 'active'
      return response({ room: room(status) })
    } })
    await api.archiveRoom('room-1')
    expect(status).toBe('archived')
    await api.restoreRoom('room-1')
    expect(status).toBe('active')
    expect(methods).toEqual(['POST', 'POST'])
    const parsed = parseHTML('<html><body><div id="root"></div></body></html>')
    Object.assign(globalThis, { window: parsed.window, document: parsed.window.document, IS_REACT_ACT_ENVIRONMENT: true })
    Object.assign(parsed.window, { setTimeout, clearTimeout, setInterval, clearInterval, electronAPI: { chatrooms: { onTransferProgress: () => () => undefined, startUpload: async () => ({ transferId: 't', phase: 'ready' }) } } })
    const store = createStore()
    store.set(chatRoomDraftsAtom, new Map([['room-1', '发送内容']]))
    const root = createRoot(document.getElementById('root')!)
    const act = (React as typeof React & { act: typeof import('react-dom/test-utils').act }).act
    await act(async () => { root.render(<Provider store={store}><ChatroomComposer roomId="room-1" agents={[]} archived connectionStatus="connected" /></Provider>) })
    expect((document.querySelector('[aria-label="聊天室消息"]') as HTMLTextAreaElement).disabled).toBe(true)
    expect((document.querySelector('[aria-label="添加附件"]') as HTMLButtonElement).disabled).toBe(true)
    await act(async () => { root.render(<Provider store={store}><ChatroomComposer roomId="room-1" agents={[]} archived={false} connectionStatus="connected" /></Provider>) })
    expect((document.querySelector('[aria-label="聊天室消息"]') as HTMLTextAreaElement).disabled).toBe(false)
    expect((document.querySelector('[aria-label="添加附件"]') as HTMLButtonElement).disabled).toBe(false)
    await act(async () => { root.unmount() })
  })
})
