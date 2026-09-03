/** 主 Agent 调度专家团队的 Pi 工具。 */

import { Type } from 'typebox'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { AgentToolResult } from '@earendil-works/pi-agent-core'
import { AGENT_IPC_CHANNELS, type AgentWorkspace, type ExpertTeamPromptContext, type ExpertTeamSchema, type ExpertTeamSchemaRevision } from '@copis/shared'
import { HTTP_API_HOST, HTTP_API_PORT } from './http-api-server'
import { getAgentWorkspace, getAgentWorkspaceAgentsPath, getAgentWorkspaceWritableRoot } from './agent-workspace-manager'
import { updateAgentSessionMeta } from './agent-session-manager'
import { ExpertTeamRunner, type ExpertTeamNodeRole, type ExpertTeamRunSnapshot } from './expert-team-runner'
import { HttpExpertTeamRustApiClient } from './expert-team-rust-client'
import { createToolCallIdempotencyCache } from './agent-collaboration-utils'
import {
  buildPromptContext,
  HttpExpertTeamContextReader,
  resolveExpertTeamPromptContext,
} from './expert-team-context'

const DEFAULT_SCHEMA_ID = 'ai-education-research-writer-reviewer'
const MAX_GOAL_LENGTH = 20_000

export function broadcastExpertTeamsChanged(): void {
  try {
    const electron = require('electron') as typeof import('electron')
    if (electron?.BrowserWindow) {
      for (const win of electron.BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
          win.webContents.send(AGENT_IPC_CHANNELS.EXPERT_TEAMS_CHANGED)
        }
      }
    }
  } catch {
    // 忽略非 Electron 或测试环境错误
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

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

function jsonToolResult(payload: unknown): AgentToolResult<unknown> {
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

/** 显式指定 schemaId 时按 Rust API 读取该 schema 的当前冻结 revision。 */
async function resolveExplicitSchemaContext(
  workspace: AgentWorkspace,
  schemaId: string,
): Promise<ExpertTeamPromptContext> {
  const rawSchema = await requestPublic<ExpertTeamSchema | { schema: ExpertTeamSchema }>(`/api/expert-teams/schemas/${encodeURIComponent(schemaId)}`)
  const schema = assertSchema(rawSchema && typeof rawSchema === 'object' && 'schema' in rawSchema ? rawSchema.schema : rawSchema)
  const revision = currentRevision(schema)
  if (!revision || !revision.snapshot) {
    throw new Error(`专家团队 Schema ${schema.id} 没有可用的冻结 revision`)
  }
  return buildPromptContext(schema, revision, {
    agentsMdPath: getAgentWorkspaceAgentsPath(workspace.slug),
  })
}

/** 主理人选择团队阵容时只读的轻量列表，不包含完整 prompt 内容。 */
interface ExpertTeamSchemaSummary {
  id: string
  name: string
  description?: string
  revision?: number
  nodeCount: number
}

async function listAvailableSchemas(): Promise<ExpertTeamSchemaSummary[]> {
  const raw = await requestPublic<unknown>('/api/expert-teams/schemas')
  const list = Array.isArray(raw)
    ? raw
    : isRecord(raw) && Array.isArray(raw.schemas)
      ? raw.schemas
      : []
  return list.flatMap((item): ExpertTeamSchemaSummary[] => {
    if (!isRecord(item) || typeof item.id !== 'string' || typeof item.name !== 'string') return []
    return [{
      id: item.id,
      name: item.name,
      ...(typeof item.description === 'string' && item.description ? { description: item.description } : {}),
      ...(typeof item.revision === 'number' ? { revision: item.revision } : {}),
      nodeCount: Array.isArray(item.nodes) ? item.nodes.length : 0,
    }]
  })
}

async function runExpertTeam(ctx: ExpertTeamToolContext, goal: string, schemaId: string | undefined, signal?: AbortSignal): Promise<ExpertTeamToolResult> {
  if ((ctx.triggeredBy ?? 'user') !== 'user') throw new Error('只有主 Agent 可以调度专家团队')
  if (!ctx.workspaceId || !ctx.workspaceSlug) throw new Error('调度专家团队需要当前工作区')
  const workspace = getAgentWorkspace(ctx.workspaceId)
  if (!workspace || workspace.slug !== ctx.workspaceSlug) throw new Error('当前工作区不存在或上下文不一致')

  // 冻结上下文：省略 schemaId 时优先使用 workspace binding；显式指定时按 Rust API 校验并读取 revision。
  const promptContext = schemaId
    ? await resolveExplicitSchemaContext(workspace, schemaId)
    : await resolveExpertTeamPromptContext({
      workspace,
      reader: new HttpExpertTeamContextReader(),
    })
  if (!promptContext) {
    throw new Error('当前工作区未绑定专家团队 Schema 或 schema 校验失败，无法调度专家团队')
  }
  const runPayload = await requestPublic<Record<string, unknown>>('/api/expert-teams/runs', {
    method: 'POST',
    body: JSON.stringify({
      schemaId: promptContext.schemaId,
      workspaceSlug: workspace.slug,
      ...(promptContext.schemaRevisionId !== undefined ? { schemaRevisionId: promptContext.schemaRevisionId } : {}),
      input: goal,
    }),
  })
  const run = (runPayload && typeof runPayload === 'object' && 'run' in runPayload)
    ? (runPayload as { run: Record<string, unknown> }).run
    : runPayload
  const runId = assertNonBlank(run.id, 'runId')
  // 回填主理人会话关联，让专家团队工作台的「继续对话」能定位到启动本次运行的会话。
  try {
    updateAgentSessionMeta(ctx.sessionId, {
      expertTeamSession: {
        runId,
        schemaId: promptContext.schemaId,
        ...(promptContext.schemaRevisionId !== undefined ? { schemaRevisionId: promptContext.schemaRevisionId } : {}),
      },
    })
  } catch (error) {
    console.error('[专家团队] 回填主理人会话关联失败:', error)
  }
  const nodes = promptContext.nodes.map((node) => {
    return {
      id: node.id,
      role: toNodeRole(node.role),
      task: `${node.task}\n\n用户目标：\n${goal}`,
      ...(node.dependsOn?.length ? { dependsOn: node.dependsOn } : {}),
      ...(node.outputPath ? { outputPath: node.outputPath } : {}),
      ...(node.allowNoArtifact ? { allowNoArtifact: true } : {}),
    }
  })
  const snapshot: ExpertTeamRunSnapshot = {
    runId,
    parentSessionId: ctx.sessionId,
    channelId: ctx.channelId,
    ...(ctx.modelId ? { modelId: ctx.modelId } : {}),
    workspaceId: ctx.workspaceId,
    nodes,
    expertTeamContext: promptContext,
  }
  const result = await new ExpertTeamRunner({
    workspaceRoot: getAgentWorkspaceWritableRoot(workspace),
    rustApi: new HttpExpertTeamRustApiClient(),
  }).run(snapshot, signal)
  const failed = result.nodes.some((node) => node.status === 'failed')
  const cancelled = result.nodes.some((node) => node.status === 'cancelled')
  return {
    runId,
    schemaId: promptContext.schemaId,
    ...(promptContext.revision !== undefined ? { schemaRevision: promptContext.revision } : {}),
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
  return [
    sdk.defineTool({
      name: 'expert_team_run',
      label: '调度专家团队',
      description: '由主 Agent 按需调度本地 Pi 专家团队。普通问答和简单任务不要调用；只有需要深入研究、总结成文档并由 reviewer 检验的完整工作流才调用。子 Agent 结果会回传给你，你必须自行汇总后再回复用户。',
      parameters: Type.Object({
        goal: Type.String({ description: '专家团队需要完成的完整目标' }),
        schemaId: Type.Optional(Type.String({ description: '团队 Schema ID；省略时使用当前工作区绑定的 Schema' })),
      }),
      async execute(toolCallId: string, params: unknown, signal?: AbortSignal) {
        const args = params as { goal?: unknown; schemaId?: unknown }
        const goal = assertNonBlank(args.goal, 'goal')
        if (goal.length > MAX_GOAL_LENGTH) throw new Error(`goal 不能超过 ${MAX_GOAL_LENGTH} 个字符`)
        const schemaId = args.schemaId === undefined ? undefined : assertNonBlank(args.schemaId, 'schemaId')
        const result = await expertTeamCalls.getOrCreate(
          ctx.sessionId,
          toolCallId,
          () => runExpertTeam(ctx, goal, schemaId, signal),
        )
        return jsonToolResult(result)
      },
    }) as unknown as ToolDefinition,
    sdk.defineTool({
      name: 'expert_team_list_schemas',
      label: '查看团队阵容',
      description: '列出当前可用的专家团队阵容（Schema），包含 ID、名称、说明、版本与岗位数量；由主理人结合用户需求选择阵容后，再调用 expert_team_run 创建并启动专家团队。',
      parameters: Type.Object({}),
      async execute() {
        const schemas = await listAvailableSchemas()
        return jsonToolResult(schemas)
      },
    }) as unknown as ToolDefinition,
    sdk.defineTool({
      name: 'expert_team_publish_schema',
      label: '发布自定义专家团队',
      description: '根据业务需求创建并发布一个新的自定义专家团队阵容（Schema），支持配置多个专业角色节点、Prompt 提示词、产物路径以及 DAG 依赖关系。可选自动绑定到当前工作区。发布成功后会自动通知前端工作台热更新。',
      parameters: Type.Object({
        name: Type.String({ description: '专家团队名称，如“全流程内容创作与审查团队”' }),
        description: Type.Optional(Type.String({ description: '团队整体职责和流程说明' })),
        nodes: Type.Array(Type.Object({
          id: Type.String({ description: '节点唯一标识，如 researcher、writer、reviewer' }),
          role: Type.String({ description: '岗位角色，支持 researcher/writer/reviewer/executor/explore/implement/custom 等' }),
          prompt: Type.Optional(Type.String({ description: '该节点的专项服务职责提示词' })),
          dependsOn: Type.Optional(Type.Array(Type.String(), { description: '依赖的前置节点 ID 列表' })),
          path: Type.Optional(Type.String({ description: '该节点输出的相对产物路径，如 report/research.md' })),
        }), { description: '专家团队包含的成员节点列表（1~32 个）' }),
        bindToCurrentWorkspace: Type.Optional(Type.Boolean({ description: '是否同时将该阵容绑定到当前工作区，默认为 true' })),
      }),
      async execute(_toolCallId: string, params: unknown) {
        const args = params as {
          name?: unknown
          description?: unknown
          nodes?: unknown
          bindToCurrentWorkspace?: unknown
        }
        const name = assertNonBlank(args.name, 'name')
        const description = typeof args.description === 'string' ? args.description.trim() : undefined
        if (!Array.isArray(args.nodes) || args.nodes.length === 0) {
          throw new Error('专家团队至少需要包含 1 个成员节点')
        }
        const nodes = args.nodes.map((item) => {
          if (!isRecord(item)) throw new Error('节点格式不正确')
          return {
            id: assertNonBlank(item.id, 'node.id'),
            role: assertNonBlank(item.role, 'node.role'),
            ...(typeof item.prompt === 'string' && item.prompt.trim() ? { prompt: item.prompt.trim() } : {}),
            ...(Array.isArray(item.dependsOn) ? { dependsOn: item.dependsOn.filter((d): d is string => typeof d === 'string') } : {}),
            ...(typeof item.path === 'string' && item.path.trim() ? { path: item.path.trim() } : {}),
          }
        })
        const published = await requestPublic<Record<string, unknown>>('/api/expert-teams/schemas', {
          method: 'POST',
          body: JSON.stringify({ name, description, nodes }),
        })
        const schemaId = assertNonBlank(published.id, 'published.id')
        const bind = args.bindToCurrentWorkspace !== false
        let bindingResult: unknown
        if (bind && ctx.workspaceId && ctx.workspaceSlug) {
          const workspace = getAgentWorkspace(ctx.workspaceId)
          if (workspace) {
            bindingResult = await requestPublic<Record<string, unknown>>(
              `/api/expert-teams/workspaces/${encodeURIComponent(workspace.slug)}/binding`,
              { method: 'POST', body: JSON.stringify({ schemaId }) },
            )
            await resolveExpertTeamPromptContext({
              workspace,
              reader: new HttpExpertTeamContextReader(),
            })
          }
        }
        broadcastExpertTeamsChanged()
        return jsonToolResult({
          published,
          boundToWorkspace: bind,
          binding: bindingResult,
        })
      },
    }) as unknown as ToolDefinition,
    sdk.defineTool({
      name: 'expert_team_bind_workspace',
      label: '绑定专家团队到工作区',
      description: '将指定的专家团队阵容绑定到当前工作区，并自动更新受管控 AGENTS.md 规范。绑定成功后会自动通知前端工作台热更新。',
      parameters: Type.Object({
        schemaId: Type.String({ description: '要绑定的专家团队阵容 ID' }),
      }),
      async execute(_toolCallId: string, params: unknown) {
        const args = params as { schemaId?: unknown }
        const schemaId = assertNonBlank(args.schemaId, 'schemaId')
        if (!ctx.workspaceId || !ctx.workspaceSlug) throw new Error('缺少当前工作区上下文')
        const workspace = getAgentWorkspace(ctx.workspaceId)
        if (!workspace) throw new Error('当前工作区不存在')
        const binding = await requestPublic<Record<string, unknown>>(
          `/api/expert-teams/workspaces/${encodeURIComponent(workspace.slug)}/binding`,
          { method: 'POST', body: JSON.stringify({ schemaId }) },
        )
        await resolveExpertTeamPromptContext({
          workspace,
          reader: new HttpExpertTeamContextReader(),
        })
        broadcastExpertTeamsChanged()
        return jsonToolResult({
          schemaId,
          workspaceSlug: workspace.slug,
          binding,
        })
      },
    }) as unknown as ToolDefinition,
  ]
}

export const expertTeamDefaultSchemaId = DEFAULT_SCHEMA_ID
