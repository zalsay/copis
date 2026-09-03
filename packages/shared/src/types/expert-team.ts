/** 专家团队工作台与本地 Rust HTTP API 共用的数据协议。 */

export type ExpertTeamRunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
export type ExpertTeamNodeStatus = 'pending' | 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'skipped'

export interface ExpertTeamNode {
  id: string
  name: string
  description?: string
  role?: 'researcher' | 'writer' | 'reviewer' | 'executor' | string
  agentId?: string
  model?: string
  prompt?: string
  dependsOn?: string[]
  path?: string
  config?: Record<string, unknown>
}

export interface ExpertTeamEdge {
  from: string
  to: string
  label?: string
  condition?: string
}

export interface ExpertTeamSchema {
  id: string
  name: string
  description?: string
  version?: string
  nodes: ExpertTeamNode[]
  edges: ExpertTeamEdge[]
  metadata?: Record<string, unknown>
  currentRevisionId?: number
  revision?: number
  sha256?: string
  createdAt?: number | string
  updatedAt?: number | string
  revisions?: ExpertTeamSchemaRevision[]
}

export interface ExpertTeamSchemaRevision {
  id: number
  revision: number
  sha256?: string
  snapshot?: ExpertTeamSchema
  createdAt?: number | string
}

export interface ExpertTeamPublishSchemaNodeInput {
  id: string
  role: 'researcher' | 'writer' | 'reviewer' | 'executor' | string
  prompt?: string
  dependsOn?: string[]
  path?: string
  config?: Record<string, unknown>
}

export interface ExpertTeamPublishSchemaInput {
  id?: string
  name: string
  description?: string
  nodes: ExpertTeamPublishSchemaNodeInput[]
  metadata?: Record<string, unknown>
}

export interface ExpertTeamValidateSchemaResult {
  valid: boolean
  nodeCount: number
  edges: ExpertTeamEdge[]
}

export interface ExpertTeamWorkspaceBinding {
  workspaceSlug: string
  schemaId: string
  schemaRevisionId?: number
  revision?: number
  sha256?: string
  boundAt?: number | string
  updatedAt?: number | string
}

export interface ExpertTeamNodeState {
  nodeId: string
  status: ExpertTeamNodeStatus
  message?: string
  startedAt?: string
  completedAt?: string
  error?: string
}

export interface ExpertTeamRun {
  id: string
  schemaId: string
  workspaceSlug: string
  status: ExpertTeamRunStatus
  input?: unknown
  nodeStates?: ExpertTeamNodeState[]
  error?: string
  schemaRevisionId?: number
  schemaRevision?: number
  schemaSha256?: string
  canceledAt?: number | string
  createdAt: number | string
  startedAt?: number | string
  completedAt?: number | string
  updatedAt?: number | string
}

export interface ExpertTeamRunEvent {
  id: string | number
  runId?: string
  type: string
  nodeId?: string
  status?: ExpertTeamNodeStatus
  message?: string
  data?: Record<string, unknown>
  timestamp: number | string
  sequence?: number
}

export interface ExpertTeamArtifact {
  id: string | number
  runId: string
  nodeId?: string
  name: string
  mimeType?: string
  size?: number
  path?: string
  content?: string
  sha256?: string
  createdAt: number | string
}

export interface ExpertTeamCreateRunInput {
  schemaId: string
  workspaceSlug: string
  schemaRevision?: number
  schemaRevisionId?: number
  input: unknown
}

export interface ExpertTeamBindWorkspaceInput {
  schemaId: string
  schemaRevision?: number
  schemaRevisionId?: number
}

export interface ExpertTeamSchemasResponse {
  schemas: ExpertTeamSchema[]
}

export interface ExpertTeamRunsResponse {
  runs: ExpertTeamRun[]
}

export interface ExpertTeamEventsResponse {
  events: ExpertTeamRunEvent[]
}

export interface ExpertTeamArtifactsResponse {
  artifacts: ExpertTeamArtifact[]
}

/**
 * 进入主 Agent system prompt 与专家节点子会话的冻结上下文。
 * 只接受主进程基于 Rust 返回的 binding/schema revision 生成的对象；
 * renderer 提交的同名字段会被 RPC parser 忽略。
 */
export interface ExpertTeamPromptNode {
  /** 节点 ID（如 researcher） */
  id: string
  /** 节点角色（researcher / writer / reviewer / executor 等） */
  role: string
  /** 冻结后的节点任务文本，运行时不得由 renderer 或子 Agent 改写 */
  task: string
  /** 依赖的前序节点 ID */
  dependsOn?: string[]
  /** 相对该节点输出目录的声明产物路径 */
  outputPath?: string
  /** 允许显式无产物完成 */
  allowNoArtifact?: boolean
}

/** 主进程生成、跨 IPC/主进程/子 Agent 传递的专家团队提示词上下文。 */
export interface ExpertTeamPromptContext {
  schemaId: string
  schemaRevisionId?: number
  /** schema 版本号（Rust revision） */
  revision?: number
  /** Rust 冻结 revision 的 sha256（64 位 hex） */
  sha256: string
  schemaName: string
  schemaDescription?: string
  /** 规范化后的冻结节点数组 */
  nodes: ExpertTeamPromptNode[]
  /** 工作区受控 AGENTS.md 的绝对路径（不写入用户项目根目录） */
  agentsMdPath: string
  /** 由 Copis 标记包围的受管控 AGENTS.md 区块内容 */
  agentsMdContent: string
  /** 子 Agent 运行时填充为当前节点 ID；主 Agent 上下文中缺省 */
  nodeId?: string
}
