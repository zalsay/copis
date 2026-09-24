import { expect, test } from 'bun:test'
import { mock } from 'bun:test'
import type { AgentMessage, ChatRoomAgentInvocation, ChatRoomAgentLocalConfig, ChatRoomLocalRoomConfig, PermissionRequest } from '@copis/shared'

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
    stopAll: async () => ({ stoppedSessionIds: [], releasedRoomAgentIds: [] }),
    dispose: async () => {},
  }
  const second = {
    handleInvocation: async () => 'duplicate' as const,
    handleGatewayDisconnected: async () => {},
    stopAll: async () => ({ stoppedSessionIds: [], releasedRoomAgentIds: [] }),
    dispose: async () => {},
  }
  const releaseFirst = coordinatorModule.registerChatRoomAgentCoordinator(first)
  const releaseSecond = coordinatorModule.registerChatRoomAgentCoordinator(second)
  releaseFirst()
  expect(coordinatorModule.getChatRoomAgentCoordinator()).toBe(second)
  releaseSecond()
  expect(() => coordinatorModule.getChatRoomAgentCoordinator()).toThrow('聊天室协调器尚未注册')
})

test('Given 注册观察者 When 注销旧协调器或替换 Then 只收到当前注册状态且旧 token 不会误注销新实例', () => {
  const events: Array<object | undefined> = []
  const detach = coordinatorModule.onChatRoomAgentCoordinatorRegistered((registration) => events.push(registration))
  const first = { handleInvocation: async () => 'accepted' as const, handleGatewayDisconnected: async () => {}, stopAll: async () => ({ stoppedSessionIds: [], releasedRoomAgentIds: [] }), dispose: async () => {} }
  const second = { handleInvocation: async () => 'duplicate' as const, handleGatewayDisconnected: async () => {}, stopAll: async () => ({ stoppedSessionIds: [], releasedRoomAgentIds: [] }), dispose: async () => {} }
  const releaseFirst = coordinatorModule.registerChatRoomAgentCoordinator(first)
  const releaseSecond = coordinatorModule.registerChatRoomAgentCoordinator(second)
  releaseFirst()
  expect(events).toEqual([first, second])
  releaseSecond()
  expect(events).toEqual([first, second, undefined])
  detach()
})

function makeAgent(id: string): ChatRoomAgentLocalConfig {
  return { roomAgentId: id, displayName: id, sourceWorkspaceId: 'workspace-1', sessionId: `session-${id}`, channelId: 'channel-1', contextMessageCount: 50, memorySharingEnabled: false, skillSharingEnabled: false }
}

function makeInput(id: string, targetAgentId: string, depth = 0, roomId = 'room-1'): ChatRoomAgentInvocation {
  return { invocationId: id, roomId, traceId: 'trace-1', targetAgentId, triggerMessageId: `message-${id}`, depth, sender: { type: 'user', id: 'user-1', displayName: '用户' }, messages: [{ messageId: `message-${id}`, sender: { type: 'user', id: 'user-1', displayName: '用户' }, text: '请处理', createdAt: 1 }], receivedAt: 1 }
}

function fakeDeps(overrides: Record<string, unknown> = {}) {
  const agents = [makeAgent('agent-a'), makeAgent('agent-b'), makeAgent('agent-c')]
  const room: ChatRoomLocalRoomConfig = { roomId: 'room-1', hostUserId: 'user-1', deviceId: 'device-1', lastProcessedSeq: 0, agents, invocations: [], createdAt: 1, updatedAt: 1 }
  const records = new Map<string, any>()
  const store = {
    read: () => room,
    list: () => [room],
    listRestorableRooms: (): ChatRoomLocalRoomConfig[] => store.list(),
    getInvocation: (_roomId: string, id: string) => records.get(id),
    getTraceAgentInvocation: (_roomId: string, traceId: string, target: string) => [...records.values()].find((record) => record.traceId === traceId && record.targetAgentId === target),
    upsertInvocation: (_roomId: string, record: any) => { records.set(record.invocationId, record); return record },
    transitionInvocation: (_roomId: string, id: string, expected: string[], update: (record: any) => any) => { const current = records.get(id); if (!current || !expected.includes(current.status)) return { transitioned: false, record: current }; const next = update(current); records.set(id, next); return { transitioned: true, record: next } },
  }
  const reportAccepted = mock(async () => {})
  const reportRunning = mock(async () => {})
  const reportCompleted = mock(async () => {})
  const reportFailed = mock(async () => {})
  const runAgentHeadless = mock(async (_input: unknown, callbacks: { onComplete: (messages: AgentMessage[]) => void }) => { callbacks.onComplete([{ role: 'assistant', id: 'assistant-1', content: '{"text":"完成","mentionedAgentIds":[],"attachmentIds":[]}', createdAt: 2 } as AgentMessage]) })
  const rustApi = { reportAccepted, reportRunning, reportDelta: mock(async () => {}), reportCompleted, reportFailed, releaseAgentLeases: mock(async () => {}), getRoomRealtimeStatus: async () => ({ ready: true, epoch: 5 }) }
  return {
    deps: {
      store,
      rustApi,
      getCurrentUserId: async () => 'user-1', getDeviceId: () => 'device-1', getSensitiveValues: () => [], runAgentHeadless, stopAgent: mock(async () => {}), subscribeAgentEvents: () => () => {}, createHiddenSessionStore: () => ({}) as never, registerSessionStorageOverride: () => () => {}, syncSkills: () => ({ snapshotPath: '/tmp/skills', digest: 'a'.repeat(64), skillSlugs: [], syncedAt: 1 }), now: () => 2, ...overrides,
      ...(overrides.rustApi ? { rustApi: { ...rustApi, ...overrides.rustApi as object } } : {}),
      ...(overrides.store ? { store: { listRestorableRooms: () => (overrides.store as typeof store).list?.() ?? [], ...overrides.store as object } } : {}),
    } as any,
    room, records, runAgentHeadless, reportAccepted, reportRunning, reportCompleted, reportFailed,
  }
}

test('首次配置 Agent 使用远端主理人授权及服务端 ID 创建本地房间', async () => {
  const room: ChatRoomLocalRoomConfig = { roomId: 'room-1', hostUserId: 'user-1', deviceId: 'device-1', lastProcessedSeq: 0, agents: [makeAgent('server-agent-1')], invocations: [], createdAt: 1, updatedAt: 1 }
  let localRoom: ChatRoomLocalRoomConfig | undefined
  const requests: string[] = []
  const { deps } = fakeDeps({
    store: {
      read: () => localRoom,
      provisionAgent: (identity: { hostUserId: string; deviceId: string }, input: { roomId: string }, id: string) => {
        expect(identity).toEqual({ hostUserId: 'user-1', deviceId: 'device-1' })
        expect(input.roomId).toBe('room-1')
        expect(id).toBe('server-agent-1')
        requests.push('local')
        localRoom = room
        return room
      },
    },
    rustApi: {
      getRoomHostUserId: async (id: string) => { requests.push(`verify:${id}`); return 'user-1' },
      registerAgent: async (input: { roomId: string; displayName: string; deviceId: string; hostUserId: string }) => {
        expect(input).toEqual({ roomId: 'room-1', displayName: 'Grok', deviceId: 'device-1', hostUserId: 'user-1' })
        requests.push('register')
        return 'server-agent-1'
      },
      unregisterAgent: async () => { requests.push('unregister') },
      renewAgentLease: async (roomId: string, agentId: string, deviceId: string) => {
        expect([roomId, agentId, deviceId]).toEqual(['room-1', 'server-agent-1', 'device-1'])
        requests.push('lease')
      },
    },
  })
  const coordinator = new coordinatorModule.ChatRoomAgentCoordinator(deps)
  const agent = await coordinator.provisionAgent({ roomId: 'room-1', sourceWorkspaceId: 'workspace-1', displayName: 'Grok', channelId: 'channel-1' })
  expect(agent.roomAgentId).toBe('server-agent-1')
  expect(requests).toEqual(['verify:room-1', 'register', 'local', 'lease'])
})

test('已有房间断连后恢复且网关确认新快照时，可添加第一个 Agent 而不重新创建房间', async () => {
  const calls: string[] = []
  const room: ChatRoomLocalRoomConfig = { roomId: 'room-1', hostUserId: 'user-1', deviceId: 'device-1', lastProcessedSeq: 0, agents: [makeAgent('server-agent-1')], invocations: [], createdAt: 1, updatedAt: 1 }
  const base = fakeDeps()
  const { deps } = fakeDeps({
    store: { read: () => undefined, list: () => [], listRestorableRooms: () => [], provisionAgent: () => { calls.push('local'); return room } },
    rustApi: {
      ...base.deps.rustApi,
      getRoomRealtimeStatus: async () => { calls.push('ready'); return { ready: true, epoch: 5 } },
      getRoomHostUserId: async () => 'user-1',
      registerAgent: async () => { calls.push('register'); return 'server-agent-1' },
      renewAgentLease: async () => { calls.push('lease') },
    },
  })
  const coordinator = new coordinatorModule.ChatRoomAgentCoordinator(deps)
  await coordinator.stopAll('gateway_disconnected')
  const agent = await coordinator.provisionAgent({ roomId: 'room-1', sourceWorkspaceId: 'workspace-1', displayName: 'Grok', channelId: 'channel-1' })
  expect(agent.roomAgentId).toBe('server-agent-1')
  expect(calls).toEqual(['ready', 'ready', 'register', 'ready', 'local', 'lease', 'ready'])
})

test('网关尚未收到当前房间快照时拒绝添加 Agent，且不注册远端记录', async () => {
  const calls: string[] = []
  const base = fakeDeps()
  const { deps } = fakeDeps({
    store: { read: () => undefined, provisionAgent: () => { calls.push('local'); throw new Error('不应写入') } },
    rustApi: {
      ...base.deps.rustApi,
      getRoomRealtimeStatus: async () => { calls.push('ready'); return { ready: false, epoch: 5 } },
      getRoomHostUserId: async () => 'user-1',
      registerAgent: async () => { calls.push('register'); return 'server-agent-1' },
    },
  })
  await expect(new coordinatorModule.ChatRoomAgentCoordinator(deps).provisionAgent({ roomId: 'room-1', sourceWorkspaceId: 'workspace-1', displayName: 'Grok', channelId: 'channel-1' })).rejects.toThrow('agent_offline')
  expect(calls).toEqual(['ready'])
})

