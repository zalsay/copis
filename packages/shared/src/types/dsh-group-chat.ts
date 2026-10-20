/**
 * DSH（DeepSeek Harness / 创造模式）专属多智能体群聊协作类型定义与 IPC 通道常量。
 * 
 * 严格遵循“零交叉物理隔离原则（Zero-Intersection Principle）”：
 * 本模块与 Copis 原生的远程讨论室（chatroom）完全隔离，仅服务于 DSH 内部的本地多 Agent 协同。
 */

export type DshGroupChatRole = 'owner' | 'admin' | 'member'

export type DshConversationKind = 'group' | 'direct'

export interface DshGroupChatAttachment {
  id: string
  name: string
  path: string
  size: number
  contentType: string
  previewUrl?: string
  storageKind?: 'local' | 'chatspace'
}

export type DshGroupChatMessageKind = 'user' | 'agent' | 'system'

export type DshGroupChatMentionType = 'user' | 'all' | 'agent' | 'coagent'

export interface DshGroupChatMention {
  type: DshGroupChatMentionType
  id: string | null
  name?: string
}

export interface DshGroupChatQuote {
  messageId: string
  authorName: string
  text: string
  attachments?: DshGroupChatAttachment[]
}

export interface DshGroupChatMessage {
  id: string
  groupId: string
  seq: number
  kind: DshGroupChatMessageKind
  text: string
  authorUserId: string | null
  authorName: string | null
  agentId: string | null
  agentName: string | null
  triggeredByUserId?: string | null
  triggeredByName?: string | null
  replyToId?: string | null
  quotes?: DshGroupChatQuote[]
  attachments?: DshGroupChatAttachment[]
  mentions: DshGroupChatMention[]
  metadata?: Record<string, unknown>
  createdAt: string
}

export interface DshGroupChatMember {
  userId: string
  displayName: string
  avatar?: string
  role: DshGroupChatRole
  joinedAt: string
}

export interface DshGroupChatAgent {
  agentId: string
  name: string
  avatar?: string
  description?: string
  responsibility?: string
  responsibilityRevision?: number
  isLeader?: boolean
  executionMode?: 'draft' | 'published'
  currentVersion?: string | null
  addedAt: string
}

export interface DshGroupChatDetail {
  id: string
  name: string
  description?: string
  conversationKind: DshConversationKind
  peerUserId?: string
  ownerUserId: string | null
  status: 'active' | 'archived'
  role: DshGroupChatRole
  lastMessageSeq: number
  lastReadSeq: number
  taskRevision: number
  leaderResponsibility?: string
  leaderResponsibilityRevision?: number
  notificationsMuted?: boolean
  members: DshGroupChatMember[]
  agents: DshGroupChatAgent[]
  createdAt: string
  updatedAt: string
  isTopPinned?: boolean
}

export interface DshGroupChatSummary {
  id: string
  name: string
  description?: string
  conversationKind: DshConversationKind
  peerUserId?: string
  status: 'active' | 'archived'
  role: DshGroupChatRole
  lastMessageSeq: number
  lastReadSeq: number
  unreadCount: number
  hasMention: boolean
  memberCount: number
  agentCount: number
  updatedAt: string
  activityAt: string
  isTopPinned?: boolean
  lastMessage?: {
    text: string
    authorName?: string
    createdAt: string
  }
}

// ======================== 群任务看板 (Kanban) 相关类型 ========================

export type DshGroupTaskStatus = 'todo' | 'in_progress' | 'blocked' | 'done'

export interface DshGroupTaskAssignee {
  type: 'user' | 'agent' | 'coagent'
  id: string | null
  name?: string
}

export interface DshGroupChatTask {
  id: string
  groupId: string
  number: number
  parentId: string | null
  title: string
  description: string
  status: DshGroupTaskStatus
  assignee: DshGroupTaskAssignee | null
  dependsOn?: string[]
  result?: string
  execution?: {
    invocationId: string | null
    status: string
    callerUserId: string
  }
  revision: number
  createdByUserId: string | null
  createdByAgentId: string | null
  createdByAgentName?: string | null
  updatedByUserId: string | null
  updatedByAgentId: string | null
  updatedByAgentName?: string | null
  createdAt: string
  updatedAt: string
  archivedAt?: string | null
}

export interface DshGroupTaskBoard {
  revision: number
  tasks: DshGroupChatTask[]
  truncated?: boolean
}

// ======================== 执行轨迹与下钻相关类型 ========================

export interface DshGroupInvocationToolCall {
  name: string
  args: unknown
  result?: unknown
  durationMs?: number
  error?: string
}

export interface DshGroupInvocationOutputFile {
  path: string
  name: string
  size: number
}

