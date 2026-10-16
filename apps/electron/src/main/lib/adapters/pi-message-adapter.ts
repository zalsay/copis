/**
 * Pi Agent 消息兼容层。
 *
 * 主进程和渲染层继续使用统一的 SDKMessage 协议；本模块集中处理
 * Pi AgentMessage 与 SDKMessage 之间的形状转换，避免 session 编排代码混入 UI 协议细节。
 */

import { randomUUID } from 'node:crypto'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { AssistantMessage, ToolResultMessage, UserMessage } from '@earendil-works/pi-ai/compat'
import type { SDKAssistantMessage, SDKMessage } from '@copis/shared'
import type { RuntimeGuardResultOverride } from '../agent-runtime-guards'
import { isMalformedResponseError, isTransientNetworkError } from '../error-patterns'

function getPiEditItems(input: Record<string, unknown>): Array<Record<string, unknown>> {
  return Array.isArray(input.edits)
    ? input.edits.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    : []
}

function isMultiEditInput(piName: string, input: Record<string, unknown>): boolean {
  return piName === 'edit' && getPiEditItems(input).length > 1
}

export function displayToolName(piName: string, input?: Record<string, unknown>): string {
  switch (piName) {
    case 'read':
      return 'Read'
    case 'write':
      return 'Write'
    case 'edit':
      return input && isMultiEditInput(piName, input) ? 'MultiEdit' : 'Edit'
    case 'bash':
      return 'Bash'
    case 'grep':
      return 'Grep'
    case 'find':
      return 'Glob'
    case 'ls':
      return 'LS'
    default:
      return piName
  }
}

export function normalizePermissionInput(piName: string, input: Record<string, unknown>): Record<string, unknown> {
  switch (piName) {
    case 'read':
    case 'write':
      return { ...input, file_path: input.path }
    case 'edit': {
      const editItems = getPiEditItems(input)
      const firstEdit = editItems[0]
      return {
        ...input,
        file_path: input.path,
        edits: editItems.map((edit) => ({
          ...edit,
          old_string: edit.old_string ?? edit.oldText,
          new_string: edit.new_string ?? edit.newText,
        })),
        old_string: firstEdit?.old_string ?? firstEdit?.oldText,
        new_string: firstEdit?.new_string ?? firstEdit?.newText,
      }
    }
    case 'find':
      return { ...input, pattern: input.pattern }
    case 'ls':
      return { ...input, file_path: input.path ?? '.' }
    default:
      return input
  }
}

function normalizeToolUseInput(piName: string, input: Record<string, unknown>): Record<string, unknown> {
  switch (piName) {
    case 'read':
    case 'write':
      return { ...input, file_path: input.file_path ?? input.path }
    case 'edit': {
      const editItems = getPiEditItems(input)
      const firstEdit = editItems[0]
      const normalizedEdits = editItems.map((edit) => ({
        ...edit,
        old_string: edit.old_string ?? edit.oldText,
        new_string: edit.new_string ?? edit.newText,
      }))
      const joinedOld = normalizedEdits
        .map((edit, index) => `--- Edit ${index + 1} ---\n${String(edit.old_string ?? '')}`)
        .join('\n')
      const joinedNew = normalizedEdits
        .map((edit, index) => `--- Edit ${index + 1} ---\n${String(edit.new_string ?? '')}`)
        .join('\n')
      return {
        ...input,
        file_path: input.file_path ?? input.path,
        edits: normalizedEdits,
        old_string: input.old_string ?? (normalizedEdits.length > 1 ? joinedOld : firstEdit?.old_string ?? firstEdit?.oldText),
        new_string: input.new_string ?? (normalizedEdits.length > 1 ? joinedNew : firstEdit?.new_string ?? firstEdit?.newText),
      }
    }
    case 'find':
      return { ...input, pattern: input.pattern }
    case 'ls':
      return { ...input, file_path: input.file_path ?? input.path ?? '.' }
    default:
      return input
  }
}