test('远端注册期间网关断线、主进程通知滞后时，撤销远端 Agent 且不写本地', async () => {
  const calls: string[] = []
  const base = fakeDeps()
  let checks = 0
  const { deps } = fakeDeps({
    store: { read: () => undefined, provisionAgent: () => { calls.push('local'); throw new Error('不应写入') } },
    rustApi: { ...base.deps.rustApi,
      getRoomHostUserId: async () => 'user-1',
      getRoomRealtimeStatus: async () => { checks++; return { ready: checks < 3, epoch: checks < 3 ? 5 : 6 } },
      registerAgent: async () => { calls.push('register'); return 'server-agent-1' },
      unregisterAgent: async () => { calls.push('delete') },
    },
  })
  await expect(new coordinatorModule.ChatRoomAgentCoordinator(deps).provisionAgent({ roomId: 'room-1', sourceWorkspaceId: 'workspace-1', displayName: 'Grok', channelId: 'channel-1' })).rejects.toThrow('agent_offline')
  expect(calls).toEqual(['register', 'delete'])
})

test('断线又重连后即使重新就绪也不能沿用注册前的连接版本', async () => {
  const calls: string[] = []
  const base = fakeDeps()
  let checks = 0
  const { deps } = fakeDeps({
    store: { read: () => undefined, provisionAgent: () => { calls.push('local'); throw new Error('不应写入') } },
    rustApi: { ...base.deps.rustApi,
      getRoomHostUserId: async () => 'user-1',
      getRoomRealtimeStatus: async () => ({ ready: true, epoch: ++checks < 3 ? 5 : 7 }),
      registerAgent: async () => { calls.push('register'); return 'server-agent-1' },
      unregisterAgent: async () => { calls.push('delete') },
    },
  })
  await expect(new coordinatorModule.ChatRoomAgentCoordinator(deps).provisionAgent({ roomId: 'room-1', sourceWorkspaceId: 'workspace-1', displayName: 'Grok', channelId: 'channel-1' })).rejects.toThrow('agent_offline')
  expect(calls).toEqual(['register', 'delete'])
})

test('注册成功但网关状态接口失败时，撤销远端 Agent 且不写本地', async () => {
  const calls: string[] = []
  let checks = 0
  const base = fakeDeps()
  const { deps } = fakeDeps({
    store: { read: () => undefined, provisionAgent: () => { calls.push('local'); throw new Error('不应写入') } },
    rustApi: { ...base.deps.rustApi,
      getRoomHostUserId: async () => 'user-1',
      getRoomRealtimeStatus: async () => { if (++checks > 2) throw new Error('状态查询失败'); return { ready: true, epoch: 5 } },
      registerAgent: async () => { calls.push('register'); return 'server-agent-1' },
      unregisterAgent: async () => { calls.push('delete') },
    },
  })
  await expect(new coordinatorModule.ChatRoomAgentCoordinator(deps).provisionAgent({ roomId: 'room-1', sourceWorkspaceId: 'workspace-1', displayName: 'Grok', channelId: 'channel-1' })).rejects.toThrow('状态查询失败')
  expect(calls).toEqual(['register', 'delete'])
})

test('续租新 Agent 期间网关断线，撤销本地配置和租约并移除远端 Agent', async () => {
  const calls: string[] = []
  const room: ChatRoomLocalRoomConfig = { roomId: 'room-1', hostUserId: 'user-1', deviceId: 'device-1', lastProcessedSeq: 0, agents: [makeAgent('server-agent-1')], invocations: [], createdAt: 1, updatedAt: 1 }
  const base = fakeDeps()
  let checks = 0
  const { deps } = fakeDeps({
    store: { read: () => undefined, provisionAgent: () => { calls.push('local'); return room }, archiveAgent: () => { calls.push('archive'); return room } },
    rustApi: { ...base.deps.rustApi,
      getRoomHostUserId: async () => 'user-1',
      getRoomRealtimeStatus: async () => ({ ready: ++checks < 4, epoch: checks < 4 ? 5 : 6 }),
      registerAgent: async () => { calls.push('register'); return 'server-agent-1' },
      renewAgentLease: async () => { calls.push('lease') },
      releaseAgentLeases: async () => { calls.push('release') },
      unregisterAgent: async () => { calls.push('delete') },
    },
  })
  await expect(new coordinatorModule.ChatRoomAgentCoordinator(deps).provisionAgent({ roomId: 'room-1', sourceWorkspaceId: 'workspace-1', displayName: 'Grok', channelId: 'channel-1' })).rejects.toThrow('agent_offline')
  expect(calls).toEqual(['register', 'local', 'lease', 'release', 'archive', 'delete'])
})

test('网关就绪查询期间再次断线，不得复活旧 generation 或注册新 Agent', async () => {
  let beginReady!: () => void
  let finishReady!: () => void
  const entered = new Promise<void>((resolve) => { beginReady = resolve })
  const waiting = new Promise<void>((resolve) => { finishReady = resolve })
  const calls: string[] = []
  const base = fakeDeps()
  const { deps } = fakeDeps({
    store: { read: () => undefined, list: () => [], provisionAgent: () => { calls.push('local'); throw new Error('不应写入') } },
    rustApi: { ...base.deps.rustApi, getRoomHostUserId: async () => 'user-1', getRoomRealtimeStatus: async () => { beginReady(); await waiting; return { ready: true, epoch: 5 } }, registerAgent: async () => { calls.push('register'); return 'server-agent-1' } },
  })
  const coordinator = new coordinatorModule.ChatRoomAgentCoordinator(deps)
  const adding = coordinator.provisionAgent({ roomId: 'room-1', sourceWorkspaceId: 'workspace-1', displayName: 'Grok', channelId: 'channel-1' })
  await entered
  await coordinator.stopAll('gateway_disconnected')
  finishReady()
  await expect(adding).rejects.toThrow('agent_offline')
  expect(calls).toEqual([])
})

test('就绪后复核账号期间断线，不得用旧 generation 恢复旧 Agent 租约', async () => {
  let identityStarted!: () => void
  let releaseIdentity!: () => void
  const waiting = new Promise<void>((resolve) => { releaseIdentity = resolve })
  const entered = new Promise<void>((resolve) => { identityStarted = resolve })
  let identityReads = 0
  const calls: string[] = []
  const oldRoom: ChatRoomLocalRoomConfig = { roomId: 'room-1', hostUserId: 'user-1', deviceId: 'device-1', lastProcessedSeq: 0, agents: [makeAgent('old-agent')], invocations: [], createdAt: 1, updatedAt: 1 }
  const base = fakeDeps()
  const { deps } = fakeDeps({
    store: { read: () => oldRoom, list: () => [oldRoom], listRestorableRooms: () => [oldRoom], provisionAgent: () => { calls.push('local'); throw new Error('不应写入') } },
    getCurrentUserId: async () => { identityReads++; if (identityReads === 2) { identityStarted(); await waiting } return 'user-1' },
    rustApi: { ...base.deps.rustApi, getRoomHostUserId: async () => 'user-1', getRoomRealtimeStatus: async () => ({ ready: true, epoch: 5 }), renewAgentLease: async () => { calls.push('renew-old') }, registerAgent: async () => { calls.push('register'); return 'server-agent-1' } },
  })
  const coordinator = new coordinatorModule.ChatRoomAgentCoordinator(deps)
  const adding = coordinator.provisionAgent({ roomId: 'room-1', sourceWorkspaceId: 'workspace-1', displayName: 'Grok', channelId: 'channel-1' })
  await entered
  await coordinator.stopAll('gateway_disconnected')
  releaseIdentity()
  await expect(adding).rejects.toThrow('agent_offline')
  expect(calls).toEqual([])
})

test('已有房间断线恢复后添加新 Agent 时，先恢复该房间旧 Agent 的在线租约', async () => {
  const calls: string[] = []
  const previous: ChatRoomLocalRoomConfig = { roomId: 'room-1', hostUserId: 'user-1', deviceId: 'device-1', lastProcessedSeq: 0, agents: [makeAgent('old-agent')], invocations: [], createdAt: 1, updatedAt: 1 }
  const next: ChatRoomLocalRoomConfig = { ...previous, agents: [...previous.agents, makeAgent('server-agent-1')] }
  const base = fakeDeps()
  const { deps } = fakeDeps({
    store: { read: () => previous, list: () => [previous], listRestorableRooms: () => [previous], provisionAgent: () => { calls.push('local'); return next } },
    rustApi: { ...base.deps.rustApi, getRoomRealtimeStatus: async () => { calls.push('ready'); return { ready: true, epoch: 5 } }, getRoomHostUserId: async () => 'user-1', registerAgent: async () => { calls.push('register'); return 'server-agent-1' }, renewAgentLease: async (_roomId: string, id: string) => { calls.push(`renew:${id}`) }, unregisterAgent: async () => undefined },
  })
  const coordinator = new coordinatorModule.ChatRoomAgentCoordinator(deps)
  await coordinator.stopAll('gateway_disconnected')
  calls.length = 0
  await coordinator.provisionAgent({ roomId: 'room-1', sourceWorkspaceId: 'workspace-1', displayName: 'Grok', channelId: 'channel-1' })
  expect(calls).toEqual(['ready', 'ready', 'ready', 'renew:old-agent', 'ready', 'ready', 'register', 'ready', 'local', 'renew:server-agent-1', 'ready'])
})

test('启动时只有当前房间已收到 WebSocket 快照才恢复旧 Agent 租约', async () => {
  const calls: string[] = []
  const base = fakeDeps()
  const { deps } = fakeDeps({ rustApi: { ...base.deps.rustApi, getRoomHostUserId: async () => 'user-1', getRoomRealtimeStatus: async () => ({ ready: false, epoch: 5 }), renewAgentLease: async () => { calls.push('renew') } } })
  await new coordinatorModule.ChatRoomAgentCoordinator(deps).resumeLeases()
  expect(calls).toEqual([])
})

test('启动首次快照未到时自动重试租约恢复，不要求用户重新添加 Agent', async () => {
  let checks = 0
  const renewed: string[] = []
  const { deps } = fakeDeps({ leaseRecoveryRetryMs: 5, rustApi: {
    getRoomHostUserId: async () => 'user-1',
    getRoomRealtimeStatus: async () => ({ ready: ++checks > 1, epoch: 5 }),
    renewAgentLease: async (_roomId: string, agentId: string) => { renewed.push(agentId) },
  } })
  const coordinator = new coordinatorModule.ChatRoomAgentCoordinator(deps)
  coordinator.start()
  try {
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(renewed).toEqual(['agent-a', 'agent-b', 'agent-c'])
    await coordinator.stopAll('gateway_disconnected')
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(renewed).toEqual(['agent-a', 'agent-b', 'agent-c', 'agent-a', 'agent-b', 'agent-c'])
  } finally { await coordinator.dispose() }
})

