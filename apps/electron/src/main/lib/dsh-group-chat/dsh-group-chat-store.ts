/**
 * DSH 群聊本地文件存储引擎（Local-First Storage Engine）
 * 
 * 存储布局：
 * ~/.copis/dsh-group-chats/
 * ├── manifest.json              # 全部群聊元数据汇总
 * └── {groupId}/
 *     ├── group.json             # 群详情、成员、Agent与岗位职责
 *     ├── messages.jsonl         # 顺序追加消息流
 *     ├── tasks.json             # 任务看板（带乐观锁 revision）
 *     ├── invocations/           # 智能体执行过程透明化快照
 *     │   └── {invocationId}.json
 *     └── chatspace/             # 群专属受限文件空间
 *         ├── uploads/
 *         └── outputs/
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { getDshGroupChatsDir, getDshGroupChatDir } from '../config-paths'
import type {
  DshGroupChatDetail,
  DshGroupChatSummary,
  DshGroupChatMessage,
  DshGroupChatTask,
  DshGroupTaskBoard,
  DshGroupInvocation,
} from '@copis/shared'

export interface DshGroupChatStoreOptions {
  baseDir?: string
}

export class DshGroupChatStore {
  private baseDir: string

  constructor(options: DshGroupChatStoreOptions = {}) {
    this.baseDir = options.baseDir || getDshGroupChatsDir()
    this.ensureBaseDir()
  }

  private ensureBaseDir(): void {
    if (!existsSync(this.baseDir)) {
      mkdirSync(this.baseDir, { recursive: true })
    }
  }

  private getManifestPath(): string {
    return join(this.baseDir, 'manifest.json')
  }

  private getGroupDir(groupId: string): string {
    const dir = join(this.baseDir, groupId)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
    return dir
  }

  private getGroupConfigPath(groupId: string): string {
    return join(this.getGroupDir(groupId), 'group.json')
  }

  private getMessagesPath(groupId: string): string {
    return join(this.getGroupDir(groupId), 'messages.jsonl')
  }

  private getTasksPath(groupId: string): string {
    return join(this.getGroupDir(groupId), 'tasks.json')
  }

  private getInvocationsDir(groupId: string): string {
    const dir = join(this.getGroupDir(groupId), 'invocations')
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
    return dir
  }

  public getChatspaceUploadsDir(groupId: string): string {
    const dir = join(this.getGroupDir(groupId), 'chatspace', 'uploads')
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
    return dir
  }

  public getChatspaceOutputsDir(groupId: string): string {
    const dir = join(this.getGroupDir(groupId), 'chatspace', 'outputs')
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
    return dir
  }

  // ======================== Manifest 管理 ========================

  public listGroups(): DshGroupChatSummary[] {
    const manifestPath = this.getManifestPath()
    if (!existsSync(manifestPath)) {
      return []
    }
    try {
      const content = readFileSync(manifestPath, 'utf-8')
      const groups = JSON.parse(content) as DshGroupChatSummary[]
      // 按置顶降序、活跃时间降序排序
      return groups.sort((a, b) => {
        if (Boolean(a.isTopPinned) !== Boolean(b.isTopPinned)) {
          return a.isTopPinned ? -1 : 1
        }
        return new Date(b.activityAt || b.updatedAt).getTime() - new Date(a.activityAt || a.updatedAt).getTime()
      })
    } catch (err) {
      console.error('[DshGroupChatStore] 读取 manifest.json 失败:', err)
      return []
    }
  }

  public saveManifest(groups: DshGroupChatSummary[]): void {
    const manifestPath = this.getManifestPath()
    const tmpPath = `${manifestPath}.tmp`
    writeFileSync(tmpPath, JSON.stringify(groups, null, 2), 'utf-8')
    writeFileSync(manifestPath, JSON.stringify(groups, null, 2), 'utf-8')
  }

  // ======================== 群组详情 CRUD ========================

  public getGroup(groupId: string): DshGroupChatDetail | null {
    const configPath = this.getGroupConfigPath(groupId)
    if (!existsSync(configPath)) {
      return null
    }
    try {
      const content = readFileSync(configPath, 'utf-8')
      return JSON.parse(content) as DshGroupChatDetail
    } catch (err) {
      console.error(`[DshGroupChatStore] 读取 group.json (${groupId}) 失败:`, err)
      return null
    }
  }

  public saveGroup(group: DshGroupChatDetail): void {
    const configPath = this.getGroupConfigPath(group.id)
    writeFileSync(configPath, JSON.stringify(group, null, 2), 'utf-8')

    // 确保 chatspace 目录存在
    this.getChatspaceUploadsDir(group.id)
    this.getChatspaceOutputsDir(group.id)

    // 同步更新 Manifest
    const groups = this.listGroups()
    const index = groups.findIndex((g) => g.id === group.id)
    const summary: DshGroupChatSummary = {
      id: group.id,
      name: group.name,
      description: group.description,
      conversationKind: group.conversationKind,
      peerUserId: group.peerUserId,
      status: group.status,
      role: group.role,
      lastMessageSeq: group.lastMessageSeq,
      lastReadSeq: group.lastReadSeq,
      unreadCount: Math.max(0, group.lastMessageSeq - group.lastReadSeq),
      hasMention: false,
      memberCount: group.members.length,
      agentCount: group.agents.length,
      updatedAt: group.updatedAt,
      activityAt: group.updatedAt,
      isTopPinned: group.isTopPinned,
    }

    const existingSummary = index >= 0 ? groups[index] : undefined
    if (existingSummary) {
      // 保留已有的 lastMessage 与 hasMention 标记
      summary.lastMessage = existingSummary.lastMessage
      summary.hasMention = existingSummary.hasMention
      groups[index] = summary
    } else {
      groups.push(summary)
    }

    this.saveManifest(groups)
  }

  public deleteGroup(groupId: string): boolean {
    const group = this.getGroup(groupId)
    if (!group) return false

    // 软标记为 archived 或从 manifest 移除
    const groups = this.listGroups().filter((g) => g.id !== groupId)
    this.saveManifest(groups)
    return true
  }

  // ======================== 消息流追加与分页读取 ========================

  public getMessages(groupId: string, limit = 50, beforeSeq?: number): DshGroupChatMessage[] {
    const messagesPath = this.getMessagesPath(groupId)
    if (!existsSync(messagesPath)) {
      return []
    }

    try {
      const content = readFileSync(messagesPath, 'utf-8')
      const lines = content.split('\n').filter((line) => line.trim().length > 0)
      const messages: DshGroupChatMessage[] = []

      for (const line of lines) {
        try {
          const msg = JSON.parse(line) as DshGroupChatMessage
          if (beforeSeq === undefined || msg.seq < beforeSeq) {
            messages.push(msg)
          }
        } catch {
          // 忽略格式损坏的单行
        }
      }

      // 如果超出 limit，取最近的 limit 条（按 seq 升序）
      if (messages.length > limit) {
        return messages.slice(messages.length - limit)
      }
      return messages
    } catch (err) {
      console.error(`[DshGroupChatStore] 读取 messages.jsonl (${groupId}) 失败:`, err)
      return []
    }
  }

  public appendMessage(groupId: string, message: Omit<DshGroupChatMessage, 'seq'>): DshGroupChatMessage {
    const group = this.getGroup(groupId)
    if (!group) {
      throw new Error(`群聊不存在: ${groupId}`)
    }

    const nextSeq = (group.lastMessageSeq || 0) + 1
    const fullMessage: DshGroupChatMessage = {
      ...message,
      seq: nextSeq,
    }

    const messagesPath = this.getMessagesPath(groupId)
    appendFileSync(messagesPath, `${JSON.stringify(fullMessage)}\n`, 'utf-8')

    // 更新 group 状态
    group.lastMessageSeq = nextSeq
    group.updatedAt = fullMessage.createdAt
    this.saveGroup(group)

    // 更新 manifest 中的最新消息摘要
    const groups = this.listGroups()
    const target = groups.find((g) => g.id === groupId)
    if (target) {
      target.lastMessageSeq = nextSeq
      target.activityAt = fullMessage.createdAt
      target.lastMessage = {
        text: fullMessage.text.slice(0, 80),
        authorName: fullMessage.authorName || fullMessage.agentName || '未知',
        createdAt: fullMessage.createdAt,
      }
      this.saveManifest(groups)
    }

    return fullMessage
  }

  public markRead(groupId: string, readSeq: number): void {
    const group = this.getGroup(groupId)
    if (!group) return

    group.lastReadSeq = Math.max(group.lastReadSeq || 0, readSeq)
    this.saveGroup(group)
  }

  // ======================== 任务看板与乐观锁版本控制 ========================

  public getTaskBoard(groupId: string): DshGroupTaskBoard {
    const tasksPath = this.getTasksPath(groupId)
    if (!existsSync(tasksPath)) {
      return { revision: 1, tasks: [] }
    }

    try {
      const content = readFileSync(tasksPath, 'utf-8')
      return JSON.parse(content) as DshGroupTaskBoard
    } catch (err) {
      console.error(`[DshGroupChatStore] 读取 tasks.json (${groupId}) 失败:`, err)
      return { revision: 1, tasks: [] }
    }
  }

  public saveTaskBoard(
    groupId: string,
    tasks: DshGroupChatTask[],
    expectedRevision?: number
  ): { success: boolean; board: DshGroupTaskBoard; error?: string } {
    const currentBoard = this.getTaskBoard(groupId)

    if (expectedRevision !== undefined && expectedRevision !== currentBoard.revision) {
      return {
        success: false,
        board: currentBoard,
        error: `版本冲突：当前看板版本为 ${currentBoard.revision}，期望版本为 ${expectedRevision}`,
      }
    }

    const nextRevision = currentBoard.revision + 1
    const updatedBoard: DshGroupTaskBoard = {
      revision: nextRevision,
      tasks: tasks.map((t) => ({ ...t, revision: nextRevision })),
    }

    const tasksPath = this.getTasksPath(groupId)
    writeFileSync(tasksPath, JSON.stringify(updatedBoard, null, 2), 'utf-8')

    // 同步到群组配置的 taskRevision
    const group = this.getGroup(groupId)
    if (group) {
      group.taskRevision = nextRevision
      group.updatedAt = new Date().toISOString()
      this.saveGroup(group)
    }

    return {
      success: true,
      board: updatedBoard,
    }
  }

  // ======================== 执行轨迹下钻快照 ========================

  public getInvocation(groupId: string, invocationId: string): DshGroupInvocation | null {
    const path = join(this.getInvocationsDir(groupId), `${invocationId}.json`)
    if (!existsSync(path)) return null
    try {
      return JSON.parse(readFileSync(path, 'utf-8')) as DshGroupInvocation
    } catch {
      return null
    }
  }

  public saveInvocation(groupId: string, invocation: DshGroupInvocation): void {
    const path = join(this.getInvocationsDir(groupId), `${invocation.id}.json`)
    writeFileSync(path, JSON.stringify(invocation, null, 2), 'utf-8')
  }
}
