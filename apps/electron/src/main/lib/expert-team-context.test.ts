import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type {
  ExpertTeamPromptContext,
  ExpertTeamSchema,
  ExpertTeamSchemaRevision,
  ExpertTeamWorkspaceBinding,
} from '@copis/shared'
import type { ExpertTeamContextReader } from './expert-team-context'

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

let tempWorkspacesDir = ''
mock.module('./http-api-server', () => ({
  HTTP_API_HOST: '127.0.0.1',
  HTTP_API_PORT: 34567,
}))
mock.module('./agent-workspace-manager', () => ({
  getAgentWorkspaceAgentsPath: (slug: string) => join(tempWorkspacesDir, slug, 'AGENTS.md'),
}))

let buildPromptContext: typeof import('./expert-team-context').buildPromptContext
let hashSnapshot: typeof import('./expert-team-context').hashSnapshot
let renderExpertTeamAgentsBlock: typeof import('./expert-team-context').renderExpertTeamAgentsBlock
let renderExpertTeamAgentsFile: typeof import('./expert-team-context').renderExpertTeamAgentsFile
let resolveExpertTeamPromptContext: typeof import('./expert-team-context').resolveExpertTeamPromptContext
let validateInternalExpertTeamContext: typeof import('./expert-team-context').validateInternalExpertTeamContext
let EXPERT_TEAM_BLOCK_START: string
let EXPERT_TEAM_BLOCK_END: string
let EXPERT_TEAM_MAX_AGENTS_MD_LENGTH: number

beforeAll(async () => {
  const imported = await import('./expert-team-context')
  buildPromptContext = imported.buildPromptContext
  hashSnapshot = imported.hashSnapshot
  renderExpertTeamAgentsBlock = imported.renderExpertTeamAgentsBlock
  renderExpertTeamAgentsFile = imported.renderExpertTeamAgentsFile
  resolveExpertTeamPromptContext = imported.resolveExpertTeamPromptContext
  validateInternalExpertTeamContext = imported.validateInternalExpertTeamContext
  EXPERT_TEAM_BLOCK_START = imported.EXPERT_TEAM_BLOCK_START
  EXPERT_TEAM_BLOCK_END = imported.EXPERT_TEAM_BLOCK_END
  EXPERT_TEAM_MAX_AGENTS_MD_LENGTH = imported.EXPERT_TEAM_MAX_AGENTS_MD_LENGTH
})

function snapshotNode(overrides: Partial<{ id: string; role: string; prompt: string; dependsOn: string[]; path: string }> = {}) {
  return {
    id: overrides.id ?? 'researcher',
    role: overrides.role ?? 'researcher',
    prompt: 'prompt' in overrides ? overrides.prompt : '搜集并整理研究资料',
    dependsOn: overrides.dependsOn ?? [],
    path: overrides.path ?? 'research.md',
    config: {},
  }
}

function revision(snapshot: Record<string, unknown>, sha256?: string): ExpertTeamSchemaRevision {
  return {
    id: 101,
    revision: 1,
    ...(sha256 ? { sha256 } : {}),
    snapshot: snapshot as unknown as ExpertTeamSchema,
    createdAt: 1,
  }
}

function schema(id: string, rev: ExpertTeamSchemaRevision): ExpertTeamSchema {
  return {
    id,
    name: '深入研究团队',
    description: '资料搜集、总结和成果复核服务',
    nodes: (rev.snapshot?.nodes ?? []) as ExpertTeamSchema['nodes'],
    edges: [],
    currentRevisionId: rev.id,
    revision: rev.revision,
    sha256: rev.sha256,
    revisions: [rev],
  }
}

function context(schemaId: string, revisionNumber: number, sha256: string): ExpertTeamPromptContext {
  return {
    schemaId,
    schemaRevisionId: 100 + revisionNumber,
    revision: revisionNumber,
    sha256,
    schemaName: '深入研究团队',
    schemaDescription: '资料搜集、总结和成果复核服务',
    nodes: [
      { id: 'researcher', role: 'researcher', task: '搜集资料', dependsOn: [], outputPath: 'research.md' },
      { id: 'summary', role: 'writer', task: '总结成文档', dependsOn: ['researcher'], outputPath: 'summary.md' },
      { id: 'reviewer', role: 'reviewer', task: '检验结果', dependsOn: ['summary'], outputPath: 'review.md' },
    ],
    agentsMdPath: '/tmp/.copis/agent-workspaces/sample-project/AGENTS.md',
    agentsMdContent: '',
  }
}

