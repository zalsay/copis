import { describe, expect, mock, test } from 'bun:test'
import type { AgentSessionMeta, SDKMessage } from '@copis/shared'

const rpcSession: AgentSessionMeta = {
  id: 'session-1',
  title: '测试会话',
  channelId: 'channel-1',
  modelId: 'model-1',
  workspaceId: 'workspace-1',
  agentRuntime: 'pi',
  createdAt: 1,
  updatedAt: 1,
}
const persistedRpcMessages: SDKMessage[] = []
const appendedRpcMessages: SDKMessage[] = []
let browserContext: { tabId: string } | undefined

mock.module('./agent-session-manager', () => ({
  appendSDKMessages: (_sessionId: string, messages: SDKMessage[]) => {
    appendedRpcMessages.push(...messages)
    persistedRpcMessages.push(...messages)
  },
  getAgentSessionMeta: (sessionId: string) => sessionId === rpcSession.id ? rpcSession : undefined,
  getAgentSessionSDKMessages: () => persistedRpcMessages,
  resolveAgentCwd: () => '/tmp/copis-agent-rpc-test/project',
  updateAgentSessionMeta: () => rpcSession,
}))

mock.module('./agent-workspace-manager', () => ({
  ensureAgentWorkspaceContextDir: () => '/tmp/copis-agent-rpc-test/workspace-1/.context',
  ensureAgentWorkspaceWritableRoot: () => '/tmp/copis-agent-rpc-test/project',
  getAgentWorkspace: (workspaceId: string) => workspaceId === 'workspace-1'
    ? {
      id: 'workspace-1',
      name: '测试项目',
      slug: 'test-workspace',
      projectRootPath: '/tmp/copis-agent-rpc-test/project',
      allowWorkspaceWrite: true,
      createdAt: 1,
      updatedAt: 1,
    }
    : undefined,
  getAgentWorkspaceWritableRoot: () => '/tmp/copis-agent-rpc-test/project',
  getAgentWorkspaceBySlug: (slug: string) => slug === 'test-workspace'
    ? {
      id: 'workspace-1',
      name: '测试项目',
      slug: 'test-workspace',
      projectRootPath: '/tmp/copis-agent-rpc-test/project',
      allowWorkspaceWrite: true,
      createdAt: 1,
      updatedAt: 1,
    }
    : undefined,
  getAgentWorkspaceContextDir: () => '/tmp/copis-agent-rpc-test/project/.context',
  getProjectFilesPath: () => '/tmp/copis-agent-rpc-test/project',
  getWorkspaceAttachedDirectories: () => [],
  getWorkspaceAttachedFiles: () => [],
  getWorkspaceMcpConfig: () => ({ servers: {} }),
  getLocalProjectRootStatus: () => 'available',
  listAgentWorkspaces: () => [],
}))

mock.module('./channel-manager', () => ({
  getChannelById: () => ({
    id: 'channel-1',
    name: '测试渠道',
    provider: 'openai',
    enabled: true,
    baseUrl: 'https://example.com/v1',
  }),
  persistCodexOAuthCredentials: () => {},
  persistXaiOAuthCredentials: () => {},
  resolveCodexOAuthCredentials: async () => ({ access: 'access', refresh: 'refresh' }),
  resolveChannelRuntimeApiKey: async () => 'api-key',
  resolveXaiOAuthCredentials: async () => ({ access: 'access', refresh: 'refresh' }),
}))

mock.module('./proxy-settings-service', () => ({
  getEffectiveProxyUrl: async () => undefined,
}))

mock.module('./functional-module-manager', () => ({
  getFunctionalModulePath: () => undefined,
}))

mock.module('./browser-workflow-service', () => ({
  getBrowserAgentContext: () => browserContext,
  sanitizeBrowserWorkflowUrl: (url: string) => url.replace(/token=[^&]+/, 'token=REDACTED'),
}))

mock.module('./web-tab-manager', () => ({
  getWebTabState: (tabId: string) => browserContext?.tabId === tabId
    ? { id: tabId, title: '测试网页', url: 'https://example.com/account?token=secret' }
    : undefined,
}))

