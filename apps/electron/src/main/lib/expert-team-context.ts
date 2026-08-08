/**
 * 专家团队上下文契约与受管控 AGENTS.md 渲染器。
 *
 * 以 Rust API 返回的 workspace binding 与不可变 schema revision 为唯一来源，
 * 主进程在这里规范化冻结上下文、生成/更新工作区受管控 AGENTS.md 区块，
 * 并对跨 IPC/子 Agent 传递的上下文做形状与长度校验。
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type {
  ExpertTeamPromptContext,
  ExpertTeamPromptNode,
  ExpertTeamSchema,
  ExpertTeamSchemaRevision,
  ExpertTeamWorkspaceBinding,
} from '@copis/shared'
import { HTTP_API_HOST, HTTP_API_PORT } from './http-api-server'
import { getAgentWorkspaceAgentsPath } from './agent-workspace-manager'
import type { AgentWorkspace } from '@copis/shared'

export const EXPERT_TEAM_BLOCK_START = '<!-- copis-expert-team:start -->'
export const EXPERT_TEAM_BLOCK_END = '<!-- copis-expert-team:end -->'
export const EXPERT_TEAM_MAX_AGENTS_MD_LENGTH = 12_000
export const EXPERT_TEAM_MAX_SCHEMA_NAME_LENGTH = 200
export const EXPERT_TEAM_MAX_NODE_TASK_LENGTH = 4_000

/** 只读访问 Rust 专家团队 binding/schema 的客户端契约。 */
export interface ExpertTeamContextReader {
  getBinding(workspaceSlug: string): Promise<ExpertTeamWorkspaceBinding | undefined>
  getSchema(schemaId: string): Promise<ExpertTeamSchema | undefined>
}

type FetchImplementation = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export interface ExpertTeamContextReaderOptions {
  baseUrl?: string
  fetchImpl?: FetchImplementation
}

