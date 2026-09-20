import { appendFileSync, chmodSync, existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  getChatRoomAgentPath,
  getChatRoomAgentSessionDir,
  getChatRoomAgentSessionMessagesPath,
  getChatRoomAgentSessionMetaPath,
  getChatRoomPath,
  getChatRoomsRootPath,
} from './config-paths'
import { writeJsonFileAtomic, writeTextFileAtomic } from './safe-file'
import {
  dedupeSDKMessagesForInternal,
  normalizePersistedSDKMessageForInternal,
  serializeSDKMessageForStorageForInternal,
  type AgentSessionMetaUpdates,
  type AgentSessionStorageOverride,
} from './agent-session-manager'
import { normalizeAttachedPaths } from './attached-paths'
import type { AgentMessage, AgentSessionMeta, SDKMessage, ChatRoomAgentLocalConfig } from '@copis/shared'

const PRIVATE_MODE = 0o600

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function assertRealDirectory(path: string, label: string): void {
  try {
    const stats = lstatSync(path)
    if (!stats.isDirectory()) throw new Error(`${label} 不是目录`)
  } catch (error) {
    if (error instanceof Error && error.message === `${label} 不是目录`) throw error
    throw new Error(`${label} 不可用`)
  }
}

function assertOptionalRegularFile(path: string, label: string): void {
  if (!existsSync(path)) return
  try {
    if (!lstatSync(path).isFile()) throw new Error(`${label} 不是文件`)
  } catch (error) {
    if (error instanceof Error && error.message === `${label} 不是文件`) throw error
    throw new Error(`${label} 不可用`)
  }
}

function readStrictJson(path: string, label: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown
  } catch {
    throw new Error(`${label} 损坏`)
  }
}

function assertValidMeta(value: unknown, config: ChatRoomAgentLocalConfig): asserts value is AgentSessionMeta {
  if (!isRecord(value)
    || value.id !== config.sessionId
    || typeof value.title !== 'string'
    || value.title.length === 0
    || typeof value.createdAt !== 'number'
    || !Number.isSafeInteger(value.createdAt)
    || typeof value.updatedAt !== 'number'
    || !Number.isSafeInteger(value.updatedAt)
    || value.updatedAt < value.createdAt
    || value.agentRuntime !== 'pi'
    || (value.channelId !== undefined && typeof value.channelId !== 'string')
    || (value.modelId !== undefined && typeof value.modelId !== 'string')
    || (value.workspaceId !== undefined && typeof value.workspaceId !== 'string')) {
    throw new Error('聊天室 Agent session 元数据损坏')
  }
}

function parseJsonlStrict<T>(path: string, label: string): T[] {
  const raw = readFileSync(path, 'utf8')
  const records: T[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      records.push(JSON.parse(line) as T)
    } catch {
      throw new Error(`${label} 损坏`)
    }
  }
  return records
}

/** 聊天室 Agent 的隐藏 session 后端，不参与公共 Agent 会话索引。 */
export class ChatRoomHiddenSessionStore implements AgentSessionStorageOverride {
  private readonly metaPath: string
  private readonly messagesPath: string
  private readonly config: ChatRoomAgentLocalConfig
  private mutating = false

  constructor(roomId: string, config: ChatRoomAgentLocalConfig, now: () => number = Date.now) {
    this.config = { ...config }
    const roomPath = getChatRoomPath(roomId)
    assertRealDirectory(getChatRoomsRootPath(), '聊天室根')
    assertRealDirectory(roomPath, '聊天室')
    assertRealDirectory(join(roomPath, 'agents'), '聊天室 Agent 根')
    assertRealDirectory(getChatRoomAgentPath(roomId, config.roomAgentId), '聊天室 Agent')
    const sessionsPath = getChatRoomAgentSessionDir(roomId, config.roomAgentId)
    assertRealDirectory(sessionsPath, '聊天室 Agent sessions')
    this.metaPath = getChatRoomAgentSessionMetaPath(roomId, config.roomAgentId)
    this.messagesPath = getChatRoomAgentSessionMessagesPath(roomId, config.roomAgentId)
    assertOptionalRegularFile(this.metaPath, '聊天室 Agent session 元数据')
    assertOptionalRegularFile(this.messagesPath, '聊天室 Agent session 消息')
    assertOptionalRegularFile(`${this.metaPath}.tmp`, '聊天室 Agent session 元数据临时文件')
    assertOptionalRegularFile(`${this.metaPath}.bak`, '聊天室 Agent session 元数据备份文件')
    if (existsSync(this.metaPath)) chmodSync(this.metaPath, PRIVATE_MODE)
    if (existsSync(this.messagesPath)) chmodSync(this.messagesPath, PRIVATE_MODE)

    const hasMeta = existsSync(this.metaPath)
    const hasMessages = existsSync(this.messagesPath)
    if (hasMeta) {
      const value = readStrictJson(this.metaPath, '聊天室 Agent session 元数据')
      assertValidMeta(value, this.config)
    } else if (hasMessages) {
      throw new Error('聊天室 Agent session 元数据缺失')
    } else {
      const timestamp = now()
      const meta: AgentSessionMeta = {
        id: config.sessionId,
        title: config.displayName,
        channelId: config.channelId,
        modelId: config.modelId,
        workspaceId: config.sourceWorkspaceId,
        agentCwdMode: 'project',
        agentRuntime: 'pi',
        workingMode: 'fast',
        createdAt: timestamp,
        updatedAt: timestamp,
      }
      this.writeMeta(meta)
    }
  }

