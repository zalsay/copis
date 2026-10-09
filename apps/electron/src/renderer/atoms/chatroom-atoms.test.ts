import { describe, expect, test } from 'bun:test'
import { createStore } from 'jotai/vanilla'
import { chatRoomActiveRoomIdAtom, chatRoomApplyEventAtom, chatRoomApplyLocalRoomConfigAtom, chatRoomApplyProvisionProgressAtom, chatRoomApplyRoomDetailAtom, chatRoomClearProvisionPlanAtom, chatRoomClearStaleProvisionPlansAtom, chatRoomConnectionStatusAtom, chatRoomCursorsAtom, chatRoomDeletedRoomIdsAtom, chatRoomDeltaFramesAtom, chatRoomDetailsAtom, chatRoomDraftsAtom, chatRoomHydrateMessagesAtom, chatRoomInvocationsAtom, chatRoomLocalRoomRevisionsAtom, chatRoomLocalRoomsAtom, chatRoomMessagesAtom, chatRoomPermissionRequestsAtom, chatRoomProvisionPlansAtom, chatRoomRejoinRoomAtom, chatRoomRemoveRoomAtom, chatRoomResetStateAtom, chatRoomRoomsAtom, chatRoomSendMessageAtom, chatRoomSendStatesAtom, chatRoomSetProvisionPlanAtom, chatRoomTransfersAtom, chatRoomUnreadCountsAtom, chatRoomUpdateLocalAgentAtom, chatRoomDataRevisionsAtom } from './chatroom-atoms'
import type { ChatRoomMessage } from '@copis/shared'