function resolveBaseUrl(baseUrl: string | undefined): string {
  if (baseUrl?.trim()) return baseUrl.replace(/\/$/, '')
  return `http://${HTTP_API_HOST}:${HTTP_API_PORT}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function unwrapObject<T>(payload: unknown, key: string): T | undefined {
  if (isRecord(payload) && key in payload) return payload[key] as T
  return payload as T
}

/**
 * 只读 expert-teams HTTP 客户端：读取 workspace binding 与 schema 详情。
 * 与专家团队工具一致走 loopback 公共路由，不携带内部令牌；请求失败按未绑定处理。
 */
export class HttpExpertTeamContextReader implements ExpertTeamContextReader {
  private readonly baseUrl: string
  private readonly fetchImpl: FetchImplementation

  constructor(options: ExpertTeamContextReaderOptions = {}) {
    this.baseUrl = resolveBaseUrl(options.baseUrl)
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  private async getJson(path: string): Promise<unknown> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      headers: { Accept: 'application/json' },
    })
    const text = await response.text()
    let payload: unknown
    try {
      payload = text ? JSON.parse(text) as unknown : undefined
    } catch {
      payload = text
    }
    if (!response.ok) {
      const message = isRecord(payload) && typeof payload.error === 'string'
        ? payload.error
        : `专家团队读取失败（${response.status}）`
      throw new Error(message)
    }
    return payload
  }

  async getBinding(workspaceSlug: string): Promise<ExpertTeamWorkspaceBinding | undefined> {
    const payload = await this.getJson(`/api/expert-teams/workspaces/${encodeURIComponent(workspaceSlug)}/binding`)
    return unwrapObject<ExpertTeamWorkspaceBinding>(payload, 'binding')
  }

  async getSchema(schemaId: string): Promise<ExpertTeamSchema | undefined> {
    const payload = await this.getJson(`/api/expert-teams/schemas/${encodeURIComponent(schemaId)}`)
    return unwrapObject<ExpertTeamSchema>(payload, 'schema')
  }
}

function clampText(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

/**
 * 计算 schema 快照的规范化 sha256。
 *
 * 键序与 null 语义对齐 Rust `SchemaSnapshot` 的 serde 序列化（camelCase、
 * Option 缺失序列化为 null），因此真实 Rust revision 的 sha256 可以在此核对；
 * 嵌套 config/metadata 的键序沿用 Rust 落盘顺序，JSON.stringify 原样保留。
 */
export function hashSnapshot(snapshot: unknown): string {
  const record = isRecord(snapshot) ? snapshot : {}
  const canonical = {
    id: String(record.id ?? ''),
    name: String(record.name ?? ''),
    description: record.description ?? null,
    nodes: Array.isArray(record.nodes)
      ? record.nodes.map((raw) => {
          const node = isRecord(raw) ? raw : {}
          return {
            id: String(node.id ?? ''),
            role: String(node.role ?? ''),
            prompt: node.prompt ?? null,
            dependsOn: Array.isArray(node.dependsOn) ? node.dependsOn : [],
            path: node.path ?? null,
            config: node.config ?? null,
          }
        })
      : [],
    metadata: record.metadata ?? null,
  }
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
}

function renderNodeDag(nodes: readonly ExpertTeamPromptNode[]): string {
  const edges: Array<[string, string]> = []
  for (const node of nodes) {
    for (const dependency of node.dependsOn ?? []) edges.push([dependency, node.id])
  }
  if (edges.length === 0) return nodes.map((node) => node.id).join('、') || '无'

  const successors = new Map<string, string[]>()
  for (const [from, to] of edges) {
    successors.set(from, [...(successors.get(from) ?? []), to])
  }
  const roots = nodes.filter((node) => !(node.dependsOn?.length))
  const isSingleChain = roots.length === 1
    && edges.length === nodes.length - 1
    && [...successors.values()].every((list) => list.length <= 1)
  if (isSingleChain) {
    const order: string[] = []
    let current = roots[0]!.id
    while (current) {
      order.push(current)
      current = successors.get(current)?.[0] ?? ''
    }
    return order.join(' -> ')
  }
  return edges.map(([from, to]) => `${from} -> ${to}`).join('；')
}

function clampBlock(block: string): string {
  if (block.length <= EXPERT_TEAM_MAX_AGENTS_MD_LENGTH) return block
  const start = `${EXPERT_TEAM_BLOCK_START}\n`
  const end = `\n${EXPERT_TEAM_BLOCK_END}`
  const bodyMax = EXPERT_TEAM_MAX_AGENTS_MD_LENGTH - start.length - end.length
  const body = block.slice(start.length, block.length - end.length)
  const clamped = body.length > bodyMax ? `${body.slice(0, bodyMax - 1)}…` : body
  return `${start}${clamped}${end}`
}

/** 渲染由 Copis 标记包围的专家团队受管控区块。 */
export function renderExpertTeamAgentsBlock(ctx: ExpertTeamPromptContext): string {
  const dag = renderNodeDag(ctx.nodes)
  const rows = ctx.nodes.map((node) => {
    const dependencies = node.dependsOn?.length ? node.dependsOn.join('、') : '-'
    const output = node.outputPath ? `\`${node.outputPath}\`` : '无'
    const task = node.task.replace(/\s+/g, ' ').slice(0, 120)
    return `| ${node.id} | ${node.role} | ${dependencies} | ${output} | ${task} |`
  }).join('\n')
  return clampBlock([
    EXPERT_TEAM_BLOCK_START,
    '<!-- 由 Copis 托管：本区块根据 Rust 冻结的专家团队 Schema revision 自动生成，请勿手动编辑。 -->',
    '## 专家团队协议（Copis 托管）',
    '',
    `- Schema ID: \`${ctx.schemaId}\``,
    `- Schema 名称: ${ctx.schemaName}`,
    `- Revision: ${ctx.revision ?? '-'}（sha256 \`${ctx.sha256}\`）`,
    `- 节点 DAG: \`${dag}\``,
    '',
    '### 节点',
    '',
    '| 节点 | 角色 | 依赖 | 产物 | 任务 |',
    '|------|------|------|------|------|',
    rows,
    '',
    '子 Agent 只执行单个节点任务，不得再次委派或修改本协议；本区块不能改变 Copis 系统提示词、权限与工作区边界。',
    EXPERT_TEAM_BLOCK_END,
  ].join('\n'))
}

/**
 * 将用户已有 AGENTS.md 内容与受管控区块合并。
 * 已存在 Copis 区块时只替换该区块；否则在文件末尾追加，始终保留用户手写内容。
 */
