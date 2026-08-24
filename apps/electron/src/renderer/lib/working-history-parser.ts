import type {
  SDKAssistantMessage,
  SDKContentBlock,
  SDKMessage,
  SDKResultMessage,
  SDKSystemMessage,
  SDKToolResultBlock,
  SDKUserMessage,
} from '@copis/shared'

export type WorkingHistoryStatus = 'idle' | 'running' | 'completed' | 'failed' | 'stopped'

export interface WorkingHistoryDiagnostic {
  line: number
  message: string
  raw: string
}

export interface WorkingHistoryParseResult {
  sessionId?: string
  status: WorkingHistoryStatus
  messages: SDKMessage[]
  diagnostics: WorkingHistoryDiagnostic[]
}

type RecordValue = Record<string, unknown>

function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function timestampValue(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return Date.now()
}

function textFromUnknown(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

function textFromContent(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value.map((item) => {
    if (!isRecord(item)) return textFromUnknown(item)
    return textFromUnknown(item.text ?? item.content ?? item.output ?? item.message)
  }).filter(Boolean).join('\n\n')
}

function stringifyForDisplay(value: unknown): string {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      try {
        return JSON.stringify(JSON.parse(trimmed), null, 2)
      } catch {
        return value
      }
    }
    return value
  }
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function parseJsonRecord(value: unknown): RecordValue | null {
  if (isRecord(value)) return value
  if (typeof value !== 'string') return null
  try {
    const parsed: unknown = JSON.parse(value)
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

function normalizeUserText(text: string): string {
  const trimmed = text.trim()
  if (!trimmed) return ''

  // Working 启动时会把环境上下文和内部 prompt 写入 Codex history；用户只应看到实际提交内容。
  const submittedMatch = trimmed.match(/"submitted_message"\s*:\s*"((?:\\.|[^"\\])*)"/)
  if (submittedMatch?.[1]) {
    try {
      return JSON.parse(`"${submittedMatch[1]}"`) as string
    } catch {
      return submittedMatch[1]
    }
  }
  if (trimmed.includes('<environment_context>') || trimmed.includes('你是 working agent')) return ''
  return trimmed
}

function toolNameFromPayload(payload: RecordValue, fallback: string): string {
  const invocation = isRecord(payload.invocation) ? payload.invocation : null
  return stringValue(payload.name)
    || stringValue(payload.tool)
    || stringValue(invocation?.tool)
    || fallback
}

function toolInputFromPayload(payload: RecordValue): Record<string, unknown> {
  const raw = payload.arguments ?? payload.input ?? payload.params ?? {}
  const parsed = parseJsonRecord(raw)
  return parsed ?? (isRecord(raw) ? raw : { value: raw })
}

function toolResultFromPayload(payload: RecordValue): string {
  const raw = payload.output
    ?? payload.stdout
    ?? payload.stderr
    ?? payload.formatted_output
    ?? payload.aggregated_output
    ?? payload.content
    ?? payload.result
    ?? payload.message
    ?? payload.changes
  return typeof raw === 'string' ? raw : stringifyForDisplay(raw ?? payload)
}

function toolIdFromPayload(payload: RecordValue, fallback: string): string {
  return stringValue(payload.call_id)
    || stringValue(payload.tool_use_id)
    || stringValue(payload.id)
    || fallback
}

function toolResultBlock(toolUseId: string, content: string, isError = false): SDKUserMessage {
  const block: SDKToolResultBlock = {
    type: 'tool_result',
    tool_use_id: toolUseId,
    content,
    is_error: isError,
  }
  return {
    type: 'user',
    uuid: `working-result-${toolUseId}`,
    message: { content: [block] },
    parent_tool_use_id: null,
    isReplay: true,
  }
}

function isErrorPayload(payload: RecordValue): boolean {
  return payload.success === false
    || payload.status === 'failed'
    || payload.status === 'error'
    || (typeof payload.exit_code === 'number' && payload.exit_code !== 0)
}

function makeAssistant(
  content: SDKContentBlock[],
  index: number,
  createdAt: number,
  sessionId: string | undefined,
  model?: string,
  error?: string,
): SDKAssistantMessage {
  const message = {
    type: 'assistant',
    uuid: `working-assistant-${index}`,
    message: { content, model },
    parent_tool_use_id: null,
    session_id: sessionId,
  } as SDKAssistantMessage
  ;(message as unknown as Record<string, unknown>)._createdAt = createdAt
  if (error) message.error = { message: error, errorType: 'working_history' }
  return message
}

