import type { MemoryPolicy, SDKMessage } from '@copis/shared'

export interface RpcMemoryRun {
  sessionId: string
  userMessage: string
  workspaceSlug?: string
  memoryPolicy: MemoryPolicy
  triggeredBy?: 'user' | 'automation' | 'delegation'
}

export interface RpcMemoryRunOutcome {
  stoppedByUser: boolean
  resultSubtype?: string
  resultErrors?: string[]
  compactRequest?: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function textFromContent(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (!Array.isArray(value)) return ''
  return value
    .filter(isRecord)
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => String(block.text).trim())
    .filter(Boolean)
    .join('\n')
    .trim()
}

export function shouldCaptureRpcRun(outcome: RpcMemoryRunOutcome): boolean {
  if (outcome.stoppedByUser || outcome.compactRequest) return false
  if (outcome.resultSubtype === 'aborted' || outcome.resultSubtype === 'empty_response') return false
  if (outcome.resultSubtype?.startsWith('error')) return false
  return !outcome.resultErrors || outcome.resultErrors.length === 0
}

export function extractLastRpcAssistantReply(messages: readonly SDKMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const record = messages[index] as unknown as Record<string, unknown>
    if (!isRecord(record)) continue
    const message = isRecord(record.message) ? record.message : undefined
    if (record.type !== 'assistant' && message?.role !== 'assistant') continue
    const content = textFromContent(message?.content ?? record.content)
    if (content) return content
  }
  return undefined
}

export function buildRpcMemoryTurn(
  run: RpcMemoryRun,
  messages: readonly SDKMessage[],
): {
  sessionId: string
  workspaceSlug: string
  userInput: string
  assistantReply: string
  autonomous: boolean
  memoryPolicy: MemoryPolicy
} | undefined {
  if (!run.workspaceSlug || run.memoryPolicy !== 'writable' || !run.userMessage.trim()) return undefined
  const assistantReply = extractLastRpcAssistantReply(messages)
  if (!assistantReply) return undefined
  return {
    sessionId: run.sessionId,
    workspaceSlug: run.workspaceSlug,
    userInput: run.userMessage.trim(),
    assistantReply,
    autonomous: run.triggeredBy === 'automation' || run.triggeredBy === 'delegation',
    memoryPolicy: run.memoryPolicy,
  }
}
