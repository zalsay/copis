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
  createAgentSession: (
    title?: string,
    channelId?: string,
    workspaceId?: string,
    modelId?: string,
  ): AgentSessionMeta => ({
    ...rpcSession,
    id: 'automation-session-1',
    title: title ?? rpcSession.title,
    channelId,
    workspaceId,
    modelId,
  }),
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
  getAgentWorkspaceReadableRoots: () => ['/tmp/copis-agent-rpc-test/project'],
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

const resolvedRpcContexts: unknown[] = []
mock.module('./expert-team-context', () => ({
  resolveExpertTeamPromptContext: async (options: unknown) => {
    resolvedRpcContexts.push(options)
    return {
      schemaId: 'team-a',
      schemaRevisionId: 202,
      revision: 2,
      sha256: 'b'.repeat(64),
      schemaName: '深入研究团队',
      nodes: [
        { id: 'researcher', role: 'researcher', task: '搜集资料', dependsOn: [], outputPath: 'research.md' },
        { id: 'summary', role: 'writer', task: '总结', dependsOn: ['researcher'], outputPath: 'summary.md' },
        { id: 'reviewer', role: 'reviewer', task: '检验', dependsOn: ['summary'], outputPath: 'review.md' },
      ],
      agentsMdPath: '/tmp/.copis/agent-workspaces/test-workspace/AGENTS.md',
      agentsMdContent: '<!-- copis-expert-team:start -->\n## 专家团队协议\n- Schema: team-a\n- Revision: 2\n- 节点 DAG: `researcher -> summary -> reviewer`\n<!-- copis-expert-team:end -->',
    }
  },
  validateInternalExpertTeamContext: (value: unknown) => {
    if (typeof value !== 'object' || value === null) return undefined
    const record = value as Record<string, unknown>
    return typeof record.sha256 === 'string' && /^[a-f0-9]{64}$/i.test(record.sha256)
      && Array.isArray(record.nodes) && record.nodes.length > 0
      ? value
      : undefined
  },
  HttpExpertTeamContextReader: class {},
}))

mock.module('./functional-module-manager', () => ({
  getFunctionalModulePath: () => undefined,
}))