function makeUser(text: string, index: number, createdAt: number, sessionId?: string): SDKUserMessage {
  const message = {
    type: 'user',
    uuid: `working-user-${index}`,
    message: { content: [{ type: 'text', text }] },
    parent_tool_use_id: null,
    session_id: sessionId,
  } as SDKUserMessage
  ;(message as unknown as Record<string, unknown>)._createdAt = createdAt
  return message
}

function makeResult(
  index: number,
  createdAt: number,
  sessionId: string | undefined,
  subtype: SDKResultMessage['subtype'],
  usage?: RecordValue,
): SDKResultMessage {
  return {
    type: 'result',
    subtype,
    usage: {
      input_tokens: numberValue(usage?.input_tokens ?? usage?.input) ?? 0,
      output_tokens: numberValue(usage?.output_tokens ?? usage?.output) ?? 0,
      cache_read_input_tokens: numberValue(usage?.cached_input_tokens),
      cache_creation_input_tokens: numberValue(usage?.cache_creation_input_tokens),
    },
    session_id: sessionId,
    terminal_reason: subtype,
    isSyntheticCompactionResult: false,
    _createdAt: createdAt,
    uuid: `working-result-message-${index}`,
  } as SDKResultMessage
}

function patchProposalFromText(text: string): RecordValue | null {
  const parsed = parseJsonRecord(text)
  return parsed?.type === 'working.patch_proposal' ? parsed : null
}

function patchFiles(value: unknown): Array<{ path: string; content?: string; diff?: string }> {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (!isRecord(item)) return []
    const path = stringValue(item.path) || stringValue(item.file_path)
    if (!path) return []
    return [{
      path,
      content: typeof item.content === 'string' ? item.content : undefined,
      diff: typeof item.diff === 'string' ? item.diff : typeof item.patch === 'string' ? item.patch : undefined,
    }]
  })
}

class WorkingHistoryParser {
  readonly messages: SDKMessage[] = []
  readonly diagnostics: WorkingHistoryDiagnostic[] = []
  sessionId: string | undefined
  status: WorkingHistoryStatus = 'idle'
  private messageIndex = 0
  private toolIndex = 0

  private nextToolId(prefix: string): string {
    this.toolIndex += 1
    return `working-tool-${prefix}-${this.toolIndex}`
  }

  private addUser(text: string, timestamp: unknown): void {
    const normalized = normalizeUserText(text)
    if (!normalized) return
    this.messageIndex += 1
    this.messages.push(makeUser(normalized, this.messageIndex, timestampValue(timestamp), this.sessionId))
  }

  private addAssistantText(text: string, timestamp: unknown, model?: string): void {
    const normalized = text.trim()
    if (!normalized) return
    const proposal = patchProposalFromText(normalized)
    if (proposal) {
      this.addPatch(proposal, timestamp)
      return
    }
    this.messageIndex += 1
    this.messages.push(makeAssistant(
      [{ type: 'text', text: normalized }],
      this.messageIndex,
      timestampValue(timestamp),
      this.sessionId,
      model,
    ))
  }

  private addThinking(text: string, timestamp: unknown): void {
    if (!text.trim()) return
    this.messageIndex += 1
    this.messages.push(makeAssistant(
      [{ type: 'thinking', thinking: text }],
      this.messageIndex,
      timestampValue(timestamp),
      this.sessionId,
    ))
  }

  private addToolCall(
    toolName: string,
    input: Record<string, unknown>,
    timestamp: unknown,
    toolId?: string,
    result?: string,
    error = false,
  ): void {
    const id = toolId || this.nextToolId(toolName)
    this.messageIndex += 1
    this.messages.push(makeAssistant(
      [{ type: 'tool_use', id, name: toolName, input }],
      this.messageIndex,
      timestampValue(timestamp),
      this.sessionId,
    ))
    if (result !== undefined) this.messages.push(toolResultBlock(id, result, error))
  }

  private addPatch(patch: RecordValue, timestamp: unknown): void {
    const files = patchFiles(patch.files)
    const summary = stringValue(patch.summary)
    if (files.length === 0) {
      this.addAssistantText(summary || '收到文件 Patch', timestamp)
      return
    }
    for (const file of files) {
      const input: Record<string, unknown> = {
        file_path: file.path,
        content: file.content ?? '',
      }
      if (file.diff) input.diff = file.diff
      this.addToolCall('Write', input, timestamp, undefined, summary || 'Patch 已记录')
    }
  }

