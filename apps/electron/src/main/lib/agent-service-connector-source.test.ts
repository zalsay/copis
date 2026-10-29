import { expect, mock, test } from 'bun:test'
import type { AgentSendInput } from '@copis/shared'
import { getTrustedAgentExternalSource, hasTrustedAgentRpcRun } from './agent-rpc-source-context'

let observedSource: string | undefined
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
