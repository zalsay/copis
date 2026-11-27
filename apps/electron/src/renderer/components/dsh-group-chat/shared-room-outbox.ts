import { atom } from 'jotai'
import type { DshGroupChatMessage } from '@copis/shared'

// 待发项只存在于当前账号、房间的 Provider，不参与历史分页或事件游标计算。
export interface OutgoingAttachmentMessage {
  key: string
  text: string
  target?: string
  files: File[]
  ids: string[]
  createdAt: string
  phase: 'uploading' | 'sending' | 'failed'
  error?: string
}
export const roomOutboxAtom = atom<OutgoingAttachmentMessage[]>([])
export type RoomDisplayMessage = DshGroupChatMessage & { outgoing?: OutgoingAttachmentMessage }
export function displayOutgoing(row: OutgoingAttachmentMessage, roomId: string, userId: string): RoomDisplayMessage {
  return { id: `local:${row.key}`, groupId: roomId, seq: 0, kind: 'user', text: row.text, authorUserId: userId,
    authorName: null, agentId: null, agentName: null, createdAt: row.createdAt, mentions: [], outgoing: row }
}

// 服务端的附件 ID 只能绑定一条消息。事件或历史先于 HTTP 回执到达时同样可以确认发送。
export function reconcileOutbox(rows: OutgoingAttachmentMessage[], incoming: DshGroupChatMessage[], userId: string) {
  if (!rows.length) return rows
  const own = incoming.filter(m => m.kind === 'user' && m.authorUserId === userId && m.attachmentIds?.length)
  const next = rows.filter(row => !(row.ids.length === row.files.length && own.some(m =>
    m.attachmentIds!.length === row.ids.length && row.ids.every(id => m.attachmentIds!.includes(id)))))
  return next.length === rows.length ? rows : next
}
