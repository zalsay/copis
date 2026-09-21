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
    list: () => [room],
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
  return {
    deps: {
      store,
      rustApi: { reportAccepted, reportRunning, reportDelta: mock(async () => {}), reportCompleted, reportFailed, releaseAgentLeases: mock(async () => {}) },
      getCurrentUserId: async () => 'user-1', getDeviceId: () => 'device-1', getSensitiveValues: () => [], runAgentHeadless, stopAgent: mock(async () => {}), subscribeAgentEvents: () => () => {}, createHiddenSessionStore: () => ({}) as never, registerSessionStorageOverride: () => () => {}, syncSkills: () => ({ snapshotPath: '/tmp/skills', digest: 'a'.repeat(64), skillSlugs: [], syncedAt: 1 }), createNextHop: mock(async () => {}), sendPermissionToHost: mock(() => {}), now: () => 2, ...overrides,
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

test('Given depth 为 3 或 Gateway 已断开 When 投递 Then 立即失败且不启动', async () => {
  const { deps, runAgentHeadless, reportFailed } = fakeDeps()
  const coordinator = new coordinatorModule.ChatRoomAgentCoordinator(deps)
  await coordinator.handleInvocation({ ...makeInput('inv-deep', 'agent-a'), depth: 3 })
  await coordinator.handleGatewayDisconnected()
  await coordinator.handleInvocation({ ...makeInput('inv-offline', 'agent-a'), traceId: 'trace-offline' })
  expect(runAgentHeadless).not.toHaveBeenCalled()
  expect(reportFailed).toHaveBeenCalledTimes(2)
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

test('Given depth=2 的结构化输出提及 Agent When 完成 Then 不创建下一跳', async () => {
  const createNextHop = mock(async () => {})
  const { deps } = fakeDeps({ createNextHop, runAgentHeadless: mock(async (_input: unknown, callbacks: { onComplete: (messages: AgentMessage[]) => void }) => callbacks.onComplete([{ role: 'assistant', id: 'assistant-2', content: '{"text":"完成","mentionedAgentIds":["agent-b"],"attachmentIds":[]}', createdAt: 2 } as AgentMessage])) })
  const coordinator = new coordinatorModule.ChatRoomAgentCoordinator(deps)
  await coordinator.handleInvocation({ ...makeInput('depth-two', 'agent-a', 2), traceId: 'depth-two-trace' })
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(createNextHop).not.toHaveBeenCalled()
})

test('Given 多个 next-hop 且一路失败 When Agent 完成 Then 其它目标仍并行调度', async () => {
  const createNextHop = mock(async ({ targetAgentId }: { targetAgentId: string }) => { if (targetAgentId === 'agent-b') throw new Error('isolated failure') })
  const { deps } = fakeDeps({ createNextHop, runAgentHeadless: mock(async (_input: unknown, callbacks: { onComplete: (messages: AgentMessage[]) => void }) => callbacks.onComplete([{ role: 'assistant', id: 'assistant-next', content: '{"text":"完成","mentionedAgentIds":["agent-b","agent-c"],"attachmentIds":[]}', createdAt: 2 } as AgentMessage])) })
  const coordinator = new coordinatorModule.ChatRoomAgentCoordinator(deps)
  await coordinator.handleInvocation(makeInput('next-hop-isolation', 'agent-a'))
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(createNextHop).toHaveBeenCalledTimes(2)
  expect(createNextHop.mock.calls.map(([input]) => input.targetAgentId)).toEqual(expect.arrayContaining(['agent-b', 'agent-c']))
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
  const createNextHop = mock(async () => {})
  const { deps, records } = fakeDeps({ rustApi: { ...base.deps.rustApi, reportCompleted: mock(async () => { throw new Error('raw sdk detail') }), reportFailed }, createNextHop })
  const coordinator = new coordinatorModule.ChatRoomAgentCoordinator(deps)
  await coordinator.handleInvocation(makeInput('completed-fail', 'agent-a'))
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(records.get('completed-fail')?.status).toBe('running')
  expect(createNextHop).not.toHaveBeenCalled()
})

test('Given completion claimed while reportCompleted is pending When gateway disconnects Then completion wins and disconnect cannot overwrite local state', async () => {
  let releaseCompleted!: () => void
  const reportCompleted = mock(async () => await new Promise<void>((resolve) => { releaseCompleted = resolve }))
  const { deps, records, reportFailed } = fakeDeps({ rustApi: { ...fakeDeps().deps.rustApi, reportCompleted } })
  const coordinator = new coordinatorModule.ChatRoomAgentCoordinator(deps)
  await coordinator.handleInvocation(makeInput('completion-race', 'agent-a'))
  for (let i = 0; i < 20 && !reportCompleted.mock.calls.length; i++) await Promise.resolve()
  expect(records.get('completion-race')?.status).toBe('running')
  await coordinator.handleGatewayDisconnected()
  expect(records.get('completion-race')?.status).toBe('running')
  releaseCompleted()
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(records.get('completion-race')?.status).toBe('completed')
  expect(reportFailed).not.toHaveBeenCalled()
})

test('Given completion response is lost When stopAll is called Then idempotent finalize confirms terminal before lease release', async () => {
  const reportCompleted = mock(async (_input: unknown, options?: { signal?: AbortSignal }) => {
    if (!options?.signal) return
    await new Promise<void>((_resolve, reject) => options.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))
  })
  const releaseAgentLeases = mock(async () => {})
  const { deps, records } = fakeDeps({ rustApi: { ...fakeDeps().deps.rustApi, reportCompleted, releaseAgentLeases }, stopAgent: mock(async () => await new Promise<void>(() => {})) })
  const coordinator = new coordinatorModule.ChatRoomAgentCoordinator(deps)
  await coordinator.handleInvocation(makeInput('completion-never', 'agent-a'))
  await new Promise((resolve) => setTimeout(resolve, 0))
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
  const releaseAgentLeases = mock(async () => {})
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
  const reportFailed = mock(async (input: { code: string; message: string }) => { failedCalls++; if (failedCalls === 1) throw new Error('temporary network'); expect(input.code).toBe('internal_error'); expect(input.message).toBe('聊天室 Agent 执行失败') })
  const releaseAgentLeases = mock(async () => {})
  const sessionRelease = () => { releaseCount++ }
  const base = fakeDeps()
  const { deps } = fakeDeps({ rustApi: { ...base.deps.rustApi, reportRunning: mock(async () => { throw new Error('running unavailable') }), reportFailed, releaseAgentLeases }, registerSessionStorageOverride: () => sessionRelease })
  const coordinator = new coordinatorModule.ChatRoomAgentCoordinator(deps)
  await coordinator.handleInvocation(makeInput('failure-retry', 'agent-a'))
  await coordinator.stopAll('app_quit')
  expect(reportFailed).toHaveBeenCalledTimes(2)
  expect(releaseAgentLeases).toHaveBeenCalled()
  expect(releaseCount).toBe(1)
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
  const sendPermissionToHost = mock(() => {})
  const respondToPermission = mock(() => 'session-agent-a')
  const { deps } = fakeDeps({
    runAgentHeadless: mock(async (_input: unknown, callbacks: { trustedRuntimeContext?: { requestPermission?: (request: PermissionRequest) => void } }) => { runtime = callbacks.trustedRuntimeContext; await held }),
    getSensitiveValues: () => ['token-secret'],
    sendPermissionToHost,
    permissionService: { respondToPermission },
  })
  const coordinator = new coordinatorModule.ChatRoomAgentCoordinator(deps)
  await coordinator.handleInvocation(makeInput('permission-1', 'agent-a'))
  for (let i = 0; i < 10 && !runtime; i++) await Promise.resolve()
  runtime?.requestPermission?.({ requestId: 'permission-request-1', sessionId: 'session-agent-a', toolName: 'Bash\u0000<script>', toolInput: { command: 'curl secret-token' }, description: '写入 /Users/private/project token-secret', dangerLevel: 'dangerous' })
  expect(JSON.stringify(sendPermissionToHost.mock.calls)).not.toContain('/Users/private/project')
  expect(JSON.stringify(sendPermissionToHost.mock.calls)).not.toContain('token-secret')
  await coordinator.respondToPermission({ requestId: 'permission-request-1', behavior: 'allow' })
  expect(respondToPermission).toHaveBeenCalledWith('permission-request-1', 'allow', false)
  release()
})

test('Given worker permission When external approval dispatches Then Main pending is installed before host notification', async () => {
  let hostNotified = false
  let pendingCreated = false
  const sendPermissionToHost = mock(() => { expect(pendingCreated).toBe(true); hostNotified = true })
  const openExternalApproval = mock(async (_request: PermissionRequest, _signal: AbortSignal, dispatch: () => void) => { pendingCreated = true; dispatch(); return { behavior: 'deny' as const, message: '拒绝' } })
  const { deps } = fakeDeps({ sendPermissionToHost, permissionService: { openExternalApproval, respondToPermission: mock(() => 'session-agent-a') } })
  const coordinator = new coordinatorModule.ChatRoomAgentCoordinator(deps)
  await coordinator.handleInvocation(makeInput('permission-order', 'agent-a'))
  const result = await coordinator.requestWorkerPermission!({ sessionId: 'session-agent-a', requestId: 'permission-order-1', toolName: 'Bash', toolInput: { command: 'echo test' } })
  expect(result.behavior).toBe('deny')
  expect(hostNotified).toBe(true)
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
  expect(second).toBe(first)
  expect(deps.rustApi.releaseAgentLeases).toHaveBeenCalledTimes(1)
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
