/** 主 Agent 调度专家团队的 Pi 工具。 */

import { Type } from 'typebox'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { AgentToolResult } from '@earendil-works/pi-agent-core'
import type { ExpertTeamSchema, ExpertTeamSchemaRevision } from '@copis/shared'
import { HTTP_API_HOST, HTTP_API_PORT } from './http-api-server'
import { getAgentWorkspace, getAgentWorkspaceWritableRoot } from './agent-workspace-manager'
import { ExpertTeamRunner, type ExpertTeamNodeRole, type ExpertTeamRunSnapshot } from './expert-team-runner'
import { HttpExpertTeamRustApiClient } from './expert-team-rust-client'
import { createToolCallIdempotencyCache } from './agent-collaboration-utils'

const DEFAULT_SCHEMA_ID = 'ai-education-research-writer-reviewer'
const MAX_GOAL_LENGTH = 20_000

interface ExpertTeamToolContext {
  sessionId: string
  channelId: string
  modelId?: string
  workspaceId?: string
  workspaceSlug?: string
  triggeredBy?: 'user' | 'automation' | 'delegation'
}

interface ExpertTeamToolResult {
  runId: string
  schemaId: string
  schemaRevision?: number
  status: 'succeeded' | 'failed' | 'cancelled'
  nodes: Array<{
    nodeId: string
    status: string
    summary?: string
    error?: string
    outputPath?: string
  }>
}

const expertTeamCalls = createToolCallIdempotencyCache<Promise<ExpertTeamToolResult>>()

function jsonToolResult(payload: ExpertTeamToolResult): AgentToolResult<unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    details: payload,
  } as AgentToolResult<unknown>
}

function assertNonBlank(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} 不能为空`)
  return value.trim()
}

function assertSchema(value: unknown): ExpertTeamSchema {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('专家团队 Schema 响应不正确')
  const schema = value as ExpertTeamSchema
  if (!schema.id || !Array.isArray(schema.nodes) || schema.nodes.length === 0) throw new Error('专家团队 Schema 缺少节点')
  return schema
}

function currentRevision(schema: ExpertTeamSchema): ExpertTeamSchemaRevision | undefined {
  if (!schema.revisions?.length) return undefined
  return schema.revisions.find((revision) => revision.id === schema.currentRevisionId)
    ?? schema.revisions.find((revision) => revision.revision === schema.revision)
    ?? schema.revisions[0]
}

function toNodeRole(role: string | undefined): ExpertTeamNodeRole {
  const supported: ExpertTeamNodeRole[] = ['researcher', 'writer', 'reviewer', 'executor', 'explore', 'research', 'implement', 'review', 'custom']
  return role && supported.includes(role as ExpertTeamNodeRole) ? role as ExpertTeamNodeRole : 'custom'
}

async function requestPublic<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`http://${HTTP_API_HOST}:${HTTP_API_PORT}${path}`, {
    ...init,
    headers: {
      Accept: 'application/json',
      ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...init.headers,
    },
  })
  const text = await response.text()
  let payload: unknown
  try { payload = text ? JSON.parse(text) as unknown : undefined } catch { payload = text }
  if (!response.ok) {
    const message = payload && typeof payload === 'object' && !Array.isArray(payload) && typeof (payload as { error?: unknown }).error === 'string'
      ? (payload as { error: string }).error
      : `专家团队请求失败（${response.status}）`
    throw new Error(message)
  }
  return payload as T
}

