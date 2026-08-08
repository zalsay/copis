import type {
  ExpertTeamArtifact,
  ExpertTeamBindWorkspaceInput,
  ExpertTeamCreateRunInput,
  ExpertTeamEventsResponse,
  ExpertTeamPublishSchemaInput,
  ExpertTeamRun,
  ExpertTeamRunEvent,
  ExpertTeamSchema,
  ExpertTeamSchemaRevision,
  ExpertTeamSchemasResponse,
  ExpertTeamWorkspaceBinding,
} from '@copis/shared'
import { RENDERER_HTTP_API_BASE_URL } from './http-api-base-url'
import { withHttpApiWebToken } from './http-api-web-token'

const EXPERT_TEAM_API_BASE_URL = RENDERER_HTTP_API_BASE_URL
const STARTUP_RETRY_COUNT = 20
const STARTUP_RETRY_DELAY_MS = 300

export class ExpertTeamApiError extends Error {
  readonly status: number
  readonly code?: string
  readonly payload: unknown

  constructor(message: string, status: number, code: string | undefined, payload: unknown) {
    super(message)
    this.name = 'ExpertTeamApiError'
    this.status = status
    this.code = code
    this.payload = payload
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function readPayload(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!text) return undefined
  try {
    return JSON.parse(text) as unknown
  } catch {
    return text
  }
}

async function fetchWithStartupRetry(path: string, init: RequestInit): Promise<Response> {
  let lastError: unknown
  for (let attempt = 0; attempt < STARTUP_RETRY_COUNT; attempt += 1) {
    try {
      const response = await fetch(`${EXPERT_TEAM_API_BASE_URL}${path}`, init)
      if (response.status < 500 || response.status > 504 || attempt + 1 >= STARTUP_RETRY_COUNT) return response
    } catch (error) {
      lastError = error
      if (attempt + 1 >= STARTUP_RETRY_COUNT) break
    }
    await new Promise<void>((resolve) => window.setTimeout(resolve, STARTUP_RETRY_DELAY_MS))
  }
  throw lastError instanceof Error ? lastError : new Error('Rust HTTP API 服务未启动')
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetchWithStartupRetry(path, withHttpApiWebToken({
    ...init,
    headers: {
      Accept: 'application/json',
      ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...init.headers,
    },
  }))
  const payload = await readPayload(response)
  if (!response.ok) {
    const errorPayload = isRecord(payload) ? payload : undefined
    const message = typeof errorPayload?.error === 'string'
      ? errorPayload.error
      : `专家团队请求失败（${response.status}）`
    const code = typeof errorPayload?.code === 'string' ? errorPayload.code : undefined
    throw new ExpertTeamApiError(message, response.status, code, payload)
  }
  return payload as T
}

function unwrapArray<T>(payload: unknown, key: string): T[] {
  if (Array.isArray(payload)) return payload as T[]
  if (isRecord(payload) && Array.isArray(payload[key])) return payload[key] as T[]
  throw new Error(`专家团队响应缺少 ${key}`)
}

function unwrapObject<T>(payload: unknown, key: string): T {
  if (isRecord(payload) && isRecord(payload[key])) return payload[key] as T
  return payload as T
}

function normalizeSchema(value: unknown): ExpertTeamSchema {
  if (!isRecord(value) || typeof value.id !== 'string') {
    throw new Error('专家团队 schema 响应格式不正确')
  }
  const rawRevisions = Array.isArray(value.revisions) ? value.revisions : []
  const currentRevisionId = typeof value.currentRevisionId === 'number'
    ? value.currentRevisionId
    : typeof value.schemaRevisionId === 'number' ? value.schemaRevisionId : undefined
  const currentRevision = rawRevisions.find((revision): revision is Record<string, unknown> => isRecord(revision) && revision.id === currentRevisionId)
  const snapshot = isRecord(value.snapshot)
    ? value.snapshot
    : isRecord(currentRevision) && isRecord(currentRevision.snapshot)
      ? currentRevision.snapshot
      : value
  if (typeof (snapshot.name ?? value.name) !== 'string') throw new Error('专家团队 schema 响应缺少名称')
  const schemaName = typeof snapshot.name === 'string' ? snapshot.name : typeof value.name === 'string' ? value.name : ''
  const rawNodes = Array.isArray(snapshot.nodes) ? snapshot.nodes : []
  const nodes = rawNodes.flatMap((node): ExpertTeamSchema['nodes'] => {
    if (!isRecord(node) || typeof node.id !== 'string') return []
    return [{
      id: node.id,
      name: typeof node.name === 'string' ? node.name : typeof node.role === 'string' ? node.role : node.id,
      ...(typeof node.description === 'string' ? { description: node.description } : {}),
      ...(typeof node.role === 'string' ? { role: node.role } : {}),
      ...(typeof node.prompt === 'string' ? { prompt: node.prompt } : {}),
      ...(Array.isArray(node.dependsOn) ? { dependsOn: node.dependsOn.filter((item): item is string => typeof item === 'string') } : {}),
      ...(typeof node.path === 'string' ? { path: node.path } : {}),
      ...(isRecord(node.config) ? { config: node.config } : {}),
    }]
  })
  const edges = nodes.flatMap((node) => (node.dependsOn ?? []).map((from) => ({ from, to: node.id })))
  const revisions = rawRevisions.length > 0
    ? rawRevisions.flatMap((revision): ExpertTeamSchemaRevision[] => {
      if (!isRecord(revision) || typeof revision.id !== 'number' || typeof revision.revision !== 'number') return []
      return [{
        id: revision.id,
        revision: revision.revision,
        ...(typeof revision.sha256 === 'string' ? { sha256: revision.sha256 } : {}),
        ...(isRecord(revision.snapshot) ? { snapshot: normalizeSchema(revision.snapshot) } : {}),
        ...(typeof revision.createdAt === 'number' || typeof revision.createdAt === 'string' ? { createdAt: revision.createdAt } : {}),
      }]
    })
    : undefined
  return {
    id: value.id,
    name: schemaName,
    ...(typeof (snapshot.description ?? value.description) === 'string' ? { description: (snapshot.description ?? value.description) as string } : {}),
    nodes,
    edges,
    ...(isRecord(snapshot.metadata) ? { metadata: snapshot.metadata } : {}),
    ...(currentRevisionId !== undefined ? { currentRevisionId } : {}),
    ...(typeof value.revision === 'number' ? { revision: value.revision } : typeof currentRevision?.revision === 'number' ? { revision: currentRevision.revision } : {}),
    ...(typeof value.sha256 === 'string' ? { sha256: value.sha256 } : typeof currentRevision?.sha256 === 'string' ? { sha256: currentRevision.sha256 } : {}),
    ...(typeof value.createdAt === 'number' || typeof value.createdAt === 'string' ? { createdAt: value.createdAt } : {}),
    ...(typeof value.updatedAt === 'number' || typeof value.updatedAt === 'string' ? { updatedAt: value.updatedAt } : {}),
    ...(revisions ? { revisions } : {}),
  }
}

function normalizeRun(value: unknown): ExpertTeamRun {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.schemaId !== 'string' || typeof value.workspaceSlug !== 'string' || typeof value.status !== 'string') {
    throw new Error('专家团队 run 响应格式不正确')
  }
  const status = value.status === 'completed' ? 'succeeded' : value.status === 'canceled' ? 'cancelled' : value.status
  if (!['queued', 'running', 'succeeded', 'failed', 'cancelled'].includes(status)) throw new Error('专家团队 run 状态不正确')
  return { ...value, status, createdAt: (value.createdAt as number | string) ?? Date.now() } as ExpertTeamRun
}