describe('专家团队受管控 AGENTS.md 渲染', () => {
  test('Given 冻结上下文 When 渲染区块 Then 包含固定标记、团队阵容版本与协作顺序', () => {
    const block = renderExpertTeamAgentsBlock(context('research-v1', 1, 'a'.repeat(64)))

    expect(block.startsWith(EXPERT_TEAM_BLOCK_START)).toBe(true)
    expect(block.endsWith(EXPERT_TEAM_BLOCK_END)).toBe(true)
    expect(block).toContain('research-v1')
    expect(block).toContain('版本信息（revision，校验摘要 sha256）: 1')
    expect(block).toContain('a'.repeat(64))
    expect(block).toContain('researcher -> summary -> reviewer')
    expect(block).toContain('researcher')
    expect(block).toContain('reviewer')
  })

  test('Given 已含 Copis 区块的文件 When 再次渲染 Then 只替换区块并保留用户手写内容', () => {
    const first = renderExpertTeamAgentsFile('# 用户自定义规则\n\n规则一：保持中文注释。\n', context('research-v1', 1, 'a'.repeat(64)))
    expect(first).toContain('# 用户自定义规则')
    expect(first).toContain('research-v1')

    const second = renderExpertTeamAgentsFile(first, context('research-v2', 2, 'b'.repeat(64)))
    expect(second).toContain('# 用户自定义规则')
    expect(second).toContain('research-v2')
    expect(second).not.toContain('research-v1')
    expect(second.match(new RegExp(EXPERT_TEAM_BLOCK_START, 'g'))?.length).toBe(1)
    expect(second.match(new RegExp(EXPERT_TEAM_BLOCK_END, 'g'))?.length).toBe(1)
  })

  test('Given 无标记的用户文件 When 渲染 Then 追加受管控区块且不破坏用户内容', () => {
    const result = renderExpertTeamAgentsFile('# 用户自己的规则\n', context('research-v1', 1, 'a'.repeat(64)))
    expect(result.startsWith('# 用户自己的规则\n')).toBe(true)
    expect(result).toContain(EXPERT_TEAM_BLOCK_START)
    expect(result.indexOf(EXPERT_TEAM_BLOCK_START)).toBeGreaterThan(result.indexOf('# 用户自己的规则'))
  })

  test('Given 超长任务文本 When 构建上下文 Then 受管控区块不超过长度上限且保留标记', () => {
    const ctx = context('research-v1', 1, 'a'.repeat(64))
    ctx.nodes = [{ id: 'long', role: 'executor', task: '长任务'.repeat(20_000) }]
    const block = renderExpertTeamAgentsBlock(ctx)

    expect(block.length).toBeLessThanOrEqual(EXPERT_TEAM_MAX_AGENTS_MD_LENGTH)
    expect(block.startsWith(EXPERT_TEAM_BLOCK_START)).toBe(true)
    expect(block.endsWith(EXPERT_TEAM_BLOCK_END)).toBe(true)
  })
})