  getMeta(): AgentSessionMeta {
    const value = readStrictJson(this.metaPath, '聊天室 Agent session 元数据')
    assertValidMeta(value, this.config)
    return value
  }

  updateMeta(updates: AgentSessionMetaUpdates): AgentSessionMeta {
    return this.withMutation(() => {
      const existing = this.getMeta()
      const normalizedUpdates = { ...updates }
      if (Object.prototype.hasOwnProperty.call(normalizedUpdates, 'attachedDirectories')) {
        normalizedUpdates.attachedDirectories = normalizeAttachedPaths(normalizedUpdates.attachedDirectories)
      }
      if (Object.prototype.hasOwnProperty.call(normalizedUpdates, 'attachedFiles')) {
        normalizedUpdates.attachedFiles = normalizeAttachedPaths(normalizedUpdates.attachedFiles)
      }
      const updateKeys = Object.keys(normalizedUpdates)
      const isStarredOnly = updateKeys.length > 0 && updateKeys.every((key) => key === 'starred')
      const isStoppedByUserOnly = updateKeys.length > 0 && updateKeys.every((key) => key === 'stoppedByUser')
      const autoUnarchive = existing.archived
        && !('archived' in normalizedUpdates)
        && !isStoppedByUserOnly
        && !isStarredOnly
      const updated: AgentSessionMeta = {
        ...existing,
        ...normalizedUpdates,
        ...(autoUnarchive ? { archived: false } : {}),
        updatedAt: isStarredOnly ? existing.updatedAt : Date.now(),
      }
      assertValidMeta(updated, this.config)
      this.writeMeta(updated)
      return updated
    })
  }

  getAgentMessages(): AgentMessage[] {
    if (!existsSync(this.messagesPath)) return []
    return parseJsonlStrict<AgentMessage>(this.messagesPath, '聊天室 Agent session 消息')
  }

  appendAgentMessage(message: AgentMessage): void {
    this.withMutation(() => {
      this.appendLine(JSON.stringify(message))
      const meta = this.getMeta()
      this.writeMeta({ ...meta, updatedAt: Date.now() })
    })
  }

  getSDKMessages(): SDKMessage[] {
    if (!existsSync(this.messagesPath)) return []
    const parsed = parseJsonlStrict<unknown>(this.messagesPath, '聊天室 Agent session 消息')
      .map(normalizePersistedSDKMessageForInternal)
    return dedupeSDKMessagesForInternal(parsed)
  }

  appendSDKMessages(messages: SDKMessage[]): void {
    if (messages.length === 0) return
    this.withMutation(() => {
      for (const message of messages) {
        this.appendLine(serializeSDKMessageForStorageForInternal(message))
      }
    })
  }

  removeSDKErrorMessage(errorUuid: string): boolean {
    return this.withMutation(() => {
      if (!existsSync(this.messagesPath)) return false
      const messages = parseJsonlStrict<unknown>(this.messagesPath, '聊天室 Agent session 消息')
        .map(normalizePersistedSDKMessageForInternal)
      const targetIndex = messages.findIndex((message) => message.type === 'assistant'
        && (message as { uuid?: string }).uuid === errorUuid
        && Boolean((message as { error?: unknown }).error))
      if (targetIndex < 0) return false
      const kept = messages.filter((_, index) => index !== targetIndex)
      const content = kept.map((message) => JSON.stringify(message)).join('\n') + (kept.length > 0 ? '\n' : '')
      writeTextFileAtomic(this.messagesPath, content)
      chmodSync(this.messagesPath, PRIVATE_MODE)
      return true
    })
  }

  private appendLine(line: string): void {
    assertOptionalRegularFile(this.messagesPath, '聊天室 Agent session 消息')
    if (!existsSync(this.messagesPath)) writeFileSync(this.messagesPath, '', { encoding: 'utf8', mode: PRIVATE_MODE })
    appendFileSync(this.messagesPath, `${line}\n`, 'utf8')
    chmodSync(this.messagesPath, PRIVATE_MODE)
  }

  private writeMeta(meta: AgentSessionMeta): void {
    assertOptionalRegularFile(this.metaPath, '聊天室 Agent session 元数据')
    // 隐藏 session 只保留约定的 meta.json；不生成普通索引风格的 .bak。
    writeJsonFileAtomic(this.metaPath, meta, true, PRIVATE_MODE)
  }

  private withMutation<T>(operation: () => T): T {
    if (this.mutating) throw new Error('聊天室 Agent session 正在写入')
    this.mutating = true
    try {
      return operation()
    } finally {
      this.mutating = false
    }
  }
}

export function createChatRoomHiddenSessionStore(
  roomId: string,
  config: ChatRoomAgentLocalConfig,
): ChatRoomHiddenSessionStore {
  return new ChatRoomHiddenSessionStore(roomId, config)
}
