import { isChatRoomAgentOutput, type ChatRoomAgentOutput } from '@copis/shared'

export interface ChatRoomOutputSanitizerContext {
  executionRoots: string[]
  sensitiveValues: string[]
  allowedAgentIds: string[]
  allowedAttachmentIds: string[]
}

const MAX_OUTPUT_BYTES = 64 * 1024
const CLEAN_PLACEHOLDER = '[内容已清理]'
const PATH_PLACEHOLDER = '[本地路径已隐藏]'
const SECRET_PLACEHOLDER = '[敏感信息已隐藏]'
const ANSI_ESCAPE = /\u001B(?:\][^\u0007]*(?:\u0007|\u001B\\)|\[[0-?]*[ -/]*[@-~])/g
const POSIX_PATH = /(^|[^\w:\]])\/(?:[A-Za-z0-9._~@%+-]+\/)*[A-Za-z0-9._~@%+-]+/g
const WINDOWS_PATH = /(^|[^\w])(?:[A-Za-z]:[\\/])(?:[^\s\\/:*?"<>|]+[\\/])*[^\s\\/:*?"<>|]+/g

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function normalizeText(value: string): string {
  return value.replace(/\r\n?/g, '\n').replace(ANSI_ESCAPE, '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '')
}

function replaceKnownRoots(value: string, roots: string[]): string {
  return [...new Set(roots)]
    .filter((root) => root.length > 0)
    .sort((left, right) => right.length - left.length)
    .reduce((result, root) => result.replace(new RegExp(escapeRegExp(root), 'g'), PATH_PLACEHOLDER), value)
}

function replaceGenericPaths(value: string): string {
  const windows = value.replace(WINDOWS_PATH, (match, prefix: string) => `${prefix}${PATH_PLACEHOLDER}`)
  return windows.replace(POSIX_PATH, (match, prefix: string) => `${prefix}${PATH_PLACEHOLDER}`)
}

function replaceSecrets(value: string, secrets: string[]): string {
  return [...new Set(secrets)]
    .filter((secret) => secret.length > 0)
    .sort((left, right) => right.length - left.length)
    .reduce((result, secret) => result.replace(new RegExp(escapeRegExp(secret), 'g'), SECRET_PLACEHOLDER), value)
}

function truncateUtf8(value: string): string {
  const encoded = new TextEncoder().encode(value)
  if (encoded.byteLength <= MAX_OUTPUT_BYTES) return value
  let end = MAX_OUTPUT_BYTES
  while (end > 0 && ((encoded[end] ?? 0) & 0xc0) === 0x80) end -= 1
  return new TextDecoder().decode(encoded.slice(0, end))
}

function sanitizeText(value: string, context: ChatRoomOutputSanitizerContext): string {
  let sanitized = normalizeText(value)
  sanitized = replaceKnownRoots(sanitized, context.executionRoots)
  sanitized = replaceGenericPaths(sanitized)
  sanitized = replaceSecrets(sanitized, context.sensitiveValues)
  sanitized = truncateUtf8(sanitized)
  return sanitized.length > 0 ? sanitized : CLEAN_PLACEHOLDER
}

function intersectIds(values: string[], allowed: string[]): string[] {
  const allow = new Set(allowed)
  const seen = new Set<string>()
  return values.filter((value) => allow.has(value) && !seen.has(value) && (seen.add(value), true))
}

export function parseAndSanitizeChatRoomAgentOutput(
  rawAssistantText: string,
  context: ChatRoomOutputSanitizerContext,
): ChatRoomAgentOutput {
  const trimmed = rawAssistantText.trim()
  let parsed: ChatRoomAgentOutput | undefined
  try {
    const candidate: unknown = JSON.parse(trimmed)
    if (isChatRoomAgentOutput(candidate)) parsed = candidate
  } catch {
    // 非结构化输出按普通文本展示，不暴露解析错误或原始内容日志。
  }
  const text = sanitizeText(parsed?.text ?? rawAssistantText, context)
  return {
    text,
    mentionedAgentIds: parsed ? intersectIds(parsed.mentionedAgentIds, context.allowedAgentIds) : [],
    attachmentIds: parsed ? intersectIds(parsed.attachmentIds, context.allowedAttachmentIds) : [],
  }
}