describe('专家团队快照哈希与上下文构建', () => {
  test('Given 规范化快照 When 计算 sha256 Then 结果确定且随内容变化', () => {
    const snapshot = {
      id: 'research-v1',
      name: '深入研究团队',
      description: '资料搜集、总结和检验 DAG',
      nodes: [snapshotNode()],
      metadata: {},
    }
    const first = hashSnapshot(snapshot)
    const second = hashSnapshot(snapshot)
    const changed = hashSnapshot({ ...snapshot, nodes: [snapshotNode({ prompt: '不同任务' })] })

    expect(first).toMatch(/^[a-f0-9]{64}$/)
    expect(first).toBe(second)
    expect(changed).not.toBe(first)
  })

  test('Given schema 与冻结 revision When 构建上下文 Then 规范化节点并保留 revision/sha256', () => {
    const rev = revision(
      {
        id: 'research-v1',
        name: '深入研究团队',
        description: '资料搜集、总结和检验 DAG',
        nodes: [
          snapshotNode(),
          snapshotNode({ id: 'summary', role: 'writer', prompt: undefined, dependsOn: ['researcher'], path: 'summary.md' }),
        ],
        metadata: {},
      },
      'c'.repeat(64),
    )
    const ctx = buildPromptContext(schema('research-v1', rev), rev, {
      agentsMdPath: '/tmp/.copis/agent-workspaces/sample-project/AGENTS.md',
    })

    expect(ctx.schemaId).toBe('research-v1')
    expect(ctx.schemaRevisionId).toBe(101)
    expect(ctx.revision).toBe(1)
    expect(ctx.sha256).toBe('c'.repeat(64))
    expect(ctx.nodes.map((node) => node.id)).toEqual(['researcher', 'summary'])
    expect(ctx.nodes[0]).toMatchObject({ id: 'researcher', role: 'researcher', dependsOn: [], outputPath: 'research.md' })
    expect(ctx.nodes[0]?.task).toContain('搜集并整理研究资料')
    expect(ctx.nodes[1]?.task).toBe('完成“summary”岗位服务事项')
    expect(ctx.agentsMdPath).toBe('/tmp/.copis/agent-workspaces/sample-project/AGENTS.md')
  })

  test('Given revision 缺少快照 When 构建上下文 Then 拒绝生成陈旧上下文', () => {
    const bad: ExpertTeamSchemaRevision = { id: 101, revision: 1, sha256: 'd'.repeat(64) }
    expect(() => buildPromptContext(schema('research-v1', bad), bad, {
      agentsMdPath: '/tmp/.copis/agent-workspaces/sample-project/AGENTS.md',
    })).toThrow(/快照/)
  })
})

class FakeReader implements ExpertTeamContextReader {
  constructor(
    private readonly data: {
      binding?: ExpertTeamWorkspaceBinding
      schema?: ExpertTeamSchema
      bindingError?: Error
    } = {},
  ) {}

  async getBinding(workspaceSlug: string): Promise<ExpertTeamWorkspaceBinding | undefined> {
    if (this.data.bindingError) throw this.data.bindingError
    return this.data.binding?.workspaceSlug === workspaceSlug ? this.data.binding : undefined
  }

  async getSchema(schemaId: string): Promise<ExpertTeamSchema | undefined> {
    return this.data.schema?.id === schemaId ? this.data.schema : undefined
  }
}

