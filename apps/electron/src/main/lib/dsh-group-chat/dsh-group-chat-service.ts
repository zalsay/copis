/**
 * DSH 群聊业务服务（DSH Group Chat Service）
 * 
 * 协调会话 CRUD、消息收发、任务看板维护、多 Agent 调度准备与实时事件推流。
 * 遵循与原生讨论室（chatroom）及 Agent 模式零交叉原则：
 * - 仅操作本地 DshGroupChatStore，严禁在 agent-sessions.json 中创建会话；
 * - 仅调用 DSH 创造模式工作区智能体，直接使用统一模型协议推流。
 */

import { existsSync, readFileSync } from 'node:fs'
import { join, basename } from 'node:path'
import { homedir } from 'node:os'
import { DshGroupChatStore } from './dsh-group-chat-store'
import { getDshHomeDir } from '../config-paths'
import {
  OpenAIResponsesAdapter,
  AnthropicAdapter,
  OpenAIAdapter,
  streamSSE,
} from '@copis/core'
import type {
  DshGroupChatDetail,
  DshGroupChatSummary,
  DshGroupChatMessage,
  DshGroupTaskBoard,
  DshGroupChatTask,
  DshGroupInvocation,
  DshCreateGroupInput,
  DshUpdateGroupInput,
  DshPostMessageInput,
  DshCreateTaskInput,
  DshUpdateTaskInput,
  DshDecomposeTaskInput,
  DshGroupChatAgent,
  DshGroupChatRealtimeEvent,
  DshCreationWorkspace,
} from '@copis/shared'
import type { ProviderHistoryMessage } from '@copis/core'

export type DshGroupChatEventListener = (event: DshGroupChatRealtimeEvent) => void

export interface DshGroupChatServiceDeps {
  store?: DshGroupChatStore
  streamFn?: (input: {
    systemPrompt: string
    prompt: string
    history: ProviderHistoryMessage[]
    signal?: AbortSignal
    onChunk: (text: string) => void
    onThinking?: (thoughts: string) => void
  }) => Promise<string>
  getSettings?: () => any
  getHttpApiInternalToken?: () => string | null
  listCreationWorkspaces?: () => DshCreationWorkspace[]
}

export class DshGroupChatService {
  private store: DshGroupChatStore
  private deps: DshGroupChatServiceDeps
  private eventListeners: Set<DshGroupChatEventListener> = new Set()
  private activeInvocations: Map<string, { abortController: AbortController }> = new Map()

  constructor(storeOrDeps?: DshGroupChatStore | DshGroupChatServiceDeps) {
    if (storeOrDeps instanceof DshGroupChatStore) {
      this.store = storeOrDeps
      this.deps = {}
    } else if (storeOrDeps && 'store' in storeOrDeps && storeOrDeps.store) {
      this.store = storeOrDeps.store
      this.deps = storeOrDeps
    } else {
      this.store = new DshGroupChatStore()
      this.deps = (storeOrDeps as DshGroupChatServiceDeps) || {}
    }
  }

  public addEventListener(listener: DshGroupChatEventListener): () => void {
    this.eventListeners.add(listener)
    return () => this.eventListeners.delete(listener)
  }

  private broadcast(event: DshGroupChatRealtimeEvent): void {
    for (const listener of this.eventListeners) {
      try {
        listener(event)
      } catch (err) {
        console.error('[DshGroupChatService] 事件广播异常:', err)
      }
    }
  }

  // ======================== 创造模式工作区管理 ========================

