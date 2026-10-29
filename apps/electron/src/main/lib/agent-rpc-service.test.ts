import { afterAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import * as nodeOs from 'node:os'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentSessionMeta, AgentWorkspace, Automation, SDKMessage } from '@copis/shared'
import { isAgentRuntime } from './agent-runtime-validation'

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
let appConnectorWorkspaces: AgentWorkspace[] = []
let resolveRuntimeApiKey: () => Promise<string> = async () => 'api-key'
let imageMcpEnabledForRpcTest = false

const customModelChannelId = 'copis-custom-custom-model'
const fixtureRoot = mkdtempSync(join(tmpdir(), 'copis-agent-rpc-test-'))
const fixturePathCalls: string[] = []
let electronGetPathCalls = 0
let packagedRpcFixture = false
const memoryContextRequests: Array<{ workspaceSlug?: string; query: string; maxChars: number }> = []
const preparedGatewayRuns: unknown[] = []
const capturedGatewayInputs: unknown[] = []
mock.module('node:os', () => ({ ...nodeOs, homedir: () => fixtureRoot }))

mock.module('./memory-api-client-runtime', () => ({
  runtimeMemoryApiClient: {
    context: async (input: { workspaceSlug?: string; query: string; maxChars: number }) => {
      memoryContextRequests.push(input)
      return { text: '' }
    },
    list: async () => ({ entries: [], total: 0 }),
    export: async () => ({ entries: [] }),
    recall: async () => ({ entries: [] }),
    read: async () => { throw new Error('RPC fixture must not read persisted memory') },
    capture: async () => { throw new Error('RPC fixture must not persist memory') },
    captureBatch: async () => { throw new Error('RPC fixture must not persist memory') },
    rewrite: async () => { throw new Error('RPC fixture must not rewrite memory') },
    maintenanceState: async () => ({ pendingCount: 0, lastRunAt: undefined }),
    applyMaintenance: async () => ({ applied: 0 }),
  },
}))

function fixturePath(...segments: string[]): string {
  const path = join(fixtureRoot, ...segments)
  fixturePathCalls.push(path)
  return path
}

const actualConfigPaths = await import('./config-paths')
mock.module('./config-paths', () => ({
  ...actualConfigPaths,
  getAgentSessionWorkspacePath: (workspaceSlug: string, sessionId: string) => fixturePath('workspaces', workspaceSlug, 'sessions', sessionId),
  getAgentWorkspacePath: (slug: string) => fixturePath('workspaces', slug),
  getDefaultSkillsDir: () => fixturePath('default-skills'),
  getSdkConfigDir: () => fixturePath('sdk-config'),
  getWorkspaceSkillsDir: (slug: string) => fixturePath('workspaces', slug, '.agents', 'skills'),
}))

mock.module('./builtin-mcp/settings', () => ({
  isBuiltinMcpUserEnabled: (id: string) => id === 'nano-banana' ? imageMcpEnabledForRpcTest : true,
  setBuiltinMcpUserEnabled: (id: string, enabled: boolean) => {
    if (id === 'nano-banana') imageMcpEnabledForRpcTest = enabled
  },
}))

mock.module('./agent-session-manager', () => ({
  appendSDKMessages: (_sessionId: string, messages: SDKMessage[]) => {
    appendedRpcMessages.push(...messages)
    persistedRpcMessages.push(...messages)
  },
  getAgentSessionMeta: (sessionId: string) => {
    if (sessionId === rpcSession.id) return rpcSession
    if (sessionId === 'automation-session-1') return { ...rpcSession, id: 'automation-session-1' }
    if (sessionId === 'codex-session-1') return { ...rpcSession, id: 'codex-session-1', agentRuntime: 'codex' }
    if (sessionId === 'feishu-session-1') return { ...rpcSession, id: 'feishu-session-1', source: 'feishu', feishuDedicated: true }
    if (sessionId === 'wechat-session-1') return { ...rpcSession, id: 'wechat-session-1', source: 'wechat', wechatDedicated: true }
    if (sessionId === 'dingtalk-session-1') return { ...rpcSession, id: 'dingtalk-session-1', source: 'dingtalk', dingtalkDedicated: true }
    if (sessionId === 'bridge-session-1') return { ...rpcSession, id: 'bridge-session-1', source: 'bridge' }
    return undefined
  },
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
  rewindPiAgentSession: async () => {},
  listAgentSessions: () => [],
  truncateSDKMessages: () => [],
  removeSDKErrorMessage: () => true,
  getAgentSessionMessages: () => [],
  appendAgentMessage: () => {},
  deleteAgentSession: () => {},
}))

mock.module('./agent-workspace-manager', () => ({
  ensureAgentWorkspaceBrowserSessionPath: () => '/tmp/copis-agent-rpc-test/project/browser/agent-workspaces/session-1',
  ensureAgentWorkspaceContextDir: () => '/tmp/copis-agent-rpc-test/workspace-1/.context',
  ensureAgentWorkspaceWritableRoot: () => '/tmp/copis-agent-rpc-test/copis',
  getAgentWorkspaceCopisPath: (workspace?: { slug?: string }) => workspace?.slug === 'missing-cross-workspace'
    ? '/tmp/copis-agent-rpc-test/missing-cross-workspace/copis'
    : '/tmp/copis-agent-rpc-test/copis',
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
  getAgentWorkspaceWritableRoot: () => '/tmp/copis-agent-rpc-test/copis',
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
  getAgentWorkspaceContextDir: () => '/tmp/copis-agent-rpc-test/copis/.context',
  getAgentWorkspaceBrowserPath: () => '/tmp/copis-agent-rpc-test/project/browser',
  getAgentWorkspaceReadableRoots: (workspace?: { slug?: string }) => workspace?.slug === 'missing-cross-workspace'
    ? ['/tmp/copis-agent-rpc-test/missing-cross-workspace/project']
    : ['/tmp/copis-agent-rpc-test/project'],
  getProjectFilesPath: (slug?: string) => slug === 'missing-cross-workspace'
    ? '/tmp/copis-agent-rpc-test/missing-cross-workspace/project'
    : '/tmp/copis-agent-rpc-test/project',
  getWorkspaceAttachedDirectories: () => [],
  getWorkspaceAttachedFiles: () => [],
  getWorkspaceMcpConfig: () => ({ servers: {} }),
  getWorkspaceSkillsReadOnly: () => [],
  getLocalProjectRootStatus: () => 'available',
  listAgentWorkspaces: () => [],
  listAgentWorkspacesByUpdatedAt: () => appConnectorWorkspaces,
  getWorkspaceCapabilities: () => ({ mcpServers: [], skills: [] }),
  ensureDefaultWorkspace: () => ({
    id: 'workspace-1',
    name: '测试项目',
    slug: 'test-workspace',
    projectRootPath: '/tmp/copis-agent-rpc-test/project',
    allowWorkspaceWrite: true,
    createdAt: 1,
    updatedAt: 1,
  }),
  getAgentWorkspaceSourceRoot: () => '/tmp/copis-agent-rpc-test/project',
}))