function normalizeEvent(value: unknown): ExpertTeamRunEvent {
  if (!isRecord(value) || typeof value.type !== 'string') throw new Error('专家团队事件响应格式不正确')
  const payload = isRecord(value.payload) ? value.payload : undefined
  const eventStatus = typeof value.status === 'string'
    ? value.status
    : ({ queued: 'queued', started: 'running', claimed: 'running', completed: 'succeeded', succeeded: 'succeeded', failed: 'failed', canceled: 'cancelled', cancelled: 'cancelled' } as Record<string, string>)[value.type]
  const nodeId = typeof value.nodeId === 'string'
    ? value.nodeId
    : typeof payload?.nodeId === 'string' ? payload.nodeId : undefined
  const message = typeof value.message === 'string'
    ? value.message
    : typeof payload?.message === 'string' ? payload.message : typeof payload?.error === 'string' ? payload.error : undefined
  return {
    id: typeof value.id === 'string' || typeof value.id === 'number' ? value.id : String(value.seq ?? value.type),
    runId: typeof value.runId === 'string' ? value.runId : undefined,
    type: value.type,
    ...(nodeId ? { nodeId } : {}),
    ...(eventStatus ? { status: eventStatus as ExpertTeamRunEvent['status'] } : {}),
    ...(message ? { message } : {}),
    ...(payload ? { data: payload } : {}),
    timestamp: (value.timestamp ?? value.createdAt ?? Date.now()) as number | string,
    ...(typeof value.seq === 'number' ? { sequence: value.seq } : {}),
  }
}