async function runExpertTeam(ctx: ExpertTeamToolContext, goal: string, schemaId: string, signal?: AbortSignal): Promise<ExpertTeamToolResult> {
  if ((ctx.triggeredBy ?? 'user') !== 'user') throw new Error('只有主 Agent 可以调度专家团队')
  if (!ctx.workspaceId || !ctx.workspaceSlug) throw new Error('调度专家团队需要当前工作区')
  const workspace = getAgentWorkspace(ctx.workspaceId)
  if (!workspace || workspace.slug !== ctx.workspaceSlug) throw new Error('当前工作区不存在或上下文不一致')

  const rawSchema = await requestPublic<ExpertTeamSchema | { schema: ExpertTeamSchema }>(`/api/expert-teams/schemas/${encodeURIComponent(schemaId)}`)
  const schema = assertSchema(rawSchema && typeof rawSchema === 'object' && 'schema' in rawSchema ? rawSchema.schema : rawSchema)
  const revision = currentRevision(schema)
  const snapshotSchema = revision?.snapshot ?? schema
  const runPayload = await requestPublic<Record<string, unknown>>('/api/expert-teams/runs', {
    method: 'POST',
    body: JSON.stringify({
      schemaId: schema.id,
      workspaceSlug: workspace.slug,
      ...(revision ? { schemaRevisionId: revision.id } : {}),
      input: goal,
    }),
  })
  const run = (runPayload && typeof runPayload === 'object' && 'run' in runPayload)
    ? (runPayload as { run: Record<string, unknown> }).run
    : runPayload
  const runId = assertNonBlank(run.id, 'runId')
  const nodes = snapshotSchema.nodes.map((node) => {
    const prompt = node.prompt?.trim() || node.description?.trim() || `完成 ${node.name} 节点任务`
    return {
      id: node.id,
      role: toNodeRole(node.role),
      task: `${prompt}\n\n用户目标：\n${goal}`,
      ...(node.dependsOn?.length ? { dependsOn: node.dependsOn } : {}),
      ...(node.path ? { outputPath: node.path } : {}),
      ...(node.config?.allowNoArtifact === true ? { allowNoArtifact: true } : {}),
    }
  })
  const snapshot: ExpertTeamRunSnapshot = {
    runId,
    parentSessionId: ctx.sessionId,
    channelId: ctx.channelId,
    ...(ctx.modelId ? { modelId: ctx.modelId } : {}),
    workspaceId: ctx.workspaceId,
    nodes,
  }
  const result = await new ExpertTeamRunner({
    workspaceRoot: getAgentWorkspaceWritableRoot(workspace),
    rustApi: new HttpExpertTeamRustApiClient(),
  }).run(snapshot, signal)
  const failed = result.nodes.some((node) => node.status === 'failed')
  const cancelled = result.nodes.some((node) => node.status === 'cancelled')
  return {
    runId,
    schemaId: schema.id,
    ...(revision ? { schemaRevision: revision.revision } : {}),
    status: cancelled ? 'cancelled' : failed ? 'failed' : 'succeeded',
    nodes: result.nodes.map((node) => ({
      nodeId: node.nodeId,
      status: node.status,
      ...(node.summary ? { summary: node.summary } : {}),
      ...(node.error ? { error: node.error } : {}),
      ...(node.outputPath ? { outputPath: node.outputPath } : {}),
    })),
  }
}

export function buildExpertTeamTools(sdk: typeof import('@earendil-works/pi-coding-agent'), ctx: ExpertTeamToolContext): ToolDefinition[] {
  if ((ctx.triggeredBy ?? 'user') !== 'user' || !ctx.workspaceId || !ctx.workspaceSlug) return []
  return [sdk.defineTool({
    name: 'expert_team_run',
    label: '调度专家团队',
    description: '由主 Agent 按需调度本地 Pi 专家团队。普通问答和简单任务不要调用；只有需要深入研究、总结成文档并由 reviewer 检验的完整工作流才调用。子 Agent 结果会回传给你，你必须自行汇总后再回复用户。',
    parameters: Type.Object({
      goal: Type.String({ description: '专家团队需要完成的完整目标' }),
      schemaId: Type.Optional(Type.String({ description: `团队 Schema ID，默认 ${DEFAULT_SCHEMA_ID}` })),
    }),
    async execute(toolCallId: string, params: unknown, signal?: AbortSignal) {
      const args = params as { goal?: unknown; schemaId?: unknown }
      const goal = assertNonBlank(args.goal, 'goal')
      if (goal.length > MAX_GOAL_LENGTH) throw new Error(`goal 不能超过 ${MAX_GOAL_LENGTH} 个字符`)
      const schemaId = args.schemaId === undefined ? DEFAULT_SCHEMA_ID : assertNonBlank(args.schemaId, 'schemaId')
      const result = await expertTeamCalls.getOrCreate(
        ctx.sessionId,
        toolCallId,
        () => runExpertTeam(ctx, goal, schemaId, signal),
      )
      return jsonToolResult(result)
    },
  }) as unknown as ToolDefinition]
}

export const expertTeamDefaultSchemaId = DEFAULT_SCHEMA_ID
