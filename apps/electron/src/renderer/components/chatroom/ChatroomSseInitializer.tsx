import { useEffect, useRef } from 'react'
import { useAtomValue, useSetAtom, useStore } from 'jotai'
import { chatRoomApplyEventAtom, chatRoomConnectionStatusAtom, chatRoomRoomsAtom } from '../../atoms/chatroom-atoms'
import { ChatRoomSseClient } from '../../lib/chatroom-sse'
import { workingAuthStateAtom } from '../../atoms/working-atoms'

/** 主窗口级聊天室实时订阅；ChatroomView 卸载不会关闭此连接。 */
export function ChatroomSseInitializer(): null {
  const rooms = useAtomValue(chatRoomRoomsAtom)
  const authState = useAtomValue(workingAuthStateAtom)
  const setEvent = useSetAtom(chatRoomApplyEventAtom)
  const setStatus = useSetAtom(chatRoomConnectionStatusAtom)
  const store = useStore()
  const clientRef = useRef<ChatRoomSseClient>()
  useEffect(() => {
    const client = new ChatRoomSseClient()
    clientRef.current = client
    const offEvent = client.onEvent((event) => store.set(chatRoomApplyEventAtom, event))
    const offStatus = client.onStatus((status) => { for (const room of store.get(chatRoomRoomsAtom)) store.set(chatRoomConnectionStatusAtom, (current) => new Map(current).set(room.roomId, status)) })
    client.setRooms(rooms.map((room) => room.roomId))
    return () => { offEvent(); offStatus(); client.close() }
  }, [setEvent, setStatus, store])
  useEffect(() => { clientRef.current?.setRooms(rooms.map((room) => room.roomId)) }, [rooms])
  useEffect(() => { if (authState?.authenticated) clientRef.current?.resume() }, [authState?.authenticated])
  return null
}