test('等待快照期间退出登录，禁止后台恢复旧 Agent 租约', async () => {
  let ready = false
  const renewed: string[] = []
  const { deps } = fakeDeps({ leaseRecoveryRetryMs: 5, rustApi: {
    getRoomHostUserId: async () => 'user-1', getRoomRealtimeStatus: async () => ({ ready, epoch: 5 }),
    renewAgentLease: async (_roomId: string, agentId: string) => { renewed.push(agentId) },
  } })
  const coordinator = new coordinatorModule.ChatRoomAgentCoordinator(deps)
  coordinator.start()
  try {
    await new Promise((resolve) => setTimeout(resolve, 10))
    await coordinator.stopAll('logout')
    ready = true
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(renewed).toEqual([])
  } finally { await coordinator.dispose() }
})

test('旧 Agent 租约恢复前连接版本已经改变时，不得续租', async () => {
  const calls: string[] = []
  let checks = 0
  const base = fakeDeps()
  const { deps } = fakeDeps({ rustApi: { ...base.deps.rustApi,
    getRoomHostUserId: async () => 'user-1',
    getRoomRealtimeStatus: async () => ({ ready: true, epoch: ++checks === 1 ? 5 : 7 }),
    renewAgentLease: async () => { calls.push('renew') },
  } })
  await new coordinatorModule.ChatRoomAgentCoordinator(deps).resumeLeases()
  expect(calls).toEqual([])
})

test('旧 Agent 续租期间断线且通知滞后时，释放该租约并停止恢复其它 Agent', async () => {
  const calls: string[] = []
  let checks = 0
  const base = fakeDeps()
  const { deps } = fakeDeps({ rustApi: { ...base.deps.rustApi,
    getRoomHostUserId: async () => 'user-1',
    getRoomRealtimeStatus: async () => ({ ready: ++checks < 3, epoch: checks < 3 ? 5 : 6 }),
    renewAgentLease: async (_roomId: string, id: string) => { calls.push(`renew:${id}`) },
    releaseAgentLeases: async () => { calls.push('release') },
  } })
  await new coordinatorModule.ChatRoomAgentCoordinator(deps).resumeLeases()
  expect(calls).toEqual(['renew:agent-a', 'release'])
})

test('旧 Agent 续租后状态查询持续失败，释放可能已激活的租约', async () => {
  const calls: string[] = []
  let checks = 0
  const base = fakeDeps()
  const { deps } = fakeDeps({ rustApi: { ...base.deps.rustApi,
    getRoomHostUserId: async () => 'user-1',
    getRoomRealtimeStatus: async () => { if (++checks > 2) throw new Error('状态查询失败'); return { ready: true, epoch: 5 } },
    renewAgentLease: async (_roomId: string, id: string) => { calls.push(`renew:${id}`) },
    releaseAgentLeases: async () => { calls.push('release') },
  } })
  await new coordinatorModule.ChatRoomAgentCoordinator(deps).resumeLeases()
  expect(calls).toEqual(['renew:agent-a', 'release'])
})

test('服务端房间不是当前用户的房间时，不注册 Agent 或写入本地配置', async () => {
  let writes = 0
  const { deps } = fakeDeps({
    store: { read: () => undefined, provisionAgent: () => { writes++; throw new Error('unexpected') } },
    rustApi: { getRoomHostUserId: async () => 'another-user', registerAgent: async () => { writes++; return 'unexpected' } },
  })
  await expect(new coordinatorModule.ChatRoomAgentCoordinator(deps).provisionAgent({ roomId: 'room-1', sourceWorkspaceId: 'workspace-1', displayName: 'Grok', channelId: 'channel-1' })).rejects.toThrow('not_room_host')
  expect(writes).toBe(0)
})

test('注册响应丢失但服务器已经创建 Agent 时，先验证设备再恢复同一个 ID', async () => {
  const calls: string[] = []
  const room: ChatRoomLocalRoomConfig = { roomId: 'room-1', hostUserId: 'user-1', deviceId: 'device-1', lastProcessedSeq: 0, agents: [makeAgent('server-agent-1')], invocations: [], createdAt: 1, updatedAt: 1 }
  const { deps } = fakeDeps({
    store: { read: () => undefined, provisionAgent: (_identity: unknown, _input: unknown, id: string) => { expect(id).toBe('server-agent-1'); calls.push('local'); return room } },
    rustApi: {
      getRoomHostUserId: async () => 'user-1',
      registerAgent: async () => { calls.push('register'); throw new Error('响应丢失') },
      findRegisteredAgent: async () => { calls.push('verify-device'); return { agentId: 'server-agent-1', leaseVerified: true } },
      renewAgentLease: async () => { calls.push('lease') },
    },
  })
  const agent = await new coordinatorModule.ChatRoomAgentCoordinator(deps).provisionAgent({ roomId: 'room-1', sourceWorkspaceId: 'workspace-1', displayName: 'Grok', channelId: 'channel-1' })
  expect(agent.roomAgentId).toBe('server-agent-1')
  expect(calls).toEqual(['register', 'verify-device', 'local'])
})

test('设备验证续租响应丢失时，使用候选 ID 定向释放并撤销远端 Agent', async () => {
  const calls: string[] = []
  const base = fakeDeps()
  const { deps } = fakeDeps({
    store: { read: () => undefined, provisionAgent: () => { calls.push('local'); throw new Error('不应写入') } },
    rustApi: { ...base.deps.rustApi,
      getRoomHostUserId: async () => 'user-1',
      registerAgent: async () => { calls.push('register'); throw new Error('响应丢失') },
      findRegisteredAgent: async () => { calls.push('verify-device'); return { agentId: 'server-agent-1', leaseVerified: false } },
      releaseAgentLeases: async () => { calls.push('release') },
      unregisterAgent: async () => { calls.push('delete') },
    },
  })
  await expect(new coordinatorModule.ChatRoomAgentCoordinator(deps).provisionAgent({ roomId: 'room-1', sourceWorkspaceId: 'workspace-1', displayName: 'Grok', channelId: 'channel-1' })).rejects.toThrow('已撤销')
  expect(calls).toEqual(['register', 'verify-device', 'release', 'delete'])
})

test('同一房间并发添加 Agent 时，只发送一个远端注册请求', async () => {
  let release!: () => void
  let started!: () => void
  const pending = new Promise<void>((resolve) => { release = resolve })
  const barrier = new Promise<void>((resolve) => { started = resolve })
  const calls: string[] = []
  const room: ChatRoomLocalRoomConfig = { roomId: 'room-1', hostUserId: 'user-1', deviceId: 'device-1', lastProcessedSeq: 0, agents: [makeAgent('server-agent-1')], invocations: [], createdAt: 1, updatedAt: 1 }
  const { deps } = fakeDeps({ store: { read: () => undefined, provisionAgent: () => room }, rustApi: {
    getRoomHostUserId: async () => 'user-1',
    registerAgent: async () => { calls.push('register'); started(); await pending; return 'server-agent-1' },
    renewAgentLease: async () => undefined,
  } })
  const coordinator = new coordinatorModule.ChatRoomAgentCoordinator(deps)
  const input = { roomId: 'room-1', sourceWorkspaceId: 'workspace-1', displayName: 'Grok', channelId: 'channel-1' }
  const first = coordinator.provisionAgent(input)
  await barrier
  const second = coordinator.provisionAgent(input)
  release()
  await expect(second).rejects.toThrow('agent_busy')
  await first
  expect(calls).toEqual(['register'])
})

test('远端注册成功但本地保存失败时，撤销远端 Agent 并保留原始错误', async () => {
  const requests: string[] = []
  const { deps } = fakeDeps({
    store: { read: () => undefined, provisionAgent: () => { requests.push('local'); throw new Error('磁盘已满') } },
    rustApi: {
      getRoomHostUserId: async () => 'user-1',
      registerAgent: async () => { requests.push('register'); return 'server-agent-1' },
      unregisterAgent: async (roomId: string, agentId: string) => { requests.push(`delete:${roomId}:${agentId}`) },
    },
  })
  await expect(new coordinatorModule.ChatRoomAgentCoordinator(deps).provisionAgent({ roomId: 'room-1', sourceWorkspaceId: 'workspace-1', displayName: 'Grok', channelId: 'channel-1' })).rejects.toThrow('磁盘已满')
  expect(requests).toEqual(['register', 'local', 'delete:room-1:server-agent-1'])
})

test('新 Agent 租约建立失败时不能宣告配置成功，并撤销本地与远端配置', async () => {
  const requests: string[] = []
  const room: ChatRoomLocalRoomConfig = { roomId: 'room-1', hostUserId: 'user-1', deviceId: 'device-1', lastProcessedSeq: 0, agents: [makeAgent('server-agent-1')], invocations: [], createdAt: 1, updatedAt: 1 }
  const { deps } = fakeDeps({
    store: {
      read: () => undefined,
      provisionAgent: () => { requests.push('local'); return room },
      archiveAgent: () => { requests.push('archive'); return room },
    },
    rustApi: {
      getRoomHostUserId: async () => 'user-1',
      registerAgent: async () => { requests.push('register'); return 'server-agent-1' },
      renewAgentLease: async () => { requests.push('lease'); throw new Error('网关离线') },
      releaseAgentLeases: async () => { requests.push('release') },
      unregisterAgent: async () => { requests.push('delete') },
    },
  })
  await expect(new coordinatorModule.ChatRoomAgentCoordinator(deps).provisionAgent({ roomId: 'room-1', sourceWorkspaceId: 'workspace-1', displayName: 'Grok', channelId: 'channel-1' })).rejects.toThrow('网关离线')
  expect(requests).toEqual(['register', 'local', 'lease', 'release', 'archive', 'delete'])
})

test('重启后只为当前主理人本机配置恢复 Agent 租约', async () => {
  const renewed: string[] = []
  const base = fakeDeps()
  const { deps } = fakeDeps({
    rustApi: {
      ...base.deps.rustApi,
      getRoomHostUserId: async () => 'user-1',
      renewAgentLease: async (_roomId: string, agentId: string) => { renewed.push(agentId) },
    },
  })
  const coordinator = new coordinatorModule.ChatRoomAgentCoordinator(deps)
  await coordinator.resumeLeases()
  expect(renewed).toEqual(['agent-a', 'agent-b', 'agent-c'])
  const other = fakeDeps({ ...deps, getCurrentUserId: async () => 'other-user' })
  await new coordinatorModule.ChatRoomAgentCoordinator(other.deps).resumeLeases()
  expect(renewed).toHaveLength(3)
})