const message = (overrides: Partial<ChatRoomMessage>): ChatRoomMessage => ({ messageId: 'm', roomId: 'r1', seq: 1, senderType: 'user', senderId: 'u1', content: '内容', mentionAgentIds: [], attachmentIds: [], clientMessageId: 'c', depth: 0, createdAt: '2026-01-01T00:00:00Z', ...overrides })
describe('chatRoomAtoms', () => {
  test('较晚到达的 Main 事件按操作代次生效，旧列表不因 Renderer 时间覆盖配置', () => {
    const store = createStore()
    const room = { roomId: 'r1', updatedAt: 2, agents: [{ roomAgentId: 'a1', displayName: 'A', sourceWorkspaceId: 'w1', channelId: 'c1', contextMessageCount: 50, memorySharingEnabled: true, skillSharingEnabled: false, archived: false }] }
    store.set(chatRoomApplyLocalRoomConfigAtom, { room: { ...room, updatedAt: Date.now() + 100_000 } })
    const listRevision = store.get(chatRoomLocalRoomRevisionsAtom).get('r1')!
    store.set(chatRoomApplyLocalRoomConfigAtom, { room: { ...room, updatedAt: 1 } })
    store.set(chatRoomApplyLocalRoomConfigAtom, { room: { ...room, agents: [{ ...room.agents[0]!, memorySharingEnabled: false }] }, expectedRevision: listRevision })
    expect(store.get(chatRoomLocalRoomsAtom).get('r1')?.agents[0]?.memorySharingEnabled).toBe(true)
  })
  test('过期共享写回回执不能覆盖更新的 Main 本机配置revision', () => {
    const store = createStore()
    const agent = { roomAgentId: 'a1', displayName: 'A', sourceWorkspaceId: 'w1', channelId: 'c1', contextMessageCount: 50, memorySharingEnabled: false, skillSharingEnabled: false, archived: false }
    store.set(chatRoomApplyLocalRoomConfigAtom, { room: { roomId: 'r1', updatedAt: 1, agents: [agent] } })
    const requestRevision = store.get(chatRoomLocalRoomRevisionsAtom).get('r1')!
    store.set(chatRoomApplyLocalRoomConfigAtom, { room: { roomId: 'r1', updatedAt: 2, agents: [{ ...agent, memorySharingEnabled: true }] } })
    store.set(chatRoomUpdateLocalAgentAtom, { roomId: 'r1', agent: { ...agent, memorySharingEnabled: false }, expectedRevision: requestRevision })
    expect(store.get(chatRoomLocalRoomsAtom).get('r1')?.agents[0]?.memorySharingEnabled).toBe(true)
  })
  test('聊天室配置计划保留冻结快照与完成进度，成功后可清理', () => {
    const store = createStore()
    const plan = { room: { roomId: 'r1', name: '房间', role: 'host' as const, status: 'active' as const, memberCount: 1, unreadCount: 0, connectionStatus: 'offline' as const }, agents: [{ sourceWorkspaceId: 'w1', displayName: 'A', channelId: 'c1', contextMessageCount: 50, memorySharingEnabled: true, skillSharingEnabled: false }], completed: 1, accountKey: 'account-a', authEpoch: 1, operationId: 'operation-a', attemptId: 'attempt-a' }
    store.set(chatRoomSetProvisionPlanAtom, plan)
    expect(store.get(chatRoomProvisionPlansAtom).get('r1')).toEqual(plan)
    store.set(chatRoomClearProvisionPlanAtom, 'r1')
    expect(store.get(chatRoomProvisionPlansAtom).has('r1')).toBe(false)
  })
  test('卸载期间的同次 attempt 回执可推进计划，迟到旧 attempt 不能覆盖续办状态', () => {
    const store = createStore()
    const room = { roomId: 'r2', name: '房间', role: 'host' as const, status: 'active' as const, memberCount: 1, unreadCount: 0, connectionStatus: 'offline' as const }
    const agents = [
      { sourceWorkspaceId: 'w1', displayName: 'A', channelId: 'c1', contextMessageCount: 50, memorySharingEnabled: false, skillSharingEnabled: false },
      { sourceWorkspaceId: 'w2', displayName: 'B', channelId: 'c1', contextMessageCount: 50, memorySharingEnabled: false, skillSharingEnabled: false },
    ]
    const plan = { room, agents, completed: 0, accountKey: 'account-a', authEpoch: 1, operationId: 'op-a', attemptId: 'attempt-a', inFlightIndex: 0, inFlightAgentName: 'A' }
    store.set(chatRoomSetProvisionPlanAtom, plan)
    store.set(chatRoomApplyProvisionProgressAtom, { roomId: room.roomId, accountKey: 'account-a', authEpoch: 1, operationId: 'op-a', attemptId: 'attempt-a', phase: 'progress', completed: 1 })
    const progressed = store.get(chatRoomProvisionPlansAtom).get(room.roomId)!
    expect(progressed.completed).toBe(1)
    expect(progressed).not.toHaveProperty('inFlightIndex')
    store.set(chatRoomSetProvisionPlanAtom, { ...progressed, attemptId: 'attempt-b', inFlightIndex: 1, inFlightAgentName: 'B' })
    store.set(chatRoomApplyProvisionProgressAtom, { roomId: room.roomId, accountKey: 'account-a', authEpoch: 1, operationId: 'op-a', attemptId: 'attempt-a', phase: 'progress', completed: 2 })
    expect(store.get(chatRoomProvisionPlansAtom).get(room.roomId)).toMatchObject({ completed: 1, attemptId: 'attempt-b', inFlightIndex: 1 })
  })
  test('认证epoch变更后清除旧生命周期计划且不触碰新epoch计划', () => {
    const store = createStore()
    const room = { roomId: 'r3', name: '房间', role: 'host' as const, status: 'active' as const, memberCount: 1, unreadCount: 0, connectionStatus: 'offline' as const }
    const plan = { room, agents: [{ sourceWorkspaceId: 'w1', displayName: 'A', channelId: 'c', contextMessageCount: 50, memorySharingEnabled: false, skillSharingEnabled: false }], completed: 0, accountKey: 'account-a', authEpoch: 1, operationId: 'old', attemptId: 'old-attempt' }
    store.set(chatRoomSetProvisionPlanAtom, plan)
    store.set(chatRoomSetProvisionPlanAtom, { ...plan, room: { ...room, roomId: 'r4' }, authEpoch: 3, operationId: 'new', attemptId: 'new-attempt' })
    store.set(chatRoomClearStaleProvisionPlansAtom, 3)
    expect(store.get(chatRoomProvisionPlansAtom).has('r3')).toBe(false)
    expect(store.get(chatRoomProvisionPlansAtom).get('r4')?.authEpoch).toBe(3)
  })
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
  test('相同 frameId 的 delta 只预览一次，不同 frameId 的相同文本仍保留且冲突内容不追加', () => {
    const store = createStore()
    store.set(chatRoomUnreadCountsAtom, new Map([['r1', 2]]))
    const applyDelta = (frameId: string, delta: string): void => store.set(chatRoomApplyEventAtom, {
      type: 'agent.delta', roomId: 'r1', payload: { invocationId: 'i1', frameId, delta },
    })
    applyDelta('a'.repeat(32), '哈')
    const startedAt = store.get(chatRoomInvocationsAtom).get('r1')?.get('i1')?.startedAt
    applyDelta('a'.repeat(32), '哈')
    applyDelta('b'.repeat(32), '哈')
    applyDelta('a'.repeat(32), '改内容')
    expect(store.get(chatRoomInvocationsAtom).get('r1')?.get('i1')).toMatchObject({ status: 'running', startedAt, delta: '哈哈', previewPaused: 'frame_conflict' })
    expect(store.get(chatRoomUnreadCountsAtom).get('r1')).toBe(2)
  })
  test('completed 与 failed 终态优先清除本地暂停标记并释放帧身份', () => {
    const store = createStore()
    for (const [invocationId, terminalType] of [['completed-i', 'agent.completed'], ['failed-i', 'agent.failed']] as const) {
      const frameId = invocationId === 'completed-i' ? 'c'.repeat(32) : 'f'.repeat(32)
      store.set(chatRoomApplyEventAtom, { type: 'agent.delta', roomId: 'r1', payload: { invocationId, frameId, delta: '片段' } })
      store.set(chatRoomApplyEventAtom, { type: 'agent.delta', roomId: 'r1', payload: { invocationId, frameId, delta: '冲突内容' } })
      expect(store.get(chatRoomInvocationsAtom).get('r1')?.get(invocationId)?.previewPaused).toBe('frame_conflict')
      store.set(chatRoomApplyEventAtom, { type: terminalType, roomId: 'r1', payload: { invocationId } })
      expect(store.get(chatRoomInvocationsAtom).get('r1')?.get(invocationId)?.status).toBe(terminalType === 'agent.completed' ? 'completed' : 'failed')
      expect(store.get(chatRoomInvocationsAtom).get('r1')?.get(invocationId)?.previewPaused).toBeUndefined()
      expect(store.get(chatRoomDeltaFramesAtom).total).toBe(0)
    }
  })
  test('preview 满额只暂停本地增量预览，不清除真实运行状态或已有内容', () => {
    const store = createStore()
    const frameIds = new Map(Array.from({ length: 8192 }, (_, index) => [index.toString(16).padStart(32, '0'), '已收帧'] as const))
    store.set(chatRoomDeltaFramesAtom, { frames: new Map([['r1', new Map([['i2', frameIds]])]]), total: 8192 })
    store.set(chatRoomApplyEventAtom, { type: 'agent.accepted', roomId: 'r1', payload: { invocationId: 'i2' } })
    store.set(chatRoomApplyEventAtom, { type: 'agent.delta', roomId: 'r1', payload: { invocationId: 'i2', frameId: 'f'.repeat(32), delta: '未追加' } })

    expect(store.get(chatRoomInvocationsAtom).get('r1')?.get('i2')).toMatchObject({ status: 'accepted', previewPaused: 'frame_capacity' })
    expect(store.get(chatRoomInvocationsAtom).get('r1')?.get('i2')?.delta).toBeUndefined()
    expect(store.get(chatRoomDeltaFramesAtom).total).toBe(8192)
  })
  test('legacy 无 frameId 的相同 delta 仍按到达顺序追加', () => {
    const store = createStore()
    store.set(chatRoomApplyEventAtom, { type: 'agent.delta', roomId: 'r1', payload: { invocationId: 'legacy', delta: '哈' } })
    store.set(chatRoomApplyEventAtom, { type: 'agent.delta', roomId: 'r1', payload: { invocationId: 'legacy', delta: '哈' } })

    expect(store.get(chatRoomInvocationsAtom).get('r1')?.get('legacy')?.delta).toBe('哈哈')
    expect(store.get(chatRoomDeltaFramesAtom).total).toBe(0)
  })
  test('完成清理单次身份，迟到帧不复活；删房、重入、账号重置及其他 store 相互隔离', () => {
    const store = createStore()
    const otherStore = createStore()
    const applyFrame = (invocationId: string, frameId: string): void => store.set(chatRoomApplyEventAtom, {
      type: 'agent.delta', roomId: 'r1', payload: { invocationId, frameId: frameId.repeat(32), delta: invocationId },
    })
    applyFrame('i1', 'a')
    applyFrame('i2', 'b')
    expect(store.get(chatRoomDeltaFramesAtom).total).toBe(2)

    store.set(chatRoomApplyEventAtom, { type: 'agent.completed', roomId: 'r1', payload: { invocationId: 'i1' } })
    expect(store.get(chatRoomDeltaFramesAtom).total).toBe(1)
    store.set(chatRoomApplyEventAtom, { type: 'agent.delta', roomId: 'r1', payload: { invocationId: 'i1', frameId: 'c'.repeat(32), delta: '迟到' } })
    expect(store.get(chatRoomInvocationsAtom).get('r1')?.get('i1')?.status).toBe('completed')
    expect(store.get(chatRoomDeltaFramesAtom).total).toBe(1)

    store.set(chatRoomApplyEventAtom, { type: 'agent.failed', roomId: 'r1', payload: { invocationId: 'i2', failureCode: 'agent_offline' } })
    expect(store.get(chatRoomDeltaFramesAtom).total).toBe(0)
    applyFrame('i3', 'e')
    store.set(chatRoomRemoveRoomAtom, 'r1')
    expect(store.get(chatRoomDeltaFramesAtom).total).toBe(0)
    store.set(chatRoomRejoinRoomAtom, { roomId: 'r1', name: '房间', role: 'member', status: 'active', memberCount: 1, unreadCount: 0, connectionStatus: 'offline' })
    applyFrame('i4', 'd')
    store.set(chatRoomResetStateAtom)
    expect(store.get(chatRoomDeltaFramesAtom).total).toBe(0)
    expect(otherStore.get(chatRoomDeltaFramesAtom).total).toBe(0)
  })
  test('终态回复仍保存完整 message.created 文本并释放暂停预览的帧身份', () => {
    const store = createStore()
    store.set(chatRoomApplyEventAtom, { type: 'agent.accepted', roomId: 'r1', payload: { invocationId: 'i1', targetAgentId: 'a1', triggerMessageId: 'm1' } })
    store.set(chatRoomApplyEventAtom, { type: 'agent.delta', roomId: 'r1', payload: { invocationId: 'i1', frameId: 'a'.repeat(32), delta: '片段' } })
    store.set(chatRoomApplyEventAtom, { type: 'agent.delta', roomId: 'r1', payload: { invocationId: 'i1', frameId: 'a'.repeat(32), delta: '冲突片段' } })
    store.set(chatRoomApplyEventAtom, { type: 'message.created', roomId: 'r1', seq: 1, payload: { messageId: 'reply-1', sender: { type: 'agent', id: 'a1' }, parentMessageId: 'm1', text: '完整最终回复' } })

    expect(store.get(chatRoomMessagesAtom).get('r1')?.[0]?.content).toBe('完整最终回复')
    expect(store.get(chatRoomInvocationsAtom).get('r1')?.get('i1')).toMatchObject({ status: 'completed', delta: '片段' })
    expect(store.get(chatRoomInvocationsAtom).get('r1')?.get('i1')?.previewPaused).toBeUndefined()
    expect(store.get(chatRoomDeltaFramesAtom).total).toBe(0)
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
  test('房间 snapshot 全量替换 agents 与 members，较旧 latestSeq 快照不覆盖较新状态', () => {
    const store = createStore()
    store.set(chatRoomDetailsAtom, { r1: { room: { roomId: 'r1', name: '旧名' }, members: [{ userId: 'u1' }], agents: [{ agentId: 'old' }] } })
    store.set(chatRoomApplyEventAtom, { type: 'agent.updated', roomId: 'r1', seq: 12, payload: { agentId: 'a1', displayName: '新 Agent', status: 'busy', availability: 'busy', busy: true } })
    store.set(chatRoomApplyEventAtom, { type: 'room.snapshot', roomId: 'r1', latestSeq: 13, payload: { room: { roomId: 'r1', name: '新名' }, members: [{ userId: 'u2' }], agents: [{ agentId: 'a2', displayName: '第二个 Agent', status: 'offline', availability: 'preparing' }] } })
    expect(store.get(chatRoomDetailsAtom).r1).toMatchObject({ room: { name: '新名' }, members: [{ userId: 'u2' }], agents: [{ agentId: 'a2' }] })
    expect(store.get(chatRoomDetailsAtom).r1).not.toHaveProperty('agents.1')
    expect(store.get(chatRoomCursorsAtom).get('r1')).toBe(13)
    store.set(chatRoomApplyEventAtom, { type: 'room.snapshot', roomId: 'r1', latestSeq: 11, payload: { room: { roomId: 'r1', name: '过期名' }, members: [], agents: [] } })
    expect(store.get(chatRoomDetailsAtom).r1).toMatchObject({ room: { name: '新名' }, members: [{ userId: 'u2' }], agents: [{ agentId: 'a2' }] })
  })
  test('房间 snapshot 将同一房间摘要同步到侧栏 rooms 与详情', () => {
    const store = createStore()
    const oldRoom = { roomId: 'r1', name: '旧名称', role: 'member' as const, status: 'active' as const, memberCount: 1, unreadCount: 0, connectionStatus: 'connected' as const }
    store.set(chatRoomRoomsAtom, [oldRoom])
    store.set(chatRoomDetailsAtom, { r1: { room: oldRoom, members: [], agents: [] } })
    store.set(chatRoomApplyEventAtom, { type: 'room.snapshot', roomId: 'r1', latestSeq: 14, payload: {
      room: { roomId: 'r1', name: '服务端新名称', status: 'archived', memberCount: 3, unreadCount: 2 },
      members: [{ userId: 'u1' }, { userId: 'u2' }, { userId: 'u3' }], agents: [],
    } })
    const summary = store.get(chatRoomRoomsAtom)[0]!
    const detail = store.get(chatRoomDetailsAtom).r1 as { room: typeof summary; members: unknown[]; agents: unknown[] }
    expect(summary).toMatchObject({ name: '服务端新名称', status: 'archived', memberCount: 3, unreadCount: 2 })
    expect(detail.room).toEqual(summary)
    expect(detail.members).toHaveLength(3)
  })
  test('无效或晚到的 snapshot 版本不能改变房间摘要、详情或 cursor', () => {
    const store = createStore()
    const room = { roomId: 'r1', name: '当前名称', role: 'member' as const, status: 'active' as const, memberCount: 2, unreadCount: 0, connectionStatus: 'connected' as const }
    store.set(chatRoomRoomsAtom, [room])
    store.set(chatRoomDetailsAtom, { r1: { room, members: [], agents: [] } })
    store.set(chatRoomCursorsAtom, new Map([['r1', 8]]))
    store.set(chatRoomApplyEventAtom, { type: 'room.snapshot', roomId: 'r1', latestSeq: -1, payload: { room: { name: '无效版本' }, members: [], agents: [] } })
    store.set(chatRoomApplyEventAtom, { type: 'room.snapshot', roomId: 'r1', latestSeq: 7, payload: { room: { name: '过期版本' }, members: [], agents: [] } })
    expect(store.get(chatRoomRoomsAtom)[0]).toEqual(room)
    expect(store.get(chatRoomDetailsAtom).r1).toMatchObject({ room })
    expect(store.get(chatRoomCursorsAtom).get('r1')).toBe(8)
  })
  test('迟到的 HTTP 房间详情不会覆盖已经到达的 SSE revision', () => {
    const store = createStore()
    const detail = { room: { roomId: 'r1', name: 'HTTP旧值', role: 'member' as const, status: 'active' as const, memberCount: 1, unreadCount: 0, connectionStatus: 'offline' as const }, members: [], agents: [] }
    store.set(chatRoomDataRevisionsAtom, new Map([['r1', 3]]))
    store.set(chatRoomApplyRoomDetailAtom, { roomId: 'r1', detail, expectedRevision: 2 })
    expect(store.get(chatRoomDetailsAtom).r1).toBeUndefined()
    store.set(chatRoomApplyRoomDetailAtom, { roomId: 'r1', detail, expectedRevision: 3 })
    expect(store.get(chatRoomDetailsAtom).r1).toEqual(detail)
  })
  test('普通 online presence 不会清除服务端 busy runtime 状态', () => {
    const store = createStore()
    store.set(chatRoomDetailsAtom, { r1: { room: { roomId: 'r1' }, members: [], agents: [{ agentId: 'a1', displayName: 'Agent', status: 'busy', busy: true, availability: 'busy' }] } })
    store.set(chatRoomApplyEventAtom, { type: 'agent.presence_changed', roomId: 'r1', payload: { agentId: 'a1', status: 'online' } })
    expect((store.get(chatRoomDetailsAtom).r1 as { agents: Array<{ status: string; availability?: string }> }).agents[0]).toMatchObject({ status: 'busy', availability: 'busy' })
  })
  test('Agent/member 增量只更新或移除目标对象，房间更新保留未提及字段', () => {
    const store = createStore()
    const room = { roomId: 'r1', name: '原名', role: 'member' as const, status: 'active' as const, memberCount: 2, unreadCount: 0, connectionStatus: 'connected' as const }
    store.set(chatRoomRoomsAtom, [room])
    store.set(chatRoomDetailsAtom, { r1: { room, members: [{ userId: 'u1', displayName: 'U1', role: 'member', presence: 'online' }, { userId: 'u2', displayName: 'U2', role: 'member', presence: 'offline' }], agents: [{ agentId: 'a1', displayName: 'A1', status: 'busy', availability: 'busy', busy: true, memoryShared: true, skillsShared: false }] } })
    store.set(chatRoomApplyEventAtom, { type: 'room.updated', roomId: 'r1', seq: 1, payload: { room: { name: '新名' } } })
    store.set(chatRoomApplyEventAtom, { type: 'agent.updated', roomId: 'r1', seq: 2, payload: { agentId: 'a1', displayName: 'A1 重命名' } })
    store.set(chatRoomApplyEventAtom, { type: 'member.presence_changed', roomId: 'r1', payload: { userId: 'u2', status: 'busy' } })
    store.set(chatRoomApplyEventAtom, { type: 'member.removed', roomId: 'r1', seq: 3, payload: { userId: 'u1' } })
    store.set(chatRoomApplyEventAtom, { type: 'agent.removed', roomId: 'r1', seq: 4, payload: { agentId: 'a1' } })
    expect(store.get(chatRoomRoomsAtom)[0]).toMatchObject({ roomId: 'r1', name: '新名', status: 'active' })
    expect(store.get(chatRoomDetailsAtom).r1).toMatchObject({ members: [{ userId: 'u2', presence: 'busy' }], agents: [] })
  })
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