export function restorePiInput(
  piName: string,
  original: Record<string, unknown>,
  updated?: Record<string, unknown>,
): Record<string, unknown> {
  if (!updated) return original
  switch (piName) {
    case 'read':
    case 'write':
      return { ...original, ...updated, path: updated.file_path ?? updated.path ?? original.path }
    case 'edit':
      return { ...original, ...updated, path: updated.file_path ?? updated.path ?? original.path }
    default:
      return { ...original, ...updated }
  }
}

function normalizeToolResultContent(content: unknown): unknown {
  if (!Array.isArray(content)) return content
  return content.map((item) => {
    if (!item || typeof item !== 'object') return item
    const record = item as Record<string, unknown>
    if (record.type === 'text' && typeof record.text === 'string') {
      return { type: 'text', text: record.text }
    }
    if (record.type === 'image') {
      return record
    }
    return record
  })
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((block) => {
      if (block && typeof block === 'object' && 'type' in block && block.type === 'text' && 'text' in block) {
        return typeof block.text === 'string' ? block.text : ''
      }
      return ''
    }).join('')
  }
  return ''
}

const CHROME_DESKTOP_FRAME_MARKER = 'Chrome Desktop Frame untrusted_chrome_frame'
const CHROME_DESKTOP_HISTORY_IMAGE_PLACEHOLDER = '[Chrome Desktop 历史截图已省略；需要当前画面时请重新调用 ChromeDesktopObserve。]'

/**
 * 压缩送往模型的 Chrome 截图历史。
 *
 * ChromeDesktopObserve 的图片只对当前决策有价值；如果把每次 Observe 的
 * base64 都带入下一轮，Pi 会把整条 transcript 的图片再次提交给上游。
 * 保留最后一张供当前轮继续判断，旧图替换为文本占位；普通用户图片和
 * 其他工具返回的图片不属于本策略。
 */
export function sanitizeChromeDesktopImagesForContext(
  messages: AgentMessage[],
  keepLatest = 1,
): AgentMessage[] {
  const chromeImagePositions: Array<{ messageIndex: number; blockIndex: number }> = []

  messages.forEach((message, messageIndex) => {
    if (!message || typeof message !== 'object' || !('role' in message) || message.role !== 'toolResult') return
    const content = (message as { content?: unknown }).content
    if (!Array.isArray(content)) return
    const isChromeFrame = content.some((block) => {
      if (!block || typeof block !== 'object') return false
      const text = (block as { type?: string; text?: unknown }).text
      return (block as { type?: string }).type === 'text'
        && typeof text === 'string'
        && text.includes(CHROME_DESKTOP_FRAME_MARKER)
    })
    if (!isChromeFrame) return

    content.forEach((block, blockIndex) => {
      if (block && typeof block === 'object' && (block as { type?: string }).type === 'image') {
        chromeImagePositions.push({ messageIndex, blockIndex })
      }
    })
  })

  const keepPositions = new Set(
    chromeImagePositions.slice(Math.max(0, chromeImagePositions.length - Math.max(0, keepLatest)))
      .map(({ messageIndex, blockIndex }) => `${messageIndex}:${blockIndex}`),
  )

  if (keepPositions.size === chromeImagePositions.length) return messages

  return messages.map((message, messageIndex) => {
    if (!message || typeof message !== 'object' || !('role' in message) || message.role !== 'toolResult') return message
    const content = (message as { content?: unknown }).content
    if (!Array.isArray(content)) return message
    const nextContent = content.map((block, blockIndex) => {
      const key = `${messageIndex}:${blockIndex}`
      if (!chromeImagePositions.some((position) => `${position.messageIndex}:${position.blockIndex}` === key)) return block
      if (keepPositions.has(key)) return block
      return { type: 'text', text: CHROME_DESKTOP_HISTORY_IMAGE_PLACEHOLDER }
    })
    return { ...message, content: nextContent } as AgentMessage
  })
}

