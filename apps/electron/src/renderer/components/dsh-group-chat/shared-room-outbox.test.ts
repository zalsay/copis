import { expect, test } from 'bun:test'
import { displayOutgoing, reconcileOutbox, type OutgoingAttachmentMessage } from './shared-room-outbox'

test('事件早于发送回执时只确认本人的同一批附件，不按相似文本或未完成的上传猜测', () => {
  const row: OutgoingAttachmentMessage = { key:'client1', text:'同一段文本', files:[new File([], 'a'), new File([], 'b')],
    ids:['a','b'], phase:'sending', createdAt:new Date().toISOString() }
  const message = { ...displayOutgoing(row, 'room', '11'), id:'server1', attachmentIds:['b','a'] }
  const rows = [row]
  expect(reconcileOutbox(rows, [{...message,authorUserId:'22'}], '11')).toBe(rows)
  expect(reconcileOutbox(rows, [{...message,attachmentIds:['c','d']}], '11')).toBe(rows)
  expect(reconcileOutbox(rows, [{...message,attachmentIds:['a']},{...message,attachmentIds:['b']}], '11')).toBe(rows)
  expect(reconcileOutbox(rows, [message], '11')).toEqual([])
  expect(reconcileOutbox([{...row,ids:['a']}], [message], '11')).toHaveLength(1)
})