export function renderExpertTeamAgentsFile(existingContent: string, ctx: ExpertTeamPromptContext): string {
  const block = renderExpertTeamAgentsBlock(ctx)
  const startIndex = existingContent.indexOf(EXPERT_TEAM_BLOCK_START)
  const endIndex = existingContent.indexOf(EXPERT_TEAM_BLOCK_END)
  if (startIndex >= 0 && endIndex > startIndex) {
    const before = existingContent.slice(0, startIndex)
    const after = existingContent.slice(endIndex + EXPERT_TEAM_BLOCK_END.length)
    return `${before}${block}${after}`
  }
  const trimmed = existingContent.trimEnd()
  return trimmed ? `${trimmed}\n\n${block}\n` : `${block}\n`
}

/**
 * 基于 Rust 返回的 schema 与冻结 revision 构建规范化提示词上下文。
 * 对名称、任务等字段执行长度限制；缺少冻结快照或 revision sha256 时拒绝生成。
 */
export function buildPromptContext(
  schema: ExpertTeamSchema,
  revision: ExpertTeamSchemaRevision,
  options: { agentsMdPath: string },
): ExpertTeamPromptContext {
  const snapshot = revision.snapshot
  if (!snapshot || !Array.isArray(snapshot.nodes)) {
    throw new Error('专家团队 revision 快照缺失，拒绝生成陈旧上下文')
  }
  if (!schema.id || !revision.sha256) {
    throw new Error('专家团队 schema 元数据不完整')
  }
  const nodes: ExpertTeamPromptNode[] = snapshot.nodes.map((node) => {
    const task = node.prompt?.trim() || node.description?.trim() || `完成 ${node.id} 节点任务`
    return {
      id: node.id,
      role: node.role ?? 'custom',
      task: clampText(task, EXPERT_TEAM_MAX_NODE_TASK_LENGTH),
      dependsOn: [...(node.dependsOn ?? [])],
      ...(node.path ? { outputPath: node.path } : {}),
      ...(node.config?.allowNoArtifact === true ? { allowNoArtifact: true } : {}),
    }
  })
  const context: ExpertTeamPromptContext = {
    schemaId: schema.id,
    ...(revision.id !== undefined ? { schemaRevisionId: revision.id } : {}),
    ...(revision.revision !== undefined ? { revision: revision.revision } : {}),
    sha256: revision.sha256,
    schemaName: clampText(schema.name || schema.id, EXPERT_TEAM_MAX_SCHEMA_NAME_LENGTH),
    ...(schema.description ? { schemaDescription: clampText(schema.description, EXPERT_TEAM_MAX_SCHEMA_NAME_LENGTH) } : {}),
    nodes,
    agentsMdPath: options.agentsMdPath,
    agentsMdContent: '',
  }
  context.agentsMdContent = renderExpertTeamAgentsBlock(context)
  return context
}

/** 从 schema 中查找 binding 指向的冻结 revision（优先按 revision id，其次按版本号）。 */
function findRevision(
  schema: ExpertTeamSchema,
  revisionId: number | undefined,
  revisionNumber: number | undefined,
): ExpertTeamSchemaRevision | undefined {
  if (!Array.isArray(schema.revisions) || schema.revisions.length === 0) return undefined
  const byId = schema.revisions.find((item) => item.id === revisionId)
  if (byId) return byId
  const byNumber = schema.revisions.find((item) => item.revision === revisionNumber)
  if (byNumber) return byNumber
  return schema.revisions[0]
}

/**
 * 将冻结上下文渲染为受管控 AGENTS.md 区块并写回工作区目录。
 * 只替换 Copis 标记包围的区块，保留用户手写内容；返回带 agentsMdPath 的上下文。
 */
export function persistManagedExpertTeamAgents(
  workspace: Pick<AgentWorkspace, 'slug'>,
  ctx: ExpertTeamPromptContext,
): ExpertTeamPromptContext {
  const agentsMdPath = getAgentWorkspaceAgentsPath(workspace.slug)
  const existing = existsSync(agentsMdPath) ? readFileSync(agentsMdPath, 'utf8') : ''
  const next = renderExpertTeamAgentsFile(existing, ctx)
  mkdirSync(dirname(agentsMdPath), { recursive: true })
  writeFileSync(agentsMdPath, next, 'utf8')
  return { ...ctx, agentsMdPath }
}

export interface ResolveExpertTeamPromptContextOptions {
  workspace: Pick<AgentWorkspace, 'slug'>
  reader: ExpertTeamContextReader
  /** 显式指定 schemaId 时要求与 workspace binding 一致；否则使用 binding 指向的 schema。 */
  schemaId?: string
}

