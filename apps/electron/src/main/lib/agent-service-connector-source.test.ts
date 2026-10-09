import { expect, mock, test } from 'bun:test'
import type { AgentSendInput } from '@copis/shared'
import type { ChatRoomAgentRuntimeContext } from '@copis/shared'
import { getTrustedAgentExternalSource, hasTrustedAgentRpcRun } from './agent-rpc-source-context'
import { getTrustedAgentRuntimeContext } from './agent-rpc-runtime-context'

let observedSource: string | undefined
let observedRuntimeContext: unknown
let observedTrustedRunId: string | undefined
let observedTrustedRunActive = false
let gatewayRunOverride: ((input: AgentSendInput, callbacks: Record<string, (...args: unknown[]) => void>) => Promise<void>) | undefined
let currentHeadlessTarget: { isDestroyed: () => boolean; once: (event: string, listener: () => void) => void; send: (...args: unknown[]) => void } | null = null
const emittedEvents: Array<{ sessionId: string; payload: unknown }> = []
let eventMiddleware: ((sessionId: string, payload: unknown, next: () => void) => void) | undefined

mock.module('./agent-event-bus', () => ({
  AgentEventBus: class {
    use(middleware: typeof eventMiddleware): void { eventMiddleware = middleware }
    emit(sessionId: string, payload: unknown): void {
      emittedEvents.push({ sessionId, payload })
      eventMiddleware?.(sessionId, payload, () => {})
    }
  },
}))

mock.module('./agent-rpc-gateway', () => ({
  agentRpcGateway: {
    run: async (input: AgentSendInput, callbacks: Record<string, (...args: unknown[]) => void>, options?: { trustedRunId?: string }): Promise<void> => {
      observedSource = getTrustedAgentExternalSource(input.sessionId)
      observedRuntimeContext = getTrustedAgentRuntimeContext(input.sessionId)
      observedTrustedRunId = options?.trustedRunId
      observedTrustedRunActive = options?.trustedRunId ? hasTrustedAgentRpcRun(input.sessionId, options.trustedRunId) : false
      await gatewayRunOverride?.(input, callbacks)
    },
    stop: async (): Promise<void> => {},
    isActive: async (): Promise<boolean> => false,
  },
}))

mock.module('./agent-session-rewind-service', () => ({
  agentSessionRewindService: {},
}))

mock.module('./config-paths', () => ({
  getAgentSessionWorkspacePath: () => '/tmp/copis-agent-service-test/session',
}))

mock.module('./agent-workspace-manager', () => ({
  ensureAgentWorkspaceWritableRoot: () => '/tmp/copis-agent-service-test/copis',
  getAgentWorkspaceBySlug: () => undefined,
  getLocalProjectRootStatus: () => 'available',
}))

mock.module('./agent-session-manager', () => ({
  getAgentSessionMeta: () => undefined,
  updateAgentSessionMeta: () => undefined,
}))

mock.module('./agent-headless-runner-registry', () => ({
  setAgentStopper: (): void => {},
  setHeadlessAgentRunner: (): void => {},
}))

mock.module('./agent-headless-run-target', () => ({
  getHeadlessAgentRunTarget: () => currentHeadlessTarget,
}))

mock.module('./agent-completion-payload', () => ({
  sendAgentStreamComplete: (): void => {},
}))

mock.module('./http-api-server', () => ({
  getHttpApiInternalToken: () => undefined,
}))

mock.module('./agent-collaboration-tools', () => ({
  registerCollaborationEventBus: (): void => {},
}))

mock.module('electron', () => ({
  BrowserWindow: Object.assign(class {}, { getAllWindows: () => [] }),
}))

test('Given 普通旧会话由飞书 headless bridge 触发 When Agent RPC 启动 Then 运行期间识别可信飞书来源并在结束后清理', async () => {
  const { runAgentHeadless } = await import('./agent-service')
  const input: AgentSendInput = {
    sessionId: 'connector-session',
    userMessage: '读取跨工作区目录',
    channelId: 'channel-1',
    agentRuntime: 'pi',
    workspaceId: 'workspace-1',
  }

  await runAgentHeadless(input, {
    source: 'feishu',
    onError: () => {},
    onComplete: () => {},
    onTitleUpdated: () => {},
  })

  expect(observedSource).toBe('feishu')
  expect(typeof observedTrustedRunId).toBe('string')
  expect(observedTrustedRunActive).toBe(true)
  expect(hasTrustedAgentRpcRun(input.sessionId, observedTrustedRunId!)).toBe(false)
  expect(getTrustedAgentExternalSource(input.sessionId)).toBeUndefined()
})

