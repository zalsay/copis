import { DSH_ROOM_ATTACHMENT_MAX_COUNT } from '@copis/shared/types'

export type RoomInvocation = { invocationId: string; text: string; attachmentIds?: string[] }

/** 只接受匹配群、发件人及显式提及的触发消息，不使用其他上下文中的附件。 */
export function readRoomInvocation(
  binding: { roomId: string; roomAgentId: string },
  value: unknown,
): RoomInvocation | null {
  if (!value || typeof value !== 'object') return null
  const event = value as Record<string, unknown>
  if (event.type !== 'agent.invocation' || event.roomId !== binding.roomId || !event.payload || typeof event.payload !== 'object') return null
  const payload = event.payload as Record<string, unknown>
  const id = payload.invocationId
  if (typeof id !== 'string' || (!id || Buffer.byteLength(id, 'utf8') > 64 || /[\p{Cc}\p{White_Space}/?#\\]/u.test(id)) || payload.targetAgentId !== binding.roomAgentId || typeof payload.triggerMessageId !== 'string' || !Array.isArray(payload.messages)) return null
  const matches = payload.messages.filter((message: unknown) => message && typeof message === 'object' && (message as Record<string, unknown>).messageId === payload.triggerMessageId)
  if (matches.length !== 1) return null
  const message = matches[0] as Record<string, unknown>
  const sender = message.sender as Record<string, unknown> | null
  const source = payload.sender as Record<string, unknown> | null
  if (payload.depth !== 0 || !source || source.type !== 'user' || typeof source.id !== 'string' || !source.id || !sender || sender.id !== source.id || !Array.isArray(message.mentionedAgentIds) || !message.mentionedAgentIds.includes(binding.roomAgentId) || sender.type !== 'user' || typeof message.text !== 'string' || !message.text.trim()) return null
  const ids = message.attachmentIds
  if (ids !== undefined && (!Array.isArray(ids) || ids.length > DSH_ROOM_ATTACHMENT_MAX_COUNT ||
      !ids.every(v => typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v)) || new Set(ids).size !== ids.length)) return null
  return { invocationId: id, text: message.text, ...(ids?.length ? { attachmentIds: ids } : {}) }
}