function normalizeArtifact(value: unknown): ExpertTeamArtifact {
  if (!isRecord(value) || (typeof value.id !== 'string' && typeof value.id !== 'number') || typeof value.name !== 'string') {
    throw new Error('专家团队产物响应格式不正确')
  }
  return { ...value, runId: typeof value.runId === 'string' ? value.runId : '', createdAt: (value.createdAt ?? Date.now()) as number | string } as ExpertTeamArtifact
}

function workspacePath(workspaceSlug: string): string {
  const slug = workspaceSlug.trim()
  if (!slug) throw new Error('当前工作区不能为空')
  return encodeURIComponent(slug)
}

export const expertTeamApi = {
  async listSchemas(): Promise<ExpertTeamSchema[]> {
    const payload = await request<ExpertTeamSchemasResponse | ExpertTeamSchema[]>('/api/expert-teams/schemas')
    return unwrapArray<unknown>(payload, 'schemas').map(normalizeSchema)
  },

  getSchema(schemaId: string): Promise<ExpertTeamSchema> {
    return request<ExpertTeamSchema | { schema: ExpertTeamSchema }>(`/api/expert-teams/schemas/${encodeURIComponent(schemaId)}`)
      .then((payload) => normalizeSchema(unwrapObject<unknown>(payload, 'schema')))
  },

  publishSchema(input: ExpertTeamPublishSchemaInput): Promise<ExpertTeamSchema> {
    return request<unknown>('/api/expert-teams/schemas', {
      method: 'POST',
      body: JSON.stringify(input),
    }).then(normalizeSchema)
  },

  async bindWorkspace(workspaceSlug: string, input: ExpertTeamBindWorkspaceInput): Promise<ExpertTeamWorkspaceBinding> {
    const payload = await request<ExpertTeamWorkspaceBinding | { binding: ExpertTeamWorkspaceBinding }>(
      `/api/expert-teams/workspaces/${workspacePath(workspaceSlug)}/binding`,
      { method: 'POST', body: JSON.stringify(input) },
    )
    return unwrapObject<ExpertTeamWorkspaceBinding>(payload, 'binding')
  },

  createRun(input: ExpertTeamCreateRunInput): Promise<ExpertTeamRun> {
    return request<ExpertTeamRun | { run: ExpertTeamRun }>('/api/expert-teams/runs', {
      method: 'POST',
      body: JSON.stringify(input),
    }).then((payload) => normalizeRun(unwrapObject<unknown>(payload, 'run')))
  },

  getRun(runId: string): Promise<ExpertTeamRun> {
    return request<ExpertTeamRun>(`/api/expert-teams/runs/${encodeURIComponent(runId)}`).then(normalizeRun)
  },

  async listEvents(runId: string): Promise<ExpertTeamRunEvent[]> {
    const payload = await request<ExpertTeamEventsResponse | ExpertTeamRunEvent[]>(`/api/expert-teams/runs/${encodeURIComponent(runId)}/events`)
    return unwrapArray<unknown>(payload, 'events').map(normalizeEvent)
  },

  cancelRun(runId: string): Promise<ExpertTeamRun> {
    return request<ExpertTeamRun | { run: ExpertTeamRun }>(`/api/expert-teams/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST' })
      .then((payload) => normalizeRun(unwrapObject<unknown>(payload, 'run')))
  },

  async listArtifacts(runId: string): Promise<ExpertTeamArtifact[]> {
    const payload = await request<ExpertTeamArtifact[] | { artifacts: ExpertTeamArtifact[] }>(`/api/expert-teams/runs/${encodeURIComponent(runId)}/artifacts`)
    return unwrapArray<unknown>(payload, 'artifacts').map(normalizeArtifact)
  },
}

export { request as requestExpertTeamApi }
