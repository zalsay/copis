import type {
  MemoryEntry,
  MemoryKind,
  MemoryMaintenanceAction,
  MemoryMaintenanceApplyInput,
  MemoryMaintenanceApplyResponse,
  MemoryMaintenanceState,
  MemoryPolicy,
  MemoryListResponse,
  ProviderType,
} from '@copis/shared'
import type { MemoryAgentListInput } from '../memory-api-client'
import { runMemoryTextTurn } from './pi-memory-auto-capture'

export const MEMORY_MAINTENANCE_CAPTURE_THRESHOLD = 10
export const MEMORY_SCRATCH_RETENTION_DAYS = 14
export const MEMORY_SCRATCH_CONTEXT_DAYS = 2
const MAX_ACTIONS = 50
const MAX_FIELD_CHARS = 256 * 1024

export interface MemoryMaintenanceClient {
  list(input: MemoryAgentListInput): Promise<MemoryListResponse>
  maintenanceState(workspaceSlug: string): Promise<MemoryMaintenanceState>
  applyMaintenance(input: MemoryMaintenanceApplyInput): Promise<MemoryMaintenanceApplyResponse>
}

export interface MemoryMaintenancePlanner {
  (input: {
    workspaceSlug: string
    expectedCaptureCount: number
    entries: readonly MemoryEntry[]
  }): Promise<string | MemoryMaintenanceAction[]>
}

export interface MemoryMaintenanceServiceOptions {
  client?: MemoryMaintenanceClient
  planner?: MemoryMaintenancePlanner
}

export interface QueuedMaintenance {
  workspaceSlug: string
  policy: MemoryPolicy
  planner?: MemoryMaintenancePlanner
  force: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isDurableKind(value: unknown): value is Exclude<MemoryKind, 'scratch'> {
  return value === 'fact' || value === 'preference' || value === 'decision' || value === 'project'
}

function finiteRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

function boundedString(value: unknown, field: string, maxChars = MAX_FIELD_CHARS): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maxChars) {
    throw new Error(`维护 ${field} 参数不正确`)
  }
  return value.trim()
}

function parseTags(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 32) throw new Error('维护 tags 参数不正确')
  return value.map((tag) => boundedString(tag, 'tag', 128))
}

/** 解析并校验模型生成的维护 JSON，任何一处不合法都拒绝整批。 */
export function parseMaintenanceActions(
  output: string,
  entries: readonly MemoryEntry[],
): MemoryMaintenanceAction[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(output.trim()) as unknown
  } catch {
    throw new Error('维护回合必须返回 JSON')
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.actions) || parsed.actions.length > MAX_ACTIONS) {
    throw new Error('维护 actions 参数不正确')
  }

  const allowed = new Map(entries.filter((entry) => !entry.archived).map((entry) => [entry.id, entry]))
  return parsed.actions.map((rawAction): MemoryMaintenanceAction => {
    if (!isRecord(rawAction) || typeof rawAction.operation !== 'string') {
      throw new Error('维护 operation 参数不正确')
    }
    if (rawAction.operation === 'promote') {
      const id = boundedString(rawAction.id, 'id', 128)
      const entry = allowed.get(id)
      if (!entry || entry.kind !== 'scratch') throw new Error('维护 promote 只能作用于当前 workspace scratch')
      if (!finiteRevision(rawAction.expectedRevision) || !isDurableKind(rawAction.kind)) {
        throw new Error('维护 promote revision/kind 参数不正确')
      }
      return { operation: 'promote', id, expectedRevision: rawAction.expectedRevision, kind: rawAction.kind }
    }
    if (rawAction.operation === 'rewrite') {
      const id = boundedString(rawAction.id, 'id', 128)
      const entry = allowed.get(id)
      if (!entry) throw new Error('维护 rewrite 条目不在当前 workspace 可见范围')
      if (!finiteRevision(rawAction.expectedRevision)) throw new Error('维护 rewrite revision 参数不正确')
      const title = rawAction.title === undefined ? undefined : boundedString(rawAction.title, 'title', 512)
      const content = rawAction.content === undefined ? undefined : boundedString(rawAction.content, 'content')
      const tags = rawAction.tags === undefined ? undefined : parseTags(rawAction.tags)
      const kind = rawAction.kind === undefined ? undefined : rawAction.kind
      if (kind !== undefined && (typeof kind !== 'string' || (!isDurableKind(kind) && kind !== 'scratch'))) {
        throw new Error('维护 rewrite kind 参数不正确')
      }
      if (title === undefined && content === undefined && tags === undefined && kind === undefined) {
        throw new Error('维护 rewrite 至少需要一个字段')
      }
      return {
        operation: 'rewrite',
        id,
        expectedRevision: rawAction.expectedRevision,
        ...(title === undefined ? {} : { title }),
        ...(content === undefined ? {} : { content }),
        ...(tags === undefined ? {} : { tags }),
        ...(kind === undefined ? {} : { kind: kind as MemoryKind }),
      }
    }
    if (rawAction.operation === 'archive') {
      const id = boundedString(rawAction.id, 'id', 128)
      if (!allowed.has(id) || !finiteRevision(rawAction.expectedRevision)) {
        throw new Error('维护 archive 条目或 revision 参数不正确')
      }
      return { operation: 'archive', id, expectedRevision: rawAction.expectedRevision }
    }
    if (rawAction.operation === 'capture') {
      const kind = rawAction.kind
      if (!isDurableKind(kind)) throw new Error('维护 capture kind 参数不正确')
      return {
        operation: 'capture',
        kind,
        title: boundedString(rawAction.title, 'title', 512),
        content: boundedString(rawAction.content, 'content'),
        tags: parseTags(rawAction.tags),
      }
    }
    throw new Error(`维护 operation 不支持: ${rawAction.operation}`)
  })
}

