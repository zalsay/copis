import { describe, expect, mock, test } from 'bun:test'
import type { ExpertTeamPromptContext } from '@copis/shared'
import type { ExpertTeamRunSnapshot } from './expert-team-runner'

const workspace = {
  id: 'workspace-1',
  name: '测试项目',
  slug: 'test-workspace',
  projectRootPath: '/tmp/copis-expert-team-tool/project',
  allowWorkspaceWrite: true,
  createdAt: 1,
  updatedAt: 1,
}

const frozenContext: ExpertTeamPromptContext = {
  schemaId: 'bound-team',
  schemaRevisionId: 301,
  revision: 3,
  sha256: 'c'.repeat(64),
  schemaName: '深入研究团队',
  nodes: [{ id: 'researcher', role: 'researcher', task: '搜集资料', dependsOn: [], outputPath: 'research.md' }],
  agentsMdPath: '/tmp/.copis/agent-workspaces/test-workspace/AGENTS.md',
  agentsMdContent: '<!-- copis-expert-team:start -->\n## 专家团队协议\n<!-- copis-expert-team:end -->',
}

const explicitSchema = {
  id: 'explicit-team',
  name: '显式团队',
  description: '显式指定的 schema',
  nodes: [
    { id: 'researcher', role: 'researcher', prompt: '显式搜集', dependsOn: [], path: 'out.md', config: {} },
  ],
  currentRevisionId: 401,
  revision: 4,
  sha256: 'd'.repeat(64),
  createdAt: 1,
  updatedAt: 1,
  revisions: [
    {
      id: 401,
      revision: 4,
      sha256: 'd'.repeat(64),
      createdAt: 1,
      snapshot: {
        id: 'explicit-team',
        name: '显式团队',
        nodes: [{ id: 'researcher', role: 'researcher', prompt: '显式搜集', dependsOn: [], path: 'out.md', config: {} }],
        metadata: {},
      },
    },
  ],
}

let capturedSnapshot: ExpertTeamRunSnapshot | undefined
let capturedRunnerDeps: unknown
const resolveCalls: Array<{ workspace: unknown; schemaId?: string }> = []
const schemaRequests: string[] = []
const runRequests: Array<Record<string, unknown>> = []

mock.module('electron', () => ({
  app: { isPackaged: false, getPath: () => '/tmp' },
  shell: {},
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString('utf8'),
  },
  BrowserWindow: class {},
  WebContentsView: class {},
  clipboard: {},
  dialog: {},
  nativeImage: { createFromPath: () => ({}) },
  nativeTheme: {},
  powerMonitor: {},
  screen: {},
}))

mock.module('./http-api-server', () => ({
  HTTP_API_HOST: '127.0.0.1',
  HTTP_API_PORT: 34568,
}))

mock.module('./agent-workspace-manager', () => ({
  getAgentWorkspace: (id: string) => (id === workspace.id ? workspace : undefined),
  getAgentWorkspaceWritableRoot: () => '/tmp/copis-expert-team-tool/copis',
  getAgentWorkspaceAgentsPath: () => '/tmp/.copis/agent-workspaces/test-workspace/AGENTS.md',
}))

mock.module('./agent-session-manager', () => ({
  updateAgentSessionMeta: () => undefined,
}))

mock.module('./expert-team-rust-client', () => ({
  HttpExpertTeamRustApiClient: class {},
}))

mock.module('./expert-team-runner', () => ({
  ExpertTeamRunner: class {
    constructor(deps: unknown) {
      capturedRunnerDeps = deps
    }

    async run(snapshot: ExpertTeamRunSnapshot) {
      capturedSnapshot = snapshot
      return { runId: snapshot.runId, nodes: [] }
    }
  },
}))

mock.module('./expert-team-context', () => ({
  resolveExpertTeamPromptContext: async (options: { workspace: unknown; schemaId?: string }) => {
    resolveCalls.push(options)
    return frozenContext
  },
  buildPromptContext: (_schema: unknown, revision: { snapshot?: { nodes?: Array<{ id: string; role: string; prompt?: string; dependsOn?: string[]; path?: string }> } }) => ({
    ...frozenContext,
    schemaId: 'explicit-team',
    schemaRevisionId: 401,
    revision: 4,
    sha256: 'd'.repeat(64),
    nodes: (revision?.snapshot?.nodes ?? []).map((node) => ({
      id: node.id,
      role: node.role,
      task: node.prompt ?? `完成 ${node.id} 节点任务`,
      dependsOn: node.dependsOn ?? [],
      ...(node.path ? { outputPath: node.path } : {}),
    })),
  }),
  HttpExpertTeamContextReader: class {},
}))

