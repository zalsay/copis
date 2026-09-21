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
// 包裹符号不属于路径 component，作为 terminator 保留在原文中。
const PATH_COMPONENT = String.raw`[^\s/\\:*?"'<>|\[\](){}]+`
const PATH_DIRECTORY = `${PATH_COMPONENT}(?:[ \t]+${PATH_COMPONENT})*`
const PATH_FILE = `(?:${PATH_COMPONENT}(?:[ \t]+${PATH_COMPONENT})*\\.${PATH_COMPONENT}|${PATH_COMPONENT})`
const PATH_TERMINATOR = String.raw`[\s,.;:!?，。！？、；："'\[\](){}]`
const FILE_URI_PATH = new RegExp(`(file://)/(?:${PATH_DIRECTORY}/)*${PATH_FILE}(?=$|${PATH_TERMINATOR})`, 'giu')
const POSIX_PATH = new RegExp(`(^|[^\\w:/\\]])/(?:${PATH_DIRECTORY}/)*${PATH_FILE}(?=$|${PATH_TERMINATOR})`, 'gu')
const WINDOWS_PATH = new RegExp(`(^|[^\\w])(?:[A-Za-z]:[\\\\/])(?:${PATH_DIRECTORY}[\\\\/])*${PATH_FILE}(?=$|${PATH_TERMINATOR})`, 'gu')

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
  const replacePath = (match: string, prefix: string): string => {
    const path = match.slice(prefix.length)
    const trailing = path.match(/[.,;:!?，。！？、；：]+$/u)?.[0] ?? ''
    return `${prefix}${PATH_PLACEHOLDER}${trailing}`
  }
  const fileUris = value.replace(FILE_URI_PATH, replacePath)
  const windows = fileUris.replace(WINDOWS_PATH, replacePath)
  return windows.replace(POSIX_PATH, replacePath)
}

function replaceSecrets(value: string, secrets: string[]): string {
  return [...new Set(secrets)]
    .filter((secret) => secret.length > 0)
    .sort((left, right) => right.length - left.length)
    .reduce((result, secret) => result.replace(new RegExp(escapeRegExp(secret), 'g'), SECRET_PLACEHOLDER), value)
}

function truncateUtf8(value: string, maxBytes = MAX_OUTPUT_BYTES): string {
  const encoded = new TextEncoder().encode(value)
  if (encoded.byteLength <= maxBytes) return value
  let end = maxBytes
  const decoder = new TextDecoder('utf-8', { fatal: true })
  while (end > 0) {
    try {
      return decoder.decode(encoded.slice(0, end))
    } catch {
      end -= 1
    }
  }
  return ''
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code >= 0xD800 && code <= 0xDBFF) {
      const next = value.charCodeAt(index + 1)
      if (next >= 0xDC00 && next <= 0xDFFF) {
        index += 1
        continue
      }
      return true
    }
    if (code >= 0xDC00 && code <= 0xDFFF) return true
  }
  return false
}

function getOverlappingSensitiveValues(roots: string[], secrets: string[]): string[] {
  return secrets.filter((secret) => roots.some((root) => root.includes(secret) || secret.includes(root)))
}

function sanitizeText(value: string, context: ChatRoomOutputSanitizerContext, maxBytes = MAX_OUTPUT_BYTES): string {
  let sanitized = normalizeText(value)
  if (hasUnpairedSurrogate(sanitized)) return CLEAN_PLACEHOLDER
  sanitized = replaceSecrets(sanitized, getOverlappingSensitiveValues(context.executionRoots, context.sensitiveValues))
  sanitized = replaceKnownRoots(sanitized, context.executionRoots)
  sanitized = replaceGenericPaths(sanitized)
  sanitized = replaceSecrets(sanitized, context.sensitiveValues)
  sanitized = truncateUtf8(sanitized, maxBytes)
  return sanitized.trim().length > 0 ? sanitized : CLEAN_PLACEHOLDER
}

/** 聊天室所有增量/摘要文本共用的安全边界。 */
export function sanitizeChatRoomText(
  value: string,
  context: ChatRoomOutputSanitizerContext,
  maxBytes = 16 * 1024,
): string {
  return sanitizeText(value, context, maxBytes)
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
