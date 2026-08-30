import { Type } from 'typebox'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { AgentToolResult } from '@earendil-works/pi-agent-core'
import type { MemoryKind, MemoryPolicy } from '@copis/shared'
import { runtimeMemoryApiClient, type MemoryApiClient } from '../memory-api-client-runtime'
import { memoryToolNamesForPolicy } from './memory-tool-policy'

type PiSdk = typeof import('@earendil-works/pi-coding-agent')

export interface PiMemoryToolsOptions {
  workspaceSlug?: string
  memoryPolicy?: MemoryPolicy
  memoryApiClient?: MemoryApiClient
}

function jsonToolResult(value: unknown): AgentToolResult<unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    details: value,
  } as AgentToolResult<unknown>
}

function isFiniteInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && Number.isFinite(value)
}

function assertNonBlank(value: string | undefined, field: string): string {
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`${field} 不能为空`)
  }
  return value.trim()
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new Error(`${field} 必须是字符串`)
  return assertNonBlank(value, field)
}

function memoryTags(value: unknown): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw new Error('tags 必须是字符串数组')
  return [...new Set(value.map((tag) => {
    if (typeof tag !== 'string') throw new Error('tags 必须是字符串数组')
    return tag.trim()
  }).filter(Boolean))]
}

function isMemoryKind(value: unknown): value is MemoryKind {
  return value === 'fact'
    || value === 'preference'
    || value === 'decision'
    || value === 'project'
    || value === 'scratch'
}

