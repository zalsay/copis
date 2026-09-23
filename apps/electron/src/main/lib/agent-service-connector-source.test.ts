import { expect, mock, test } from 'bun:test'
import type { AgentSendInput } from '@copis/shared'
import type { ChatRoomAgentRuntimeContext } from '@copis/shared'
import { getTrustedAgentExternalSource } from './agent-rpc-source-context'
import { getTrustedAgentRuntimeContext } from './agent-rpc-runtime-context'

let observedSource: string | undefined
let observedRuntimeContext: unknown

mock.module('./agent-event-bus', () => ({
  AgentEventBus: class {
    use(): void {}
    emit(): void {}
  },
}))

mock.module('./agent-rpc-gateway', () => ({
  agentRpcGateway: {
    run: async (input: AgentSendInput): Promise<void> => {
      observedSource = getTrustedAgentExternalSource(input.sessionId)
      observedRuntimeContext = getTrustedAgentRuntimeContext(input.sessionId)
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
  getHeadlessAgentRunTarget: () => null,
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
  BrowserWindow: class {},
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