test('Given chatroom headless run supplies trusted context When gateway runs Then context is visible only during run and cleaned afterwards', async () => {
  const { getTrustedAgentRuntimeContext } = await import('./agent-rpc-runtime-context')
  const { runAgentHeadless } = await import('./agent-service')
  const context: ChatRoomAgentRuntimeContext = {
    executionWorkspace: { root: '/tmp/chatroom', projectRoot: '/tmp/chatroom/project', inboxRoot: '/tmp/chatroom/inbox', sessionRoot: '/tmp/chatroom/session' },
    permissionContext: { roomId: 'room-1', roomAgentId: 'agent-1', invocationId: 'invocation-1', traceId: 'trace-1', originalSender: { type: 'user', id: 'user-1', displayName: '用户' }, invocationChain: [] },
  }
  await runAgentHeadless({
    sessionId: 'chatroom-session', userMessage: '执行', channelId: 'channel-1', agentRuntime: 'pi', workspaceId: 'workspace-1',
  }, {
    source: 'chatroom', trustedRuntimeContext: context,
    onError: () => {}, onComplete: () => {}, onTitleUpdated: () => {},
  })
  expect(getTrustedAgentRuntimeContext('chatroom-session')).toBeUndefined()
  expect(observedRuntimeContext).toMatchObject({ executionWorkspace: { projectRoot: '/tmp/chatroom/project' } })
})

test('Given chatroom RPC is preparing When its run signal aborts Then only that trusted registration is revoked before RPC completion', async () => {
  const { registerTrustedAgentExternalSource } = await import('./agent-rpc-source-context')
  const { registerTrustedAgentRuntimeContext: registerRuntime } = await import('./agent-rpc-runtime-context')
  const { runAgentHeadless } = await import('./agent-service')
  const context: ChatRoomAgentRuntimeContext = {
    executionWorkspace: { root: '/tmp/chatroom/a', projectRoot: '/tmp/chatroom/a/project', inboxRoot: '/tmp/chatroom/a/inbox', sessionRoot: '/tmp/chatroom/a/session' },
    permissionContext: { roomId: 'room-1', roomAgentId: 'agent-1', invocationId: 'invocation-a', traceId: 'trace-a', originalSender: { type: 'user', id: 'user-1', displayName: '用户' }, invocationChain: [] },
  }
  let markStarted!: () => void
  let releaseRpc!: () => void
  const started = new Promise<void>((resolve) => { markStarted = resolve })
  const rpcGate = new Promise<void>((resolve) => { releaseRpc = resolve })
  gatewayRunOverride = async (input) => {
    expect(getTrustedAgentExternalSource(input.sessionId)).toBe('chatroom')
    expect(getTrustedAgentRuntimeContext(input.sessionId)?.permissionContext.invocationId).toBe('invocation-a')
    markStarted()
    await rpcGate
  }
  const controller = new AbortController()
  const runPromise = runAgentHeadless({
    sessionId: 'chatroom-abort-fence', userMessage: '执行', channelId: 'channel-1', agentRuntime: 'pi', workspaceId: 'workspace-1',
  }, {
    source: 'chatroom', trustedRuntimeContext: context,
    onError: () => {}, onComplete: () => {}, onTitleUpdated: () => {},
    signal: controller.signal,
  } as Parameters<typeof runAgentHeadless>[1])
  await started

  let releaseNextSource: (() => void) | undefined
  let releaseNextRuntime: (() => void) | undefined
  let nextContext: ChatRoomAgentRuntimeContext | undefined
  try {
    controller.abort()
    expect(getTrustedAgentExternalSource('chatroom-abort-fence')).toBeUndefined()
    expect(getTrustedAgentRuntimeContext('chatroom-abort-fence')).toBeUndefined()

    nextContext = { ...context, permissionContext: { ...context.permissionContext, invocationId: 'invocation-b', traceId: 'trace-b' } }
    releaseNextSource = registerTrustedAgentExternalSource('chatroom-abort-fence', 'chatroom')
    releaseNextRuntime = registerRuntime('chatroom-abort-fence', nextContext)
    releaseRpc()
    await runPromise
    expect(getTrustedAgentExternalSource('chatroom-abort-fence')).toBe('chatroom')
    expect(getTrustedAgentRuntimeContext('chatroom-abort-fence')?.permissionContext.invocationId).toBe('invocation-b')
  } finally {
    releaseRpc()
    await runPromise
    releaseNextSource?.()
    releaseNextRuntime?.()
    gatewayRunOverride = undefined
  }

  expect(getTrustedAgentExternalSource('chatroom-abort-fence')).toBeUndefined()
  expect(getTrustedAgentRuntimeContext('chatroom-abort-fence')).toBeUndefined()
})