test('恢复租约时一个 Agent 失败不阻止同房间其他 Agent 上线', async () => {
  const calls: string[] = []
  const base = fakeDeps()
  const { deps } = fakeDeps({ rustApi: {
    ...base.deps.rustApi,
    getRoomHostUserId: async () => 'user-1',
    renewAgentLease: async (_roomId: string, id: string) => { calls.push(id); if (id === 'agent-a') throw new Error('Agent 已失效') },
  } })
  await new coordinatorModule.ChatRoomAgentCoordinator(deps).resumeLeases()
  expect(calls).toEqual(['agent-a', 'agent-b', 'agent-c'])
})

test('损坏房间不阻断其他房间 Agent 的租约恢复', async () => {
  const renewed: string[] = []
  const base = fakeDeps()
  const { deps, room } = fakeDeps({
    store: { list: () => { throw new Error('room.json 损坏') }, listRestorableRooms: () => [base.room] },
    rustApi: { ...base.deps.rustApi, getRoomHostUserId: async () => 'user-1', renewAgentLease: async (_roomId: string, id: string) => { renewed.push(id) } },
  })
  await new coordinatorModule.ChatRoomAgentCoordinator(deps).resumeLeases()
  expect(renewed).toEqual(room.agents.map((agent) => agent.roomAgentId))
})

test('损坏房间不应中断断线清理，重连后仍可添加新 Agent', async () => {
  const base = fakeDeps()
  const saved = { ...base.room, roomId: 'new-room', agents: [makeAgent('server-agent')] }
  const { deps } = fakeDeps({
    store: {
      list: () => { throw new Error('invalid_room_config') },
      listRestorableRooms: () => [base.room],
      read: () => undefined,
      provisionAgent: () => saved,
    },
    rustApi: {
      getRoomHostUserId: async () => 'user-1',
      registerAgent: async () => 'server-agent',
      renewAgentLease: async () => undefined,
    },
  })
  const coordinator = new coordinatorModule.ChatRoomAgentCoordinator(deps)
  const stopped = await coordinator.stopAll('gateway_disconnected')
  expect(stopped.releasedRoomAgentIds).toEqual(['agent-a', 'agent-b', 'agent-c'])
  const agent = await coordinator.provisionAgent({ roomId: 'new-room', sourceWorkspaceId: 'workspace-1', displayName: 'Grok', channelId: 'channel-1' })
  expect(agent.roomAgentId).toBe('server-agent')
})

test('房间目录暂时不可读导致清理失败后，下一次清理可重试而不永久卡在 stopping', async () => {
  const { deps } = fakeDeps()
  const list = deps.store.list
  deps.store.list = () => { throw new Error('目录不可读') }
  deps.store.listRestorableRooms = () => { throw new Error('目录不可读') }
  const coordinator = new coordinatorModule.ChatRoomAgentCoordinator(deps)
  await expect(coordinator.stopAll('gateway_disconnected')).rejects.toThrow('目录不可读')
  deps.store.list = list
  deps.store.listRestorableRooms = list
  const stopped = await coordinator.stopAll('gateway_disconnected')
  expect(stopped.releasedRoomAgentIds).toEqual(['agent-a', 'agent-b', 'agent-c'])
})

test('远端注册期间登出后，不能再创建本地 Agent 或续租', async () => {
  let releaseRegistration!: () => void
  let registrationStarted!: () => void
  const pending = new Promise<void>((resolve) => { releaseRegistration = resolve })
  const started = new Promise<void>((resolve) => { registrationStarted = resolve })
  const calls: string[] = []
  const base = fakeDeps()
  const { deps } = fakeDeps({
    store: { read: () => undefined, list: () => [], provisionAgent: () => { calls.push('local'); throw new Error('不应写入') } },
    rustApi: { ...base.deps.rustApi,
      getRoomHostUserId: async () => 'user-1',
      registerAgent: async () => { calls.push('register'); registrationStarted(); await pending; return 'server-agent-1' },
      renewAgentLease: async () => { calls.push('lease') },
      unregisterAgent: async () => { calls.push('delete') },
    },
  })
  const coordinator = new coordinatorModule.ChatRoomAgentCoordinator(deps)
  const provisioning = coordinator.provisionAgent({ roomId: 'room-1', sourceWorkspaceId: 'workspace-1', displayName: 'Grok', channelId: 'channel-1' })
  await started
  await coordinator.stopAll('logout')
  releaseRegistration()
  await expect(provisioning).rejects.toThrow('agent_offline')
  expect(calls).toEqual(['register', 'delete'])
})

test('旧 lease 请求在断连清理后完成，必须再次释放且不能保留本地 Agent', async () => {
  let releaseLease!: () => void
  let leaseStarted!: () => void
  const pending = new Promise<void>((resolve) => { releaseLease = resolve })
  const started = new Promise<void>((resolve) => { leaseStarted = resolve })
  const calls: string[] = []
  const room: ChatRoomLocalRoomConfig = { roomId: 'room-1', hostUserId: 'user-1', deviceId: 'device-1', lastProcessedSeq: 0, agents: [makeAgent('server-agent-1')], invocations: [], createdAt: 1, updatedAt: 1 }
  const base = fakeDeps()
  const { deps } = fakeDeps({
    store: { read: () => undefined, list: () => [room], provisionAgent: () => room, archiveAgent: () => { calls.push('archive'); return room } },
    rustApi: { ...base.deps.rustApi,
      getRoomHostUserId: async () => 'user-1', registerAgent: async () => 'server-agent-1',
      renewAgentLease: async () => { leaseStarted(); await pending; calls.push('lease-done') },
      releaseAgentLeases: async () => { calls.push('release') },
      unregisterAgent: async () => { calls.push('delete') },
    },
  })
  const coordinator = new coordinatorModule.ChatRoomAgentCoordinator(deps)
  const provisioning = coordinator.provisionAgent({ roomId: 'room-1', sourceWorkspaceId: 'workspace-1', displayName: 'Grok', channelId: 'channel-1' })
  await started
  await coordinator.stopAll('gateway_disconnected')
  releaseLease()
  await expect(provisioning).rejects.toThrow('agent_offline')
  expect(calls).toEqual(['release', 'lease-done', 'release', 'archive', 'delete'])
})

test('启动时恢复租约碰到登出，不得把刚完成的旧租约重新上线', async () => {
  let releaseLease!: () => void
  let leaseStarted!: () => void
  const pending = new Promise<void>((resolve) => { releaseLease = resolve })
  const started = new Promise<void>((resolve) => { leaseStarted = resolve })
  const calls: string[] = []
  const room: ChatRoomLocalRoomConfig = { roomId: 'room-1', hostUserId: 'user-1', deviceId: 'device-1', lastProcessedSeq: 0, agents: [makeAgent('agent-a')], invocations: [], createdAt: 1, updatedAt: 1 }
  const base = fakeDeps()
  const { deps } = fakeDeps({
    store: { list: () => [room], listRestorableRooms: () => [room] },
    rustApi: { ...base.deps.rustApi, getRoomHostUserId: async () => 'user-1',
      renewAgentLease: async () => { leaseStarted(); await pending; calls.push('lease-done') },
      releaseAgentLeases: async () => { calls.push('release') },
    },
  })
  const coordinator = new coordinatorModule.ChatRoomAgentCoordinator(deps)
  const restoration = coordinator.resumeLeases()
  await started
  await coordinator.stopAll('logout')
  releaseLease()
  await restoration
  expect(calls).toEqual(['release', 'lease-done', 'release'])
})

test('Given 三个在线 Agent When 并发投递 Then 各自立即启动且不共享全局队列', async () => {
  const { deps, runAgentHeadless } = fakeDeps()
  const coordinator = new coordinatorModule.ChatRoomAgentCoordinator(deps)
  await Promise.all(['agent-a', 'agent-b', 'agent-c'].map((agentId, index) => coordinator.handleInvocation({ ...makeInput(`inv-${index}`, agentId), traceId: `trace-${index}` })))
  expect(runAgentHeadless).toHaveBeenCalledTimes(3)
})

test('Given 相同 invocationId 并发到达 When 身份校验包含 await Then 只有一次 accepted/start', async () => {
  let releaseIdentity!: () => void
  const identity = new Promise<void>((resolve) => { releaseIdentity = resolve })
  const reportAccepted = mock(async () => {})
  const { deps, runAgentHeadless } = fakeDeps({
    getCurrentUserId: async () => { await identity; return 'user-1' },
    rustApi: { ...fakeDeps().deps.rustApi, reportAccepted },
  })
  const coordinator = new coordinatorModule.ChatRoomAgentCoordinator(deps)
  const first = coordinator.handleInvocation(makeInput('same-concurrent', 'agent-a'))
  const second = coordinator.handleInvocation(makeInput('same-concurrent', 'agent-a'))
  releaseIdentity()
  expect(await Promise.all([first, second])).toContain('duplicate')
  expect(reportAccepted).toHaveBeenCalledTimes(1)
  expect(runAgentHeadless).toHaveBeenCalledTimes(1)
})

test('Given 最后一次身份读取期间 Agent 被归档 When invocation 到达 Then ABA 失败且不启动', async () => {
  let reads = 0
  const { deps, runAgentHeadless, reportFailed } = fakeDeps({
    getCurrentUserId: async () => {
      reads++
      if (reads === 3) (depsStoreRoom as ChatRoomLocalRoomConfig).agents[0]!.archivedAt = 3
      return 'user-1'
    },
  })
  const depsStoreRoom = deps.store.read() as ChatRoomLocalRoomConfig
  const coordinator = new coordinatorModule.ChatRoomAgentCoordinator(deps)
  await coordinator.handleInvocation(makeInput('archive-aba', 'agent-a'))
  expect(runAgentHeadless).not.toHaveBeenCalled()
  expect(reportFailed).toHaveBeenCalledWith(expect.objectContaining({ code: 'room_agent_not_found' }))
})

test('Given 同一 trace 与 Agent 已有记录 When 重复投递 Then 返回 duplicate 且不重启', async () => {
  const { deps, runAgentHeadless } = fakeDeps()
  const coordinator = new coordinatorModule.ChatRoomAgentCoordinator(deps)
  await coordinator.handleInvocation(makeInput('inv-1', 'agent-a'))
  expect(await coordinator.handleInvocation({ ...makeInput('inv-2', 'agent-a'), traceId: 'trace-1' })).toBe('duplicate')
  expect(runAgentHeadless).toHaveBeenCalledTimes(1)
})