mock.module('./browser-workflow-service', () => ({
  getBrowserAgentContext: () => browserContext,
  isBrowserPageAdvancedAuthorizationEnabled: () => (
    rpcSession.advancedAuthorization === true
    && !rpcSession.sourceAutomationId
    && !rpcSession.sourceDelegationId
  ),
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

describe('Agent RPC 专家团队上下文解析边界', () => {
  const validContext = {
    schemaId: 'team-a',
    schemaRevisionId: 202,
    revision: 2,
    sha256: 'b'.repeat(64),
    schemaName: '深入研究团队',
    nodes: [{ id: 'researcher', role: 'researcher', task: '搜集', dependsOn: [], outputPath: 'research.md' }],
    agentsMdPath: '/tmp/.copis/agent-workspaces/test-workspace/AGENTS.md',
    agentsMdContent: '<!-- copis-expert-team:start -->\n## 协议\n<!-- copis-expert-team:end -->',
  }

  test('Given delegation 输入携带有效冻结上下文 When 解析 Then 保留内部上下文', () => {
    const input = parseAgentRpcInput({
      sessionId: 'session-1',
      userMessage: '执行节点任务',
      triggeredBy: 'delegation',
      expertTeamContext: validContext,
    })

    expect(input.triggeredBy).toBe('delegation')
    expect(input.expertTeamContext?.schemaId).toBe('team-a')
    expect(input.expertTeamContext?.revision).toBe(2)
  })

  test('Given user/automation 输入携带 expertTeamContext When 解析 Then 一律忽略', () => {
    const user = parseAgentRpcInput({
      sessionId: 'session-1',
      userMessage: '开始',
      triggeredBy: 'user',
      expertTeamContext: validContext,
    })
    const automation = parseAgentRpcInput({
      sessionId: 'session-1',
      userMessage: '开始',
      triggeredBy: 'automation',
      expertTeamContext: validContext,
    })

    expect(user.expertTeamContext).toBeUndefined()
    expect(automation.expertTeamContext).toBeUndefined()
  })

  test('Given delegation 输入携带伪造/损坏上下文 When 解析 Then 拒绝并忽略', () => {
    const forged = parseAgentRpcInput({
      sessionId: 'session-1',
      userMessage: '执行节点任务',
      triggeredBy: 'delegation',
      expertTeamContext: { schemaId: 'team-a', sha256: 'not-a-hex', nodes: [] },
    })

    expect(forged.expertTeamContext).toBeUndefined()
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

describe('Agent RPC 专家团队上下文', () => {
  const delegationContext = {
    schemaId: 'team-a',
    schemaRevisionId: 202,
    revision: 2,
    sha256: 'b'.repeat(64),
    schemaName: '深入研究团队',
    nodes: [
      { id: 'researcher', role: 'researcher', task: '搜集资料', dependsOn: [], outputPath: 'research.md' },
      { id: 'summary', role: 'writer', task: '总结', dependsOn: ['researcher'], outputPath: 'summary.md' },
      { id: 'reviewer', role: 'reviewer', task: '检验', dependsOn: ['summary'], outputPath: 'review.md' },
    ],
    agentsMdPath: '/tmp/.copis/agent-workspaces/test-workspace/AGENTS.md',
    agentsMdContent: '<!-- copis-expert-team:start -->\n## 专家团队协议\n- Schema: team-a\n- Revision: 2\n- 节点 DAG: `researcher -> summary -> reviewer`\n<!-- copis-expert-team:end -->',
    nodeId: 'researcher',
  }

  test('Given delegation 子会话携带冻结上下文 When 准备 Pi Worker Then 注入受管控协议与节点 schema', async () => {
    const { prepareAgentRpcRun } = await import('./agent-rpc-service')

    const run = await prepareAgentRpcRun({
      sessionId: rpcSession.id,
      userMessage: '执行专家节点任务',
      channelId: 'channel-1',
      modelId: rpcSession.modelId,
      agentRuntime: 'pi',
      triggeredBy: 'delegation',
      expertTeamContext: delegationContext,
    })

    expect(run.query.systemPrompt).toContain('<copis_expert_team_agents_md>')
    expect(run.query.systemPrompt).toContain('researcher -> summary -> reviewer')
    expect(run.query.systemPrompt).toContain('<copis_expert_team_schema>')
    expect(run.query.systemPrompt).toContain('"id":"researcher"')
    expect(run.query.systemPrompt).toContain('版本 2')
  })

  test('Given user 主会话 When 准备 Pi Worker Then 解析 workspace binding 并注入同一上下文', async () => {
    const { prepareAgentRpcRun } = await import('./agent-rpc-service')
    resolvedRpcContexts.length = 0

    const run = await prepareAgentRpcRun({
      sessionId: rpcSession.id,
      userMessage: '开始研究',
      channelId: 'channel-1',
      modelId: rpcSession.modelId,
      agentRuntime: 'pi',
    })

    expect(resolvedRpcContexts).toHaveLength(1)
    expect(resolvedRpcContexts[0]).toMatchObject({
      workspace: expect.objectContaining({ slug: 'test-workspace' }),
    })
    expect(run.query.systemPrompt).toContain('<copis_expert_team_agents_md>')
    expect(run.query.systemPrompt).toContain('team-a')
  })

  test('Given 专家团队主理人会话 When 准备 Pi Worker Then 注入专属服务语义', async () => {
    const { prepareAgentRpcRun } = await import('./agent-rpc-service')
    rpcSession.expertTeamSession = { runId: 'run-1', schemaId: 'team-a', schemaRevisionId: 202 }

    try {
      const run = await prepareAgentRpcRun({
        sessionId: rpcSession.id,
        userMessage: '研究这个问题',
        channelId: 'channel-1',
        modelId: rpcSession.modelId,
        agentRuntime: 'pi',
      })

      expect(run.query.systemPrompt).toContain('## 专家团队主理人')
      expect(run.query.systemPrompt).toContain('关联服务任务 `run-1`')
      expect(run.query.systemPrompt).toContain('这是专家团队专属服务对话')
    } finally {
      delete rpcSession.expertTeamSession
    }
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
    expect(run.query.additionalSkillPaths).toHaveLength(1)
    expect(run.query.fileAccessPolicy?.readRoots).toContain(run.query.additionalSkillPaths?.[0])
    expect(run.query.systemPrompt).toContain('tab-1')
    expect(run.query.systemPrompt).toContain('token=REDACTED')
    expect(run.query.systemPrompt).not.toContain('token=secret')
    expect(run.query.browserPageControl).toEqual({
      endpoint: '/api/internal/agent/browser-tool',
      token: expect.any(String),
    })

    browserContext = undefined
  })

  test('Given a user Browser session with Composer advanced authorization When preparing Pi Worker Then it permits sensitive page actions in the prompt', async () => {
    const { prepareAgentRpcRun } = await import('./agent-rpc-service')
    browserContext = { tabId: 'tab-1' }
    rpcSession.advancedAuthorization = true

    try {
      const run = await prepareAgentRpcRun({
        sessionId: rpcSession.id,
        userMessage: '填写当前页面',
        channelId: 'channel-1',
        modelId: rpcSession.modelId,
        agentRuntime: 'pi',
      })

      expect(run.query.systemPrompt).toContain('Composer“高级授权”已开启')
      expect(run.query.systemPrompt).toContain('直接执行')
    } finally {
      delete rpcSession.advancedAuthorization
      browserContext = undefined
    }
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

  test('Given ordinary Agent session When preparing Pi Worker Then it receives a capability to open its first browser tab', async () => {
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
    expect(run.query.browserPageControl).toEqual({
      endpoint: '/api/internal/agent/browser-tool',
      token: expect.any(String),
    })
  })
})