const { buildExpertTeamTools } = await import('./expert-team-agent-tool')

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function installFetchMock(): void {
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/api/expert-teams/schemas') && (init?.method ?? 'GET') === 'GET') {
      return jsonResponse(200, {
        schemas: [
          { id: 'bound-team', name: '深入研究团队', description: '研究-总结-检验', revision: 3, nodes: [{ id: 'researcher' }, { id: 'summary' }, { id: 'reviewer' }] },
          { id: 'explicit-team', name: '显式团队', revision: 4, nodes: [{ id: 'researcher' }] },
        ],
      })
    }
    if (url.endsWith('/api/expert-teams/schemas/explicit-team')) {
      schemaRequests.push(url)
      return jsonResponse(200, explicitSchema)
    }
    if (url.endsWith('/api/expert-teams/runs') && init?.method === 'POST') {
      runRequests.push(JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>)
      return jsonResponse(201, { run: { id: 'run-tool-1' } })
    }
    return jsonResponse(404, { error: 'not found' })
  }) as unknown as typeof fetch
}

function sdkMock(): typeof import('@earendil-works/pi-coding-agent') {
  return {
    defineTool: <T>(definition: T): T => definition,
  } as unknown as typeof import('@earendil-works/pi-coding-agent')
}

describe('专家团队工具冻结上下文', () => {
  test('Given 主 Agent 未指定 schemaId When 执行 expert_team_run Then 使用 workspace binding 的冻结上下文', async () => {
    installFetchMock()
    resolveCalls.length = 0
    runRequests.length = 0
    const tools = buildExpertTeamTools(sdkMock(), {
      sessionId: 'parent-session',
      channelId: 'channel-1',
      workspaceId: workspace.id,
      workspaceSlug: workspace.slug,
      triggeredBy: 'user',
    })
    const tool = tools[0] as unknown as { execute: (toolCallId: string, params: unknown) => Promise<unknown> }

    const result = await tool.execute('call-bound', { goal: '研究目标' })

    expect(resolveCalls).toHaveLength(1)
    expect(resolveCalls[0]).toMatchObject({ workspace: { slug: workspace.slug } })
    expect('schemaId' in (resolveCalls[0] ?? {})).toBe(false)
    expect(capturedSnapshot?.expertTeamContext?.schemaId).toBe('bound-team')
    expect(capturedSnapshot?.expertTeamContext?.revision).toBe(3)
    expect(capturedSnapshot?.expertTeamContext?.sha256).toBe('c'.repeat(64))
    expect(runRequests[0]).toMatchObject({
      schemaId: 'bound-team',
      workspaceSlug: workspace.slug,
      schemaRevisionId: 301,
    })
    expect(result).toMatchObject({ details: { runId: 'run-tool-1' } })
  })

  test('Given 主 Agent 显式指定 schemaId When 执行 expert_team_run Then 按 Rust API 读取该 schema 的冻结 revision', async () => {
    installFetchMock()
    resolveCalls.length = 0
    schemaRequests.length = 0
    runRequests.length = 0
    const tools = buildExpertTeamTools(sdkMock(), {
      sessionId: 'parent-session',
      channelId: 'channel-1',
      workspaceId: workspace.id,
      workspaceSlug: workspace.slug,
      triggeredBy: 'user',
    })
    const tool = tools[0] as unknown as { execute: (toolCallId: string, params: unknown) => Promise<unknown> }

    const result = await tool.execute('call-explicit', { goal: '研究目标', schemaId: 'explicit-team' })

    expect(schemaRequests).toHaveLength(1)
    expect(resolveCalls).toHaveLength(0)
    expect(capturedSnapshot?.expertTeamContext?.schemaId).toBe('explicit-team')
    expect(capturedSnapshot?.expertTeamContext?.schemaRevisionId).toBe(401)
    expect(capturedSnapshot?.expertTeamContext?.revision).toBe(4)
    expect(capturedSnapshot?.expertTeamContext?.sha256).toBe('d'.repeat(64))
    expect(capturedSnapshot?.nodes[0]?.task).toContain('显式搜集')
    expect(result).toMatchObject({ details: { schemaId: 'explicit-team', schemaRevision: 4 } })
  })

  test('Given 主 Agent 筹备新专家团 When 执行 expert_team_list_schemas Then 返回可用团队阵容', async () => {
    installFetchMock()
    const tools = buildExpertTeamTools(sdkMock(), {
      sessionId: 'parent-session',
      channelId: 'channel-1',
      workspaceId: workspace.id,
      workspaceSlug: workspace.slug,
      triggeredBy: 'user',
    })
    const listTool = tools[1] as unknown as { execute: () => Promise<unknown> }

    expect(tools.length).toBeGreaterThanOrEqual(2)
    const result = await listTool.execute()

    expect(result).toMatchObject({
      details: [
        { id: 'bound-team', name: '深入研究团队', nodeCount: 3 },
        { id: 'explicit-team', name: '显式团队', nodeCount: 1 },
      ],
    })
  })

  test('Given delegation 子会话 When 构建专家团队工具 Then 不暴露 expert_team_run', () => {
    const tools = buildExpertTeamTools(sdkMock(), {
      sessionId: 'child-session',
      channelId: 'channel-1',
      workspaceId: workspace.id,
      workspaceSlug: workspace.slug,
      triggeredBy: 'delegation',
    })

    expect(tools).toEqual([])
  })
})