  /**
   * 读取 DSH 本地创造模式工作区列表（零交叉，不依赖 Agent 模式）
   */
  public static readLocalCreationWorkspaces(): DshCreationWorkspace[] {
    const candidatePaths = [
      join(getDshHomeDir(), 'storages', 'workspace.json'),
      join(homedir(), '.copis-dev', 'dsh', 'storages', 'workspace.json'),
      join(homedir(), '.copis', 'dsh', 'storages', 'workspace.json'),
    ]

    for (const filePath of candidatePaths) {
      try {
        if (existsSync(filePath)) {
          const content = readFileSync(filePath, 'utf8')
          const parsed = JSON.parse(content)
          const workspacesTable = parsed?.tables?.workspaces || {}
          const results: DshCreationWorkspace[] = []

          for (const [id, ws] of Object.entries<any>(workspacesTable)) {
            if (!ws) continue
            results.push({
              id,
              name: ws.title || (ws.path ? basename(ws.path) : id),
              path: ws.path || '',
              description: ws.description || `创造模式工作区: ${ws.title || id}`,
              sessionIds: Array.isArray(ws.sessionIds) ? ws.sessionIds : [],
              createdAt: ws.createdAt,
              updatedAt: ws.updatedAt,
            })
          }

          if (results.length > 0) {
            return results
          }
        }
      } catch (err) {
        console.warn(`[DshGroupChatService] 读取工作区文件异常 (${filePath}):`, err)
      }
    }

    // 兜底返回默认创造工作区
    return [
      {
        id: 'default',
        name: '默认工作区',
        path: join(getDshHomeDir(), 'workspace'),
        description: 'DSH 本地默认工作区空间',
        isDefault: true,
      },
    ]
  }

  public listCreationWorkspaces(): DshCreationWorkspace[] {
    if (this.deps.listCreationWorkspaces) {
      return this.deps.listCreationWorkspaces()
    }
    return DshGroupChatService.readLocalCreationWorkspaces()
  }

  // ======================== 群组与会话管理 ========================

  public listGroups(): DshGroupChatSummary[] {
    return this.store.listGroups()
  }

  public getGroup(groupId: string): DshGroupChatDetail | null {
    return this.store.getGroup(groupId)
  }