export function isAssistantPiMessage(message: AgentMessage): message is AssistantMessage {
  return !!message && typeof message === 'object' && 'role' in message && message.role === 'assistant'
}

/** Pi's terminal error and any generated assistant content are independent fields. */
export function getPiAssistantErrorDetails(message: SDKAssistantMessage): {
  detailedMessage: string
  originalError: string
} {
  const errorMessage = message.error?.message?.trim() || 'Unknown error'
  return { detailedMessage: errorMessage, originalError: errorMessage }
}

/** Pi can generate text before a stream failure; preserve it as normal assistant output. */
export function hasPiAssistantTextContent(message: SDKAssistantMessage): boolean {
  return message.message.content.some(
    (block) => block.type === 'text' && 'text' in block && typeof block.text === 'string' && block.text.trim().length > 0,
  )
}

/** Copy Pi's generated output without the terminal transport/provider failure. */
export function stripPiAssistantError(message: SDKAssistantMessage): SDKAssistantMessage {
  const contentMessage = { ...message }
  delete contentMessage.error
  return contentMessage
}

export function isAbortedAssistantMessage(message: AgentMessage): message is AssistantMessage {
  return isAssistantPiMessage(message) && message.stopReason === 'aborted'
}

export function dropTrailingAbortedAssistant(messages: AgentMessage[]): AgentMessage[] {
  const lastMessage = messages[messages.length - 1]
  return lastMessage && isAbortedAssistantMessage(lastMessage) ? messages.slice(0, -1) : messages
}

/**
 * 校验并清理会话消息历史中的孤立 toolCall 与异常尾部 assistant，避免下游 LLM Provider
 * （如 DeepSeek / OpenAI / Console Go）在发起新 turn 时抛出：
 * `No tool output found for tool call call_xxx` 或 `Invalid message sequence`。
 */
export function sanitizeSessionMessagesForTurn(messages: AgentMessage[]): AgentMessage[] {
  if (!messages || messages.length === 0) return []

  // 1. 收集所有已存在的 toolResult 消息的 toolCallId
  const completedToolCallIds = new Set<string>()
  for (const msg of messages) {
    if (msg && typeof msg === 'object' && 'role' in msg && msg.role === 'toolResult') {
      const tr = msg as ToolResultMessage
      if (tr.toolCallId) {
        completedToolCallIds.add(tr.toolCallId)
      }
    }
  }

  // 2. 遍历所有消息，清理没有结果的 toolCall
  const sanitized: AgentMessage[] = []
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (!msg || typeof msg !== 'object' || !('role' in msg)) continue

    if (msg.role === 'assistant') {
      const assistant = msg as AssistantMessage
      const content = Array.isArray(assistant.content) ? assistant.content : []

      // 检查该 assistant message 是否包含未完成的 toolCall
      const validContent = content.filter((block) => {
        if (block && typeof block === 'object' && block.type === 'toolCall') {
          const tcId = (block as { id?: string }).id
          return tcId && completedToolCallIds.has(tcId)
        }
        return true
      })

      const hasMeaningfulContent = validContent.some((block) => {
        if (block.type === 'text') return typeof block.text === 'string' && block.text.trim().length > 0
        if (block.type === 'thinking') return typeof block.thinking === 'string' && block.thinking.trim().length > 0
        if (block.type === 'toolCall') return true
        return false
      })

      const isLast = i === messages.length - 1
      if (isLast && (assistant.stopReason === 'error' || assistant.stopReason === 'aborted' || !hasMeaningfulContent)) {
        continue
      }

      if (hasMeaningfulContent) {
        sanitized.push({
          ...assistant,
          content: validContent,
        } as AssistantMessage)
      }
    } else {
      sanitized.push(msg)
    }
  }

  // 3. 再次检查尾部是否仍留有 aborted / error / 孤立 assistant
  while (sanitized.length > 0) {
    const last = sanitized[sanitized.length - 1]
    if (last && typeof last === 'object' && 'role' in last && last.role === 'assistant') {
      const assistant = last as AssistantMessage
      const content = Array.isArray(assistant.content) ? assistant.content : []
      const toolCalls = content.filter((b) => b.type === 'toolCall')
      const allToolCallsHaveResult = toolCalls.every((tc) => tc.id && completedToolCallIds.has(tc.id))
      if (assistant.stopReason === 'error' || assistant.stopReason === 'aborted' || !allToolCallsHaveResult) {
        sanitized.pop()
        continue
      }
    }
    break
  }

  return sanitized
}

