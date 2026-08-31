import { expect, mock, test } from 'bun:test'
import type { AgentSendInput } from '@copis/shared'
import { getTrustedAgentExternalSource } from './agent-rpc-source-context'

let observedSource: string | undefined

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
