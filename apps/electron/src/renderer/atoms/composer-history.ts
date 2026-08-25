/**
 * Composer 输入历史管理模块
 *
 * 管理用户在 Composer（Agent、Welcome 等）中输入并发送的消息历史，
 * 支持在输入框为空时按键盘「上箭头」唤起上次输入，并支持上下箭头多级回溯。
 */

import { atomWithStorage } from 'jotai/utils'
import { extractUserText, stripScheduledRunMarker, stripBridgeEnvelope } from '@copis/session-core'
import type { SDKMessage, SDKUserMessage } from '@copis/shared'

const MAX_COMPOSER_HISTORY_ITEMS = 100

/** 全局 Composer 输入历史持久化 Atom（时间升序：旧 -> 新） */
export const composerInputHistoryAtom = atomWithStorage<string[]>(
  'copis-composer-input-history',
  [],
  undefined,
  { getOnInit: true },
)

/**
 * 向历史列表中追加一条新输入（自动过滤空白、过滤连续重复项、限制最大数量）
 */
export function appendHistoryEntry(
  history: string[],
  entry: string,
  maxItems = MAX_COMPOSER_HISTORY_ITEMS,
): string[] {
  const trimmed = entry.trim()
  if (!trimmed) return history

  // 如果最后一条记录与当前输入完全相同，则不重复记录
  if (history.length > 0 && history[history.length - 1] === trimmed) {
    return history
  }

  const next = [...history, trimmed]
  if (next.length > maxItems) {
    return next.slice(next.length - maxItems)
  }
  return next
}

/**
 * 从 SDKMessage 列表中提取真实的人类用户提问历史（时间升序）
 * 过滤掉 synthetic 消息、/compact 指令、Bridge 协议包装及 XML 附件标记
 */
export function extractUserHistoryFromMessages(messages: SDKMessage[]): string[] {
  const history: string[] = []

  for (const message of messages) {
    if (message.type !== 'user') continue
    const userMsg = message as SDKUserMessage
    if (userMsg.isSynthetic) continue

    const rawText = extractUserText(userMsg) ?? ''
    if (!rawText) continue

    const withoutSchedule = stripScheduledRunMarker(rawText)
    const cleaned = stripBridgeEnvelope(withoutSchedule)
    // 剥离附件和引用 XML
    const pureText = cleaned
      .replace(/<attached_files>[\s\S]*?<\/attached_files>\n*/g, '')
      .replace(/<quoted_file[^>]*>[\s\S]*?<\/quoted_file>\n*/g, '')
      .replace(/<quoted_context[^>]*>[\s\S]*?<\/quoted_context>\n*/g, '')
      .trim()

    if (!pureText || pureText === '/compact') continue

    // 连续重复项去重
    if (history.length === 0 || history[history.length - 1] !== pureText) {
      history.push(pureText)
    }
  }

  return history
}

/**
 * 将全局历史记录与当前会话历史记录进行合并
 * 保留当前会话的最近提问，并在前面补充全局历史中其他不重复的较早输入
 */
export function mergeSessionAndGlobalHistory(
  globalHistory: string[],
  sessionHistory: string[],
  maxItems = MAX_COMPOSER_HISTORY_ITEMS,
): string[] {
  if (sessionHistory.length === 0) {
    return globalHistory.slice(-maxItems)
  }

  // 过滤出全局历史中未在会话历史中出现的项
  const sessionSet = new Set(sessionHistory)
  const nonDuplicateGlobal = globalHistory.filter((item) => !sessionSet.has(item))

  const merged = [...nonDuplicateGlobal, ...sessionHistory]
  if (merged.length > maxItems) {
    return merged.slice(merged.length - maxItems)
  }
  return merged
}
