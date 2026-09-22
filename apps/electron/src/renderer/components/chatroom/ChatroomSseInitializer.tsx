import { useEffect, useRef } from 'react'
import { useAtomValue, useSetAtom, useStore } from 'jotai'
import { chatRoomApplyEventAtom, chatRoomConnectionStatusAtom, chatRoomResetStateAtom, chatRoomRoomsAtom } from '../../atoms/chatroom-atoms'
import { ChatRoomSseClient } from '../../lib/chatroom-sse'
import { chatRoomApi } from '../../lib/chatroom-api'
import { workingAuthStateAtom } from '../../atoms/working-atoms'
import type { WorkingAuthState } from '@copis/shared'

export function getChatRoomAccountKey(state: WorkingAuthState | null): string {
  if (!state?.authenticated) return 'anonymous'
  const accountId = state.user?.id ?? state.user?.userId
  return accountId === undefined || accountId === null ? 'authenticated' : `authenticated:${String(accountId)}`
}

/** 主窗口级聊天室实时订阅；ChatroomView 卸载不会关闭此连接。 */
export function ChatroomSseInitializer(): null {
  const rooms = useAtomValue(chatRoomRoomsAtom)
  const authState = useAtomValue(workingAuthStateAtom)
  const resetState = useSetAtom(chatRoomResetStateAtom)
  const store = useStore()
  const clientRef = useRef<ChatRoomSseClient>()
  const loadRequestRef = useRef(0)
  const accountKey = getChatRoomAccountKey(authState)
  useEffect(() => {
    const requestId = ++loadRequestRef.current
    const client = new ChatRoomSseClient()
    clientRef.current = client
    const offEvent = client.onEvent((event) => store.set(chatRoomApplyEventAtom, event))
    const offStatus = client.onStatus((status) => { for (const room of store.get(chatRoomRoomsAtom)) store.set(chatRoomConnectionStatusAtom, (current) => new Map(current).set(room.roomId, status)) })
    if (accountKey === 'anonymous') {
      resetState()
    } else {
      void chatRoomApi.listRooms().then((nextRooms) => {
        if (requestId !== loadRequestRef.current || getChatRoomAccountKey(store.get(workingAuthStateAtom)) !== accountKey) return
        store.set(chatRoomRoomsAtom, nextRooms)
        client.setRooms(nextRooms.map((room) => room.roomId))
      }).catch(() => {
        if (requestId === loadRequestRef.current && getChatRoomAccountKey(store.get(workingAuthStateAtom)) === accountKey) client.close()
      })
    }
    return () => { offEvent(); offStatus(); client.close() }
  }, [accountKey, resetState, store])
  useEffect(() => {
    if (accountKey === 'anonymous') return
    clientRef.current?.setRooms(store.get(chatRoomRoomsAtom).map((room) => room.roomId))
  }, [accountKey, rooms, store])
  return null
}
