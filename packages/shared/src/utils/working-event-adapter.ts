import type {
  AgentEvent,
  AgentStreamCompletePayload,
  AgentStreamEvent,
  AgentStreamPayload,
  SDKAssistantMessage,
  SDKContentBlock,
  SDKMessage,
  SDKResultMessage,
  SDKToolUseBlock,
  SDKToolResultBlock,
  SDKUserMessage,
} from '../types/agent'
import type { WorkingEvent } from '../types/working'

const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'ApplyPatch', 'Patch'])
const TODO_TOOLS = new Set(['TodoWrite', 'TaskCreate', 'TaskUpdate'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function asText(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (!isRecord(item)) return asText(item)
      return asText(item.text ?? item.content ?? item.output ?? item.message)
    }).filter(Boolean).join('\n')
  }
  return ''
}

function toolResultText(block: SDKToolResultBlock): string {
  const text = asText(block.content)
  if (text) return text
  try {
    return JSON.stringify(block.content ?? '')
  } catch {
    return String(block.content ?? '')
  }
}

function getToolPath(input: Record<string, unknown>): string | undefined {
  const value = input.file_path ?? input.filePath ?? input.path ?? input.notebook_path
  return typeof value === 'string' && value.trim() ? value : undefined
}

function getPatchFiles(input: Record<string, unknown>): Array<{ path: string; content?: string; diff?: string }> {
  if (!Array.isArray(input.files)) return []
  return input.files.flatMap((item) => {
    if (!isRecord(item)) return []
    const path = typeof item.path === 'string' ? item.path : typeof item.file_path === 'string' ? item.file_path : ''
    if (!path) return []
    return [{
      path,
      content: typeof item.content === 'string' ? item.content : undefined,
      diff: typeof item.diff === 'string' ? item.diff : typeof item.patch === 'string' ? item.patch : undefined,
    }]
  })
}

function adaptToolCall(sessionId: string, block: Extract<SDKContentBlock, { type: 'tool_use' }>): WorkingEvent[] {
  const input = isRecord(block.input) ? block.input : {}
  const events: WorkingEvent[] = [{
    type: 'tool_call',
    sessionId,
    toolUseId: block.id,
    toolName: block.name,
    input,
  }]

  if (FILE_TOOLS.has(block.name)) {
    const path = getToolPath(input)
    if (path) {
      events.push({
        type: 'file_change',
        sessionId,
        toolUseId: block.id,
        path,
        operation: block.name,
        content: typeof input.content === 'string' ? input.content : typeof input.new_string === 'string' ? input.new_string : undefined,
        diff: typeof input.diff === 'string' ? input.diff : typeof input.patch === 'string' ? input.patch : undefined,
      })
    }
  }

  if (TODO_TOOLS.has(block.name)) {
    events.push({
      type: 'todo',
      sessionId,
      toolUseId: block.id,
      todos: Array.isArray(input.todos) ? input.todos : [input],
    })
  }

  if (block.name === 'Patch' || block.name === 'ApplyPatch' || getPatchFiles(input).length > 0) {
    const files = getPatchFiles(input)
    if (files.length > 0) {
      events.push({
        type: 'patch',
        sessionId,
        patchId: block.id,
        summary: typeof input.summary === 'string' ? input.summary : undefined,
        files,
      })
    }
  }

  return events
}

