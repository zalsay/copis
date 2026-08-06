import { beforeAll, describe, expect, mock, test } from 'bun:test'
import type { AgentSessionMeta, AgentWorkspace } from '@copis/shared'

const sessionMeta = {
  id: 'browser-session',
  title: '网页 Browser Agent',
  workspaceId: 'workspace-1',
  permissionMode: 'plan',
} as AgentSessionMeta
const workspace = {
  id: 'workspace-1',
  name: 'Browser 工作区',
  slug: 'browser-workspace',
} as AgentWorkspace

const getAgentSessionMeta = mock(() => sessionMeta)
const updateAgentSessionMeta = mock((sessionId: string, updates: Record<string, unknown>) => ({
  ...sessionMeta,
  id: sessionId,
  ...updates,
}))

mock.module('./agent-session-manager', () => ({ getAgentSessionMeta, updateAgentSessionMeta }))
mock.module('./agent-workspace-manager', () => ({ getAgentWorkspace: () => workspace }))
mock.module('./browser-workflow-store', () => ({
  getBrowserWorkflow: () => undefined,
  saveBrowserWorkflow: () => undefined,
}))
mock.module('./rust-browser-recording-client', () => ({
  appendRustBrowserRecordingEvent: () => Promise.resolve(),
  cancelRustBrowserRecording: () => Promise.resolve(),
  finishRustBrowserRecording: () => Promise.resolve(),
  readRustBrowserRecording: () => Promise.resolve(undefined),
  startRustBrowserRecording: () => Promise.resolve(undefined),
}))
mock.module('./web-tab-manager', () => ({
  getWebTabState: () => ({ id: 'tab-1', url: 'https://example.com/account', title: 'Account' }),
  sendWebTabCdpCommandInternal: () => Promise.resolve(undefined),
  subscribeWebTabCdpEvents: () => () => undefined,
  subscribeWebTabCdpDetach: () => () => undefined,
  subscribeWebTabLifecycle: () => () => undefined,
}))

let bindBrowserAgentContext: typeof import('./browser-workflow-service')['bindBrowserAgentContext']
let unbindBrowserAgentContext: typeof import('./browser-workflow-service')['unbindBrowserAgentContext']

beforeAll(async () => {
  const service = await import('./browser-workflow-service')
  bindBrowserAgentContext = service.bindBrowserAgentContext
  unbindBrowserAgentContext = service.unbindBrowserAgentContext
})

describe('Browser Agent Context 绑定', () => {
  test('Given 新会话元数据为 plan When Browser Context 绑定成功 Then 持久化为 bypassPermissions', () => {
    bindBrowserAgentContext('browser-session', { tabId: 'tab-1' })

    expect(updateAgentSessionMeta).toHaveBeenCalledWith('browser-session', {
      permissionMode: 'bypassPermissions',
    })

    unbindBrowserAgentContext('browser-session')
  })
})