test('Given depth 为 3 或 Gateway 已断开 When 投递 Then 深度失败且可信新 invocation 可恢复连接', async () => {
  const { deps, runAgentHeadless, reportFailed } = fakeDeps()
  const coordinator = new coordinatorModule.ChatRoomAgentCoordinator(deps)
  await coordinator.handleInvocation({ ...makeInput('inv-deep', 'agent-a'), depth: 3 })
  await coordinator.handleGatewayDisconnected()
  await coordinator.handleInvocation({ ...makeInput('inv-reconnect', 'agent-a'), traceId: 'trace-reconnect' })
  expect(runAgentHeadless).toHaveBeenCalledTimes(1)
  expect(reportFailed).toHaveBeenCalledTimes(1)
})

test('Given Gateway 断开 When 重复或并发通知 Then 终态收敛并只释放一次全部未归档 Agent lease', async () => {
  const { deps } = fakeDeps()
  const releaseAgentLeases = deps.rustApi.releaseAgentLeases as ReturnType<typeof mock>
  const coordinator = new coordinatorModule.ChatRoomAgentCoordinator({
    ...deps,
    rustApi: { ...deps.rustApi, releaseAgentLeases },
  })

  await Promise.all([coordinator.handleGatewayDisconnected(), coordinator.handleGatewayDisconnected()])
  await coordinator.handleGatewayDisconnected()

  expect(releaseAgentLeases).toHaveBeenCalledTimes(1)
  expect(releaseAgentLeases).toHaveBeenCalledWith(expect.objectContaining({
    roomAgentIds: ['agent-a', 'agent-b', 'agent-c'],
    reason: 'gateway_disconnected',
  }))
  await coordinator.handleInvocation(makeInput('gateway-recovered', 'agent-a'))
})

test('Given logout 已停止 When 旧 invocation 到达 Then 拒绝；认证成功恢复后新 invocation 才执行', async () => {
  const { deps, runAgentHeadless, reportFailed } = fakeDeps()
  const coordinator = new coordinatorModule.ChatRoomAgentCoordinator(deps)
  await coordinator.stopAll('logout')
  await coordinator.handleInvocation(makeInput('logout-old', 'agent-a'))
  expect(reportFailed).toHaveBeenCalledWith(expect.objectContaining({ invocationId: 'logout-old', code: 'agent_offline' }))
  expect(runAgentHeadless).not.toHaveBeenCalled()
  await coordinator.resumeAfterAuthentication()
  await coordinator.handleInvocation({ ...makeInput('logout-new', 'agent-a'), traceId: 'trace-after-login' })
  expect(runAgentHeadless).toHaveBeenCalledTimes(1)
})

test('Given logout stop 正在进行 When authentication callback arrives Then it waits and does not revive app quit state', async () => {
  const { deps, runAgentHeadless } = fakeDeps()
  const coordinator = new coordinatorModule.ChatRoomAgentCoordinator(deps)
  const stop = coordinator.stopAll('app_quit')
  await coordinator.resumeAfterAuthentication()
  await stop
  await coordinator.handleInvocation(makeInput('quit-no-revive', 'agent-a'))
  expect(runAgentHeadless).not.toHaveBeenCalled()
})

test('Given gateway transient disconnect When trusted invocation arrives after stop Then it proves recovery once', async () => {
  const { deps, runAgentHeadless } = fakeDeps()
  const coordinator = new coordinatorModule.ChatRoomAgentCoordinator(deps)
  await coordinator.stopAll('gateway_disconnected')
  await coordinator.handleInvocation(makeInput('reconnect-new', 'agent-a'))
  expect(runAgentHeadless).toHaveBeenCalledTimes(1)
})

test('Given gateway stop is in flight When logout escalates Then auth_required wins over auto-resume', async () => {
  const { deps, runAgentHeadless, reportFailed } = fakeDeps()
  const coordinator = new coordinatorModule.ChatRoomAgentCoordinator(deps)
  const gatewayStop = coordinator.stopAll('gateway_disconnected')
  const logoutStop = coordinator.stopAll('logout')
  await Promise.all([gatewayStop, logoutStop])
  await coordinator.handleInvocation({ ...makeInput('late-auth-window', 'agent-a'), traceId: 'late-auth-window' })
  expect(runAgentHeadless).not.toHaveBeenCalled()
  expect(reportFailed).toHaveBeenCalledWith(expect.objectContaining({ invocationId: 'late-auth-window', code: 'agent_offline' }))
  await coordinator.resumeAfterAuthentication()
  await coordinator.handleInvocation({ ...makeInput('after-auth', 'agent-a'), traceId: 'after-auth' })
  expect(runAgentHeadless).toHaveBeenCalledTimes(1)
})

test('Given 三个 run 都被 barrier 卡住 When 批量投递 Then 任一完成前三个都已经启动', async () => {
  const started: string[] = []
  const release: Array<() => void> = []
  const { deps, runAgentHeadless } = fakeDeps({ runAgentHeadless: mock(async (input: { sessionId: string }, callbacks: { onComplete: (messages: AgentMessage[]) => void }) => {
    started.push(input.sessionId)
    await new Promise<void>((resolve) => release.push(() => { callbacks.onComplete([]); resolve() }))
  }) })
  const coordinator = new coordinatorModule.ChatRoomAgentCoordinator(deps)
  const all = Promise.all(['agent-a', 'agent-b', 'agent-c'].map((agentId, index) => coordinator.handleInvocation({ ...makeInput(`barrier-${index}`, agentId), traceId: `barrier-trace-${index}` })))
  for (let i = 0; i < 20 && started.length < 3; i++) await Promise.resolve()
  expect(started).toHaveLength(3)
  release.forEach((resolve) => resolve())
  await all
})

test('Given 两个聊天室使用相同 roomAgentId When room-1 被 barrier 卡住 Then room-2 仍可并行执行且同房间请求返回 busy', async () => {
  const started: string[] = []
  const release: Array<() => void> = []
  const base = fakeDeps({ runAgentHeadless: mock(async (input: { sessionId: string }, callbacks: { onComplete: (messages: AgentMessage[]) => void }) => {
    started.push(input.sessionId)
    await new Promise<void>((resolve) => release.push(() => { callbacks.onComplete([]); resolve() }))
  }) })
  const secondRoom: ChatRoomLocalRoomConfig = { ...base.room, roomId: 'room-2', agents: base.room.agents.map((agent) => ({ ...agent })) }
  base.deps.store.read = (roomId: string) => roomId === 'room-2' ? secondRoom : base.room
  base.deps.store.list = () => [base.room, secondRoom]
  const coordinator = new coordinatorModule.ChatRoomAgentCoordinator(base.deps)

  await coordinator.handleInvocation({ ...makeInput('pair-room-1', 'agent-a'), traceId: 'pair-room-1' })
  for (let attempt = 0; attempt < 20 && started.length < 1; attempt++) await Promise.resolve()
  expect(started).toEqual(['session-agent-a'])

  await coordinator.handleInvocation({ ...makeInput('pair-room-2', 'agent-a', 0, 'room-2'), traceId: 'pair-room-2' })
  await coordinator.handleInvocation({ ...makeInput('pair-room-1-busy', 'agent-a'), traceId: 'pair-room-1-busy' })
  expect(started).toEqual(['session-agent-a', 'session-agent-a'])
  expect(base.reportFailed).toHaveBeenCalledWith(expect.objectContaining({ invocationId: 'pair-room-1-busy', code: 'agent_busy' }))

  release.forEach((resolve) => resolve())
})

test('Given disconnect 已成功释放 lease When 合法 invocation 深度超限 Then 不恢复 lifecycle 或清理 generation lease 集合', async () => {
  const { deps, reportFailed } = fakeDeps()
  const coordinator = new coordinatorModule.ChatRoomAgentCoordinator(deps)
  await coordinator.stopAll('gateway_disconnected')
  await coordinator.handleInvocation({ ...makeInput('disconnected-depth', 'agent-a', 3), traceId: 'disconnected-depth' })
  expect(reportFailed).toHaveBeenCalledWith(expect.objectContaining({ invocationId: 'disconnected-depth', code: 'invocation_depth_exceeded' }))
  expect((coordinator as unknown as { lifecycle: string }).lifecycle).toBe('disconnected')
  await coordinator.stopAll('gateway_disconnected')
  expect(deps.rustApi.releaseAgentLeases).toHaveBeenCalledTimes(1)
})

test('Given disconnect 已成功释放 lease 且同 room Agent 可构造为 busy When busy invocation 到达 Then 不恢复 lifecycle 或重复释放 generation lease', async () => {
  const { deps, reportFailed } = fakeDeps()
  const coordinator = new coordinatorModule.ChatRoomAgentCoordinator(deps)
  await coordinator.stopAll('gateway_disconnected')
  const activeRuns = (coordinator as unknown as { activeRuns: Map<string, unknown> }).activeRuns
  activeRuns.set('synthetic-busy', { invocation: { roomId: 'room-1' }, config: { roomAgentId: 'agent-a' } })
  await coordinator.handleInvocation({ ...makeInput('disconnected-busy', 'agent-a'), traceId: 'disconnected-busy' })
  expect(reportFailed).toHaveBeenCalledWith(expect.objectContaining({ invocationId: 'disconnected-busy', code: 'agent_busy' }))
  expect((coordinator as unknown as { lifecycle: string }).lifecycle).toBe('disconnected')
  activeRuns.delete('synthetic-busy')
  await coordinator.stopAll('gateway_disconnected')
  expect(deps.rustApi.releaseAgentLeases).toHaveBeenCalledTimes(1)
})

test('Given depth=2 的结构化输出提及 Agent When 完成 Then mentions 仍交给服务端边界', async () => {
  const { deps } = fakeDeps({ runAgentHeadless: mock(async (_input: unknown, callbacks: { onComplete: (messages: AgentMessage[]) => void }) => callbacks.onComplete([{ role: 'assistant', id: 'assistant-2', content: '{"text":"完成","mentionedAgentIds":["agent-b"],"attachmentIds":[]}', createdAt: 2 } as AgentMessage])) })
  const coordinator = new coordinatorModule.ChatRoomAgentCoordinator(deps)
  await coordinator.handleInvocation({ ...makeInput('depth-two', 'agent-a', 2), traceId: 'depth-two-trace' })
  await new Promise((resolve) => setTimeout(resolve, 0))
})

