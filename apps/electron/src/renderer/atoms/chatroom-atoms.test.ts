import { describe, expect, test } from 'bun:test'
import { createStore } from 'jotai/vanilla'
import { chatRoomActiveRoomIdAtom, chatRoomApplyEventAtom, chatRoomMessagesAtom, chatRoomUnreadCountsAtom } from './chatroom-atoms'
describe('chatRoomAtoms', () => {
  test('同一 roomId 的消息与未读互不污染', () => { const store = createStore(); store.set(chatRoomActiveRoomIdAtom, 'r2'); store.set(chatRoomApplyEventAtom, { type: 'message.created', roomId: 'r1', seq: 1, payload: { messageId: 'm1' } }); store.set(chatRoomApplyEventAtom, { type: 'message.created', roomId: 'r2', seq: 1, payload: { messageId: 'm2' } }); expect(store.get(chatRoomMessagesAtom).get('r1')).toHaveLength(1); expect(store.get(chatRoomMessagesAtom).get('r2')).toHaveLength(1); expect(store.get(chatRoomUnreadCountsAtom).get('r1')).toBe(1); expect(store.get(chatRoomUnreadCountsAtom).get('r2')).toBeUndefined() })
})