test('Given 同 session A 已取消且 B 已注册 When A 的迟到事件/终态/finally 到达 Then 只保留 B 的通知与 webContents 映射', async () => {
  const { runAgentHeadless } = await import('./agent-service')
  const context = (invocationId: string): ChatRoomAgentRuntimeContext => ({
    executionWorkspace: { root: `/tmp/chatroom/${invocationId}`, projectRoot: `/tmp/chatroom/${invocationId}/project`, inboxRoot: `/tmp/chatroom/${invocationId}/inbox`, sessionRoot: `/tmp/chatroom/${invocationId}/session` },
    permissionContext: { roomId: 'room-1', roomAgentId: 'agent-1', invocationId, traceId: `trace-${invocationId}`, originalSender: { type: 'user', id: 'user-1', displayName: '用户' }, invocationChain: [] },
  })
  const aSent: unknown[] = []
  const bSent: unknown[] = []
  const makeTarget = (sent: unknown[]) => ({ isDestroyed: () => false, once: () => {}, send: (...args: unknown[]) => sent.push(args) })
  const targetA = makeTarget(aSent)
  const targetB = makeTarget(bSent)
  let callbacksA: Record<string, (...args: unknown[]) => void> | undefined
  let callbacksB: Record<string, (...args: unknown[]) => void> | undefined
  let startA!: () => void
  let startB!: () => void
  let releaseA!: () => void
  let releaseB!: () => void
  const aStarted = new Promise<void>((resolve) => { startA = resolve })
  const bStarted = new Promise<void>((resolve) => { startB = resolve })
  const aGate = new Promise<void>((resolve) => { releaseA = resolve })
  const bGate = new Promise<void>((resolve) => { releaseB = resolve })
  gatewayRunOverride = async (input, callbacks) => {
    if (input.userMessage === 'A') { callbacksA = callbacks; callbacks.onRunStarted?.(1); startA(); await aGate }
    else { callbacksB = callbacks; callbacks.onRunStarted?.(2); startB(); await bGate }
  }
  currentHeadlessTarget = targetA
  const controllerA = new AbortController()
  const common = { sessionId: 'same-chatroom-session', channelId: 'channel-1', agentRuntime: 'pi' as const, workspaceId: 'workspace-1' }
  const runA = runAgentHeadless({ ...common, userMessage: 'A' }, {
    source: 'chatroom', trustedRuntimeContext: context('A'), signal: controllerA.signal,
    onError: (error) => aSent.push(error), onComplete: (messages) => aSent.push(messages), onTitleUpdated: (title) => aSent.push(title),
  })
  await aStarted
  aSent.length = 0
  controllerA.abort()

  currentHeadlessTarget = targetB
  const runB = runAgentHeadless({ ...common, userMessage: 'B' }, {
    source: 'chatroom', trustedRuntimeContext: context('B'),
    onError: (error) => bSent.push(error), onComplete: (messages) => bSent.push(messages), onTitleUpdated: (title) => bSent.push(title),
  })
  await bStarted
  const event = { sessionId: common.sessionId, payload: { kind: 'copis_event', event: { type: 'old-a' } } }
  callbacksA!.onEvent!(event)
  callbacksA!.onError!('old-a-error')
  callbacksA!.onComplete!([], { sessionId: common.sessionId })
  callbacksA!.onTitleUpdated!('old-a-title')
  callbacksA!.onRunStarted!(1)
  releaseA()
  await runA

  callbacksB!.onEvent!({ sessionId: common.sessionId, payload: { kind: 'copis_event', event: { type: 'new-b' } } })
  expect(bSent.some((args) => JSON.stringify(args).includes('new-b'))).toBe(true)
  expect(aSent).toEqual([])
  expect(emittedEvents.some((item) => JSON.stringify(item.payload).includes('old-a'))).toBe(false)
  expect(emittedEvents.some((item) => JSON.stringify(item.payload).includes('new-b'))).toBe(true)

  releaseB()
  await runB
  currentHeadlessTarget = null
  gatewayRunOverride = undefined
})