mock.module('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => '/tmp/copis-agent-rpc-test',
  },
  BrowserWindow: class {},
  clipboard: {},
  dialog: {},
  nativeImage: { createFromPath: () => ({}) },
  nativeTheme: {},
  powerMonitor: {},
  powerSaveBlocker: {},
  shell: { openExternal: async () => {} },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString('utf8'),
  },
}))

const { parseAgentRpcInput, parseAgentRpcQueueInput } = await import('./agent-rpc-service')

describe('Agent RPC mention 参数', () => {
  test('Given HTTP 请求包含 Skill mention When解析 Then保留原始 slug 并去重', () => {
    const input = parseAgentRpcInput({
      sessionId: 'session-1',
      userMessage: '生成周报',
      mentionedSkills: [' automation ', 'automation', '', 42],
      mentionedMcpServers: ['planning'],
    })

    expect(input.mentionedSkills).toEqual(['automation'])
    expect(input.mentionedMcpServers).toEqual(['planning'])
  })

  test('Given HTTP queue 请求包含引用 When解析 Then保留去重后的所有 mention', () => {
    const input = parseAgentRpcQueueInput({
      sessionId: 'session-1',
      userMessage: '继续生成周报',
      rawUserMessage: '/自动化办公 继续生成周报',
      uuid: 'message-1',
      interrupt: true,
      mentionedSkills: [' automation ', 'automation'],
      mentionedMcpServers: ['planning'],
      mentionedSessionIds: ['session-2', 'session-2'],
      mentionedTodoIds: ['todo-1'],
      mentionedCalendarEventIds: ['event-1'],
    })

    expect(input).toEqual({
      sessionId: 'session-1',
      userMessage: '继续生成周报',
      rawUserMessage: '/自动化办公 继续生成周报',
      uuid: 'message-1',
      interrupt: true,
      mentionedSkills: ['automation'],
      mentionedMcpServers: ['planning'],
      mentionedSessionIds: ['session-2'],
      mentionedTodoIds: ['todo-1'],
      mentionedCalendarEventIds: ['event-1'],
    })
  })
})

describe('Agent RPC queue UUID 幂等性', () => {
  test('Given 同一个 queue UUID 重复准备 When 写入 RPC 持久化链路 Then JSONL 只追加一次并返回同一个 UUID', async () => {
    const { prepareAgentRpcQueue, prepareAgentRpcRun } = await import('./agent-rpc-service')

    await prepareAgentRpcRun({
      sessionId: rpcSession.id,
      userMessage: '/compact',
      channelId: 'channel-1',
      modelId: rpcSession.modelId,
      agentRuntime: 'pi',
    })

    const input = {
      sessionId: rpcSession.id,
      userMessage: '继续处理',
      rawUserMessage: '继续处理',
      uuid: 'queue-message-1',
    }
    const first = prepareAgentRpcQueue(input)
    const second = prepareAgentRpcQueue(input)

    expect(first.uuid).toBe('queue-message-1')
    expect(second.uuid).toBe('queue-message-1')
    expect(appendedRpcMessages.filter((message) => {
      const record = message as unknown as Record<string, unknown>
      return record.uuid === 'queue-message-1'
    })).toHaveLength(1)
  })
})