mock.module('./channel-manager', () => ({
  listChannels: () => [],
  getChannelById: () => ({
    id: 'channel-1',
    name: '测试渠道',
    provider: 'openai',
    enabled: true,
    baseUrl: 'https://example.com/v1',
  }),
  decryptApiKey: () => 'api-key',
  persistCodexOAuthCredentials: () => {},
  persistXaiOAuthCredentials: () => {},
  resolveCodexOAuthCredentials: async () => ({ access: 'access', refresh: 'refresh' }),
  resolveChannelRuntimeApiKey: () => resolveRuntimeApiKey(),
  resolveXaiOAuthCredentials: async () => ({ access: 'access', refresh: 'refresh' }),
}))

const fixtureSettings = {
  browserWorkflowEnabled: true,
  defaultMemoryPolicy: 'writable',
  agentMaxTurns: 0,
  agentMaxBudgetUsd: 0,
  windowsShellPreference: 'auto',
  agentEffort: 'high',
  agentThinking: { type: 'adaptive' },
  gitAttributionEnabled: true,
  professionalMode: false,
  builtinMcpDisabledIds: [] as string[],
  builtinMcpEnabledIds: [] as string[],
}
mock.module('./settings-service', () => ({
  getSettings: () => fixtureSettings,
  updateSettings: (updates: Partial<typeof fixtureSettings>) => Object.assign(fixtureSettings, updates),
}))

mock.module('./http-api-server', () => ({ getHttpApiInternalToken: () => null }))
mock.module('./runtime-init', () => ({ getRuntimeStatus: () => null }))

mock.module('./agent-event-bus', () => ({ AgentEventBus: class { use(): void {} emit(): void {} } }))
mock.module('./agent-rpc-gateway', () => ({
  agentRpcGateway: {
    run: async (input: unknown, callbacks: { onRunStarted?: (startedAt: number) => void; onError: (error: string) => void }, options?: { trustedRunId?: string }) => {
      const { prepareAgentRpcRun } = await import('./agent-rpc-service')
      capturedGatewayInputs.push(input)
      preparedGatewayRuns.push(await prepareAgentRpcRun(input as import('@copis/shared').AgentSendInput, options?.trustedRunId))
      callbacks.onRunStarted?.(1)
      callbacks.onError('fixture stopped after actual prepare')
    },
    stop: async () => {},
    isActive: async () => false,
  },
}))
mock.module('./agent-session-rewind-service', () => ({ agentSessionRewindService: {} }))
mock.module('./agent-headless-runner-registry', () => ({ setAgentStopper: () => {}, setHeadlessAgentRunner: () => {} }))
mock.module('./agent-headless-run-target', () => ({ getHeadlessAgentRunTarget: () => null }))
mock.module('./agent-completion-payload', () => ({ sendAgentStreamComplete: () => {} }))
mock.module('./agent-collaboration-tools', () => ({ registerCollaborationEventBus: () => {} }))
mock.module('./agent-permission-service', () => ({ AgentPermissionService: class {}, permissionService: {} }))

mock.module('./adapters/pi-memory-auto-capture', () => ({
  extractMemoryFactsWithProvider: async () => '',
  MemoryAutoCapture: class {
    async onTurnEnd(): Promise<void> {}
  },
}))

mock.module('./adapters/pi-memory-maintenance', () => ({
  createMemoryMaintenanceRunner: () => async () => {},
  sharedMemoryMaintenanceService: {},
}))

mock.module('./codex-app-server-service', () => ({
  DEFAULT_CODEX_PORT: 54080,
  getCodexAppServerStatus: () => ({ running: true, port: 54080 }),
  startCodexAppServer: async () => ({ port: 54080 }),
}))

mock.module('./proxy-settings-service', () => ({
  getEffectiveProxyUrl: async () => undefined,
}))

mock.module('./working-api-service', () => ({
  getWorkingApiClient: () => ({
    baseUrl: 'https://working.example.com',
    getCachedUser: () => ({ id: 'vip-account', isVip: true }),
  }),
}))

mock.module('./working-model-catalog', () => ({
  getWorkingModelCatalogOwnerId: (user: { id?: string } | null | undefined) => user?.id,
  getWorkingModelCatalog: () => ({ models: [] }),
  saveWorkingModelCatalog: () => ({ models: [] }),
  assertWorkingModelCatalogVip: () => {},
  assertWorkingCustomModelSelection: () => {},
  filterWorkingModelCatalogUpdate: () => {},
  redactWorkingModelCatalog: (s: unknown) => s,
  getWorkingCustomModelRuntime: (channelId: string, isVip: boolean) => {
    if (!isVip || channelId !== customModelChannelId) throw new Error('自定义模型测试配置不正确')
    return {
      model: {
        id: 'custom-model',
        name: '自定义 Responses',
        baseUrl: 'https://models.example.com/v1',
        modelId: 'gpt-5.5',
        protocol: 'openai-responses',
        thinkingLevel: 'xhigh',
        apiKeyConfigured: true,
      },
      apiKey: 'custom-api-key',
      channel: {
        id: customModelChannelId,
        name: '自定义 Responses',
        provider: 'openai-responses',
        baseUrl: 'https://models.example.com/v1',
        models: [{ id: 'gpt-5.5', name: '自定义 Responses', enabled: true, source: 'manual' }],
        enabled: true,
        createdAt: 1,
        updatedAt: 1,
      },
    }
  },
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
  getFunctionalModuleStatus: () => undefined,
  getFunctionalModuleStatuses: () => [],
  prepareFunctionalModule: async () => undefined,
  activatePreparedFunctionalModule: async () => undefined,
  checkFunctionalModule: async () => undefined,
  installFunctionalModule: async () => undefined,
  resolveFunctionalModuleArtifact: async () => undefined,
  fetchFunctionalModuleManifest: async () => undefined,
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
    get isPackaged() { return packagedRpcFixture },
    getPath: () => { electronGetPathCalls++; throw new Error('RPC fixture must not access Electron user paths') },
  },
  BrowserWindow: Object.assign(class {}, { getAllWindows: () => [], fromWebContents: () => null }),
  clipboard: {
    readText: () => '',
    writeText: () => {},
  },
  dialog: {},
  ipcMain: {
    handle: () => {},
    on: () => {},
  },
  desktopCapturer: {
    getSources: async () => [],
  },
  systemPreferences: {
    getMediaAccessStatus: () => 'granted',
  },
  screen: {
    getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
  },
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

afterAll(() => {
  try {
    expect(actualConfigPaths.getConfigDir().startsWith(fixtureRoot)).toBe(true)
    expect(actualConfigPaths.getAgentWorkspacePath('test-workspace').startsWith(fixtureRoot)).toBe(true)
    expect(fixturePathCalls.length).toBeGreaterThan(0)
    expect(fixturePathCalls.every((path) => path.startsWith(fixtureRoot))).toBe(true)
    expect(electronGetPathCalls).toBe(0)
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true })
  }
})