test('Given Agent 输出提及多个 Agent When 完成 Then mentions 原样交给 Rust，由服务端事务创建下一跳', async () => {
  const reportCompleted = mock(async () => {})
  const base = fakeDeps()
  const { deps } = fakeDeps({ rustApi: { ...base.deps.rustApi, reportCompleted }, runAgentHeadless: mock(async (_input: unknown, callbacks: { onComplete: (messages: AgentMessage[]) => void }) => callbacks.onComplete([{ role: 'assistant', id: 'assistant-next', content: '{"text":"完成","mentionedAgentIds":["agent-b","agent-c"],"attachmentIds":[]}', createdAt: 2 } as AgentMessage])) })
  const coordinator = new coordinatorModule.ChatRoomAgentCoordinator(deps)
  await coordinator.handleInvocation(makeInput('next-hop-server-owned', 'agent-a'))
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(reportCompleted).toHaveBeenCalledWith(expect.objectContaining({ invocationId: 'next-hop-server-owned', output: { text: '完成', mentionedAgentIds: ['agent-b', 'agent-c'], attachmentIds: [] } }), expect.anything())
})

test('Given authenticated host/device 不匹配 When invocation 到达 Then fail closed 且不改外来 room', async () => {
  const { deps, records, runAgentHeadless, reportFailed } = fakeDeps({ getCurrentUserId: async () => 'other-user' })
  const coordinator = new coordinatorModule.ChatRoomAgentCoordinator(deps)
  await coordinator.handleInvocation(makeInput('foreign-room', 'agent-a'))
  expect(records.size).toBe(0)
  expect(runAgentHeadless).not.toHaveBeenCalled()
  expect(reportFailed).toHaveBeenCalledWith(expect.objectContaining({ code: 'not_room_member' }))
})

test('Given hidden session override 注册失败 When invocation 到达 Then terminal failed 且不运行普通 session', async () => {
  const { deps, runAgentHeadless, reportFailed } = fakeDeps({ registerSessionStorageOverride: () => { throw new Error('注册失败') } })
  const coordinator = new coordinatorModule.ChatRoomAgentCoordinator(deps)
  await coordinator.handleInvocation(makeInput('hidden-fail', 'agent-a'))
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(runAgentHeadless).not.toHaveBeenCalled()
  expect(reportFailed).toHaveBeenCalledWith(expect.objectContaining({ code: 'internal_error' }))
})

test('Given reportAccepted 失败 When invocation 到达 Then 不启动 Agent 并记录固定 terminal', async () => {
  const base = fakeDeps()
  const reportFailed = mock(async () => {})
  const { deps, runAgentHeadless } = fakeDeps({ rustApi: { ...base.deps.rustApi, reportAccepted: mock(async () => { throw new Error('secret sdk error') }), reportFailed } })
  const coordinator = new coordinatorModule.ChatRoomAgentCoordinator(deps)
  await coordinator.handleInvocation(makeInput('accepted-fail', 'agent-a'))
  expect(runAgentHeadless).not.toHaveBeenCalled()
  expect(reportFailed).toHaveBeenCalledWith(expect.objectContaining({ code: 'internal_error', message: '聊天室 Agent 执行失败' }))
})

test('Given reportRunning 失败 When accepted 已回传 Then 不启动 Agent 且固定失败', async () => {
  const base = fakeDeps()
  const reportFailed = mock(async () => {})
  const { deps, runAgentHeadless } = fakeDeps({ rustApi: { ...base.deps.rustApi, reportRunning: mock(async () => { throw new Error('raw sdk detail') }), reportFailed } })
  const coordinator = new coordinatorModule.ChatRoomAgentCoordinator(deps)
  await coordinator.handleInvocation(makeInput('running-fail', 'agent-a'))
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(runAgentHeadless).not.toHaveBeenCalled()
  expect(reportFailed).toHaveBeenCalledWith(expect.objectContaining({ code: 'internal_error', message: '聊天室 Agent 执行失败' }))
})

test('Given reportCompleted 结果未知 When Agent 完成 Then local remains uncertain and no lease release is claimed', async () => {
  const base = fakeDeps()
  const reportFailed = mock(async () => {})
  const { deps, records } = fakeDeps({ rustApi: { ...base.deps.rustApi, reportCompleted: mock(async () => { throw new Error('raw sdk detail') }), reportFailed } })
  const coordinator = new coordinatorModule.ChatRoomAgentCoordinator(deps)
  await coordinator.handleInvocation(makeInput('completed-fail', 'agent-a'))
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(records.get('completed-fail')?.status).toBe('running')
})

test('Given completion claimed while reportCompleted is pending When gateway disconnects Then completion wins and disconnect cannot overwrite local state', async () => {
  let releaseCompleted!: () => void
  const reportCompleted = mock(async () => await new Promise<void>((resolve) => { releaseCompleted = resolve }))
  const { deps, records, reportFailed } = fakeDeps({ rustApi: { ...fakeDeps().deps.rustApi, reportCompleted } })
  const coordinator = new coordinatorModule.ChatRoomAgentCoordinator(deps)
  await coordinator.handleInvocation(makeInput('completion-race', 'agent-a'))
  for (let i = 0; i < 20 && !reportCompleted.mock.calls.length; i++) await Promise.resolve()
  expect(records.get('completion-race')?.status).toBe('running')
  const disconnect = coordinator.handleGatewayDisconnected()
  expect(records.get('completion-race')?.status).toBe('running')
  releaseCompleted()
  await new Promise((resolve) => setTimeout(resolve, 0))
  await disconnect
  expect(records.get('completion-race')?.status).toBe('completed')
  expect(reportFailed).not.toHaveBeenCalled()
})

test('Given completion response is lost When stopAll is called Then idempotent finalize confirms terminal before lease release', async () => {
  let completionStarted = false
  const reportCompleted = mock(async (_input: unknown, options?: { signal?: AbortSignal }) => {
    completionStarted = true
    if (!options?.signal) return
    await new Promise<void>((_resolve, reject) => options.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))
  })
  const releaseAgentLeases = mock(async (_input: { roomAgentIds: string[] }) => {})
  const { deps, records } = fakeDeps({ rustApi: { ...fakeDeps().deps.rustApi, reportCompleted, releaseAgentLeases }, stopAgent: mock(async () => await new Promise<void>(() => {})) })
  const coordinator = new coordinatorModule.ChatRoomAgentCoordinator(deps)
  await coordinator.handleInvocation(makeInput('completion-never', 'agent-a'))
  for (let attempt = 0; attempt < 50 && !completionStarted; attempt++) await Promise.resolve()
  expect(completionStarted).toBe(true)
  const started = Date.now()
  await coordinator.stopAll('app_quit')
  expect(Date.now() - started).toBeLessThan(3_000)
  expect(records.get('completion-never')?.status).toBe('completed')
  expect(releaseAgentLeases).toHaveBeenCalled()
})

test('Given Rust 已写入 completed 但响应丢失 When finalize retry succeeds Then local terminal 也唯一为 completed', async () => {
  let serverCompleted = false
  const reportCompleted = mock(async (_input: unknown, options?: { signal?: AbortSignal }) => {
    if (reportCompleted.mock.calls.length === 1) {
      serverCompleted = true
      await new Promise<void>((_resolve, reject) => options?.signal?.addEventListener('abort', () => reject(new Error('response_lost')), { once: true }))
      return
    }
    if (serverCompleted) return
  })
  const reportFailed = mock(async () => {})
  const { deps, records } = fakeDeps({ rustApi: { ...fakeDeps().deps.rustApi, reportCompleted, reportFailed } })
  const coordinator = new coordinatorModule.ChatRoomAgentCoordinator(deps)
  await coordinator.handleInvocation(makeInput('remote-completed', 'agent-a'))
  await new Promise((resolve) => setTimeout(resolve, 1_200))
  expect(serverCompleted).toBe(true)
  expect(records.get('remote-completed')?.status).toBe('completed')
  expect(reportFailed).not.toHaveBeenCalled()
})

test('Given finalize retry 仍不可确认 When stopAll 收敛 Then uncertain run 不释放 lease', async () => {
  const reportCompleted = mock(async () => { throw new Error('unavailable') })
  const releaseAgentLeases = mock(async (_input: { roomAgentIds: string[] }) => {})
  const { deps, records } = fakeDeps({ rustApi: { ...fakeDeps().deps.rustApi, reportCompleted, releaseAgentLeases } })
  const coordinator = new coordinatorModule.ChatRoomAgentCoordinator(deps)
  await coordinator.handleInvocation(makeInput('uncertain-terminal', 'agent-a'))
  await new Promise((resolve) => setTimeout(resolve, 1_100))
  await coordinator.stopAll('app_quit')
  expect(records.get('uncertain-terminal')?.status).toBe('running')
  expect(releaseAgentLeases).not.toHaveBeenCalled()
})

test('Given reportFailed 网络失败 When stopAll 收敛 Then 未确认 terminal 保留 lease', async () => {
  const reportFailed = mock(async () => { throw new Error('network down') })
  const releaseAgentLeases = mock(async () => {})
  const base = fakeDeps()
  const { deps } = fakeDeps({ rustApi: { ...base.deps.rustApi, reportRunning: mock(async () => { throw new Error('running unavailable') }), reportFailed, releaseAgentLeases } })
  const coordinator = new coordinatorModule.ChatRoomAgentCoordinator(deps)
  await coordinator.handleInvocation(makeInput('failed-unconfirmed', 'agent-a'))
  await coordinator.stopAll('app_quit')
  expect(releaseAgentLeases).not.toHaveBeenCalled()
})

