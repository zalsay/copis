import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { getConfigDir } from './config-paths'

export interface LegacyChatCleanupResult {
  conversationIds: string[]
  removedConversationIndex: boolean
  removedConversationDirectory: boolean
  removedAttachmentDirectories: string[]
}

interface LegacyConversationEntry {
  id?: unknown
}

interface LegacyConversationIndex {
  conversations?: unknown
}

function isSafeConversationId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && !value.includes('/')
    && !value.includes('\\')
    && !value.includes('..')
}

function readLegacyConversationIds(indexPath: string): string[] {
  if (!existsSync(indexPath)) return []

  try {
    const parsed: unknown = JSON.parse(readFileSync(indexPath, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) {
      console.warn('[启动] 旧 Chat 索引不是对象，忽略其中的会话 ID')
      return []
    }

    const conversations = (parsed as LegacyConversationIndex).conversations
    if (!Array.isArray(conversations)) {
      console.warn('[启动] 旧 Chat 索引缺少 conversations 数组，忽略其中的会话 ID')
      return []
    }

    const ids: string[] = []
    for (const entry of conversations) {
      const id = typeof entry === 'object' && entry !== null
        ? (entry as LegacyConversationEntry).id
        : undefined
      if (isSafeConversationId(id)) {
        if (!ids.includes(id)) ids.push(id)
      } else {
        console.warn('[启动] 旧 Chat 索引包含无效会话 ID，已忽略')
      }
    }
    return ids
  } catch (error) {
    console.warn('[启动] 读取旧 Chat 索引失败，仍继续清理文件:', error)
    return []
  }
}

/** 幂等删除旧 Chat 数据，不创建已删除的 conversations 目录。 */
export function cleanupLegacyChatData(configDir = getConfigDir()): LegacyChatCleanupResult {
  const indexPath = join(configDir, 'conversations.json')
  const conversationsDir = join(configDir, 'conversations')
  const attachmentRoot = join(configDir, 'attachments')
  const conversationIds = readLegacyConversationIds(indexPath)
  const hadIndex = existsSync(indexPath)
  const hadConversationDirectory = existsSync(conversationsDir)

  rmSync(indexPath, { force: true })
  rmSync(conversationsDir, { recursive: true, force: true })

  const removedAttachmentDirectories: string[] = []
  for (const conversationId of conversationIds) {
    const attachmentDir = join(attachmentRoot, conversationId)
    if (!existsSync(attachmentDir)) continue
    rmSync(attachmentDir, { recursive: true, force: true })
    removedAttachmentDirectories.push(conversationId)
  }

  console.info(
    `[启动] 旧 Chat 清理完成：发现 ${conversationIds.length} 个会话，` +
    `删除索引=${hadIndex ? '是' : '否'}，删除消息目录=${hadConversationDirectory ? '是' : '否'}，` +
    `删除附件目录=${removedAttachmentDirectories.length} 个`,
  )

  return {
    conversationIds,
    removedConversationIndex: hadIndex,
    removedConversationDirectory: hadConversationDirectory,
    removedAttachmentDirectories,
  }
}