  public createGroup(input: DshCreateGroupInput): DshGroupChatDetail {
    const groupId = `grp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
    const now = new Date().toISOString()

    const members = (input.members || []).map((m) => ({
      userId: m.userId,
      displayName: m.displayName,
      role: m.role || 'member',
      joinedAt: now,
    }))

    // 默认如果 members 为空，添加当前所有者
    if (members.length === 0) {
      members.push({
        userId: 'local_user',
        displayName: '我',
        role: 'owner',
        joinedAt: now,
      })
    }

    const agents: DshGroupChatAgent[] = (input.agents || []).map((a) => ({
      agentId: a.agentId,
      name: a.name,
      responsibility: a.responsibility || '协作执行成员',
      isLeader: Boolean(a.isLeader),
      addedAt: now,
    }))

    const group: DshGroupChatDetail = {
      id: groupId,
      name: input.name,
      description: input.description,
      conversationKind: input.conversationKind || 'group',
      peerUserId: input.peerUserId,
      ownerUserId: 'local_user',
      status: 'active',
      role: 'owner',
      lastMessageSeq: 0,
      lastReadSeq: 0,
      taskRevision: 1,
      members,
      agents,
      createdAt: now,
      updatedAt: now,
      isTopPinned: false,
    }

    this.store.saveGroup(group)

    // 初始化任务看板
    this.store.saveTaskBoard(groupId, [], 1)

    this.broadcast({
      type: 'group_updated',
      groupId,
      group,
    })

    return group
  }

  public updateGroup(input: DshUpdateGroupInput): DshGroupChatDetail | null {
    const group = this.store.getGroup(input.groupId)
    if (!group) return null

    if (input.name !== undefined) group.name = input.name
    if (input.description !== undefined) group.description = input.description
    if (input.isTopPinned !== undefined) group.isTopPinned = input.isTopPinned
    if (input.notificationsMuted !== undefined) group.notificationsMuted = input.notificationsMuted
    if (input.status !== undefined) group.status = input.status

    group.updatedAt = new Date().toISOString()
    this.store.saveGroup(group)

    this.broadcast({
      type: 'group_updated',
      groupId: group.id,
      group,
    })

    return group
  }

  public deleteGroup(groupId: string): boolean {
    const success = this.store.deleteGroup(groupId)
    if (success) {
      this.broadcast({
        type: 'group_deleted',
        groupId,
      })
    }
    return success
  }

  public addAgent(groupId: string, agent: Omit<DshGroupChatAgent, 'addedAt'>): DshGroupChatDetail | null {
    const group = this.store.getGroup(groupId)
    if (!group) return null

    const existing = group.agents.find((a) => a.agentId === agent.agentId)
    if (!existing) {
      group.agents.push({
        ...agent,
        addedAt: new Date().toISOString(),
      })
      group.updatedAt = new Date().toISOString()
      this.store.saveGroup(group)
      this.broadcast({ type: 'group_updated', groupId, group })
    }
    return group
  }

  public removeAgent(groupId: string, agentId: string): DshGroupChatDetail | null {
    const group = this.store.getGroup(groupId)
    if (!group) return null

    group.agents = group.agents.filter((a) => a.agentId !== agentId)
    group.updatedAt = new Date().toISOString()
    this.store.saveGroup(group)
    this.broadcast({ type: 'group_updated', groupId, group })
    return group
  }

  public updateAgentResponsibility(groupId: string, agentId: string, responsibility: string): DshGroupChatDetail | null {
    const group = this.store.getGroup(groupId)
    if (!group) return null

    const target = group.agents.find((a) => a.agentId === agentId)
    if (target) {
      target.responsibility = responsibility
      target.responsibilityRevision = (target.responsibilityRevision || 0) + 1
      group.updatedAt = new Date().toISOString()
      this.store.saveGroup(group)
      this.broadcast({ type: 'group_updated', groupId, group })
    }
    return group
  }

  // ======================== 消息收发与未读管理 ========================

  public getMessages(groupId: string, limit = 50, beforeSeq?: number): DshGroupChatMessage[] {
    return this.store.getMessages(groupId, limit, beforeSeq)
  }

  public postMessage(input: DshPostMessageInput): DshGroupChatMessage {
    const group = this.store.getGroup(input.groupId)
    if (!group) {
      throw new Error(`群聊不存在: ${input.groupId}`)
    }

    const messageId = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
    const now = new Date().toISOString()

    const rawMessage: Omit<DshGroupChatMessage, 'seq'> = {
      id: messageId,
      groupId: input.groupId,
      kind: 'user',
      text: input.text,
      authorUserId: 'local_user',
      authorName: '我',
      agentId: null,
      agentName: null,
      replyToId: input.replyToId,
      quotes: input.quotes || [],
      attachments: input.attachments || [],
      mentions: input.mentions || [],
      createdAt: now,
    }

    const savedMessage = this.store.appendMessage(input.groupId, rawMessage)

    this.broadcast({
      type: 'message_created',
      groupId: input.groupId,
      message: savedMessage,
    })

    // 检查是否有智能体提及，异步派发回复执行
    if (group.agents.length > 0) {
      const isMentionAll =
        input.mentions?.some((m) => m.type === 'all' || m.name === '所有人' || m.name === 'all') ||
        input.text.includes('@所有人') ||
        input.text.includes('＠所有人') ||
        input.text.includes('@all')

      const targetAgents = isMentionAll
        ? group.agents
        : group.agents.filter(
            (a) =>
              input.mentions?.some((m) => m.type === 'agent' && (m.id === a.agentId || m.name === a.name)) ||
              input.text.includes(`@${a.name}`) ||
              input.text.includes(`＠${a.name}`)
          )

      if (targetAgents.length > 0) {
        void this.triggerAgentInvocations(group, savedMessage, targetAgents).catch((err) => {
          console.error('[DshGroupChatService] 触发智能体响应异常:', err)
        })
      }
    }

    return savedMessage
  }

  // ======================== 多 Agent 调度与执行 ========================

  private async triggerAgentInvocations(
    group: DshGroupChatDetail,
    triggerMessage: DshGroupChatMessage,
    agents: DshGroupChatAgent[],
  ): Promise<void> {
    for (const agent of agents) {
      await this.invokeAgent(group, triggerMessage, agent).catch((err) => {
        console.error(`[DshGroupChatService] 智能体「${agent.name}」协同异常:`, err)
      })
    }
  }

  private buildSystemPrompt(
    group: DshGroupChatDetail,
    agent: DshGroupChatAgent,
    workspace?: DshCreationWorkspace,
  ): string {
    const wsPath = workspace?.path || '未指定本地工作区路径'
    const wsName = workspace?.name || agent.name
    return `你正在 DSH 创造模式（DeepSeek Harness Creation Mode）的多智能体群聊协作空间「${group.name}」中协同工作。
你的角色：${agent.name}
当前关联的创造模式工作区：${wsName} (本地路径: ${wsPath})
你的专业定位与职责：${agent.responsibility || '工作区专业协同与技术方案落地'}
${agent.isLeader ? '★ 你是当前群聊的主控 Leader，负责整体方案统筹、技术把控与任务分工。' : ''}

【协作准则】
1. 保持专业、精炼、有逻辑性，结合工作区业务实际，给出高价值的分析与可落地的实施路径；
2. 尊重群聊中的其他智能体成员与用户，紧密配合任务看板的分工与推进；
3. 输出格式清晰，重要结论与代码片段使用规范 Markdown 排版。`
  }

  private buildHistoryMessages(
    group: DshGroupChatDetail,
    triggerMessage: DshGroupChatMessage,
    agent: DshGroupChatAgent,
  ): ProviderHistoryMessage[] {
    const recent = this.store.getMessages(group.id, 20)
    const history: ProviderHistoryMessage[] = []
    for (const msg of recent) {
      if (msg.id === triggerMessage.id) continue
      if (msg.kind === 'agent' && msg.agentId === agent.agentId) {
        history.push({
          role: 'assistant',
          content: msg.text,
        })
      } else {
        const sender = msg.kind === 'user' ? (msg.authorName || '用户') : (msg.agentName || '群友')
        history.push({
          role: 'user',
          content: `[${sender}]: ${msg.text}`,
        })
      }
    }
    return history
  }

  private async executeCreationStream(
    _group: DshGroupChatDetail,
    _agent: DshGroupChatAgent,
    prompt: string,
    history: ProviderHistoryMessage[],
    systemPrompt: string,
    signal: AbortSignal,
    onChunk: (chunk: string) => void,
    onThinking?: (thoughts: string) => void,
  ): Promise<string> {
    if (this.deps.streamFn) {
      return this.deps.streamFn({
        systemPrompt,
        prompt,
        history,
        signal,
        onChunk,
        onThinking,
      })
    }

    const { resolveDshUnifiedModelConfig } = await import('../dsh-model-config')
    const config = await resolveDshUnifiedModelConfig()

    let adapter: any
    if (config.protocol === 'openai-responses') {
      adapter = new OpenAIResponsesAdapter()
    } else if (config.protocol === 'anthropic-messages') {
      adapter = new AnthropicAdapter()
    } else {
      adapter = new OpenAIAdapter()
    }

    const request = adapter.buildStreamRequest({
      baseUrl: config.baseURL,
      apiKey: config.apiKey,
      modelId: config.defaultModelId,
      history,
      userMessage: prompt,
      systemMessage: systemPrompt,
      readImageAttachments: () => [],
      thinkingEnabled: true,
    })

    let fetchFn: typeof globalThis.fetch | undefined
    try {
      const { getEffectiveProxyUrl } = await import('../proxy-settings-service')
      const { getFetchFn } = await import('../proxy-fetch')
      const proxyUrl = await getEffectiveProxyUrl()
      fetchFn = getFetchFn(proxyUrl)
    } catch {
      fetchFn = globalThis.fetch
    }

    const sseResult = await streamSSE({
      request,
      adapter,
      signal,
      fetchFn,
      onEvent: (event: any) => {
        if (event.type === 'chunk') {
          onChunk(event.delta)
        } else if (event.type === 'reasoning') {
          onThinking?.(event.delta)
        }
      },
    })

    return sseResult.content
  }

  private async invokeAgent(
    group: DshGroupChatDetail,
    triggerMessage: DshGroupChatMessage,
    agent: DshGroupChatAgent,
  ): Promise<void> {
    const invocationId = `inv_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
    const workspaces = this.listCreationWorkspaces()
    const workspace = workspaces.find((w) => w.id === agent.agentId)

    const systemPrompt = this.buildSystemPrompt(group, agent, workspace)
    const history = this.buildHistoryMessages(group, triggerMessage, agent)
    const prompt = `[${triggerMessage.authorName || '用户'}]: ${triggerMessage.text}`

    const invocation: DshGroupInvocation = {
      id: invocationId,
      groupId: group.id,
      agentId: agent.agentId,
      agentName: agent.name,
      triggerMessageId: triggerMessage.id,
      callerUserId: triggerMessage.authorUserId || 'local-user',
      callerName: triggerMessage.authorName || '用户',
      status: 'running',
      prompt,
      createdAt: new Date().toISOString(),
    }
    this.store.saveInvocation(group.id, invocation)
    this.broadcast({
      type: 'invocation_started',
      groupId: group.id,
      invocation,
    })

    const abortController = new AbortController()
    this.activeInvocations.set(invocationId, { abortController })

    let accumulatedText = ''
    let executionError: string | null = null

    try {
      const result = await this.executeCreationStream(
        group,
        agent,
        prompt,
        history,
        systemPrompt,
        abortController.signal,
        (chunk) => {
          accumulatedText += chunk
          this.broadcast({
            type: 'invocation_progress',
            groupId: group.id,
            invocationId,
            delta: chunk,
          })
        },
        (thinking) => {
          this.broadcast({
            type: 'invocation_progress',
            groupId: group.id,
            invocationId,
            delta: '',
            thoughts: thinking,
          })
        }
      )
      if (!accumulatedText.trim() && result) {
        accumulatedText = result
      }

      invocation.status = 'completed'
      invocation.completedAt = new Date().toISOString()
      this.store.saveInvocation(group.id, invocation)
      this.broadcast({
        type: 'invocation_completed',
        groupId: group.id,
        invocation,
      })
    } catch (err) {
      executionError = err instanceof Error ? err.message : String(err)
      console.error(`[DshGroupChatService] Agent「${agent.name}」协同异常:`, err)
      invocation.status = 'failed'
      invocation.error = executionError
      invocation.completedAt = new Date().toISOString()
      this.store.saveInvocation(group.id, invocation)
      this.broadcast({
        type: 'invocation_failed',
        groupId: group.id,
        invocationId,
        error: executionError,
      })
    } finally {
      this.activeInvocations.delete(invocationId)
    }

    // 构造并保存 Agent 回复消息
    const replyText = accumulatedText.trim()
    if (replyText) {
      const agentMsg: Omit<DshGroupChatMessage, 'seq'> = {
        id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        groupId: group.id,
        kind: 'agent',
        text: replyText,
        authorUserId: null,
        authorName: null,
        agentId: agent.agentId,
        agentName: agent.name,
        replyToId: triggerMessage.id,
        quotes: [
          {
            messageId: triggerMessage.id,
            authorName: triggerMessage.authorName || '我',
            text: triggerMessage.text,
          },
        ],
        mentions: [],
        createdAt: new Date().toISOString(),
      }
      const savedAgentMessage = this.store.appendMessage(group.id, agentMsg)
      this.broadcast({
        type: 'message_created',
        groupId: group.id,
        message: savedAgentMessage,
      })
    } else if (executionError) {
      const errorMsg: Omit<DshGroupChatMessage, 'seq'> = {
        id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        groupId: group.id,
        kind: 'system',
        text: `⚠️ 智能体「${agent.name}」响应失败: ${executionError}`,
        authorUserId: null,
        authorName: '系统',
        agentId: agent.agentId,
        agentName: agent.name,
        replyToId: triggerMessage.id,
        mentions: [],
        createdAt: new Date().toISOString(),
      }
      const savedErrorMsg = this.store.appendMessage(group.id, errorMsg)
      this.broadcast({
        type: 'message_created',
        groupId: group.id,
        message: savedErrorMsg,
      })
    }
  }