test('Given 首次 reportFailed 失败 When stopAll 重试成功 Then 使用原 failure claim 确认并只清理一次', async () => {
  let releaseCount = 0
  let failedCalls = 0
  let firstFailureSettled!: () => void
  const firstFailure = new Promise<void>((resolve) => { firstFailureSettled = resolve })
  const order: string[] = []
  const reportFailed = mock(async (input: { code: string; message: string }) => { failedCalls++; if (failedCalls === 1) { firstFailureSettled(); throw new Error('temporary network') }; expect(input.code).toBe('internal_error'); expect(input.message).toBe('聊天室 Agent 执行失败') })
  const releaseAgentLeases = mock(async () => { order.push('lease-release') })
  const sessionRelease = () => { releaseCount++; order.push('session-release') }
  const base = fakeDeps()
  const { deps } = fakeDeps({ rustApi: { ...base.deps.rustApi, reportRunning: mock(async () => { throw new Error('running unavailable') }), reportFailed, releaseAgentLeases }, registerSessionStorageOverride: () => sessionRelease })
  const coordinator = new coordinatorModule.ChatRoomAgentCoordinator(deps)
  await coordinator.handleInvocation(makeInput('failure-retry', 'agent-a'))
  await firstFailure
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(releaseCount).toBe(0)
  await coordinator.stopAll('app_quit')
  expect(reportFailed).toHaveBeenCalledTimes(2)
  expect(releaseAgentLeases).toHaveBeenCalled()
  expect(releaseCount).toBe(1)
  expect((coordinator as unknown as { activeRuns: Map<string, unknown> }).activeRuns.size).toBe(0)
  expect(order).toEqual(['session-release', 'lease-release'])
  await coordinator.stopAll('app_quit')
  expect(reportFailed).toHaveBeenCalledTimes(2)
  expect(releaseCount).toBe(1)
})

test('Given session cleanup 首次失败 When stopAll 重试 Then 未清理成功前不释放 lease 且后续只成功清理一次', async () => {
  let releaseAttempts = 0
  const releaseAgentLeases = mock(async () => {})
  const base = fakeDeps()
  const { deps } = fakeDeps({
    rustApi: { ...base.deps.rustApi, reportRunning: mock(async () => { throw new Error('running unavailable') }), releaseAgentLeases },
    registerSessionStorageOverride: () => () => { releaseAttempts++; if (releaseAttempts < 3) throw new Error('cleanup unavailable') },
  })
  const coordinator = new coordinatorModule.ChatRoomAgentCoordinator(deps)
  await coordinator.handleInvocation(makeInput('cleanup-retry', 'agent-a'))
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(releaseAttempts).toBe(1)
  await coordinator.stopAll('app_quit')
  expect(releaseAttempts).toBe(2)
  expect(releaseAgentLeases).not.toHaveBeenCalled()
  expect((coordinator as unknown as { activeRuns: Map<string, unknown> }).activeRuns.size).toBe(1)
  await coordinator.stopAll('app_quit')
  expect(releaseAttempts).toBe(3)
  expect(releaseAgentLeases).toHaveBeenCalledTimes(1)
  expect((coordinator as unknown as { activeRuns: Map<string, unknown> }).activeRuns.size).toBe(0)
  await coordinator.stopAll('app_quit')
  expect(releaseAttempts).toBe(3)
})

test('Given reportFailed 持续失败 When stopAll 使用不同 reason Then 原 failure claim 不变且不释放 lease', async () => {
  const reportFailed = mock(async (input: { code: string; message: string }) => { expect(input.code).toBe('internal_error'); expect(input.message).toBe('聊天室 Agent 执行失败'); throw new Error('offline') })
  const releaseAgentLeases = mock(async () => {})
  const base = fakeDeps()
  const { deps } = fakeDeps({ rustApi: { ...base.deps.rustApi, reportRunning: mock(async () => { throw new Error('running unavailable') }), reportFailed, releaseAgentLeases } })
  const coordinator = new coordinatorModule.ChatRoomAgentCoordinator(deps)
  await coordinator.handleInvocation(makeInput('failure-stable', 'agent-a'))
  await coordinator.stopAll('gateway_disconnected')
  expect(reportFailed).toHaveBeenCalledTimes(2)
  expect(releaseAgentLeases).not.toHaveBeenCalled()
})

test('Given contextMessageCount=50 且收到55条消息 When启动 Then只提交最新50条', async () => {
  let captured: AgentSendInputLike | undefined
  const messages = Array.from({ length: 55 }, (_, index) => ({ messageId: `m-${index}`, sender: { type: 'user' as const, id: 'u', displayName: '用户' }, text: `消息-${index}`, createdAt: index }))
  const { deps } = fakeDeps({ runAgentHeadless: mock(async (input: AgentSendInputLike, callbacks: { onComplete: (messages: AgentMessage[]) => void }) => { captured = input; callbacks.onComplete([]) }) })
  const coordinator = new coordinatorModule.ChatRoomAgentCoordinator(deps)
  await coordinator.handleInvocation({ ...makeInput('context-limit', 'agent-a'), messages })
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(captured?.userMessage.startsWith('用户: 消息-5')).toBe(true)
  expect(captured?.userMessage).not.toContain('消息-0')
})

test('Given Agent 请求敏感权限 When 主理人响应 Then 仅收到脱敏摘要且底层强制 alwaysAllow=false', async () => {
  let runtime: { requestPermission?: (request: PermissionRequest) => void } | undefined
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  const respondToPermission = mock(() => 'session-agent-a')
  const { deps } = fakeDeps({
    runAgentHeadless: mock(async (_input: unknown, callbacks: { trustedRuntimeContext?: { requestPermission?: (request: PermissionRequest) => void } }) => { runtime = callbacks.trustedRuntimeContext; await held }),
    getSensitiveValues: () => ['token-secret'],
    permissionService: { respondToPermission },
  })
  const coordinator = new coordinatorModule.ChatRoomAgentCoordinator(deps)
  const hostRequests: unknown[] = []
  coordinator.onPermissionRequested((request) => hostRequests.push(request))
  await coordinator.handleInvocation(makeInput('permission-1', 'agent-a'))
  for (let i = 0; i < 10 && !runtime; i++) await Promise.resolve()
  runtime?.requestPermission?.({ requestId: 'permission-request-1', sessionId: 'session-agent-a', toolName: 'Bash\u0000<script>', toolInput: { command: 'curl secret-token' }, description: '写入 /Users/private/project token-secret', dangerLevel: 'dangerous' })
  expect(JSON.stringify(hostRequests)).not.toContain('/Users/private/project')
  expect(JSON.stringify(hostRequests)).not.toContain('token-secret')
  await coordinator.respondToPermission({ requestId: 'permission-request-1', behavior: 'allow' })
  expect(respondToPermission).toHaveBeenCalledWith('permission-request-1', 'allow', false)
  release()
})

test('Given worker permission When external approval dispatches Then Main pending is installed before host notification', async () => {
  let pendingCreated = false
  const openExternalApproval = mock(async (_request: PermissionRequest, _signal: AbortSignal, dispatch: () => void) => { pendingCreated = true; dispatch(); return { behavior: 'deny' as const, message: '拒绝' } })
  const { deps } = fakeDeps({ permissionService: { openExternalApproval, respondToPermission: mock(() => 'session-agent-a') } })
  const coordinator = new coordinatorModule.ChatRoomAgentCoordinator(deps)
  let hostNotified = false
  coordinator.onPermissionRequested(() => { expect(pendingCreated).toBe(true); hostNotified = true })
  await coordinator.handleInvocation(makeInput('permission-order', 'agent-a'))
  const result = await coordinator.requestWorkerPermission!({ sessionId: 'session-agent-a', requestId: 'permission-order-1', toolName: 'Bash', toolInput: { command: 'echo test' } })
  expect(result.behavior).toBe('deny')
  expect(hostNotified).toBe(true)
})

test('Given worker permission When external approval dispatches Then IPC permission listener receives one redacted request', async () => {
  const openExternalApproval = mock(async (_request: PermissionRequest, _signal: AbortSignal, dispatch: () => void) => { dispatch(); return { behavior: 'deny' as const } })
  const { deps } = fakeDeps({ permissionService: { openExternalApproval, respondToPermission: mock(() => 'session-agent-a') } })
  const coordinator = new coordinatorModule.ChatRoomAgentCoordinator(deps)
  const pushed: unknown[] = []
  coordinator.onPermissionRequested((request) => pushed.push(request))
  await coordinator.handleInvocation(makeInput('permission-push', 'agent-a'))
  await coordinator.requestWorkerPermission!({ sessionId: 'session-agent-a', requestId: 'permission-push-1', toolName: 'Bash', toolInput: { command: 'secret' }, description: '执行命令' })
  expect(pushed).toHaveLength(1)
  expect(JSON.stringify(pushed)).not.toContain('toolInput')
})

test('Given host denies a pending permission When stopAgent never returns Then underlying promise is denied before bounded terminal handling', async () => {
  let runtime: { requestPermission?: (request: PermissionRequest) => void } | undefined
  const respondToPermission = mock(async () => 'session-agent-a')
  const stopAgent = mock(async () => await new Promise<void>(() => {}))
  const { deps, records } = fakeDeps({
    stopAgent,
    permissionService: { respondToPermission },
    runAgentHeadless: mock(async (_input: unknown, callbacks: { trustedRuntimeContext?: { requestPermission?: (request: PermissionRequest) => void } }) => { runtime = callbacks.trustedRuntimeContext; await new Promise<void>(() => {}) }),
  })
  const coordinator = new coordinatorModule.ChatRoomAgentCoordinator(deps)
  await coordinator.handleInvocation(makeInput('deny-bounded', 'agent-a'))
  for (let i = 0; i < 10 && !runtime; i++) await Promise.resolve()
  runtime?.requestPermission?.({ requestId: 'deny-request', sessionId: 'session-agent-a', toolName: 'Bash', toolInput: { command: 'rm -rf project' }, description: '危险命令', dangerLevel: 'dangerous' })
  await coordinator.respondToPermission({ requestId: 'deny-request', behavior: 'deny' })
  expect(respondToPermission).toHaveBeenCalledWith('deny-request', 'deny', false)
  expect(records.get('deny-bounded')?.status).toBe('failed')
})

test('Given permissionTimeoutMs 可注入 When 主理人不响应 Then worker pending 显式 deny 且 terminal 收敛', async () => {
  let runtime: { requestPermission?: (request: PermissionRequest) => void } | undefined
  const respondToPermission = mock(async () => 'session-agent-a')
  const { deps, records } = fakeDeps({
    permissionTimeoutMs: 10,
    permissionService: { respondToPermission, openExternalApproval: async () => await new Promise<never>(() => {}) },
    runAgentHeadless: mock(async (_input: unknown, callbacks: { trustedRuntimeContext?: { requestPermission?: (request: PermissionRequest) => void } }) => { runtime = callbacks.trustedRuntimeContext; await new Promise<void>(() => {}) }),
  })
  const coordinator = new coordinatorModule.ChatRoomAgentCoordinator(deps)
  await coordinator.handleInvocation(makeInput('permission-timeout', 'agent-a'))
  for (let i = 0; i < 10 && !runtime; i++) await Promise.resolve()
  runtime?.requestPermission?.({ requestId: 'timeout-request', sessionId: 'session-agent-a', toolName: 'Bash', toolInput: { command: 'danger' }, description: '危险操作', dangerLevel: 'dangerous' })
  await new Promise((resolve) => setTimeout(resolve, 30))
  expect(respondToPermission).toHaveBeenCalledWith('timeout-request', 'deny', false)
  expect(records.get('permission-timeout')?.failureCode).toBe('host_approval_timeout')
})

