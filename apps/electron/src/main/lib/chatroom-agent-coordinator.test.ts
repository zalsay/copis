import { expect, test } from 'bun:test'
import { mock } from 'bun:test'
import type { AgentMessage, ChatRoomAgentInvocation, ChatRoomAgentLocalConfig, ChatRoomLocalRoomConfig } from '@copis/shared'

const coordinatorModule = await import('./chatroom-agent-coordinator')

test('Given Task 9 协调器 When 导入 Then 导出真正的主进程协调器', () => {
  expect(coordinatorModule.ChatRoomAgentCoordinator).toBeDefined()
})

test('Given Task 9 尚未注册协调器 When bridge 获取 Then 不创建默认实例并明确不可用', () => {
  expect(() => coordinatorModule.getChatRoomAgentCoordinator()).toThrow('聊天室协调器尚未注册')
})

test('Given 注册后替换协调器 When 旧 token 释放 Then 不得清理新实例', () => {
  const first = {
    handleInvocation: async () => 'accepted' as const,
    handleGatewayDisconnected: async () => {},
  }
  const second = {
    handleInvocation: async () => 'duplicate' as const,
    handleGatewayDisconnected: async () => {},
  }
  const releaseFirst = coordinatorModule.registerChatRoomAgentCoordinator(first)
  const releaseSecond = coordinatorModule.registerChatRoomAgentCoordinator(second)
  releaseFirst()
  expect(coordinatorModule.getChatRoomAgentCoordinator()).toBe(second)
  releaseSecond()
  expect(() => coordinatorModule.getChatRoomAgentCoordinator()).toThrow('聊天室协调器尚未注册')
})

function makeAgent(id: string): ChatRoomAgentLocalConfig {
  return { roomAgentId: id, displayName: id, sourceWorkspaceId: 'workspace-1', sessionId: `session-${id}`, channelId: 'channel-1', contextMessageCount: 50, memorySharingEnabled: false, skillSharingEnabled: false }
}

function makeInput(id: string, targetAgentId: string, depth = 0): ChatRoomAgentInvocation {
  return { invocationId: id, roomId: 'room-1', traceId: 'trace-1', targetAgentId, triggerMessageId: `message-${id}`, depth, sender: { type: 'user', id: 'user-1', displayName: '用户' }, messages: [{ messageId: `message-${id}`, sender: { type: 'user', id: 'user-1', displayName: '用户' }, text: '请处理', createdAt: 1 }], receivedAt: 1 }
}

function fakeDeps(overrides: Record<string, unknown> = {}) {
  const agents = [makeAgent('agent-a'), makeAgent('agent-b'), makeAgent('agent-c')]
  const room: ChatRoomLocalRoomConfig = { roomId: 'room-1', hostUserId: 'user-1', deviceId: 'device-1', lastProcessedSeq: 0, agents, invocations: [], createdAt: 1, updatedAt: 1 }
  const records = new Map<string, any>()
  const store = {
    read: () => room,
    getInvocation: (_roomId: string, id: string) => records.get(id),
    getTraceAgentInvocation: (_roomId: string, traceId: string, target: string) => [...records.values()].find((record) => record.traceId === traceId && record.targetAgentId === target),
    upsertInvocation: (_roomId: string, record: any) => { records.set(record.invocationId, record); return record },
  }
  const reportAccepted = mock(async () => {})
  const reportRunning = mock(async () => {})
  const reportCompleted = mock(async () => {})
  const reportFailed = mock(async () => {})
  const runAgentHeadless = mock(async (_input: unknown, callbacks: { onComplete: (messages: AgentMessage[]) => void }) => { callbacks.onComplete([{ role: 'assistant', id: 'assistant-1', content: '{"text":"完成","mentionedAgentIds":[],"attachmentIds":[]}', createdAt: 2 } as AgentMessage]) })
  return {
    deps: {
      store,
      rustApi: { reportAccepted, reportRunning, reportDelta: mock(async () => {}), reportCompleted, reportFailed, releaseAgentLeases: mock(async () => {}) },
      getCurrentUserId: async () => 'user-1', getDeviceId: () => 'device-1', runAgentHeadless, stopAgent: mock(async () => {}), subscribeAgentEvents: () => () => {}, createHiddenSessionStore: () => ({}) as never, syncSkills: () => ({ snapshotPath: '/tmp/skills', digest: 'a'.repeat(64), skillSlugs: [], syncedAt: 1 }), createNextHop: mock(async () => {}), sendPermissionToHost: mock(() => {}), now: () => 2, ...overrides,
    } as any,
    room, records, runAgentHeadless, reportAccepted, reportRunning, reportCompleted, reportFailed,
  }
}

test('Given 三个在线 Agent When 并发投递 Then 各自立即启动且不共享全局队列', async () => {
  const { deps, runAgentHeadless } = fakeDeps()
  const coordinator = new coordinatorModule.ChatRoomAgentCoordinator(deps)
  await Promise.all(['agent-a', 'agent-b', 'agent-c'].map((agentId, index) => coordinator.handleInvocation({ ...makeInput(`inv-${index}`, agentId), traceId: `trace-${index}` })))
  expect(runAgentHeadless).toHaveBeenCalledTimes(3)
})

test('Given 同一 trace 与 Agent 已有记录 When 重复投递 Then 返回 duplicate 且不重启', async () => {
  const { deps, runAgentHeadless } = fakeDeps()
  const coordinator = new coordinatorModule.ChatRoomAgentCoordinator(deps)
  await coordinator.handleInvocation(makeInput('inv-1', 'agent-a'))
  expect(await coordinator.handleInvocation({ ...makeInput('inv-2', 'agent-a'), traceId: 'trace-1' })).toBe('duplicate')
  expect(runAgentHeadless).toHaveBeenCalledTimes(1)
})

test('Given depth 为 3 或 Gateway 已断开 When 投递 Then 立即失败且不启动', async () => {
  const { deps, runAgentHeadless, reportFailed } = fakeDeps()
  const coordinator = new coordinatorModule.ChatRoomAgentCoordinator(deps)
  await coordinator.handleInvocation({ ...makeInput('inv-deep', 'agent-a'), depth: 3 })
  await coordinator.handleGatewayDisconnected()
  await coordinator.handleInvocation(makeInput('inv-offline', 'agent-a'))
  expect(runAgentHeadless).not.toHaveBeenCalled()
  expect(reportFailed).toHaveBeenCalledTimes(2)
})