describe('专家团队 binding/schema 解析', () => {
  const tempRoots: string[] = []

  afterEach(() => {
    for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  function workspaceRoot(): string {
    const root = mkdtempSync(join(tmpdir(), 'copis-expert-team-workspace-'))
    tempRoots.push(root)
    tempWorkspacesDir = join(root, 'agent-workspaces')
    return root
  }

  function boundSchema(id: string, revisionNumber: number): { schema: ExpertTeamSchema; rev: ExpertTeamSchemaRevision; sha256: string } {
    const snapshot = {
      id,
      name: '深入研究团队',
      description: '资料搜集、总结和检验 DAG',
      nodes: [
        { id: 'researcher', role: 'researcher', prompt: '搜集资料', dependsOn: [], path: 'research.md', config: {} },
        { id: 'summary', role: 'writer', prompt: '总结', dependsOn: ['researcher'], path: 'summary.md', config: {} },
        { id: 'reviewer', role: 'reviewer', prompt: '检验', dependsOn: ['summary'], path: 'review.md', config: {} },
      ],
      metadata: {},
    }
    const sha256 = hashSnapshot(snapshot)
    const rev: ExpertTeamSchemaRevision = {
      id: 100 + revisionNumber,
      revision: revisionNumber,
      sha256,
      snapshot: snapshot as unknown as ExpertTeamSchema,
      createdAt: 1,
    }
    const schema: ExpertTeamSchema = {
      id,
      name: snapshot.name,
      description: snapshot.description,
      nodes: snapshot.nodes as unknown as ExpertTeamSchema['nodes'],
      edges: [],
      currentRevisionId: rev.id,
      revision: rev.revision,
      sha256: rev.sha256,
      revisions: [rev],
    }
    return { schema, rev, sha256 }
  }

  function binding(slug: string, schemaId: string, rev: ExpertTeamSchemaRevision, sha256: string): ExpertTeamWorkspaceBinding {
    return {
      workspaceSlug: slug,
      schemaId,
      schemaRevisionId: rev.id,
      revision: rev.revision,
      sha256,
      boundAt: 1,
      updatedAt: 1,
    }
  }

  test('Given 有效 binding When 解析上下文 Then 注入冻结 revision 并写入受控 AGENTS.md，不修改项目根目录', async () => {
    const root = workspaceRoot()
    const projectRoot = join(root, 'project')
    const { schema, rev, sha256 } = boundSchema('team-a', 2)
    const workspace = { slug: 'sample-project', projectRootPath: projectRoot, allowWorkspaceWrite: false }
    const reader = new FakeReader({ binding: binding('sample-project', 'team-a', rev, sha256), schema })

    const ctx = await resolveExpertTeamPromptContext({ workspace, reader })

    expect(ctx?.schemaId).toBe('team-a')
    expect(ctx?.revision).toBe(2)
    expect(ctx?.sha256).toBe(sha256)
    expect(ctx?.nodes.map((node) => node.id)).toEqual(['researcher', 'summary', 'reviewer'])
    expect(ctx?.agentsMdPath).toBe(join(tempWorkspacesDir, 'sample-project', 'AGENTS.md'))
    const file = readFileSync(join(tempWorkspacesDir, 'sample-project', 'AGENTS.md'), 'utf8')
    expect(file).toContain('team-a')
    expect(file).toContain('版本信息（revision，校验摘要 sha256）: 2')
    expect(file).toContain('researcher -> summary -> reviewer')
    // 本地项目根目录必须保持不动
    expect(() => readFileSync(join(projectRoot, 'AGENTS.md'), 'utf8')).toThrow()
  })

  test('Given 工作区未绑定 When 解析上下文 Then fail-soft 返回 undefined 且不写文件', async () => {
    const root = workspaceRoot()
    const workspace = { slug: 'sample-project', projectRootPath: join(root, 'project') }
    const reader = new FakeReader({})

    const ctx = await resolveExpertTeamPromptContext({ workspace, reader })

    expect(ctx).toBeUndefined()
    expect(() => readFileSync(join(tempWorkspacesDir, 'sample-project', 'AGENTS.md'), 'utf8')).toThrow()
  })

  test('Given 显式 schemaId 与 binding 不一致 When 解析上下文 Then 返回 undefined', async () => {
    const root = workspaceRoot()
    const { schema, rev, sha256 } = boundSchema('team-a', 1)
    const workspace = { slug: 'sample-project', projectRootPath: join(root, 'project') }
    const reader = new FakeReader({ binding: binding('sample-project', 'team-a', rev, sha256), schema })

    const ctx = await resolveExpertTeamPromptContext({ workspace, reader, schemaId: 'other-team' })

    expect(ctx).toBeUndefined()
  })

  test('Given revision sha256 与 binding 不一致 When 解析上下文 Then 拒绝陈旧 schema 且不写入文件', async () => {
    const root = workspaceRoot()
    const { schema, rev } = boundSchema('team-a', 1)
    const workspace = { slug: 'sample-project', projectRootPath: join(root, 'project') }
    const reader = new FakeReader({ binding: binding('sample-project', 'team-a', rev, 'f'.repeat(64)), schema })

    const ctx = await resolveExpertTeamPromptContext({ workspace, reader })

    expect(ctx).toBeUndefined()
    expect(() => readFileSync(join(tempWorkspacesDir, 'sample-project', 'AGENTS.md'), 'utf8')).toThrow()
  })

  test('Given schema 缺少 binding 指向的 revision When 解析上下文 Then 返回 undefined', async () => {
    const root = workspaceRoot()
    const { rev, sha256 } = boundSchema('team-a', 1)
    const staleSchema: ExpertTeamSchema = { id: 'team-a', name: '团队', nodes: [], edges: [], currentRevisionId: 999, revision: 99, sha256: 'e'.repeat(64), revisions: [] }
    const workspace = { slug: 'sample-project', projectRootPath: join(root, 'project') }
    const reader = new FakeReader({ binding: binding('sample-project', 'team-a', rev, sha256), schema: staleSchema })

    const ctx = await resolveExpertTeamPromptContext({ workspace, reader })

    expect(ctx).toBeUndefined()
  })

  test('Given Rust API 不可用 When 解析上下文 Then fail-soft 返回 undefined 且不阻断主 Agent 对话', async () => {
    const root = workspaceRoot()
    const workspace = { slug: 'sample-project', projectRootPath: join(root, 'project') }
    const reader = new FakeReader({ bindingError: new Error('Rust HTTP API 尚未启动') })

    const ctx = await resolveExpertTeamPromptContext({ workspace, reader })

    expect(ctx).toBeUndefined()
  })

  test('Given 已有受管控区块且用户内容 When 解析新 binding Then 只替换区块保留用户内容', async () => {
    const root = workspaceRoot()
    const workspace = { slug: 'sample-project', projectRootPath: join(root, 'project') }
    mkdirSync(join(tempWorkspacesDir, 'sample-project'), { recursive: true })
    writeFileSync(join(tempWorkspacesDir, 'sample-project', 'AGENTS.md'), '# 用户规则\n', 'utf8')

    const { schema: schemaV1, rev: revV1, sha256: shaV1 } = boundSchema('team-a', 1)
    await resolveExpertTeamPromptContext({
      workspace,
      reader: new FakeReader({ binding: binding('sample-project', 'team-a', revV1, shaV1), schema: schemaV1 }),
    })
    const { schema: schemaV2, rev: revV2, sha256: shaV2 } = boundSchema('team-a', 2)
    await resolveExpertTeamPromptContext({
      workspace,
      reader: new FakeReader({ binding: binding('sample-project', 'team-a', revV2, shaV2), schema: schemaV2 }),
    })

    const file = readFileSync(join(tempWorkspacesDir, 'sample-project', 'AGENTS.md'), 'utf8')
    expect(file).toContain('# 用户规则')
    expect(file).toContain('版本信息（revision，校验摘要 sha256）: 2')
    expect(file).not.toContain('Revision: 1')
  })
})

describe('专家团队内部上下文校验', () => {
  function validContext(): ExpertTeamPromptContext {
    return context('team-a', 2, 'b'.repeat(64))
  }

  test('Given 主进程生成的冻结上下文 When 校验 Then 通过', () => {
    const ctx = validContext()
    ctx.agentsMdContent = renderExpertTeamAgentsBlock(ctx)

    expect(validateInternalExpertTeamContext(ctx)).toBe(ctx)
  })

  test('Given 缺少 revision/hash/节点 When 校验 Then 拒绝', () => {
    expect(validateInternalExpertTeamContext({ schemaId: 'team-a' })).toBeUndefined()
    expect(validateInternalExpertTeamContext({ ...validContext(), sha256: 'not-hex' })).toBeUndefined()
    expect(validateInternalExpertTeamContext({ ...validContext(), nodes: [] })).toBeUndefined()
    expect(validateInternalExpertTeamContext({ ...validContext(), nodes: [{ id: 'x', role: 'r', task: '' }] })).toBeUndefined()
  })

  test('Given 缺少受管控标记或超长内容 When 校验 Then 拒绝', () => {
    const noMarkers = validContext()
    noMarkers.agentsMdContent = '没有标记的普通文本'
    expect(validateInternalExpertTeamContext(noMarkers)).toBeUndefined()

    const oversized = validContext()
    oversized.agentsMdContent = `${EXPERT_TEAM_BLOCK_START}\n${'x'.repeat(20_000)}\n${EXPERT_TEAM_BLOCK_END}`
    expect(validateInternalExpertTeamContext(oversized)).toBeUndefined()
  })
})