test('Given skill snapshot digest 不匹配 When invocation 启动 Then 拒绝执行并记录固定失败', async () => {
  const reportFailed = mock(async () => {})
  const { deps, runAgentHeadless } = fakeDeps({
    room: undefined,
    rustApi: { ...fakeDeps().deps.rustApi, reportFailed },
  })
  const room = (deps.store.read() as ChatRoomLocalRoomConfig)
  room.agents[0] = { ...room.agents[0]!, skillSharingEnabled: true, skillSnapshotDigest: 'b'.repeat(64) }
  const coordinator = new coordinatorModule.ChatRoomAgentCoordinator(deps)
  await coordinator.handleInvocation(makeInput('skill-mismatch', 'agent-a'))
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(runAgentHeadless).not.toHaveBeenCalled()
  expect(reportFailed).toHaveBeenCalledWith(expect.objectContaining({ code: 'invalid_invocation' }))
})

test('Given 本地存在多个未归档 Agent When stopAll Then 释放全部 lease 且重复调用幂等', async () => {
  const { deps } = fakeDeps()
  const coordinator = new coordinatorModule.ChatRoomAgentCoordinator(deps)
  const first = await coordinator.stopAll('gateway_disconnected')
  const second = await coordinator.stopAll('gateway_disconnected')
  expect(first.releasedRoomAgentIds).toEqual(['agent-a', 'agent-b', 'agent-c'])
  expect(second.releasedRoomAgentIds).toEqual([])
  expect(deps.rustApi.releaseAgentLeases).toHaveBeenCalledTimes(1)
})

test('Given 两个聊天室共六个未归档 Agent When stopAll Then 每批最多释放三个且汇总全部成功 lease', async () => {
  const base = fakeDeps()
  const secondRoom = { ...base.room, roomId: 'room-2', agents: ['agent-d', 'agent-e', 'agent-f'].map(makeAgent) }
  base.deps.store.list = () => [base.room, secondRoom]
  const releaseAgentLeases = mock(async (_input: { roomAgentIds: string[] }) => {})
  base.deps.rustApi.releaseAgentLeases = releaseAgentLeases
  const coordinator = new coordinatorModule.ChatRoomAgentCoordinator(base.deps)

  const result = await coordinator.stopAll('gateway_disconnected')

  expect(releaseAgentLeases.mock.calls.map(([input]) => input!.roomAgentIds)).toEqual([
    ['agent-a', 'agent-b', 'agent-c'],
    ['agent-d', 'agent-e', 'agent-f'],
  ])
  expect(releaseAgentLeases.mock.calls.every(([input]) => input!.roomAgentIds.length <= 3)).toBe(true)
  expect(result.releasedRoomAgentIds).toEqual(['agent-a', 'agent-b', 'agent-c', 'agent-d', 'agent-e', 'agent-f'])
})

test('Given 两个聊天室存在相同 roomAgentId When stopAll Then 按精确 room lease pair 分批释放且不漏报重复 ID', async () => {
  const base = fakeDeps()
  const secondRoom = { ...base.room, roomId: 'room-2', agents: ['agent-a', 'agent-b', 'agent-c'].map(makeAgent) }
  base.deps.store.list = () => [base.room, secondRoom]
  const releaseAgentLeases = mock(async (_input: { roomAgentIds: string[]; leases: Array<{ roomId: string; roomAgentId: string }> }) => {})
  base.deps.rustApi.releaseAgentLeases = releaseAgentLeases
  const coordinator = new coordinatorModule.ChatRoomAgentCoordinator(base.deps)

  const result = await coordinator.stopAll('gateway_disconnected')

  expect(releaseAgentLeases.mock.calls.map(([input]) => input!.leases)).toEqual([
    [{ roomId: 'room-1', roomAgentId: 'agent-a' }, { roomId: 'room-1', roomAgentId: 'agent-b' }, { roomId: 'room-1', roomAgentId: 'agent-c' }],
    [{ roomId: 'room-2', roomAgentId: 'agent-a' }, { roomId: 'room-2', roomAgentId: 'agent-b' }, { roomId: 'room-2', roomAgentId: 'agent-c' }],
  ])
  expect(result.releasedRoomAgentIds).toEqual(['agent-a', 'agent-b', 'agent-c', 'agent-a', 'agent-b', 'agent-c'])
})

test('Given disconnect 后可信 invocation 或重新认证建立新 generation When 再次断开 Then 相同 lease pair 再次释放', async () => {
  const { deps, runAgentHeadless } = fakeDeps()
  const coordinator = new coordinatorModule.ChatRoomAgentCoordinator(deps)

  await coordinator.handleGatewayDisconnected()
  await coordinator.handleInvocation(makeInput('new-generation', 'agent-a'))
  await new Promise((resolve) => setTimeout(resolve, 0))
  await coordinator.handleGatewayDisconnected()
  await coordinator.stopAll('logout')
  await coordinator.resumeAfterAuthentication()
  await coordinator.handleGatewayDisconnected()

  expect(runAgentHeadless).toHaveBeenCalledTimes(1)
  expect(deps.rustApi.releaseAgentLeases).toHaveBeenCalledTimes(3)
  expect((deps.rustApi.releaseAgentLeases as ReturnType<typeof mock>).mock.calls.every(([input]) => input!.leases.length === 3)).toBe(true)
})

test('Given 某一批 lease 释放失败 When stopAll 重试 Then 只重试失败批次且不谎报成功批次', async () => {
  const base = fakeDeps()
  const secondRoom = { ...base.room, roomId: 'room-2', agents: ['agent-d', 'agent-e', 'agent-f'].map(makeAgent) }
  base.deps.store.list = () => [base.room, secondRoom]
  let calls = 0
  const releaseAgentLeases = mock(async (input: { roomAgentIds: string[] }) => {
    calls++
    if (calls === 1) throw new Error('first batch unavailable')
    expect(input.roomAgentIds).toEqual(calls === 2 ? ['agent-d', 'agent-e', 'agent-f'] : ['agent-a', 'agent-b', 'agent-c'])
  })
  base.deps.rustApi.releaseAgentLeases = releaseAgentLeases
  const coordinator = new coordinatorModule.ChatRoomAgentCoordinator(base.deps)

  const first = await coordinator.stopAll('gateway_disconnected')
  const second = await coordinator.stopAll('gateway_disconnected')

  expect(first.releasedRoomAgentIds).toEqual(['agent-d', 'agent-e', 'agent-f'])
  expect(second.releasedRoomAgentIds).toEqual(['agent-a', 'agent-b', 'agent-c'])
  expect(releaseAgentLeases.mock.calls.map(([input]) => input!.roomAgentIds)).toEqual([
    ['agent-a', 'agent-b', 'agent-c'],
    ['agent-d', 'agent-e', 'agent-f'],
    ['agent-a', 'agent-b', 'agent-c'],
  ])
})

test('Given 首次 lease release 失败 When 并发 stopAll 后再次重试 Then 不误报并复用已完成清理', async () => {
  let releaseCalls = 0
  let sessionCleanupCalls = 0
  const releaseAgentLeases = mock(async () => { releaseCalls++; if (releaseCalls === 1) throw new Error('lease service unavailable') })
  const base = fakeDeps()
  const { deps, runAgentHeadless, reportCompleted } = fakeDeps({
    rustApi: { ...base.deps.rustApi, releaseAgentLeases },
    registerSessionStorageOverride: () => () => { sessionCleanupCalls++ },
  })
  const coordinator = new coordinatorModule.ChatRoomAgentCoordinator(deps)
  await coordinator.handleInvocation(makeInput('lease-retry', 'agent-a'))
  for (let attempt = 0; attempt < 20 && runAgentHeadless.mock.calls.length === 0; attempt++) await Promise.resolve()
  expect(runAgentHeadless).toHaveBeenCalledTimes(1)
  for (let attempt = 0; attempt < 20 && reportCompleted.mock.calls.length === 0; attempt++) await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(sessionCleanupCalls).toBe(1)
  const [first, concurrent] = await Promise.all([coordinator.stopAll('app_quit'), coordinator.stopAll('app_quit')])
  expect(first.releasedRoomAgentIds).toEqual([])
  expect(concurrent).toEqual(first)
  expect(releaseCalls).toBe(1)
  const second = await coordinator.stopAll('app_quit')
  expect(second.releasedRoomAgentIds).toEqual(['agent-a', 'agent-b', 'agent-c'])
  expect(releaseCalls).toBe(2)
  expect(sessionCleanupCalls).toBe(1)
})

test('Given SDK delta 含 secret/path When EventBus 转发 Then 使用 UTF-8 16KiB sanitizer 且50ms内不重复上报', async () => {
  let listener!: (sessionId: string, payload: unknown) => void
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  const { deps } = fakeDeps({
    getSensitiveValues: () => ['token-secret'],
    subscribeAgentEvents: (next: (sessionId: string, payload: unknown) => void) => { listener = next; return () => {} },
    runAgentHeadless: mock(async (_input: unknown, callbacks: { onComplete: (messages: AgentMessage[]) => void }) => { await held; callbacks.onComplete([]) }),
  })
  const coordinator = new coordinatorModule.ChatRoomAgentCoordinator(deps)
  coordinator.start()
  await coordinator.handleInvocation(makeInput('delta-safe', 'agent-a'))
  listener('session-agent-a', { kind: 'sdk_message', message: { type: 'assistant', message: { content: [{ type: 'text', text: `/Users/private token-secret ${'界'.repeat(20_000)}` }] } } })
  listener('session-agent-a', { kind: 'sdk_message', message: { type: 'assistant', message: { content: [{ type: 'text', text: '第二次' }] } } })
  await new Promise((resolve) => setTimeout(resolve, 0))
  const deltas = (deps.rustApi.reportDelta as ReturnType<typeof mock>).mock.calls
  expect(deltas.length).toBe(1)
  expect(String(deltas[0]?.[0].delta)).not.toContain('token-secret')
  expect(new TextEncoder().encode(String(deltas[0]?.[0].delta)).byteLength).toBeLessThanOrEqual(16 * 1024)
  release()
})

type AgentSendInputLike = { userMessage: string }