export function buildMemoryMaintenancePrompt(
  workspaceSlug: string,
  expectedCaptureCount: number,
  entries: readonly MemoryEntry[],
): string {
  const visibleEntries = entries.map((entry) => JSON.stringify({
    id: entry.id,
    revision: entry.revision,
    kind: entry.kind,
    title: entry.title,
    content: entry.content.slice(0, 2_000),
    tags: entry.tags,
    capturedAt: entry.capturedAt,
  })).join('\n')
  return `<copis_memory_maintenance>
这是 Copis 的隐藏 Memory consolidation 回合，workspace=${workspaceSlug}，captureCount=${expectedCaptureCount}。
只输出一个 JSON 对象：{"actions":[...]}，不要输出 Markdown、解释或 SQL。

目标：优先 merge/update，归档过期、矛盾、重复或可推导的 scratch；稳定偏好提升为 preference，项目长期经验提升为 project，持久决策提升为 decision，普通事实提升为 fact；一次性状态不 promotion。保留用户明确要求记住的事实，不要跨 scope 合并，不要写 secret、路径、endpoint、header 或工具 schema。
promote/rewrite/archive 必须使用下面条目的当前 id 和 revision；capture 只能写当前 workspace 的 durable 条目，不能写 scratch。

当前条目：
${visibleEntries}
</copis_memory_maintenance>`
}

function defaultClient(): MemoryMaintenanceClient {
  return {
    list: async (input) => {
      const { memoryApiClient } = await import('../memory-api-client')
      return memoryApiClient.list(input)
    },
    maintenanceState: async (workspaceSlug) => {
      const { memoryApiClient } = await import('../memory-api-client')
      return memoryApiClient.maintenanceState(workspaceSlug)
    },
    applyMaintenance: async (input) => {
      const { memoryApiClient } = await import('../memory-api-client')
      return memoryApiClient.applyMaintenance(input)
    },
  }
}

export class MemoryMaintenanceService {
  private readonly client: MemoryMaintenanceClient
  private readonly defaultPlanner?: MemoryMaintenancePlanner
  private readonly queues = new Map<string, Promise<MemoryMaintenanceApplyResponse | undefined>>()

  constructor(options: MemoryMaintenanceServiceOptions = {}) {
    this.client = options.client ?? defaultClient()
    this.defaultPlanner = options.planner
  }

  async run(input: QueuedMaintenance): Promise<MemoryMaintenanceApplyResponse | undefined> {
    if (input.policy !== 'writable') return undefined
    const previous = this.queues.get(input.workspaceSlug) ?? Promise.resolve(undefined)
    const next = previous.catch(() => undefined).then(() => this.runOnce(input))
    this.queues.set(input.workspaceSlug, next)
    try {
      return await next
    } finally {
      if (this.queues.get(input.workspaceSlug) === next) this.queues.delete(input.workspaceSlug)
    }
  }

  async maybeRun(input: Omit<QueuedMaintenance, 'force'>): Promise<MemoryMaintenanceApplyResponse | undefined> {
    return this.run({ ...input, force: false })
  }

  async runManual(input: Omit<QueuedMaintenance, 'force'>): Promise<MemoryMaintenanceApplyResponse | undefined> {
    return this.run({ ...input, force: true })
  }

  private async runOnce(input: QueuedMaintenance): Promise<MemoryMaintenanceApplyResponse | undefined> {
    const state = await this.client.maintenanceState(input.workspaceSlug)
    const due = state.captureCount - state.lastConsolidatedCaptureCount >= MEMORY_MAINTENANCE_CAPTURE_THRESHOLD
    if (!input.force && !due) return undefined

    const list = await this.client.list({ workspaceSlug: input.workspaceSlug, includeArchived: false, limit: 50 })
    const planner = input.planner ?? this.defaultPlanner
    let actions: MemoryMaintenanceAction[] = []
    if (planner) {
      const planned = await planner({
        workspaceSlug: input.workspaceSlug,
        expectedCaptureCount: state.captureCount,
        entries: list.entries,
      })
      actions = Array.isArray(planned) ? planned : parseMaintenanceActions(planned, list.entries)
    }
    return this.client.applyMaintenance({
      workspaceSlug: input.workspaceSlug,
      expectedCaptureCount: state.captureCount,
      actions,
    })
  }
}

/** 主进程内 direct Agent 与 RPC 入口共用同一把 workspace keyed queue。 */
export const sharedMemoryMaintenanceService = new MemoryMaintenanceService()

export interface MemoryMaintenanceRunnerInput {
  service: MemoryMaintenanceService
  workspaceSlug: string
  policy: MemoryPolicy
  provider: ProviderType
  baseUrl?: string
  apiKey: string
  modelId: string
  proxyUrl?: string
  force: boolean
}

/** 把阈值维护和 token-threshold 维护统一收敛到同一个 keyed queue。 */
export function createMemoryMaintenanceRunner(input: MemoryMaintenanceRunnerInput): () => Promise<void> {
  return async () => {
    const run = input.force ? input.service.runManual.bind(input.service) : input.service.maybeRun.bind(input.service)
    await run({
      workspaceSlug: input.workspaceSlug,
      policy: input.policy,
      planner: async ({ workspaceSlug, expectedCaptureCount, entries }) => runMemoryTextTurn({
        provider: input.provider,
        baseUrl: input.baseUrl,
        apiKey: input.apiKey,
        modelId: input.modelId,
        proxyUrl: input.proxyUrl,
        prompt: buildMemoryMaintenancePrompt(workspaceSlug, expectedCaptureCount, entries),
      }),
    })
  }
}