export interface DshGroupInvocation {
  id: string
  groupId: string
  triggerMessageId: string
  agentId: string
  agentName: string
  callerUserId: string
  callerName: string
  status: 'admitting' | 'running' | 'completed' | 'failed' | 'stopped'
  executionState?: 'admitting' | 'queued' | 'running'
  prompt?: string
  thoughts?: string
  toolCalls?: DshGroupInvocationToolCall[]
  outputs?: DshGroupInvocationOutputFile[]
  tokens?: number
  durationMs?: number
  error?: string
  createdAt: string
  completedAt?: string
}

// ======================== IPC 请求与输入契约 ========================

export interface DshCreateGroupInput {
  name: string
  description?: string
  conversationKind?: DshConversationKind
  peerUserId?: string
  members?: Array<{ userId: string; displayName: string; role?: DshGroupChatRole }>
  agents?: Array<{ agentId: string; name: string; isLeader?: boolean; responsibility?: string }>
}

export interface DshUpdateGroupInput {
  groupId: string
  name?: string
  description?: string
  isTopPinned?: boolean
  notificationsMuted?: boolean
  status?: 'active' | 'archived'
}

export interface DshPostMessageInput {
  groupId: string
  text: string
  mentions?: DshGroupChatMention[]
  quotes?: DshGroupChatQuote[]
  attachments?: DshGroupChatAttachment[]
  replyToId?: string
}

export interface DshUpdateTaskInput {
  groupId: string
  taskId: string
  expectedRevision?: number
  title?: string
  description?: string
  status?: DshGroupTaskStatus
  assignee?: DshGroupTaskAssignee | null
  dependsOn?: string[]
  result?: string
}

export interface DshCreateTaskInput {
  groupId: string
  expectedRevision?: number
  parentId?: string | null
  title: string
  description?: string
  status?: DshGroupTaskStatus
  assignee?: DshGroupTaskAssignee | null
  dependsOn?: string[]
}

export interface DshDecomposeTaskInput {
  groupId: string
  parentTaskId?: string | null
  expectedRevision?: number
  tasks: Array<{
    title: string
    description?: string
    status?: DshGroupTaskStatus
    assignee?: DshGroupTaskAssignee | null
    dependsOn?: string[]
  }>
}

export interface DshGroupTaskMutationResult {
  success: boolean
  revision: number
  board: DshGroupTaskBoard
  error?: string
}

export interface DshCreationWorkspace {
  id: string
  name: string
  path: string
  description?: string
  sessionCount?: number
  sessionIds?: string[]
  isDefault?: boolean
  createdAt?: string
  updatedAt?: string
}

// ======================== IPC 事件通道常量 ========================

export const DSH_GROUP_CHAT_IPC_CHANNELS = {
  // 创造模式工作区智能体
  LIST_CREATION_WORKSPACES: 'dsh-group-chat:list-creation-workspaces',

  // 群组与会话管理
  LIST_GROUPS: 'dsh-group-chat:list-groups',
  GET_GROUP: 'dsh-group-chat:get-group',
  CREATE_GROUP: 'dsh-group-chat:create-group',
  UPDATE_GROUP: 'dsh-group-chat:update-group',
  DELETE_GROUP: 'dsh-group-chat:delete-group',
  ADD_AGENT: 'dsh-group-chat:add-agent',
  REMOVE_AGENT: 'dsh-group-chat:remove-agent',
  UPDATE_AGENT_RESPONSIBILITY: 'dsh-group-chat:update-agent-responsibility',

  // 消息收发与历史查询
  GET_MESSAGES: 'dsh-group-chat:get-messages',
  POST_MESSAGE: 'dsh-group-chat:post-message',
  MARK_READ: 'dsh-group-chat:mark-read',

  // 任务看板与协作
  GET_TASKS: 'dsh-group-chat:get-tasks',
  CREATE_TASK: 'dsh-group-chat:create-task',
  UPDATE_TASK: 'dsh-group-chat:update-task',
  DECOMPOSE_TASKS: 'dsh-group-chat:decompose-tasks',
  ARCHIVE_TASK: 'dsh-group-chat:archive-task',

  // 智能体执行轨迹与状态下钻
  GET_INVOCATION: 'dsh-group-chat:get-invocation',
  STOP_INVOCATION: 'dsh-group-chat:stop-invocation',

  // 实时推流与事件广播（渲染进程监听）
  EVENT_STREAM: 'dsh-group-chat:event-stream',
} as const

export type DshGroupChatRealtimeEvent =
  | { type: 'message_created'; groupId: string; message: DshGroupChatMessage }
  | { type: 'group_updated'; groupId: string; group: DshGroupChatDetail }
  | { type: 'group_deleted'; groupId: string }
  | { type: 'tasks_updated'; groupId: string; board: DshGroupTaskBoard }
  | { type: 'invocation_started'; groupId: string; invocation: DshGroupInvocation }
  | { type: 'invocation_progress'; groupId: string; invocationId: string; delta: string; thoughts?: string }
  | { type: 'invocation_completed'; groupId: string; invocation: DshGroupInvocation }
  | { type: 'invocation_failed'; groupId: string; invocationId: string; error: string }