describe('Agent RPC 工作区边界', () => {
  test('Given 只附加一个文件 When 准备 Rust 文件策略 Then 不授权该文件的父目录', async () => {
    const { prepareAgentRpcRun } = await import('./agent-rpc-service')
    const originalAttachedFiles = rpcSession.attachedFiles
    const attachedFile = '/tmp/copis-agent-rpc-test/external/allowed.txt'
    rpcSession.attachedFiles = [attachedFile]

    try {
      const result = await prepareAgentRpcRun({
        sessionId: rpcSession.id,
        userMessage: '读取附件',
        channelId: 'channel-1',
        modelId: rpcSession.modelId,
        agentRuntime: 'pi',
        additionalDirectories: ['/tmp/copis-agent-rpc-test/external'],
      })
      const policy = result.query.fileAccessPolicy
      expect(policy).toBeDefined()
      expect(policy?.readFiles).toContain(attachedFile)
      expect(policy?.readRoots).not.toContain('/tmp/copis-agent-rpc-test/external')
    } finally {
      rpcSession.attachedFiles = originalAttachedFiles
    }
  })

  test('Given 会话没有有效工作区 When 准备 Pi Worker Then 拒绝启动并不回退到 Home 目录', async () => {
    const { prepareAgentRpcRun } = await import('./agent-rpc-service')
    const sessionWithoutWorkspace = { ...rpcSession, workspaceId: undefined }
    const originalWorkspaceId = rpcSession.workspaceId
    rpcSession.workspaceId = sessionWithoutWorkspace.workspaceId

    await expect(prepareAgentRpcRun({
      sessionId: rpcSession.id,
      userMessage: '读取文件',
      channelId: 'channel-1',
      modelId: rpcSession.modelId,
      agentRuntime: 'pi',
    })).rejects.toThrow('必须绑定有效工作区')

    rpcSession.workspaceId = originalWorkspaceId
  })
})

describe('Browser Agent RPC 准备', () => {
  test('Given Browser session bound to an HTTP tab When preparing Pi Worker Then it injects capability, Skill, sanitized prompt context and bypass mode', async () => {
    const { prepareAgentRpcRun } = await import('./agent-rpc-service')
    browserContext = { tabId: 'tab-1' }

    const run = await prepareAgentRpcRun({
      sessionId: rpcSession.id,
      userMessage: '这个页面是什么？',
      channelId: 'channel-1',
      modelId: rpcSession.modelId,
      agentRuntime: 'pi',
      permissionModeOverride: 'plan',
    })

    expect(run.query.permissionMode).toBe('bypassPermissions')
    expect(run.query.skillMentions).toContain('browser-page-control')
    expect(run.query.systemPrompt).toContain('tab-1')
    expect(run.query.systemPrompt).toContain('token=REDACTED')
    expect(run.query.systemPrompt).not.toContain('token=secret')
    expect(run.query.browserPageControl).toEqual({
      endpoint: '/api/internal/agent/browser-tool',
      token: expect.any(String),
    })

    browserContext = undefined
  })

  test('Given Browser Agent run When queueing and finalizing Then it retains the Skill and revokes the issued capability', async () => {
    const { assertBrowserAgentWorkerCapability } = await import('./browser-agent-worker-capability')
    const { finalizeAgentRpcRun, prepareAgentRpcQueue, prepareAgentRpcRun } = await import('./agent-rpc-service')
    browserContext = { tabId: 'tab-1' }
    const run = await prepareAgentRpcRun({
      sessionId: rpcSession.id,
      userMessage: '观察页面',
      channelId: 'channel-1',
      modelId: rpcSession.modelId,
      agentRuntime: 'pi',
    })

    expect(prepareAgentRpcQueue({
      sessionId: rpcSession.id,
      userMessage: '继续说明页面内容',
      uuid: 'browser-queue-1',
    }).skillMentions).toContain('browser-page-control')

    finalizeAgentRpcRun({ sessionId: rpcSession.id, stoppedByUser: false })
    expect(() => assertBrowserAgentWorkerCapability({
      sessionId: rpcSession.id,
      tabId: 'tab-1',
      token: run.query.browserPageControl?.token ?? '',
    })).toThrow(expect.objectContaining({ code: 'browser_capability_stale' }))

    browserContext = undefined
  })

  test('Given ordinary Agent session When preparing Pi Worker Then Browser-only fields stay absent', async () => {
    const { prepareAgentRpcRun } = await import('./agent-rpc-service')
    browserContext = undefined

    const run = await prepareAgentRpcRun({
      sessionId: rpcSession.id,
      userMessage: '整理工作区文件',
      channelId: 'channel-1',
      modelId: rpcSession.modelId,
      agentRuntime: 'pi',
      permissionModeOverride: 'plan',
    })

    expect(run.query.permissionMode).toBe('plan')
    expect(run.query.skillMentions ?? []).not.toContain('browser-page-control')
    expect(run.query.browserPageControl).toBeUndefined()
  })
})
