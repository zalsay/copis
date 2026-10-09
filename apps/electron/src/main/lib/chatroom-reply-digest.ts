import { createHash } from 'node:crypto'
import type { ChatRoomAgentOutput } from '@copis/shared'

export interface ChatRoomReplyDigestInput extends ChatRoomAgentOutput {
  clientMessageId: string
}

function hasInvalidUnicodeOrControl(value: string, allowTextControls: boolean): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0)
    if (codePoint === undefined || (codePoint >= 0xd800 && codePoint <= 0xdfff)) return true
    const isControl = codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)
    return isControl && !(allowTextControls && (character === '\n' || character === '\r' || character === '\t'))
  })
}

function assertText(value: unknown, maxBytes: number, allowTextControls: boolean): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0 || Buffer.byteLength(value, 'utf8') > maxBytes
    || hasInvalidUnicodeOrControl(value, allowTextControls)) {
    throw new Error('聊天室回复摘要输入不正确')
  }
}

function assertId(value: unknown, maxBytes: number): asserts value is string {
  assertText(value, maxBytes, false)
  if (value.trim() !== value || /[\s/?#\\]/u.test(value)) throw new Error('聊天室回复摘要输入不正确')
}

function uniqueInOrder(values: string[]): string[] {
  return [...new Set(values)]
}

function goCompatibleStringify(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

function normalize(input: ChatRoomReplyDigestInput): ChatRoomReplyDigestInput {
  assertId(input.clientMessageId, 128)
  assertText(input.text, 64 * 1024, true)
  if (!Array.isArray(input.attachmentIds) || input.attachmentIds.length > 20
    || !Array.isArray(input.mentionedAgentIds) || input.mentionedAgentIds.length > 3) {
    throw new Error('聊天室回复摘要输入不正确')
  }
  input.attachmentIds.forEach((id) => assertId(id, 64))
  input.mentionedAgentIds.forEach((id) => assertId(id, 64))
  return {
    clientMessageId: input.clientMessageId,
    text: input.text,
    attachmentIds: uniqueInOrder(input.attachmentIds),
    mentionedAgentIds: uniqueInOrder(input.mentionedAgentIds),
  }
}

export function canonicalChatRoomReplyJson(input: ChatRoomReplyDigestInput): string {
  const value = normalize(input)
  return goCompatibleStringify({
    attachmentIds: value.attachmentIds,
    clientMessageId: value.clientMessageId,
    content: value.text,
    mentionAgentIds: value.mentionedAgentIds,
  })
}

export function computeChatRoomReplyDigest(input: ChatRoomReplyDigestInput): string {
  return createHash('sha256').update(canonicalChatRoomReplyJson(input), 'utf8').digest('hex')
}

export function normalizeChatRoomReplyOutput(input: ChatRoomAgentOutput): ChatRoomAgentOutput {
  return {
    text: input.text,
    attachmentIds: uniqueInOrder(input.attachmentIds),
    mentionedAgentIds: uniqueInOrder(input.mentionedAgentIds),
  }
}