test('Given 普通 headless A 仍有效 When 同 session B 被 Native 拒绝 Then B 不得夺走 A 的回调或 webContents owner', async () => {
  const { runAgentHeadless } = await import('./agent-service')
  const aSent: unknown[] = []
  const bSent: unknown[] = []
  const target = { isDestroyed: () => false, once: () => {}, send: (...args: unknown[]) => aSent.push(args) }
  currentHeadlessTarget = target
  let callbacksA: Record<string, (...args: unknown[]) => void> | undefined
  let startA!: () => void
  let releaseA!: () => void
  const started = new Promise<void>((resolve) => { startA = resolve })
  const gate = new Promise<void>((resolve) => { releaseA = resolve })
  gatewayRunOverride = async (input, callbacks) => {
    if (input.userMessage === 'A') {
      callbacksA = callbacks
      callbacks.onRunStarted?.(1)
      startA()
      await gate
      return
    }
    throw new Error('该 Agent 会话已有运行中的 Pi worker')
  }
  const common = { sessionId: 'ordinary-same-session', channelId: 'channel-1', agentRuntime: 'pi' as const }
  const runA = runAgentHeadless({ ...common, userMessage: 'A' }, {
    source: 'feishu', onError: (error) => aSent.push(error), onComplete: (messages) => aSent.push(messages), onTitleUpdated: (title) => aSent.push(title),
  })
  await started
  try {
    const bError = mock((error: string) => bSent.push(error))
    const runB = runAgentHeadless({ ...common, userMessage: 'B' }, {
      source: 'feishu', onError: bError, onComplete: (messages) => bSent.push(messages), onTitleUpdated: (title) => bSent.push(title),
    })
    await runB

    expect(bError).toHaveBeenCalledWith('该 Agent 会话已有运行中的 Pi worker')
    callbacksA!.onEvent!({ sessionId: common.sessionId, payload: { kind: 'copis_event', event: { type: 'still-a' } } })
    expect(emittedEvents.some((item) => JSON.stringify(item.payload).includes('still-a'))).toBe(true)
    expect(aSent.some((args) => JSON.stringify(args).includes('still-a'))).toBe(true)
  } finally {
    releaseA()
    await runA
    currentHeadlessTarget = null
    gatewayRunOverride = undefined
  }
})

test('Given non-chatroom headless run supplies trusted context When called Then it rejects the forged scope', async () => {
  const { runAgentHeadless } = await import('./agent-service')
  const context: ChatRoomAgentRuntimeContext = {
    executionWorkspace: { root: '/tmp/chatroom', projectRoot: '/tmp/chatroom/project', inboxRoot: '/tmp/chatroom/inbox', sessionRoot: '/tmp/chatroom/session' },
    permissionContext: { roomId: 'room-1', roomAgentId: 'agent-1', invocationId: 'invocation-1', traceId: 'trace-1', originalSender: { type: 'user', id: 'user-1', displayName: '用户' }, invocationChain: [] },
  }
  await expect(runAgentHeadless({ sessionId: 'bad-session', userMessage: '执行', channelId: 'channel-1', agentRuntime: 'pi' }, {
    source: 'feishu', trustedRuntimeContext: context,
    onError: () => {}, onComplete: () => {}, onTitleUpdated: () => {},
})).rejects.toThrow('trustedRuntimeContext')
})

test('Given chatroom trusted source and runtime registration throws When headless run fails Then source registration is cleaned', async () => {
  const { runAgentHeadless } = await import('./agent-service')
  const maliciousContext = new Proxy({} as ChatRoomAgentRuntimeContext, {
    ownKeys: () => { throw new Error('malicious context') },
  })
  await runAgentHeadless({ sessionId: 'chatroom-registration-failure', userMessage: '执行', channelId: 'channel-1', agentRuntime: 'pi' }, {
    source: 'chatroom', trustedRuntimeContext: maliciousContext,
    onError: () => {}, onComplete: () => {}, onTitleUpdated: () => {},
  })
  expect(getTrustedAgentExternalSource('chatroom-registration-failure')).toBeUndefined()
})