function usageFromAssistant(message: AssistantMessage): {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
} {
  return {
    input_tokens: message.usage?.input ?? 0,
    output_tokens: message.usage?.output ?? 0,
    cache_read_input_tokens: message.usage?.cacheRead ?? 0,
    cache_creation_input_tokens: message.usage?.cacheWrite ?? 0,
  }
}

// 说明：本函数产出的消息 parent_tool_use_id 恒为 null。Pi 的事件模型（AgentEvent）不存在
// 子代理/sidechain 概念，AgentMessage 也无父子关联字段，故 pi 会话的所有消息都是主线。
// 渲染层（SDKMessageRenderer 的 childBlocksMap/agentToolIds 分组）不是死代码：旧
// runtime 持久化的历史会话 JSONL 里子代理消息带非空 parent_tool_use_id，打开老会话时仍
// 依赖该逻辑正确嵌套显示，不可删除。
export function convertPiMessage(
  message: AgentMessage,
  sessionId: string,
  channelModelId?: string,
  options: { final?: boolean; uuid?: string } = {},
): SDKMessage | null {
  const final = options.final ?? true
  if (!message || typeof message !== 'object' || !('role' in message)) return null

  if (message.role === 'user') {
    const user = message as UserMessage
    return {
      type: 'user',
      message: {
        content: [{ type: 'text', text: contentToText(user.content) }],
      },
      parent_tool_use_id: null,
      session_id: sessionId,
      ...(final && { uuid: options.uuid ?? randomUUID() }),
    } as unknown as SDKMessage
  }

  if (message.role === 'assistant') {
    const assistant = message as AssistantMessage
    // 只有 stopReason === 'error' 时才把 errorMessage 提升为终态 error 字段。
    // - 'aborted' 属于用户/系统主动中断，不是失败，弹「服务繁忙 + 重试」在语义上完全错误。
    // - 'stop' / 'length' / 'toolUse' 即使带 errorMessage 也只是 provider 中途抖动，
    //   Pi SDK 认定本轮已成功，不应在渲染层误导用户。
    // 上述非终态情况的 errorMessage 只写主进程 console，供开发排查；用户侧完全无感知。
    // Pi 可能先用预览帧报告 error，随后通过同一 transcript 原生重试；
    // 在最终帧到达前不能把它展示成用户可见的终态失败。
    const isTerminalError = final && assistant.stopReason === 'error'
    const errorType = assistant.errorMessage && isMalformedResponseError(assistant.errorMessage)
      ? 'service_error'
      : assistant.errorMessage && isTransientNetworkError(assistant.errorMessage)
        ? 'network_error'
        : 'provider_error'
    if (assistant.errorMessage && !isTerminalError && final) {
      console.warn(
        `[pi-adapter] 忽略非终态 errorMessage（stopReason=${assistant.stopReason}）: ${assistant.errorMessage}`,
      )
    }
    return {
      type: 'assistant',
      message: {
        content: assistant.content.map((block) => {
          if (block.type === 'text') return { type: 'text', text: block.text }
          if (block.type === 'thinking') return { type: 'thinking', thinking: block.thinking }
          if (block.type === 'toolCall') {
            return {
              type: 'tool_use',
              id: block.id,
              name: displayToolName(block.name, block.arguments as Record<string, unknown>),
              // Pi 的 toolcall_delta 每帧携带累计 arguments。大 Write content 会随每个 token
              // 反复穿过 IPC、Jotai 和 React；预览帧只需保留工具身份，最终帧再提供完整 input。
              input: final ? normalizeToolUseInput(block.name, block.arguments as Record<string, unknown>) : {},
            }
          }
          return block as unknown as Record<string, unknown>
        }),
        usage: usageFromAssistant(assistant),
        model: assistant.model,
        stop_reason: assistant.stopReason,
      },
      parent_tool_use_id: null,
      session_id: sessionId,
      uuid: options.uuid ?? randomUUID(),
      ...(!final && { _partial: true }),
      ...(assistant.errorMessage && isTerminalError && {
        error: { message: assistant.errorMessage, errorType },
      }),
      ...(channelModelId && { _channelModelId: channelModelId }),
    } as unknown as SDKMessage
  }

  if (message.role === 'toolResult') {
    const toolResult = message as ToolResultMessage
    return {
      type: 'user',
      message: {
        content: [{
          type: 'tool_result',
          tool_use_id: toolResult.toolCallId,
          content: normalizeToolResultContent(toolResult.content),
          is_error: toolResult.isError,
        }],
      },
      tool_use_result: toolResult.details,
      parent_tool_use_id: null,
      session_id: sessionId,
      uuid: randomUUID(),
    } as unknown as SDKMessage
  }

  return null
}