export function buildPiMemoryTools(sdk: PiSdk, options: PiMemoryToolsOptions = {}): ToolDefinition[] {
  const policy = options.memoryPolicy ?? 'writable'
  const memoryToolNames = memoryToolNamesForPolicy(policy)
  if (memoryToolNames.length === 0) return []

  const apiClient = options.memoryApiClient ?? runtimeMemoryApiClient
  const workspaceSlug = options.workspaceSlug

  const kindSchema = Type.String({
    enum: ['fact', 'preference', 'decision', 'project', 'scratch'],
    description: '记忆类型：fact（事实）、preference（偏好）、decision（决策）、project（项目经验）、scratch（临时经验）',
  })

  const tools: ToolDefinition[] = [
    sdk.defineTool({
      name: 'memory_recall',
      label: '检索记忆',
      description: '检索当前可见的 Copis 长期记忆。工作区会同时看到用户记忆和当前工作区记忆；没有工作区时只看到用户记忆。先检索，再按需读取完整内容。',
      parameters: Type.Object({
        query: Type.String({ description: '要检索的事实、偏好、决策或项目经验关键词' }),
        limit: Type.Optional(Type.Number({ description: '返回数量，默认 8，最大 8' })),
      }),
      async execute(_toolCallId: string, params: unknown, signal?: AbortSignal) {
        const args = params as { query?: unknown; limit?: unknown }
        const query = assertNonBlank(typeof args.query === 'string' ? args.query : undefined, 'query')
        const limit = args.limit === undefined ? undefined : args.limit
        if (limit !== undefined && (!isFiniteInt(limit) || limit < 1 || limit > 8)) {
          throw new Error('limit 必须是 1 到 8 之间的整数')
        }
        const response = await apiClient.recall({
          ...(workspaceSlug ? { workspaceSlug } : {}),
          query,
          ...(limit === undefined ? {} : { limit }),
        }, signal)
        return jsonToolResult(response)
      },
    }),
    sdk.defineTool({
      name: 'memory_read',
      label: '读取记忆',
      description: '读取一条已经通过 memory_recall 得到的当前可见 Copis 记忆的完整内容。不能读取其他工作区的记忆。',
      parameters: Type.Object({
        id: Type.String({ description: 'memory_recall 返回的记忆 ID' }),
      }),
      async execute(_toolCallId: string, params: unknown, signal?: AbortSignal) {
        const rawId = (params as { id?: unknown }).id
        const id = assertNonBlank(typeof rawId === 'string' ? rawId : undefined, 'id')
        const entry = await apiClient.read(id, workspaceSlug, signal)
        return jsonToolResult({ entry })
      },
    }),
  ] as unknown as ToolDefinition[]

  if (memoryToolNames.includes('memory_capture')) {
    tools.push(
      sdk.defineTool({
        name: 'memory_capture',
        label: '记录记忆',
        description: '把稳定、可复用且有足够证据的经验记录到当前工作区。scope 固定为当前工作区，不能写入其他工作区；没有工作区时不可写入。',
        parameters: Type.Object({
          title: Type.String({ description: '简短的记忆标题' }),
          content: Type.String({ description: '稳定、可复用的事实、偏好、决策或项目经验' }),
          kind: kindSchema,
          tags: Type.Optional(Type.Array(Type.String(), { description: '用于后续检索的标签' })),
        }),
        async execute(_toolCallId: string, params: unknown, signal?: AbortSignal) {
          if (!workspaceSlug) throw new Error('当前没有工作区，不能写入工作区记忆')
          const args = params as { title?: unknown; content?: unknown; kind?: unknown; tags?: unknown }
          const kind = args.kind
          if (!isMemoryKind(kind)) throw new Error('kind 参数不正确')
          const tags = memoryTags(args.tags)
          const response = await apiClient.capture({
            workspaceSlug,
            title: assertNonBlank(typeof args.title === 'string' ? args.title : undefined, 'title'),
            content: assertNonBlank(typeof args.content === 'string' ? args.content : undefined, 'content'),
            kind,
            ...(tags === undefined ? {} : { tags }),
          }, signal)
          return jsonToolResult(response)
        },
      }) as unknown as ToolDefinition,
    )
  }

  if (memoryToolNames.includes('memory_rewrite')) {
    tools.push(
      sdk.defineTool({
        name: 'memory_rewrite',
        label: '修订记忆',
        description: '修订当前工作区可见的 Copis 记忆。必须携带 memory_read 得到的 expectedRevision；发生冲突时先读取当前记录再重新判断，不能追加相反条目。',
        parameters: Type.Object({
          id: Type.String({ description: '要修订的记忆 ID' }),
          title: Type.Optional(Type.String({ description: '新的标题' })),
          content: Type.Optional(Type.String({ description: '新的记忆内容' })),
          tags: Type.Optional(Type.Array(Type.String(), { description: '新的标签数组；传空数组可清空标签' })),
          expectedRevision: Type.Number({ description: 'memory_read 返回的当前 revision' }),
        }),
        async execute(_toolCallId: string, params: unknown, signal?: AbortSignal) {
          if (!workspaceSlug) throw new Error('当前没有工作区，不能修订工作区记忆')
          const args = params as {
            id?: unknown
            title?: unknown
            content?: unknown
            tags?: unknown
            expectedRevision?: unknown
          }
          const expectedRevision = args.expectedRevision
          if (!isFiniteInt(expectedRevision) || expectedRevision < 1) {
            throw new Error('expectedRevision 必须是正整数')
          }
          const title = optionalString(args.title, 'title')
          const content = optionalString(args.content, 'content')
          const tags = memoryTags(args.tags)
          if (title === undefined && content === undefined && tags === undefined) {
            throw new Error('至少提供 title、content 或 tags 之一')
          }
          const id = assertNonBlank(typeof args.id === 'string' ? args.id : undefined, 'id')
          const entry = await apiClient.rewrite(id, {
            workspaceSlug,
            ...(title === undefined ? {} : { title }),
            ...(content === undefined ? {} : { content }),
            ...(tags === undefined ? {} : { tags }),
            expectedRevision,
          }, signal)
          return jsonToolResult({ entry })
        },
      }) as unknown as ToolDefinition,
    )
  }

  return tools
}
