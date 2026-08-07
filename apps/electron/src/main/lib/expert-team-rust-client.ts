/** 专家团队状态 API 的 Electron 侧客户端。 */

import { getHttpApiInternalToken, HTTP_API_HOST, HTTP_API_PORT } from './http-api-server'
import { basename } from 'node:path'

export interface ExpertTeamNodeRef {
  runId: string
  nodeId: string
}

export interface ExpertTeamNodeEvent extends ExpertTeamNodeRef {
  type: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'artifact'
  payload?: Record<string, unknown>
}

export interface ExpertTeamArtifact extends ExpertTeamNodeRef {
  path: string
  name?: string
  mimeType?: string
  sizeBytes?: number
  sha256?: string
}

export interface ExpertTeamRustApi {
  claimRun(runId: string): Promise<void>
  completeRun(input: { runId: string; status: 'succeeded' | 'failed' | 'cancelled' }): Promise<void>
  nodeStarted(input: ExpertTeamNodeRef & { childSessionId: string; outputDir: string }): Promise<void>
  nodeCompleted(input: ExpertTeamNodeRef & { childSessionId: string; summary?: string; noArtifact?: boolean }): Promise<void>
  nodeFailed(input: ExpertTeamNodeRef & { childSessionId?: string; error: string }): Promise<void>
  nodeCancelled(input: ExpertTeamNodeRef & { childSessionId?: string; reason?: string }): Promise<void>
  appendEvent(input: ExpertTeamNodeEvent): Promise<void>
  recordArtifact(input: ExpertTeamArtifact): Promise<void>
}

type FetchImplementation = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export interface ExpertTeamRustApiClientOptions {
  baseUrl?: string
  fetchImpl?: FetchImplementation
  getToken?: () => string | null
}

function resolveBaseUrl(baseUrl: string | undefined): string {
  if (baseUrl?.trim()) return baseUrl.replace(/\/$/, '')
  return `http://${HTTP_API_HOST}:${HTTP_API_PORT}`
}

function assertComponent(value: string, field: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value)) throw new Error(`${field} 参数不正确`)
  return encodeURIComponent(value)
}

async function responseError(response: Response): Promise<string> {
  const body = await response.text()
  return `Rust 专家团队 API 请求失败（${response.status}）：${body.slice(0, 400)}`
}

/**
 * Rust API 尚未实现专家团队路由时，Electron 仍可以通过注入 fake client 测试调度逻辑。
 * 生产客户端只访问 loopback，并且每个请求都携带启动 Rust 时生成的内部令牌。
 */
export class HttpExpertTeamRustApiClient implements ExpertTeamRustApi {
  private readonly baseUrl: string
  private readonly fetchImpl: FetchImplementation
  private readonly getToken: () => string | null

  constructor(options: ExpertTeamRustApiClientOptions = {}) {
    this.baseUrl = resolveBaseUrl(options.baseUrl)
    this.fetchImpl = options.fetchImpl ?? fetch
    this.getToken = options.getToken ?? getHttpApiInternalToken
  }

  private async post(path: string, body?: Record<string, unknown>): Promise<void> {
    const token = this.getToken()
    if (!token) throw new Error('Rust HTTP API 尚未启动')
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'X-Copis-Internal-Token': token,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    if (!response.ok) throw new Error(await responseError(response))
  }

  private nodePath(input: ExpertTeamNodeRef, action: string): string {
    void action
    return `/api/internal/expert-teams/runs/${assertComponent(input.runId, 'runId')}/nodes/${assertComponent(input.nodeId, 'nodeId')}`
  }

  async claimRun(runId: string): Promise<void> {
    await this.post(`/api/internal/expert-teams/runs/${assertComponent(runId, 'runId')}/claim`)
  }

  async completeRun(input: { runId: string; status: 'succeeded' | 'failed' | 'cancelled' }): Promise<void> {
    await this.post(`/api/internal/expert-teams/runs/${assertComponent(input.runId, 'runId')}/complete`, { status: input.status })
  }

  async nodeStarted(input: ExpertTeamNodeRef & { childSessionId: string; outputDir: string }): Promise<void> {
    await this.post(this.nodePath(input, 'start'), {
      status: 'running',
      childSessionId: input.childSessionId,
      input: { childSessionId: input.childSessionId, outputDir: input.outputDir },
      startedAt: Date.now(),
    })
  }

  async nodeCompleted(input: ExpertTeamNodeRef & { childSessionId: string; summary?: string; noArtifact?: boolean }): Promise<void> {
    await this.post(this.nodePath(input, 'complete'), {
      status: 'succeeded',
      childSessionId: input.childSessionId,
      output: {
        ...(input.summary ? { summary: input.summary } : {}),
        ...(input.noArtifact !== undefined ? { noArtifact: input.noArtifact } : {}),
      },
      completedAt: Date.now(),
    })
  }

  async nodeFailed(input: ExpertTeamNodeRef & { childSessionId?: string; error: string }): Promise<void> {
    await this.post(this.nodePath(input, 'fail'), {
      status: 'failed',
      ...(input.childSessionId ? { childSessionId: input.childSessionId } : {}),
      output: { error: input.error },
      completedAt: Date.now(),
    })
  }

  async nodeCancelled(input: ExpertTeamNodeRef & { childSessionId?: string; reason?: string }): Promise<void> {
    await this.post(this.nodePath(input, 'cancel'), {
      status: 'cancelled',
      ...(input.childSessionId ? { childSessionId: input.childSessionId } : {}),
      output: input.reason ? { reason: input.reason } : {},
      completedAt: Date.now(),
    })
  }

  async appendEvent(input: ExpertTeamNodeEvent): Promise<void> {
    await this.post(`/api/internal/expert-teams/runs/${assertComponent(input.runId, 'runId')}/events`, {
      type: input.type,
      payload: { nodeId: input.nodeId, ...(input.payload ?? {}) },
    })
  }

  async recordArtifact(input: ExpertTeamArtifact): Promise<void> {
    await this.post(`/api/internal/expert-teams/runs/${assertComponent(input.runId, 'runId')}/artifacts`, {
      nodeId: input.nodeId,
      name: input.name ?? basename(input.path),
      path: input.path,
      ...(input.mimeType ? { mimeType: input.mimeType } : {}),
      ...(input.sizeBytes !== undefined ? { sizeBytes: input.sizeBytes } : {}),
      ...(input.sha256 ? { sha256: input.sha256 } : {}),
    })
  }
}