function adaptSdkMessage(sessionId: string, message: SDKMessage): WorkingEvent[] {
  const events: WorkingEvent[] = []
  if (message.type === 'system' && message.subtype === 'init') {
    return [{
      type: 'run_started',
      sessionId,
      startedAt: typeof (message as unknown as Record<string, unknown>)._createdAt === 'number'
        ? (message as unknown as Record<string, unknown>)._createdAt as number
        : Date.now(),
      model: typeof message.model === 'string' ? message.model : undefined,
    }]
  }
  if (message.type === 'assistant') {
    const assistant = message as SDKAssistantMessage
    for (const block of assistant.message?.content ?? []) {
      if (block.type === 'text' && typeof block.text === 'string' && block.text) {
        events.push({ type: 'message_delta', sessionId, role: 'assistant', text: block.text, messageId: assistant.uuid })
      } else if (block.type === 'tool_use' && isRecord(block)) {
        events.push(...adaptToolCall(sessionId, block as unknown as SDKToolUseBlock))
      }
    }
    if (assistant.error?.message) events.push({ type: 'run_failed', sessionId, error: assistant.error.message })
    return events
  }

  if (message.type === 'user') {
    const user = message as SDKUserMessage
    for (const block of user.message?.content ?? []) {
      if (block.type === 'text' && typeof block.text === 'string' && block.text) {
        events.push({ type: 'message_delta', sessionId, role: 'user', text: block.text, messageId: user.uuid })
      } else if (block.type === 'tool_result' && isRecord(block)) {
        const resultBlock = block as unknown as SDKToolResultBlock
        events.push({
          type: 'tool_result',
          sessionId,
          toolUseId: resultBlock.tool_use_id,
          result: toolResultText(resultBlock),
          isError: resultBlock.is_error === true,
        })
      }
    }
    return events
  }

  if (message.type === 'result') {
    const result = message as SDKResultMessage
    const errors = result.errors?.filter(Boolean) ?? []
    if (result.subtype !== 'success' || errors.length > 0) {
      events.push({ type: 'run_failed', sessionId, error: errors.join('\n') || result.terminal_reason || result.subtype })
    } else {
      events.push({ type: 'run_completed', sessionId, stopReason: result.terminal_reason })
    }
    return events
  }

  if (message.type === 'system') {
    if (message.subtype === 'task_notification' && message.status === 'stopped') {
      events.push({ type: 'run_stopped', sessionId, reason: typeof message.message === 'string' ? message.message : undefined })
    }
  }
  return events
}

function adaptPromaEvent(sessionId: string, event: Extract<AgentStreamPayload, { kind: 'proma_event' }>['event']): WorkingEvent[] {
  switch (event.type) {
    case 'external_run_started':
      return [{
        type: 'run_started',
        sessionId,
        startedAt: event.startedAt,
        model: event.modelId,
      }]
    case 'run_resumed':
      return [{ type: 'run_started', sessionId, startedAt: Date.now() }]
    case 'retry':
      if (event.status === 'cancelled') return [{ type: 'run_stopped', sessionId, reason: event.reason }]
      if (event.status === 'failed') return [{ type: 'run_failed', sessionId, error: event.error?.message ?? event.reason ?? '重试失败' }]
      return []
    default:
      return []
  }
}

function adaptLegacyEvent(sessionId: string, event: AgentEvent): WorkingEvent[] {
  switch (event.type) {
    case 'text_delta':
      return [{ type: 'message_delta', sessionId, role: 'assistant', text: event.text }]
    case 'tool_start':
      return [{
        type: 'tool_call',
        sessionId,
        toolUseId: event.toolUseId,
        toolName: event.toolName,
        input: event.input,
        parentToolUseId: event.parentToolUseId,
      }]
    case 'tool_result':
      return [{ type: 'tool_result', sessionId, toolUseId: event.toolUseId, result: event.result, isError: event.isError }]
    case 'complete':
      return [{ type: 'run_completed', sessionId, stopReason: event.stopReason }]
    case 'error':
      return [{ type: 'run_failed', sessionId, error: event.message }]
    default:
      return []
  }
}

/** 将当前 Proma IPC 流映射为方案中的 Working 事件。 */
export function adaptWorkingStreamEvent(streamEvent: Pick<AgentStreamEvent, 'sessionId' | 'payload' | 'event'>): WorkingEvent[] {
  const events = streamEvent.payload.kind === 'sdk_message'
    ? adaptSdkMessage(streamEvent.sessionId, streamEvent.payload.message)
    : adaptPromaEvent(streamEvent.sessionId, streamEvent.payload.event)
  return streamEvent.event ? [...events, ...adaptLegacyEvent(streamEvent.sessionId, streamEvent.event)] : events
}

/** 将完成回调映射为 Working 的终态事件，保证停止与失败语义不混淆。 */
export function adaptWorkingStreamComplete(payload: AgentStreamCompletePayload): WorkingEvent {
  if (payload.stoppedByUser) return { type: 'run_stopped', sessionId: payload.sessionId, reason: '用户已停止运行' }
  if (payload.resultSubtype && payload.resultSubtype !== 'success') {
    return {
      type: 'run_failed',
      sessionId: payload.sessionId,
      error: payload.resultErrors?.join('\n') || payload.resultSubtype,
    }
  }
  return { type: 'run_completed', sessionId: payload.sessionId, stopReason: payload.resultSubtype }
}

export function adaptWorkingStreamError(sessionId: string, error: string): WorkingEvent {
  return { type: 'run_failed', sessionId, error }
}