const { parseAgentRpcInput, parseAgentRpcQueueInput } = await import('./agent-rpc-service')

describe('Agent RPC mention 参数', () => {
  test('Given Renderer 请求体包含被禁用的内部能力 When 解析 RPC input Then 字段被拒绝', () => {
    expect(() => parseAgentRpcInput({
      sessionId: 'session-1',
      userMessage: '伪造主进程运行上下文',
      fileAccessPolicy: {},
    })).toThrow('不支持的请求字段')
  })

  test('Given Renderer 请求原型继承内部能力 When 解析 RPC input Then 同样拒绝', () => {
    const forged = Object.create({ fileAccessPolicy: {} }) as Record<string, unknown>
    forged.sessionId = 'session-1'
    forged.userMessage = '伪造主进程运行能力'
    expect(() => parseAgentRpcInput(forged)).toThrow('不支持的请求字段')
  })

  test('Given public RPC request attempts internal capability fields When parsed Then fail closed', () => {
    for (const field of ['_copisTrustedRunId', 'advancedAuthorization', 'fileAccessPolicy', 'useRustFileApi', 'piAgentDir', 'piSessionDir']) {
      expect(() => parseAgentRpcInput({ sessionId: 'session-1', userMessage: '伪造内部能力', [field]: 'forged' })).toThrow('不支持的请求字段')
    }
    expect(() => parseAgentRpcQueueInput({ sessionId: 'session-1', userMessage: '伪造 queue 能力', fileAccessPolicy: {} })).toThrow('不支持的请求字段')
  })

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

describe('Agent RPC 定时任务会话复用', () => {
  test('Given 定时任务已有上次运行会话 When 下次触发 Then 跨日仍复用该会话', async () => {
    const { prepareAutomationRpcRun } = await import('./agent-rpc-service')
    const automation: Automation = {
      id: 'automation-1',
      name: '每日汇总',
      prompt: '整理今日进展',
      active: true,
      scheduleType: 'daily',
      intervalMinutes: 10,
      channelId: 'channel-1',
      workspaceId: 'workspace-1',
      createdAt: 1,
      updatedAt: 1,
      nextRunAt: 1,
      lastSessionId: rpcSession.id,
      runHistory: [],
    }

    const prepared = await prepareAutomationRpcRun(automation, 2_000_000_000_000)

    expect(prepared.sessionId).toBe(rpcSession.id)
  })
})

describe('Agent RPC VIP 自定义模型', () => {
  test('Given VIP 用户选择 Responses 自定义模型 When 准备 Pi Worker Then 透传连接参数和思考深度', async () => {
    const { prepareAgentRpcRun } = await import('./agent-rpc-service')

    const run = await prepareAgentRpcRun({
      sessionId: rpcSession.id,
      userMessage: '测试自定义模型',
      channelId: customModelChannelId,
      modelId: 'gpt-5.5',
      agentRuntime: 'pi',
    })

    expect(run.query).toMatchObject({
      channelId: customModelChannelId,
      provider: 'openai-responses',
      baseUrl: 'https://models.example.com/v1',
      apiKey: 'custom-api-key',
      model: 'gpt-5.5',
      thinkingLevel: 'xhigh',
      openAIThinkingLevel: 'xhigh',
    })
  })

  test('Given 旧会话携带过期 Model ID When 准备自定义模型运行 Then 使用目录中的最新 Model ID', async () => {
    const { prepareAgentRpcRun } = await import('./agent-rpc-service')

    const run = await prepareAgentRpcRun({
      sessionId: rpcSession.id,
      userMessage: '使用最新模型 ID',
      channelId: customModelChannelId,
      modelId: 'stale-model-id',
      agentRuntime: 'pi',
    })

    expect(run.query.model).toBe('gpt-5.5')
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

    const prepared = await prepareAgentRpcRun({
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
  test('Given 没有飞书元数据的旧会话由飞书桥接触发 When 准备 Rust 文件策略 Then 授权所有有效工作区读取并在释放后恢复普通边界', async () => {
    const { prepareAgentRpcRun, registerTrustedAgentExternalSource } = await import('./agent-rpc-service')
    const crossWorkspaceRoot = '/tmp'
    appConnectorWorkspaces = [{
      id: 'workspace-cross',
      name: 'Downloads Grok',
      slug: 'test-workspace',
      projectRootPath: crossWorkspaceRoot,
      allowWorkspaceWrite: true,
      createdAt: 1,
      updatedAt: 1,
    }]
    const releaseSource = registerTrustedAgentExternalSource(rpcSession.id, 'feishu')

    try {
      const result = await prepareAgentRpcRun({
        sessionId: rpcSession.id,
        userMessage: '读取跨工作区项目',
        channelId: 'channel-1',
        modelId: rpcSession.modelId,
        agentRuntime: 'pi',
      })

      expect(result.query.fileAccessPolicy?.readRoots).toContain(crossWorkspaceRoot)
      expect(result.query.systemPrompt).toContain('调用本机所有工作区的最高权限')
    } finally {
      releaseSource()
      appConnectorWorkspaces = []
    }

    const ordinaryResult = await prepareAgentRpcRun({
      sessionId: rpcSession.id,
      userMessage: '读取当前工作区',
      channelId: 'channel-1',
      modelId: rpcSession.modelId,
      agentRuntime: 'pi',
    })
    expect(ordinaryResult.query.fileAccessPolicy?.readRoots).not.toContain(crossWorkspaceRoot)
  })

  test('Given 飞书会话包含已失效的其他工作区 When 准备 Rust 文件策略 Then 忽略不存在的跨工作区路径', async () => {
    const { prepareAgentRpcRun } = await import('./agent-rpc-service')
    const originalFeishuDedicated = rpcSession.feishuDedicated
    const missingWorkspaceRoot = '/tmp/copis-agent-rpc-test/missing-cross-workspace'
    rpcSession.feishuDedicated = true
    appConnectorWorkspaces = [{
      id: 'workspace-2',
      name: '已失效项目',
      slug: 'missing-cross-workspace',
      projectRootPath: `${missingWorkspaceRoot}/source`,
      allowWorkspaceWrite: true,
      createdAt: 1,
      updatedAt: 1,
    }]

    try {
      const result = await prepareAgentRpcRun({
        sessionId: rpcSession.id,
        userMessage: '读取其他项目',
        channelId: 'channel-1',
        modelId: rpcSession.modelId,
        agentRuntime: 'pi',
      })
      const policy = result.query.fileAccessPolicy

      expect(policy).toBeDefined()
      expect(policy?.readRoots).not.toContain(`${missingWorkspaceRoot}/project`)
      expect(policy?.readRoots).not.toContain(`${missingWorkspaceRoot}/copis`)
      expect(policy?.readRoots).not.toContain(`${missingWorkspaceRoot}/source`)
      expect(policy?.writeRoots).not.toContain(`${missingWorkspaceRoot}/project`)
      expect(policy?.writeRoots).not.toContain(`${missingWorkspaceRoot}/copis`)
    } finally {
      rpcSession.feishuDedicated = originalFeishuDedicated
      appConnectorWorkspaces = []
    }
  })

  test('Given 只附加一个文件 When 准备 Rust 文件策略 Then 不授权该文件的父目录', async () => {
    const { prepareAgentRpcRun } = await import('./agent-rpc-service')
    const originalAttachedFiles = rpcSession.attachedFiles
    const attachedFile = process.execPath
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
      expect(policy?.writeRoots).toContain('/tmp/copis-agent-rpc-test/project')
      expect(policy?.writeRoots).toContain('/tmp/copis-agent-rpc-test/copis')
      expect(policy?.readRoots).toContain('/tmp/copis-agent-rpc-test/project/browser/agent-workspaces/session-1')
      expect(policy?.writeRoots).toContain('/tmp/copis-agent-rpc-test/project/browser/agent-workspaces/session-1')
      expect(policy?.writeRoots).not.toContain('/tmp/copis-agent-rpc-test/project/browser')
      expect(policy?.browserSessionRoot).toBe('/tmp/copis-agent-rpc-test/project/browser/agent-workspaces/session-1')
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
    expect(run.query.systemPrompt).toContain('## 专家团队服务')
    expect(run.query.systemPrompt).toContain('# Copis Agent')
    expect(run.query.systemPrompt).toContain('只有用户明确提出使用、启动或组建专家团队时')
    expect(run.query.systemPrompt).not.toContain('# 专家团队主理人')
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
    expect(run.query.additionalSkillPaths?.length).toBeGreaterThanOrEqual(1)
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

  test('Given Pi user main session Composer advanced authorization is enabled When preparing Agent RPC Then command instructions match the enabled state without reopening authorization', async () => {
    const { prepareAgentRpcRun } = await import('./agent-rpc-service')
    const previousAuthorization = rpcSession.advancedAuthorization
    browserContext = undefined
    rpcSession.advancedAuthorization = true

    try {
      const run = await prepareAgentRpcRun({
        sessionId: rpcSession.id,
        userMessage: '执行项目检查',
        channelId: 'channel-1',
        modelId: rpcSession.modelId,
        agentRuntime: 'pi',
        permissionModeOverride: 'plan',
      })

      expect(run.query.advancedAuthorization).toBe(true)
      expect(run.query.fileAccessPolicy?.advancedAuthorization).toBe(true)
      expect(run.query.permissionMode).toBe('plan')
      expect(run.query.systemPrompt).toContain('Composer“高级授权”已开启')
      expect(run.query.systemPrompt).toContain('所有命令类型（包括 Git、SSH、curl、Python 等）均可')
      expect(run.query.systemPrompt).toContain('Shell 命令可按任务需要组合')
      expect(run.query.systemPrompt).toContain('Shell 子进程可能触达系统其他位置')
      expect(run.query.systemPrompt).toContain('计划模式仍只允许调研规划')
      expect(run.query.systemPrompt).not.toContain('Composer“高级授权”未开启')
    } finally {
      if (previousAuthorization === undefined) delete rpcSession.advancedAuthorization
      else rpcSession.advancedAuthorization = previousAuthorization
    }
  })

  test('Given Pi user main session Composer advanced authorization is disabled When preparing Agent RPC Then protected commands remain limited', async () => {
    const { prepareAgentRpcRun } = await import('./agent-rpc-service')
    const previousAuthorization = rpcSession.advancedAuthorization
    browserContext = undefined
    rpcSession.advancedAuthorization = false

    try {
      const run = await prepareAgentRpcRun({
        sessionId: rpcSession.id,
        userMessage: '检查项目',
        channelId: 'channel-1',
        modelId: rpcSession.modelId,
        agentRuntime: 'pi',
      })

      expect(run.query.advancedAuthorization).toBe(false)
      expect(run.query.fileAccessPolicy?.advancedAuthorization).toBe(false)
      expect(run.query.systemPrompt).toContain('Composer“高级授权”未开启')
      expect(run.query.systemPrompt).toContain('Git、SSH、curl、Python 等受保护命令仍受限制')
      expect(run.query.systemPrompt).toContain('项目命令逐条调用')
    } finally {
      if (previousAuthorization === undefined) delete rpcSession.advancedAuthorization
      else rpcSession.advancedAuthorization = previousAuthorization
    }
  })

  test('Given advanced authorization is enabled on an automation or delegation session When preparing Agent RPC Then the main-session authorization is not inherited', async () => {
    const { prepareAgentRpcRun } = await import('./agent-rpc-service')
    const previousAuthorization = rpcSession.advancedAuthorization
    const previousAutomationId = rpcSession.sourceAutomationId
    const previousDelegationId = rpcSession.sourceDelegationId
    rpcSession.advancedAuthorization = true
    browserContext = undefined

    try {
      for (const source of ['automation', 'delegation'] as const) {
        rpcSession.sourceAutomationId = source === 'automation' ? 'automation-1' : undefined
        rpcSession.sourceDelegationId = source === 'delegation' ? 'delegation-1' : undefined
        const run = await prepareAgentRpcRun({
          sessionId: rpcSession.id,
          userMessage: '执行内部任务',
          channelId: 'channel-1',
          modelId: rpcSession.modelId,
          triggeredBy: source,
        })

        expect(run.query.advancedAuthorization).toBe(false)
        expect(run.query.fileAccessPolicy?.advancedAuthorization).toBe(false)
        expect(run.query.systemPrompt).toContain('Composer“高级授权”未开启')
      }
    } finally {
      if (previousAuthorization === undefined) delete rpcSession.advancedAuthorization
      else rpcSession.advancedAuthorization = previousAuthorization
      rpcSession.sourceAutomationId = previousAutomationId
      rpcSession.sourceDelegationId = previousDelegationId
    }
  }, 30_000)

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

  test('Given ordinary Agent preparation When dynamic memory context is enabled Then it queries the isolated runtime client with the current workspace and prompt', async () => {
    const { prepareAgentRpcRun } = await import('./agent-rpc-service')
    memoryContextRequests.length = 0

    const prepared = await prepareAgentRpcRun({
      sessionId: rpcSession.id,
      userMessage: '为当前任务召回相关记忆',
      channelId: 'channel-1',
      modelId: rpcSession.modelId,
      agentRuntime: 'pi',
    })

    expect(memoryContextRequests).toEqual([{
      workspaceSlug: 'test-workspace',
      query: '为当前任务召回相关记忆',
      maxChars: 6_000,
    }])
  })

  test('Given 普通 Pi 用户会话读取或提到图片技能 When 未开启图片 MCP 且无 MCP mention Then 图片生成工具仍可用', async () => {
    const { prepareAgentRpcRun } = await import('./agent-rpc-service')
    const { isBuiltinMcpUserEnabled, setBuiltinMcpUserEnabled } = await import('./builtin-mcp/settings')
    const imageGenerationWasEnabled = isBuiltinMcpUserEnabled('nano-banana')

    try {
      setBuiltinMcpUserEnabled('nano-banana', false)
      const runWithSkillMention = await prepareAgentRpcRun({
        sessionId: rpcSession.id,
        userMessage: '阅读图片生成技能并生成小猫图片',
        channelId: 'channel-1',
        modelId: rpcSession.modelId,
        agentRuntime: 'pi',
        mentionedSkills: ['copis-image-generation'],
      })
      const runWithoutSkillMention = await prepareAgentRpcRun({
        sessionId: rpcSession.id,
        userMessage: '生成普通图片',
        channelId: 'channel-1',
        modelId: rpcSession.modelId,
        agentRuntime: 'pi',
      })

      expect(runWithSkillMention.query.imageGenerationEnabled).toBe(true)
      expect(runWithoutSkillMention.query.imageGenerationEnabled).toBe(true)
    } finally {
      setBuiltinMcpUserEnabled('nano-banana', imageGenerationWasEnabled)
    }
  }, 30_000)

  test('Given 普通桌面 Pi 会话处于 plan 模式且图片 MCP disabled When 提到图片技能 Then 默认图片工具不启用且权限保持 plan', async () => {
    const { prepareAgentRpcRun } = await import('./agent-rpc-service')
    const { isBuiltinMcpUserEnabled, setBuiltinMcpUserEnabled } = await import('./builtin-mcp/settings')
    const imageGenerationWasEnabled = isBuiltinMcpUserEnabled('nano-banana')

    try {
      setBuiltinMcpUserEnabled('nano-banana', false)
      const run = await prepareAgentRpcRun({
        sessionId: rpcSession.id,
        userMessage: '阅读图片生成技能并生成小猫图片',
        channelId: 'channel-1',
        modelId: rpcSession.modelId,
        agentRuntime: 'pi',
        mentionedSkills: ['copis-image-generation'],
        permissionModeOverride: 'plan',
      })

      expect(run.query.permissionMode).toBe('plan')
      expect(run.query.imageGenerationEnabled).toBe(false)
    } finally {
      setBuiltinMcpUserEnabled('nano-banana', imageGenerationWasEnabled)
    }
  }, 15_000)

  test('Given automation or delegation Pi sessions When no image MCP is enabled Then keep the existing explicit opt-in boundary', async () => {
    const { prepareAgentRpcRun, registerTrustedAgentExternalSource } = await import('./agent-rpc-service')
    const { isBuiltinMcpUserEnabled, setBuiltinMcpUserEnabled } = await import('./builtin-mcp/settings')
    const imageGenerationWasEnabled = isBuiltinMcpUserEnabled('nano-banana')
    const previousAutomationId = rpcSession.sourceAutomationId
    const previousDelegationId = rpcSession.sourceDelegationId

    try {
      setBuiltinMcpUserEnabled('nano-banana', false)
      rpcSession.sourceAutomationId = 'automation-1'
      const automationRun = await prepareAgentRpcRun({
        sessionId: rpcSession.id,
        userMessage: '自动生成任务摘要图片',
        channelId: 'channel-1',
        modelId: rpcSession.modelId,
        triggeredBy: 'automation',
      })
      rpcSession.sourceAutomationId = undefined
      rpcSession.sourceDelegationId = 'delegation-1'
      const delegationRun = await prepareAgentRpcRun({
        sessionId: rpcSession.id,
        userMessage: '执行委派图片任务',
        channelId: 'channel-1',
        modelId: rpcSession.modelId,
        triggeredBy: 'delegation',
      })

      expect(automationRun.query.imageGenerationEnabled).toBe(false)
      expect(delegationRun.query.imageGenerationEnabled).toBe(false)

      rpcSession.sourceDelegationId = undefined
      const releaseBridgeSource = registerTrustedAgentExternalSource(rpcSession.id, 'feishu')
      let bridgeRun: Awaited<ReturnType<typeof prepareAgentRpcRun>>
      try {
        bridgeRun = await prepareAgentRpcRun({
          sessionId: rpcSession.id,
          userMessage: '通过桥接生成图片',
          channelId: 'channel-1',
          modelId: rpcSession.modelId,
          triggeredBy: 'user',
        })
      } finally {
        releaseBridgeSource()
      }
      expect(bridgeRun.query.imageGenerationEnabled).toBe(false)

      const explicitMcpMentionRun = await prepareAgentRpcRun({
        sessionId: rpcSession.id,
        userMessage: '继续生成图片',
        channelId: 'channel-1',
        modelId: rpcSession.modelId,
        triggeredBy: 'delegation',
        mentionedMcpServers: ['copis_image'],
      })
      expect(explicitMcpMentionRun.query.imageGenerationEnabled).toBe(true)

      setBuiltinMcpUserEnabled('nano-banana', true)
      const explicitSettingRun = await prepareAgentRpcRun({
        sessionId: rpcSession.id,
        userMessage: '自动生成图片',
        channelId: 'channel-1',
        modelId: rpcSession.modelId,
        triggeredBy: 'automation',
      })
      expect(explicitSettingRun.query.imageGenerationEnabled).toBe(true)
    } finally {
      setBuiltinMcpUserEnabled('nano-banana', imageGenerationWasEnabled)
      rpcSession.sourceAutomationId = previousAutomationId
      rpcSession.sourceDelegationId = previousDelegationId
    }
  }, 30_000)

  test('Given professional Codex 主会话且图片 MCP disabled When 未提及 MCP Then 图片工具默认可用', async () => {
    const { COPIS_WORKING_CHANNEL_ID } = await import('@copis/shared')
    const { prepareAgentRpcRun } = await import('./agent-rpc-service')
    const { isBuiltinMcpUserEnabled, setBuiltinMcpUserEnabled } = await import('./builtin-mcp/settings')
    const imageGenerationWasEnabled = isBuiltinMcpUserEnabled('nano-banana')

    try {
      setBuiltinMcpUserEnabled('nano-banana', false)
      const run = await prepareAgentRpcRun({
        sessionId: 'codex-session-1',
        userMessage: '生成一张图片',
        channelId: COPIS_WORKING_CHANNEL_ID,
        agentRuntime: 'codex',
      })

      expect(run.query.agentRuntime).toBe('codex')
      expect(run.query.imageGenerationEnabled).toBe(true)
    } finally {
      setBuiltinMcpUserEnabled('nano-banana', imageGenerationWasEnabled)
    }
  })

  test('Given professional Codex 主会话处于 plan 模式 When 图片 MCP 已启用且提及 MCP Then 不提供图片工具', async () => {
    const { COPIS_WORKING_CHANNEL_ID } = await import('@copis/shared')
    const { prepareAgentRpcRun } = await import('./agent-rpc-service')
    const { isBuiltinMcpUserEnabled, setBuiltinMcpUserEnabled } = await import('./builtin-mcp/settings')
    const imageGenerationWasEnabled = isBuiltinMcpUserEnabled('nano-banana')

    try {
      setBuiltinMcpUserEnabled('nano-banana', true)
      const run = await prepareAgentRpcRun({
        sessionId: 'codex-session-1',
        userMessage: '生成一张图片',
        channelId: COPIS_WORKING_CHANNEL_ID,
        agentRuntime: 'codex',
        permissionModeOverride: 'plan',
        mentionedMcpServers: ['copis_image'],
      })

      expect(run.query.permissionMode).toBe('plan')
      expect(run.query.imageGenerationEnabled).toBe(false)
    } finally {
      setBuiltinMcpUserEnabled('nano-banana', imageGenerationWasEnabled)
    }
  }, 15_000)

  test('Given professional Codex 自动化或委派会话 When 图片 MCP disabled 且无 MCP mention Then 不因普通主会话默认分支启用图片工具', async () => {
    const { COPIS_WORKING_CHANNEL_ID } = await import('@copis/shared')
    const { prepareAgentRpcRun } = await import('./agent-rpc-service')
    const { isBuiltinMcpUserEnabled, setBuiltinMcpUserEnabled } = await import('./builtin-mcp/settings')
    const imageGenerationWasEnabled = isBuiltinMcpUserEnabled('nano-banana')
    const previousRuntime = rpcSession.agentRuntime
    const previousAutomationId = rpcSession.sourceAutomationId
    const previousDelegationId = rpcSession.sourceDelegationId

    try {
      setBuiltinMcpUserEnabled('nano-banana', false)
      rpcSession.agentRuntime = 'codex'
      for (const source of ['automation', 'delegation'] as const) {
        rpcSession.sourceAutomationId = source === 'automation' ? 'automation-1' : undefined
        rpcSession.sourceDelegationId = source === 'delegation' ? 'delegation-1' : undefined
        const run = await prepareAgentRpcRun({
          sessionId: rpcSession.id,
          userMessage: '执行隔离任务',
          channelId: COPIS_WORKING_CHANNEL_ID,
          modelId: rpcSession.modelId,
          agentRuntime: 'codex',
          triggeredBy: source,
        })

        expect(run.query.agentRuntime).toBe('codex')
        expect(run.query.imageGenerationEnabled).toBe(false)
      }
    } finally {
      setBuiltinMcpUserEnabled('nano-banana', imageGenerationWasEnabled)
      rpcSession.agentRuntime = previousRuntime
      rpcSession.sourceAutomationId = previousAutomationId
      rpcSession.sourceDelegationId = previousDelegationId
    }
  }, 15_000)

  test('Given isAgentRuntime 验证器 When 传入 codex/pi/dsh 及非法字符 Then 正确识别', () => {
    expect(isAgentRuntime('codex')).toBe(true)
    expect(isAgentRuntime('pi')).toBe(true)
    expect(isAgentRuntime('dsh')).toBe(true)
    expect(isAgentRuntime('invalid')).toBe(false)
    expect(isAgentRuntime('')).toBe(false)
    expect(isAgentRuntime(null)).toBe(false)
  })

  test('Given 普通模式会话 (agentRuntime: pi) When 试图以专业模式 (codex) 执行 Then 强拦截并报错', async () => {
    const { prepareAgentRpcRun } = await import('./agent-rpc-service')
    await expect(
      prepareAgentRpcRun({
        sessionId: rpcSession.id,
        userMessage: '测试防混用',
        channelId: 'channel-1',
        modelId: rpcSession.modelId,
        agentRuntime: 'codex', // 与会话 pi 不一致
      }),
    ).rejects.toThrow('专业模式与普通模式会话不能混用。当前会话与所选模式不一致。')
  })

  test('Given 专业模式会话 (agentRuntime: codex) When 试图以普通模式 (pi) 执行 Then 强拦截并报错', async () => {
    const { prepareAgentRpcRun } = await import('./agent-rpc-service')
    await expect(
      prepareAgentRpcRun({
        sessionId: 'codex-session-1',
        userMessage: '测试防混用',
        channelId: 'channel-1',
        modelId: rpcSession.modelId,
        agentRuntime: 'pi', // 与会话 codex 不一致
      }),
    ).rejects.toThrow('专业模式与普通模式会话不能混用。当前会话与所选模式不一致。')
  })

  test('Given Codex professional user session has advanced authorization enabled When preparing in plan mode Then prompt uses Codex runtime and preserves the read-only boundary', async () => {
    const { prepareAgentRpcRun } = await import('./agent-rpc-service')
    const previousAuthorization = rpcSession.advancedAuthorization
    rpcSession.advancedAuthorization = true

    try {
      const run = await prepareAgentRpcRun({
        sessionId: 'codex-session-1',
        userMessage: '规划项目检查',
        channelId: 'copis-working',
        modelId: 'fast',
        agentRuntime: 'codex',
        permissionModeOverride: 'plan',
      })

      expect(run.query.advancedAuthorization).toBe(true)
      expect(run.query.permissionMode).toBe('plan')
      expect(run.query.systemPrompt).toContain('Codex App Server 专业模式')
      expect(run.query.systemPrompt).toContain('## Codex App Server Runtime（专业模式）')
      expect(run.query.systemPrompt).toContain('Composer“高级授权”已开启')
      expect(run.query.systemPrompt).toContain('即使 Composer“高级授权”已开启')
      expect(run.query.systemPrompt).not.toContain('## Pi Agent Runtime')
      expect(run.query.systemPrompt).not.toContain('当前会话的基础工具使用小写')
      expect(run.query.systemPrompt).not.toContain('Git/SSH/curl/Python 命令必须在 Composer 开启')
      expect(run.query.systemPrompt).not.toContain('memory_recall')
      expect(run.query.systemPrompt).not.toContain('memory_rewrite')
    } finally {
      if (previousAuthorization === undefined) delete rpcSession.advancedAuthorization
      else rpcSession.advancedAuthorization = previousAuthorization
    }
  })

  test('Given Codex professional user session has advanced authorization disabled When preparing Then prompt does not claim command authorization', async () => {
    const { prepareAgentRpcRun } = await import('./agent-rpc-service')
    const previousAuthorization = rpcSession.advancedAuthorization
    rpcSession.advancedAuthorization = false

    try {
      const run = await prepareAgentRpcRun({
        sessionId: 'codex-session-1',
        userMessage: '检查项目',
        channelId: 'copis-working',
        modelId: 'fast',
        agentRuntime: 'codex',
        permissionModeOverride: 'bypassPermissions',
      })

      expect(run.query.advancedAuthorization).toBe(false)
      expect(run.query.systemPrompt).toContain('Composer“高级授权”未开启')
      expect(run.query.systemPrompt).toContain('关闭时，不要把命令视为已获高级授权')
      expect(run.query.systemPrompt).not.toContain('## Pi Agent Runtime')
      expect(run.query.systemPrompt).not.toContain('Git/SSH/curl/Python 命令必须在 Composer 开启')
    } finally {
      if (previousAuthorization === undefined) delete rpcSession.advancedAuthorization
      else rpcSession.advancedAuthorization = previousAuthorization
    }
  })

  test('Given 专业模式会话 When 引用第三方 Provider 渠道 Then 拦截并提示仅支持默认及自定义模型', async () => {
    const { prepareAgentRpcRun } = await import('./agent-rpc-service')
    await expect(
      prepareAgentRpcRun({
        sessionId: 'codex-session-1',
        userMessage: '测试专业模式渠道过滤',
        channelId: 'channel-1', // channel-1 是第三方 provider
        modelId: rpcSession.modelId,
        agentRuntime: 'codex',
      }),
    ).rejects.toThrow('专业模式仅支持 Copis 默认模型与自定义模型，不支持当前渠道 Provider')

    await expect(
      prepareAgentRpcRun({
        sessionId: 'codex-session-1',
        userMessage: '测试 DeepSeek 虚拟渠道拦截',
        channelId: 'copis-working-deepseek',
        modelId: 'deepseek-v4-flash',
        agentRuntime: 'codex',
      }),
    ).rejects.toThrow('专业模式仅支持 Copis 默认模型与自定义模型，不支持当前渠道 Provider')
  })

  test('Given 专业模式会话 When 选用 Copis 通识 (global) 模型 Then 强拦截并报错', async () => {
    const { prepareAgentRpcRun } = await import('./agent-rpc-service')
    await expect(
      prepareAgentRpcRun({
        sessionId: 'codex-session-1',
        userMessage: '测试 global 模型拦截',
        channelId: 'copis-working',
        modelId: 'global',
        agentRuntime: 'codex',
      }),
    ).rejects.toThrow('专业模式不支持通识 (global) 模型，请选择快速或专家模型')
  })

  test('Given Assistant 中间流式帧 (stop_reason 为 null 且无 error) When 检查持久化 Then 返回 false', async () => {
    const { shouldPersistAgentRpcMessage } = await import('./agent-rpc-service')
    const streamingAssistant: SDKMessage = {
      type: 'assistant',
      uuid: 'uuid-streaming',
      session_id: 'session-1',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: '片段文本' }],
        stop_reason: null,
      },
    } as unknown as SDKMessage

    expect(shouldPersistAgentRpcMessage(streamingAssistant)).toBe(false)
  })

  test('Given Assistant 终态帧 (stop_reason 为 stop) When 检查持久化 Then 返回 true', async () => {
    const { shouldPersistAgentRpcMessage } = await import('./agent-rpc-service')
    const finalAssistant: SDKMessage = {
      type: 'assistant',
      uuid: 'uuid-final',
      session_id: 'session-1',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: '完整文本' }],
        stop_reason: 'stop',
      },
    } as unknown as SDKMessage

    expect(shouldPersistAgentRpcMessage(finalAssistant)).toBe(true)
  })

  for (const packaged of [false, true]) {
    test.skipIf(process.platform !== 'darwin')(`Given isPackaged=${packaged} 的普通本机 Pi 会话 When 图片模型已确认支持 Then Worker 配置包含 Chrome capability 和工具提示`, async () => {
      const { prepareAgentRpcRun } = await import('./agent-rpc-service')
      const previousResourcesPath = Object.getOwnPropertyDescriptor(process, 'resourcesPath')
      Object.defineProperty(process, 'resourcesPath', { configurable: true, value: fixturePath('packaged-resources') })
      packagedRpcFixture = packaged
      try {
        const run = await prepareAgentRpcRun({
          sessionId: rpcSession.id, userMessage: '查看本机 Chrome 页面',
          channelId: 'channel-1', modelId: 'deepseek-v4-flash', agentRuntime: 'pi',
        })
        expect(run.query.chromeDesktopControl).toEqual({
          endpoint: '/api/internal/agent/chrome-desktop-tool', token: expect.any(String),
        })
        expect(run.query.systemPrompt).toContain('ChromeDesktopStart')

        for (const modelId of ['fast', 'export']) {
          const builtin = await prepareAgentRpcRun({
            sessionId: rpcSession.id, userMessage: '查看本机 Chrome 页面',
            channelId: 'copis-working', modelId, agentRuntime: 'pi',
          })
          expect(builtin.query.chromeDesktopControl).toEqual({
            endpoint: '/api/internal/agent/chrome-desktop-tool', token: expect.any(String),
          })
          expect(builtin.query.systemPrompt).toContain('ChromeDesktopStart')
        }

        const unknown = await prepareAgentRpcRun({
          sessionId: rpcSession.id, userMessage: '查看本机 Chrome 页面',
          channelId: 'channel-1', modelId: 'unknown-packaged-fixture-model', agentRuntime: 'pi',
        })
        expect(unknown.query.chromeDesktopControl).toBeUndefined()
      } finally {
        packagedRpcFixture = false
        if (previousResourcesPath) Object.defineProperty(process, 'resourcesPath', previousResourcesPath)
        else Reflect.deleteProperty(process, 'resourcesPath')
      }
    })
  }

  test('Given Feishu / WeChat / DingTalk / Bridge 远程会话 When prepareAgentRpcRun Then 绝不签发 chromeDesktopControl 且系统提示词不包含 Chrome 章节', async () => {
    const { prepareAgentRpcRun } = await import('./agent-rpc-service')

    for (const sessionId of ['feishu-session-1', 'wechat-session-1', 'dingtalk-session-1', 'bridge-session-1']) {
      const run = await prepareAgentRpcRun({
        sessionId,
        userMessage: '帮我打开网页',
        channelId: 'channel-1',
        modelId: rpcSession.modelId,
        agentRuntime: 'pi',
      })
      expect(run.query.chromeDesktopControl).toBeUndefined()
      expect(run.query.systemPrompt).not.toContain('macOS 本机 Chrome 桌面视觉自动化')
    }
  })

  test('Given 支付流程消息或引用支付 Skill When prepareAgentRpcRun Then 绝不签发 chromeDesktopControl 且系统提示词不包含 Chrome 章节', async () => {
    const { prepareAgentRpcRun } = await import('./agent-rpc-service')

    // 1. 包含 <copis_diamond_purchase>
    const run1 = await prepareAgentRpcRun({
      sessionId: rpcSession.id,
      userMessage: '我已确认套餐 <copis_diamond_purchase>套餐 ID: diamond-1</copis_diamond_purchase>',
      channelId: 'channel-1',
      modelId: rpcSession.modelId,
      agentRuntime: 'pi',
    })
    expect(run1.query.chromeDesktopControl).toBeUndefined()
    expect(run1.query.systemPrompt).not.toContain('macOS 本机 Chrome 桌面视觉自动化')

    // 2. 包含 <copis_vip_upgrade>
    const run2 = await prepareAgentRpcRun({
      sessionId: rpcSession.id,
      userMessage: '升级 VIP <copis_vip_upgrade></copis_vip_upgrade>',
      channelId: 'channel-1',
      modelId: rpcSession.modelId,
      agentRuntime: 'pi',
    })
    expect(run2.query.chromeDesktopControl).toBeUndefined()
    expect(run2.query.systemPrompt).not.toContain('macOS 本机 Chrome 桌面视觉自动化')

    // 3. mentionedSkills 包含 alipay-payment-skill
    const run3 = await prepareAgentRpcRun({
      sessionId: rpcSession.id,
      userMessage: '开始充值',
      channelId: 'channel-1',
      modelId: rpcSession.modelId,
      agentRuntime: 'pi',
      mentionedSkills: ['alipay-payment-skill'],
    })
    expect(run3.query.chromeDesktopControl).toBeUndefined()
    expect(run3.query.systemPrompt).not.toContain('macOS 本机 Chrome 桌面视觉自动化')
  })

  test('Given 当前 pending run 持有 Chrome control When Agent turn finalize Then 保留 Chrome 控制供下一轮复用', async () => {
    const { finalizeAgentRpcRun, prepareAgentRpcRun, getPendingAgentRpcRun } = await import('./agent-rpc-service')
    const { chromeDesktopService } = await import('./chrome-desktop-service')

    // 模拟运行准备
    const run = await prepareAgentRpcRun({
      sessionId: rpcSession.id,
      userMessage: '用户主窗口普通请求',
      channelId: 'channel-1',
      modelId: rpcSession.modelId,
      agentRuntime: 'pi',
    })

    const token = run.query.chromeDesktopControl?.token
    if (process.platform === 'darwin' && token) {
      // 启动并确认一个活跃 control
      const startResp = await chromeDesktopService.handleToolRequest({
        sessionId: rpcSession.id,
        capabilityToken: token,
        toolCallId: 'start-call',
        toolName: 'ChromeDesktopStart',
        toolInput: {},
      })
      const controlId = startResp.kind === 'json' ? (startResp.value.controlId as string) : ''
      await chromeDesktopService.confirmStart({ sessionId: rpcSession.id, controlId, windowId: 101, pid: 2001 })
      expect(chromeDesktopService.getSessionState()?.state).toBe('active')

      // 本轮结束不携带 token：控制仍保留，避免下一轮重新授权。
      finalizeAgentRpcRun({
        sessionId: rpcSession.id,
        stoppedByUser: false,
      })
      expect(chromeDesktopService.getSessionState()?.state).toBe('active')
      expect(getPendingAgentRpcRun(rpcSession.id)?.chromeDesktopCapabilityToken).toBe(token)

      // 即使完成帧携带 token，普通 turn finalize 也不释放 Chrome 控制。
      finalizeAgentRpcRun({
        sessionId: rpcSession.id,
        stoppedByUser: false,
        chromeDesktopCapabilityToken: token,
      })
      expect(chromeDesktopService.getSessionState()?.state).toBe('active')
      expect(getPendingAgentRpcRun(rpcSession.id)).toBeUndefined()
      chromeDesktopService.releaseCurrentControl()
    }
  })
})