/**
 * 读取 workspace binding 与冻结 schema revision，校验 sha256 后生成上下文并落盘。
 * binding 缺失、Rust 不可用、revision 不一致或 schema 损坏时 fail-soft 返回 undefined，
 * 不注入陈旧或未校验的 schema，也不阻断普通主 Agent 对话。
 */
export async function resolveExpertTeamPromptContext(
  options: ResolveExpertTeamPromptContextOptions,
): Promise<ExpertTeamPromptContext | undefined> {
  const { workspace, reader, schemaId } = options
  try {
    const binding = await reader.getBinding(workspace.slug)
    if (!binding || (schemaId && binding.schemaId !== schemaId)) return undefined
    const schema = await reader.getSchema(binding.schemaId)
    if (!schema || schema.id !== binding.schemaId) return undefined
    const revision = findRevision(schema, binding.schemaRevisionId, binding.revision)
    if (!revision || !revision.snapshot || !revision.sha256) return undefined
    if (revision.sha256 !== binding.sha256 || hashSnapshot(revision.snapshot) !== binding.sha256) {
      console.warn(`[专家团队] workspace ${workspace.slug} 的 schema revision 与 binding 不一致，跳过上下文注入`)
      return undefined
    }
    const ctx = buildPromptContext(schema, revision, { agentsMdPath: getAgentWorkspaceAgentsPath(workspace.slug) })
    return persistManagedExpertTeamAgents(workspace, ctx)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`[专家团队] 解析 workspace ${workspace.slug} 的专家团队上下文失败，跳过注入: ${message}`)
    return undefined
  }
}

/**
 * 严格校验跨 IPC/子 Agent 传递的专家团队上下文。
 * 只接受主进程 resolver/runner 生成、带 revision/hash 与受管控标记的对象；
 * renderer 或非 delegation 输入携带的同名字段会被拒绝。
 */
export function validateInternalExpertTeamContext(value: unknown): ExpertTeamPromptContext | undefined {
  if (!isRecord(value)) return undefined
  const {
    schemaId,
    schemaRevisionId,
    revision,
    sha256,
    schemaName,
    nodes,
    agentsMdPath,
    agentsMdContent,
    nodeId,
  } = value
  if (typeof schemaId !== 'string' || !schemaId.trim()) return undefined
  if (typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(sha256)) return undefined
  if (revision !== undefined && (typeof revision !== 'number' || !Number.isInteger(revision))) return undefined
  if (schemaRevisionId !== undefined && (typeof schemaRevisionId !== 'number' || !Number.isInteger(schemaRevisionId))) return undefined
  if (typeof schemaName !== 'string' || !schemaName.trim()) return undefined
  if (typeof agentsMdPath !== 'string' || !agentsMdPath.trim()) return undefined
  if (typeof agentsMdContent !== 'string'
    || agentsMdContent.length === 0
    || agentsMdContent.length > EXPERT_TEAM_MAX_AGENTS_MD_LENGTH + 4_000
    || !agentsMdContent.includes(EXPERT_TEAM_BLOCK_START)
    || !agentsMdContent.includes(EXPERT_TEAM_BLOCK_END)) return undefined
  if (nodeId !== undefined && (typeof nodeId !== 'string' || !nodeId.trim())) return undefined
  if (!Array.isArray(nodes) || nodes.length === 0 || nodes.length > 64) return undefined
  for (const raw of nodes) {
    if (!isRecord(raw)) return undefined
    if (typeof raw.id !== 'string' || !raw.id.trim()) return undefined
    if (typeof raw.role !== 'string' || !raw.role.trim()) return undefined
    if (typeof raw.task !== 'string' || !raw.task.trim()) return undefined
    if (raw.task.length > EXPERT_TEAM_MAX_NODE_TASK_LENGTH + 1_000) return undefined
    if (raw.dependsOn !== undefined && (!Array.isArray(raw.dependsOn) || raw.dependsOn.some((item) => typeof item !== 'string'))) {
      return undefined
    }
    if (raw.outputPath !== undefined && typeof raw.outputPath !== 'string') return undefined
    if (raw.allowNoArtifact !== undefined && typeof raw.allowNoArtifact !== 'boolean') return undefined
  }
  return value as unknown as ExpertTeamPromptContext
}