export function hasToolResult(message: SDKMessage): boolean {
  if (message.type !== 'user') return false
  const content = (message as { message?: { content?: Array<{ type?: string }> } }).message?.content
  return Array.isArray(content) && content.some((block) => block.type === 'tool_result')
}

export function convertResultMessage(
  messages: AgentMessage[],
  sessionId: string,
  override?: RuntimeGuardResultOverride,
): SDKMessage {
  const assistants = messages.filter((m): m is AssistantMessage =>
    !!m && typeof m === 'object' && 'role' in m && m.role === 'assistant')
  const costValues = assistants
    .map((msg) => msg.usage?.cost?.total)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
  const usage = assistants.reduce(
    (acc, msg) => ({
      input_tokens: acc.input_tokens + (msg.usage?.input ?? 0),
      output_tokens: acc.output_tokens + (msg.usage?.output ?? 0),
      cache_read_input_tokens: acc.cache_read_input_tokens + (msg.usage?.cacheRead ?? 0),
      cache_creation_input_tokens: acc.cache_creation_input_tokens + (msg.usage?.cacheWrite ?? 0),
    }),
    { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  )
  const lastAssistant = assistants[assistants.length - 1]
  // Pi 在重试耗尽、请求超时或取消时可能使用 stopReason="aborted"，但仍把
  // 上游真实错误放在 errorMessage。只看 error 会把这类失败误报成 success。
  const hasTerminalError = lastAssistant?.stopReason === 'error' || lastAssistant?.stopReason === 'aborted'
  const assistantError = hasTerminalError ? lastAssistant?.errorMessage?.trim() || undefined : undefined
  const terminalReason = override?.terminalReason ?? (lastAssistant?.stopReason === 'length' ? 'max_tokens' : 'completed')
  return {
    type: 'result',
    subtype: override?.subtype ?? (assistantError ? 'error_during_execution' : terminalReason === 'max_tokens' ? 'max_tokens' : 'success'),
    usage,
    total_cost_usd: costValues.length > 0 ? costValues.reduce((sum, cost) => sum + cost, 0) : undefined,
    terminal_reason: terminalReason,
    errors: override?.errors ?? (assistantError ? [assistantError] : undefined),
    session_id: sessionId,
  } as unknown as SDKMessage
}
