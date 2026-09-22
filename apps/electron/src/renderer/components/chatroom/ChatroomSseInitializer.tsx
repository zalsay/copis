import { useEffect, useRef } from 'react'
import { useAtomValue, useSetAtom, useStore } from 'jotai'
import { chatRoomApplyEventAtom, chatRoomConnectionStatusAtom, chatRoomPermissionRequestsAtom, chatRoomResetStateAtom, chatRoomRoomsAtom } from '../../atoms/chatroom-atoms'
import { ChatRoomSseClient } from '../../lib/chatroom-sse'
import { chatRoomApi } from '../../lib/chatroom-api'
import { workingAuthStateAtom } from '../../atoms/working-atoms'
import type { WorkingAuthState } from '@copis/shared'

export function getChatRoomAccountKey(state: WorkingAuthState | null): string {
  if (!state?.authenticated) return 'anonymous'
  const accountId = state.user?.id ?? state.user?.userId
  return accountId === undefined || accountId === null ? 'authenticated' : `authenticated:${String(accountId)}`
}

export function shouldSubscribeChatRoomRooms(accountKey: string, subscribedAccountKey: string | undefined): boolean {
  return accountKey !== 'anonymous' && subscribedAccountKey === accountKey
}

/** 主窗口级聊天室实时订阅；ChatroomView 卸载不会关闭此连接。 */
export function ChatroomSseInitializer(): null {
  const rooms = useAtomValue(chatRoomRoomsAtom)
  const authState = useAtomValue(workingAuthStateAtom)
  const resetState = useSetAtom(chatRoomResetStateAtom)
  const store = useStore()
  const clientRef = useRef<ChatRoomSseClient>()
  const loadRequestRef = useRef(0)
  const previousAccountKeyRef = useRef<string>()
  const subscribedAccountKeyRef = useRef<string>()
  const accountKey = getChatRoomAccountKey(authState)
  useEffect(() => {
    const requestId = ++loadRequestRef.current
    const accountChanged = previousAccountKeyRef.current !== accountKey
    previousAccountKeyRef.current = accountKey
    if (accountChanged) subscribedAccountKeyRef.current = undefined
    const client = new ChatRoomSseClient()
    clientRef.current = client
    const offEvent = client.onEvent((event) => store.set(chatRoomApplyEventAtom, event))
    const offStatus = client.onStatus((status) => { for (const room of store.get(chatRoomRoomsAtom)) store.set(chatRoomConnectionStatusAtom, (current) => new Map(current).set(room.roomId, status)) })
    if (accountChanged || accountKey === 'anonymous') {
      resetState()
    }
    if (accountKey !== 'anonymous') {
      void chatRoomApi.listRooms().then((nextRooms) => {
        if (requestId !== loadRequestRef.current || getChatRoomAccountKey(store.get(workingAuthStateAtom)) !== accountKey) return
        store.set(chatRoomRoomsAtom, nextRooms)
        client.setRooms(nextRooms.map((room) => room.roomId))
        subscribedAccountKeyRef.current = accountKey
      }).catch(() => {
        if (requestId === loadRequestRef.current && getChatRoomAccountKey(store.get(workingAuthStateAtom)) === accountKey) client.close()
      })
    }
    return () => { offEvent(); offStatus(); client.close() }
  }, [accountKey, resetState, store])
  useEffect(() => {
    return window.electronAPI.chatrooms.onPermissionRequested((request) => {
      const currentAuth = store.get(workingAuthStateAtom)
      if (!currentAuth?.authenticated) return
      store.set(chatRoomPermissionRequestsAtom, (current) => new Map(current).set(request.requestId, request))
    })
  }, [store])
  useEffect(() => {
    if (!shouldSubscribeChatRoomRooms(accountKey, subscribedAccountKeyRef.current)) {
      if (accountKey !== 'anonymous') subscribedAccountKeyRef.current = accountKey
      return
    }
    clientRef.current?.setRooms(store.get(chatRoomRoomsAtom).map((room) => room.roomId))
  }, [accountKey, rooms, store])
  return null
}
