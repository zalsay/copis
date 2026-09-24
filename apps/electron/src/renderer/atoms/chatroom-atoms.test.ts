import { describe, expect, test } from 'bun:test'
import { createStore } from 'jotai/vanilla'
import { chatRoomActiveRoomIdAtom, chatRoomApplyEventAtom, chatRoomConnectionStatusAtom, chatRoomCursorsAtom, chatRoomDeletedRoomIdsAtom, chatRoomDetailsAtom, chatRoomDraftsAtom, chatRoomHydrateMessagesAtom, chatRoomInvocationsAtom, chatRoomMessagesAtom, chatRoomPermissionRequestsAtom, chatRoomRejoinRoomAtom, chatRoomRemoveRoomAtom, chatRoomResetStateAtom, chatRoomRoomsAtom, chatRoomSendMessageAtom, chatRoomSendStatesAtom, chatRoomTransfersAtom, chatRoomUnreadCountsAtom } from './chatroom-atoms'
import type { ChatRoomMessage } from '@copis/shared'

const message = (overrides: Partial<ChatRoomMessage>): ChatRoomMessage => ({ messageId: 'm', roomId: 'r1', seq: 1, senderType: 'user', senderId: 'u1', content: '内容', mentionAgentIds: [], attachmentIds: [], clientMessageId: 'c', depth: 0, createdAt: '2026-01-01T00:00:00Z', ...overrides })
describe('chatRoomAtoms', () => {
  test('收到真实租约心跳后更新 Agent 在线状态，离线广播不虚构调用', () => {
    const store = createStore()
    store.set(chatRoomDetailsAtom, { r1: { agents: [{ agentId: 'a1', displayName: 'Grok', status: 'offline', busy: false }] } })
    store.set(chatRoomApplyEventAtom, { type: 'agent.presence_changed', roomId: 'r1', payload: { roomAgentId: 'a1', status: 'online', online: true } })
    expect(store.get(chatRoomDetailsAtom).r1).toMatchObject({ agents: [{ agentId: 'a1', status: 'online' }] })
    store.set(chatRoomApplyEventAtom, { type: 'agent.offline', roomId: 'r1', payload: { agentId: 'a1', reason: 'client_release' } })
    expect(store.get(chatRoomDetailsAtom).r1).toMatchObject({ agents: [{ agentId: 'a1', status: 'offline' }] })
    expect(store.get(chatRoomInvocationsAtom).size).toBe(0)
  })
  test('唤起、接受和首段输出有独立状态，迟到的接受事件不覆盖终态或清空输出', () => {
    const store = createStore()
    const payload = { invocationId: 'i1', targetAgentId: 'a1', triggerMessageId: 'm1', traceId: 't1', depth: 0 }
    store.set(chatRoomApplyEventAtom, { type: 'agent.invocation', roomId: 'r1', payload })
    expect(store.get(chatRoomInvocationsAtom).get('r1')?.get('i1')?.status).toBe('created')
    store.set(chatRoomApplyEventAtom, { type: 'agent.accepted', roomId: 'r1', payload })
    expect(store.get(chatRoomInvocationsAtom).get('r1')?.get('i1')?.status).toBe('accepted')
    store.set(chatRoomApplyEventAtom, { type: 'agent.delta', roomId: 'r1', payload: { invocationId: 'i1', delta: '答复' } })
    store.set(chatRoomApplyEventAtom, { type: 'agent.accepted', roomId: 'r1', payload })
    expect(store.get(chatRoomInvocationsAtom).get('r1')?.get('i1')).toMatchObject({ status: 'running', delta: '答复', targetAgentId: 'a1' })
    store.set(chatRoomApplyEventAtom, { type: 'agent.completed', roomId: 'r1', payload })
    store.set(chatRoomApplyEventAtom, { type: 'agent.accepted', roomId: 'r1', payload })
    expect(store.get(chatRoomInvocationsAtom).get('r1')?.get('i1')?.status).toBe('completed')
  })

  test('服务端未创建 invocation 的 lease_expired 结果仍按消息与 Agent 显示失败', () => {
    const store = createStore()
    const event = { type: 'agent.offline', roomId: 'r1', seq: 5, payload: { agentId: 'a1', messageId: 'm1', failureCode: 'lease_expired', reason: 'lease_expired' } }
    store.set(chatRoomApplyEventAtom, event)
    store.set(chatRoomApplyEventAtom, event)
    const results = [...store.get(chatRoomInvocationsAtom).get('r1')!.values()]
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ targetAgentId: 'a1', triggerMessageId: 'm1', status: 'rejected', failureCode: 'lease_expired' })
  })

  test('发送带提及消息立即记录稳定的起始时间，并用响应 ID 关联后续调用', async () => {
    const store = createStore()
    let finish!: (value: ChatRoomMessage) => void
    const response = new Promise<ChatRoomMessage>((resolve) => { finish = resolve })
    const sending = store.set(chatRoomSendMessageAtom, { api: { sendMessage: () => response }, roomId: 'r1', content: '@A 你好', mentionAgentIds: ['a1'], attachmentIds: [], clientMessageId: 'c1' })
    const startedAt = store.get(chatRoomSendStatesAtom).get('c1')?.startedAt
    expect(typeof startedAt).toBe('number')
    finish(message({ messageId: 'm1', clientMessageId: 'c1' }))
    await sending
    expect(store.get(chatRoomSendStatesAtom).get('c1')).toMatchObject({ startedAt, messageId: 'm1', status: 'sent' })
  })
  test('accepted 先到而发送响应晚到时，补全 Agent 身份且不把思考降级为等待', async () => {
    const store = createStore()
    store.set(chatRoomApplyEventAtom, { type: 'agent.accepted', roomId: 'r1', payload: { invocationId: 'i1' } })
    await store.set(chatRoomSendMessageAtom, { api: { sendMessage: async () => ({ ...message({ messageId: 'm1' }), invocations: [{ invocationId: 'i1', roomId: 'r1', targetAgentId: 'a1', triggerMessageId: 'm1', traceId: 't1', depth: 0, status: 'created' as const }], events: [{ type: 'agent.offline', roomId: 'r1', payload: { messageId: 'm1', agentId: 'a2', failureCode: 'lease_expired' } }] }) }, roomId: 'r1', content: '@A @B', mentionAgentIds: ['a1', 'a2'], attachmentIds: [] })
    expect(store.get(chatRoomInvocationsAtom).get('r1')?.get('i1')).toMatchObject({ status: 'accepted', targetAgentId: 'a1', triggerMessageId: 'm1' })
    expect([...store.get(chatRoomInvocationsAtom).get('r1')!.values()].some((item) => item.targetAgentId === 'a2' && item.status === 'rejected')).toBe(true)
  })
  test('真实 Agent 回复已落库，即使 completed 帧丢失也结束思考状态', () => {
    const store = createStore()
    store.set(chatRoomApplyEventAtom, { type: 'agent.accepted', roomId: 'r1', payload: { invocationId: 'i1', targetAgentId: 'a1', triggerMessageId: 'm1', traceId: 't1' } })
    store.set(chatRoomApplyEventAtom, { type: 'message.created', roomId: 'r1', seq: 2, payload: { messageId: 'reply', senderType: 'agent', senderAgentId: 'a1', content: '答复', parentMessageId: 'm1', traceId: 't1' } })
    expect(store.get(chatRoomInvocationsAtom).get('r1')?.get('i1')?.status).toBe('completed')
  })

  test('切换账号后迟到的发送响应不得重建旧账号的动画或调用结果', async () => {
    const store = createStore()
    let finish!: (value: ReturnType<typeof message>) => void
    const response = new Promise<ReturnType<typeof message>>((resolve) => { finish = resolve })
    const pending = store.set(chatRoomSendMessageAtom, { api: { sendMessage: () => response }, roomId: 'r1', content: '@A', mentionAgentIds: ['a1'], attachmentIds: [], clientMessageId: 'old-send' })
    store.set(chatRoomResetStateAtom)
    finish({ ...message({}), invocations: [{ invocationId: 'i1', roomId: 'r1', targetAgentId: 'a1', triggerMessageId: 'm1', traceId: 't1', depth: 0, status: 'created' }] } as ReturnType<typeof message>)
    await pending
    expect(store.get(chatRoomSendStatesAtom).size).toBe(0)
    expect(store.get(chatRoomInvocationsAtom).size).toBe(0)
  })
  test('网关确认某房间已不可访问时，仅移除该房间并保留其他订阅房间', () => {
    const store = createStore()
    const room = (roomId: string) => ({ roomId, name: roomId, role: 'member' as const, status: 'active' as const, memberCount: 1, unreadCount: 0, connectionStatus: 'connected' as const })
    store.set(chatRoomRoomsAtom, [room('valid-room'), room('stale-room')])
    store.set(chatRoomApplyEventAtom, { type: 'local.status', roomId: 'stale-room', code: 'room_not_found', payload: null })
    expect(store.get(chatRoomRoomsAtom).map((item) => item.roomId)).toEqual(['valid-room'])
    expect(store.get(chatRoomDeletedRoomIdsAtom).has('stale-room')).toBe(true)
  })
  test('用户重新加入刚退出的同一个房间后可继续接收消息和详情', () => {
    const store = createStore()
    const room = { roomId: 'r1', name: '重新加入', role: 'member' as const, status: 'active' as const, memberCount: 1, unreadCount: 0, connectionStatus: 'offline' as const }
    store.set(chatRoomRoomsAtom, [room])
    store.set(chatRoomRemoveRoomAtom, 'r1')
    store.set(chatRoomRejoinRoomAtom, room)
    store.set(chatRoomApplyEventAtom, { type: 'message.created', roomId: 'r1', seq: 1, payload: { messageId: 'new-message', text: '欢迎回来' } })
    expect(store.get(chatRoomDeletedRoomIdsAtom).has('r1')).toBe(false)
    expect(store.get(chatRoomMessagesAtom).get('r1')?.[0]?.content).toBe('欢迎回来')
    expect(store.get(chatRoomRoomsAtom)).toEqual([room])
  })
  test('同一 roomId 的消息与未读互不污染', () => { const store = createStore(); store.set(chatRoomActiveRoomIdAtom, 'r2'); store.set(chatRoomApplyEventAtom, { type: 'message.created', roomId: 'r1', seq: 1, payload: { messageId: 'm1' } }); store.set(chatRoomApplyEventAtom, { type: 'message.created', roomId: 'r2', seq: 1, payload: { messageId: 'm2' } }); expect(store.get(chatRoomMessagesAtom).get('r1')).toHaveLength(1); expect(store.get(chatRoomMessagesAtom).get('r2')).toHaveLength(1); expect(store.get(chatRoomUnreadCountsAtom).get('r1')).toBe(1); expect(store.get(chatRoomUnreadCountsAtom).get('r2')).toBeUndefined() })
  test('历史晚于 SSE 到达时合并且按 messageId/seq 去重，不覆盖实时消息', () => { const store = createStore(); store.set(chatRoomActiveRoomIdAtom, 'other'); store.set(chatRoomApplyEventAtom, { type: 'message.created', roomId: 'r1', seq: 2, payload: { messageId: 'm2', sender: { type: 'agent', id: 'a1' }, text: '实时较新', createdAt: '2026-01-01T00:00:02Z' } }); store.set(chatRoomHydrateMessagesAtom, { roomId: 'r1', cursor: 2, messages: [message({ messageId: 'm1', seq: 1, content: '历史' }), message({ messageId: 'm2', seq: 2, content: '历史旧值', senderType: 'agent', senderId: 'a1' })] }); const messages = store.get(chatRoomMessagesAtom).get('r1')!; expect(messages.map((item) => item.messageId)).toEqual(['m1', 'm2']); expect(messages[1]?.content).toBe('实时较新'); expect(store.get(chatRoomUnreadCountsAtom).get('r1')).toBe(1); expect(store.get(chatRoomCursorsAtom).get('r1')).toBe(2) })
  test('SSE 晚于历史到达时仍只保留一条，并且重复事件不增加未读', () => { const store = createStore(); store.set(chatRoomActiveRoomIdAtom, 'other'); store.set(chatRoomHydrateMessagesAtom, { roomId: 'r1', messages: [message({ messageId: 'm1', seq: 1 })], cursor: 1 }); const event = { type: 'message.created' as const, roomId: 'r1', seq: 1, payload: { messageId: 'm1', text: '同一条' } }; store.set(chatRoomApplyEventAtom, event); store.set(chatRoomApplyEventAtom, event); expect(store.get(chatRoomMessagesAtom).get('r1')).toHaveLength(1); expect(store.get(chatRoomUnreadCountsAtom).get('r1')).toBeUndefined() })
  test('edu-api 历史响应没有 cursor 时仍用最大历史 seq 初始化客户端 cursor', () => { const store = createStore(); store.set(chatRoomHydrateMessagesAtom, { roomId: 'r1', messages: [message({ messageId: 'm1', seq: 7 }), message({ messageId: 'm2', seq: 9 })] }); expect(store.get(chatRoomCursorsAtom).get('r1')).toBe(9) })
  test('Agent 完成或失败保留已收到的 delta 并保留终态', () => { const store = createStore(); store.set(chatRoomApplyEventAtom, { type: 'agent.delta', roomId: 'r1', payload: { invocationId: 'i1', delta: '处理中' } }); store.set(chatRoomApplyEventAtom, { type: 'agent.failed', roomId: 'r1', payload: { invocationId: 'i1', failureCode: 'agent_offline' } }); const invocation = store.get(chatRoomInvocationsAtom).get('r1')?.get('i1'); expect(invocation?.status).toBe('failed'); expect(invocation?.delta).toBe('处理中'); expect(invocation?.failureCode).toBe('agent_offline') })
  test('迟到 delta 和重复终态都不能降级或覆盖 invocation 终态', () => { const store = createStore(); store.set(chatRoomApplyEventAtom, { type: 'agent.completed', roomId: 'r1', payload: { invocationId: 'i1', traceId: 't1', targetAgentId: 'a1' } }); store.set(chatRoomApplyEventAtom, { type: 'agent.delta', roomId: 'r1', payload: { invocationId: 'i1', delta: '迟到内容' } }); const afterDelta = store.get(chatRoomInvocationsAtom).get('r1')?.get('i1'); expect(afterDelta?.status).toBe('completed'); expect(afterDelta).not.toHaveProperty('delta'); store.set(chatRoomApplyEventAtom, { type: 'agent.failed', roomId: 'r1', payload: { invocationId: 'i1', failureCode: 'agent_offline' } }); const afterFailure = store.get(chatRoomInvocationsAtom).get('r1')?.get('i1'); expect(afterFailure?.status).toBe('completed'); expect(afterFailure).not.toHaveProperty('failureCode') })
  test('迟到 delta 不能将 failed invocation 降级为 running', () => { const store = createStore(); store.set(chatRoomApplyEventAtom, { type: 'agent.failed', roomId: 'r1', payload: { invocationId: 'i-failed', failureCode: 'agent_offline' } }); store.set(chatRoomApplyEventAtom, { type: 'agent.delta', roomId: 'r1', payload: { invocationId: 'i-failed', delta: '迟到内容' } }); const invocation = store.get(chatRoomInvocationsAtom).get('r1')?.get('i-failed'); expect(invocation?.status).toBe('failed'); expect(invocation?.failureCode).toBe('agent_offline'); expect(invocation).not.toHaveProperty('delta') })
  test('失败发送可复用同一 clientMessageId，且不建立队列', async () => { const store = createStore(); const calls: string[] = []; const api = { sendMessage: async (input: { clientMessageId: string }) => { calls.push(input.clientMessageId); throw new Error('offline') } }; await expect(store.set(chatRoomSendMessageAtom, { api, roomId: 'r1', content: 'x', mentionAgentIds: [], attachmentIds: [], clientMessageId: 'c1' })).rejects.toThrow('offline'); expect(store.get(chatRoomSendStatesAtom).get('c1')).toMatchObject({ status: 'failed' }); expect(calls).toEqual(['c1']) })
  test('SSE message.created 使用真实 sender/text 字段写入标准消息', () => { const store = createStore(); store.set(chatRoomApplyEventAtom, { type: 'message.created', roomId: 'r1', seq: 4, payload: { messageId: 'm-4', sender: { type: 'agent', id: 'a-1', displayName: '助理' }, text: '完成', createdAt: 1720000000000, mentionedAgentIds: ['a-2'], attachmentIds: [] } }); expect(store.get(chatRoomMessagesAtom).get('r1')?.[0]).toMatchObject({ messageId: 'm-4', senderType: 'agent', senderId: 'a-1', content: '完成', mentionAgentIds: ['a-2'], createdAt: '1720000000000' }) })
  test('注销或切换账号时清空所有账号范围聊天室状态', () => { const store = createStore(); store.set(chatRoomApplyEventAtom, { type: 'message.created', roomId: 'old', seq: 1, payload: { messageId: 'm-old', sender: { type: 'user', id: 'u-a' }, text: '旧账号', createdAt: 1 } }); store.set(chatRoomDraftsAtom, new Map([['old', '草稿']])); store.set(chatRoomResetStateAtom); expect(store.get(chatRoomMessagesAtom).size).toBe(0); expect(store.get(chatRoomCursorsAtom).size).toBe(0); expect(store.get(chatRoomDraftsAtom).size).toBe(0); expect(store.get(chatRoomUnreadCountsAtom).size).toBe(0); expect(store.get(chatRoomSendStatesAtom).size).toBe(0) })
  test('删除房间清理全部客户端状态并阻止迟到事件复活', () => {
    const store = createStore()
    store.set(chatRoomRoomsAtom, [{ roomId: 'r1', name: '房间', role: 'member', status: 'active', memberCount: 1, unreadCount: 1, connectionStatus: 'connected' }])
    store.set(chatRoomDetailsAtom, { r1: { room: '详情' } })
    store.set(chatRoomMessagesAtom, new Map([['r1', []]])); store.set(chatRoomCursorsAtom, new Map([['r1', 4]])); store.set(chatRoomConnectionStatusAtom, new Map([['r1', 'connected']]))
    store.set(chatRoomDraftsAtom, new Map([['r1', '草稿']])); store.set(chatRoomUnreadCountsAtom, new Map([['r1', 2]])); store.set(chatRoomInvocationsAtom, new Map([['r1', new Map()]])); store.set(chatRoomTransfersAtom, new Map([['t1', { transferId: 't1', roomId: 'r1', phase: 'uploading', progress: 0 }]]))
    store.set(chatRoomActiveRoomIdAtom, 'r1'); store.set(chatRoomRemoveRoomAtom, 'r1')
    expect(store.get(chatRoomRoomsAtom)).toEqual([]); expect(store.get(chatRoomDetailsAtom)).toEqual({}); expect(store.get(chatRoomMessagesAtom).has('r1')).toBe(false); expect(store.get(chatRoomCursorsAtom).has('r1')).toBe(false); expect(store.get(chatRoomConnectionStatusAtom).has('r1')).toBe(false); expect(store.get(chatRoomDraftsAtom).has('r1')).toBe(false); expect(store.get(chatRoomUnreadCountsAtom).has('r1')).toBe(false); expect(store.get(chatRoomInvocationsAtom).has('r1')).toBe(false); expect(store.get(chatRoomTransfersAtom).size).toBe(0); expect(store.get(chatRoomActiveRoomIdAtom)).toBeUndefined()
    store.set(chatRoomApplyEventAtom, { type: 'message.created', roomId: 'r1', seq: 5, payload: { messageId: 'late' } })
    expect(store.get(chatRoomMessagesAtom).has('r1')).toBe(false); expect(store.get(chatRoomDeletedRoomIdsAtom).has('r1')).toBe(true)
  })
  test('权限请求按 requestId 去重，并在账号重置时清空', () => {
    const store = createStore()
    const request = { requestId: 'p1', roomId: 'r1', roomAgentId: 'a1', invocationId: 'i1', traceId: 't1', originalSender: { type: 'user' as const, id: 'u1', displayName: '用户' }, invocationChain: [{ agentId: 'a1', invocationId: 'i1' }], toolName: 'Bash', summary: '执行命令', createdAt: 1, expiresAt: 2 }
    store.set(chatRoomPermissionRequestsAtom, new Map([[request.requestId, request]]))
    store.set(chatRoomPermissionRequestsAtom, (current) => new Map(current).set(request.requestId, { ...request, summary: '更新后的请求' }))
    expect(store.get(chatRoomPermissionRequestsAtom).size).toBe(1)
    expect(store.get(chatRoomPermissionRequestsAtom).get('p1')?.summary).toBe('更新后的请求')
    store.set(chatRoomResetStateAtom)
    expect(store.get(chatRoomPermissionRequestsAtom).size).toBe(0)
  })
})