  public async stopInvocation(groupId: string, invocationId: string): Promise<boolean> {
    const active = this.activeInvocations.get(invocationId)
    if (active) {
      active.abortController.abort()
      this.activeInvocations.delete(invocationId)
    }

    const invocation = this.store.getInvocation(groupId, invocationId)
    if (invocation && invocation.status === 'running') {
      invocation.status = 'stopped'
      invocation.completedAt = new Date().toISOString()
      this.store.saveInvocation(groupId, invocation)
      this.broadcast({
        type: 'invocation_completed',
        groupId,
        invocation,
      })
      return true
    }
    return false
  }

  public markRead(groupId: string, readSeq: number): void {
    this.store.markRead(groupId, readSeq)
  }

  // ======================== 任务看板 ========================

  public getTasks(groupId: string): DshGroupTaskBoard {
    return this.store.getTaskBoard(groupId)
  }

  public createTask(input: DshCreateTaskInput): DshGroupTaskBoard {
    const current = this.store.getTaskBoard(input.groupId)
    const nextNumber = current.tasks.length + 1
    const now = new Date().toISOString()

    const newTask: DshGroupChatTask = {
      id: `task_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      groupId: input.groupId,
      number: nextNumber,
      parentId: input.parentId || null,
      title: input.title,
      description: input.description || '',
      status: input.status || 'todo',
      assignee: input.assignee || null,
      dependsOn: input.dependsOn || [],
      revision: current.revision + 1,
      createdByUserId: 'local_user',
      createdByAgentId: null,
      updatedByUserId: 'local_user',
      updatedByAgentId: null,
      createdAt: now,
      updatedAt: now,
    }

    const res = this.store.saveTaskBoard(input.groupId, [...current.tasks, newTask], input.expectedRevision)
    if (!res.success) {
      throw new Error(res.error || '创建任务失败')
    }

    this.broadcast({
      type: 'tasks_updated',
      groupId: input.groupId,
      board: res.board,
    })

    return res.board
  }

  public updateTask(input: DshUpdateTaskInput): DshGroupTaskBoard {
    const current = this.store.getTaskBoard(input.groupId)
    const index = current.tasks.findIndex((t) => t.id === input.taskId)
    const targetTask = index >= 0 ? current.tasks[index] : undefined
    if (!targetTask) {
      throw new Error(`任务不存在: ${input.taskId}`)
    }

    const task: DshGroupChatTask = {
      ...targetTask,
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.assignee !== undefined ? { assignee: input.assignee } : {}),
      ...(input.dependsOn !== undefined ? { dependsOn: input.dependsOn } : {}),
      ...(input.result !== undefined ? { result: input.result } : {}),
      updatedAt: new Date().toISOString(),
    }

    const updatedTasks = [...current.tasks]
    updatedTasks[index] = task

    const res = this.store.saveTaskBoard(input.groupId, updatedTasks, input.expectedRevision)
    if (!res.success) {
      throw new Error(res.error || '更新任务失败')
    }

    this.broadcast({
      type: 'tasks_updated',
      groupId: input.groupId,
      board: res.board,
    })

    return res.board
  }

  public decomposeTasks(input: DshDecomposeTaskInput): DshGroupTaskBoard {
    const current = this.store.getTaskBoard(input.groupId)
    let nextNumber = current.tasks.length + 1
    const now = new Date().toISOString()

    const newTasks: DshGroupChatTask[] = input.tasks.map((item) => ({
      id: `task_${Date.now()}_${Math.random().toString(36).slice(2, 6)}_${nextNumber}`,
      groupId: input.groupId,
      number: nextNumber++,
      parentId: input.parentTaskId || null,
      title: item.title,
      description: item.description || '',
      status: item.status || 'todo',
      assignee: item.assignee || null,
      dependsOn: item.dependsOn || [],
      revision: current.revision + 1,
      createdByUserId: 'local_user',
      createdByAgentId: null,
      updatedByUserId: 'local_user',
      updatedByAgentId: null,
      createdAt: now,
      updatedAt: now,
    }))

    const res = this.store.saveTaskBoard(input.groupId, [...current.tasks, ...newTasks], input.expectedRevision)
    if (!res.success) {
      throw new Error(res.error || '分解任务失败')
    }

    this.broadcast({
      type: 'tasks_updated',
      groupId: input.groupId,
      board: res.board,
    })

    return res.board
  }

  public archiveTask(groupId: string, taskId: string): DshGroupTaskBoard {
    const current = this.store.getTaskBoard(groupId)
    const task = current.tasks.find((t) => t.id === taskId)
    if (!task) {
      throw new Error(`任务不存在: ${taskId}`)
    }

    task.archivedAt = new Date().toISOString()
    const res = this.store.saveTaskBoard(groupId, current.tasks)
    this.broadcast({
      type: 'tasks_updated',
      groupId,
      board: res.board,
    })
    return res.board
  }

  // ======================== 执行轨迹下钻快照 ========================

  public getInvocation(groupId: string, invocationId: string): DshGroupInvocation | null {
    return this.store.getInvocation(groupId, invocationId)
  }
}