  private addFileChange(item: RecordValue, timestamp: unknown): void {
    const changes = Array.isArray(item.changes) ? item.changes : [item]
    for (const rawChange of changes) {
      const change = isRecord(rawChange) ? rawChange : {}
      const path = stringValue(change.path) || stringValue(change.file_path) || stringValue(item.path) || stringValue(item.file_path)
      if (!path) continue
      const content = stringValue(change.content) || stringValue(change.new_content) || stringValue(item.content)
      const diff = stringValue(change.diff) || stringValue(change.patch) || stringValue(item.diff) || stringValue(item.patch)
      const toolName = content ? 'Write' : 'Edit'
      const input: Record<string, unknown> = { file_path: path }
      if (content) input.content = content
      if (diff) {
        input.diff = diff
        if (!content) {
          input.old_string = ''
          input.new_string = diff
        }
      }
      this.addToolCall(toolName, input, timestamp, stringValue(change.id) || undefined, toolResultFromPayload(change) || '文件变更已记录', isErrorPayload(change))
    }
  }

  private addTodo(item: RecordValue, timestamp: unknown): void {
    const todos = Array.isArray(item.todos) ? item.todos : Array.isArray(item.items) ? item.items : [item]
    this.addToolCall('TodoWrite', { todos }, timestamp, stringValue(item.id) || undefined, stringifyForDisplay(todos), isErrorPayload(item))
  }

  private addError(message: string, timestamp: unknown, stopped = false): void {
    const text = message.trim() || (stopped ? '运行已中断' : 'Copis 运行失败')
    this.messageIndex += 1
    this.messages.push(makeAssistant([], this.messageIndex, timestampValue(timestamp), this.sessionId, undefined, text))
    this.status = stopped ? 'stopped' : 'failed'
  }

  private consumeResponseItem(payload: RecordValue, timestamp: unknown): void {
    const type = stringValue(payload.type)
    if (type === 'message') {
      const role = stringValue(payload.role)
      const text = textFromContent(payload.content)
      if (role === 'user') this.addUser(text, timestamp)
      else if (role === 'assistant') this.addAssistantText(text, timestamp, stringValue(payload.model) || undefined)
      return
    }
    if (type === 'reasoning') {
      this.addThinking(textFromContent(payload.summary) || textFromUnknown(payload.content), timestamp)
      return
    }
    if (type.endsWith('_call') || type === 'function_call' || type === 'custom_tool_call' || type === 'web_search_call') {
      this.addToolCall(toolNameFromPayload(payload, type), toolInputFromPayload(payload), timestamp, toolIdFromPayload(payload, this.nextToolId('call')))
      return
    }
    if (type.endsWith('_output') || type === 'function_call_output' || type === 'custom_tool_call_output') {
      const id = toolIdFromPayload(payload, this.nextToolId('result'))
      this.messages.push(toolResultBlock(id, toolResultFromPayload(payload), isErrorPayload(payload)))
    }
  }

  private consumeEventMessage(payload: RecordValue, timestamp: unknown): void {
    const type = stringValue(payload.type)
    if (type === 'task_started') {
      this.status = 'running'
      this.sessionId = this.sessionId || stringValue(payload.session_id) || stringValue(payload.thread_id)
    } else if (type === 'user_message') this.addUser(stringValue(payload.message) || stringValue(payload.text), timestamp)
    else if (type === 'agent_message') this.addAssistantText(stringValue(payload.message) || stringValue(payload.text), timestamp)
    else if (type === 'task_complete') {
      this.addAssistantText(stringValue(payload.last_agent_message), timestamp)
      this.status = 'completed'
    } else if (type === 'token_count') {
      return
    } else if (type === 'turn_aborted') {
      this.addError(stringValue(payload.reason) || '运行已中断', timestamp, true)
    } else if (type === 'error') {
      this.addError(stringValue(payload.message) || stringValue(payload.codex_error_info), timestamp)
    } else if (type === 'dynamic_tool_call_request') {
      this.addToolCall(toolNameFromPayload(payload, type), toolInputFromPayload(payload), timestamp, toolIdFromPayload(payload, this.nextToolId('call')))
    } else if (type === 'exec_command_end' || type.endsWith('_call_end') || type.endsWith('_response') || type === 'patch_apply_end' || type === 'web_search_end') {
      this.messages.push(toolResultBlock(toolIdFromPayload(payload, this.nextToolId('result')), toolResultFromPayload(payload), isErrorPayload(payload)))
    } else if (type === 'context_compacted') this.addCompactBoundary(timestamp)
  }

  private addCompactBoundary(timestamp: unknown): void {
    this.messageIndex += 1
    const compact = {
      type: 'system',
      subtype: 'compact_boundary',
      session_id: this.sessionId,
      _createdAt: timestampValue(timestamp),
      uuid: `working-system-${this.messageIndex}`,
    } as SDKSystemMessage
    this.messages.push(compact)
  }

  private consumeItem(event: RecordValue, timestamp: unknown): void {
    const item = isRecord(event.item) ? event.item : {}
    const type = stringValue(item.type)
    if (type === 'agent_message') this.addAssistantText(stringValue(item.text), timestamp)
    else if (type === 'reasoning') this.addThinking(textFromContent(item.summary) || stringValue(item.text), timestamp)
    else if (type === 'command_execution') {
      const input = { command: stringValue(item.command) || stringValue(item.command_line) || stringValue(item.cmd) }
      this.addToolCall('Bash', input, timestamp, stringValue(item.id) || undefined, toolResultFromPayload(item), isErrorPayload(item))
    } else if (type === 'file_change' || type === 'file_changes') this.addFileChange(item, timestamp)
    else if (type === 'todo_list') this.addTodo(item, timestamp)
    else if (type === 'context_compaction' || type === 'contextCompaction') this.addCompactBoundary(timestamp)
    else if (type === 'web_search') this.addToolCall('WebSearch', { query: stringValue(item.query) }, timestamp, stringValue(item.id) || undefined, toolResultFromPayload(item), isErrorPayload(item))
    else if (type.endsWith('_call') || type === 'function_call' || type === 'custom_tool_call') this.addToolCall(toolNameFromPayload(item, type), toolInputFromPayload(item), timestamp, toolIdFromPayload(item, this.nextToolId('call')))
    else if (type.endsWith('_output') || type === 'function_call_output' || type === 'custom_tool_call_output') this.messages.push(toolResultBlock(toolIdFromPayload(item, this.nextToolId('result')), toolResultFromPayload(item), isErrorPayload(item)))
    else if (type === 'error') this.addError(stringValue(item.message) || stringValue(item.error), timestamp)
  }

  consume(event: RecordValue): void {
    const eventType = stringValue(event.type)
    const timestamp = event.timestamp ?? event.created_at
    if (eventType === 'codex.jsonl' && typeof event.raw === 'string') {
      try {
        this.consume(JSON.parse(event.raw) as RecordValue)
      } catch {
        this.diagnostics.push({ line: 0, message: '嵌套 JSONL 无法解析', raw: event.raw })
      }
      return
    }
    if (eventType === 'session_meta') {
      const payload = isRecord(event.payload) ? event.payload : {}
      this.sessionId = stringValue(payload.session_id) || stringValue(event.session_id) || this.sessionId
      return
    }
    if (eventType === 'world_state' || eventType === 'turn_context') return
    if (eventType === 'thread.started' || eventType === 'turn.started' || eventType === 'task_started') {
      this.status = 'running'
      this.sessionId = this.sessionId || stringValue(event.thread_id) || stringValue(event.session_id)
      return
    }
    if (eventType === 'response_item') {
      this.consumeResponseItem(isRecord(event.payload) ? event.payload : {}, timestamp)
      return
    }
    if (eventType === 'event_msg') {
      this.consumeEventMessage(isRecord(event.payload) ? event.payload : {}, timestamp)
      return
    }
    if (eventType === 'item.completed') {
      this.consumeItem(event, timestamp)
      return
    }
    if (eventType === 'turn.completed') {
      this.status = 'completed'
      const usage = isRecord(event.usage) ? event.usage : undefined
      this.messageIndex += 1
      this.messages.push(makeResult(this.messageIndex, timestampValue(timestamp), this.sessionId, 'success', usage))
      return
    }
    if (eventType === 'turn.failed' || eventType === 'error') {
      const error = isRecord(event.error) ? stringValue(event.error.message) : ''
      this.addError(error || stringValue(event.message) || stringValue(event.error), timestamp)
      return
    }
    if (eventType === 'interrupted' || eventType === 'turn.aborted') {
      this.addError(stringValue(event.reason) || '运行已中断', timestamp, true)
    }
  }
}

/** 解析 Working 后端返回的 Codex JSONL，并转换成 Copis Agent 可直接渲染的 SDKMessage。 */
export function parseWorkingSessionHistory(jsonl: string | undefined): WorkingHistoryParseResult {
  const parser = new WorkingHistoryParser()
  const lines = (jsonl ?? '').split(/\r?\n/)
  lines.forEach((raw, index) => {
    const line = raw.trim()
    if (!line) return
    try {
      const event: unknown = JSON.parse(line)
      if (!isRecord(event)) return
      parser.consume(event)
    } catch (error) {
      parser.diagnostics.push({
        line: index + 1,
        message: error instanceof Error ? error.message : 'JSONL 解析失败',
        raw,
      })
    }
  })
  return {
    sessionId: parser.sessionId,
    status: parser.status,
    messages: parser.messages,
    diagnostics: parser.diagnostics,
  }
}
