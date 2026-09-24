import type { ChatRoomSummary } from '@copis/shared'
import { closeChatRoomTab, type TabItem } from '@/atoms/tab-atoms'
import type { ChatRoomApi } from '@/lib/chatroom-api'

type SidebarRoom = Pick<ChatRoomSummary, 'roomId' | 'hostUserId'>
export type ChatRoomCloseAction = 'delete' | 'leave' | 'local'

export function getChatRoomCloseAction(room: SidebarRoom, currentUserId: string | undefined): ChatRoomCloseAction {
  if (!room.roomId.trim()) return 'local'
  return currentUserId && room.hostUserId === currentUserId ? 'delete' : 'leave'
}

export async function closeSidebarChatRoom(input: {
  room: SidebarRoom
  currentUserId: string | undefined
  getCurrentUserId: () => string | undefined
  isRoomCurrent: () => boolean
  api: Pick<ChatRoomApi, 'deleteRoom' | 'leaveRoom'>
  getTabs: () => TabItem[]
  getActiveTabId: () => string | null
  removeRoom: (roomId: string) => void
  setTabs: (tabs: TabItem[]) => void
  setActiveTabId: (id: string | null) => void
}): Promise<void> {
  const action = getChatRoomCloseAction(input.room, input.currentUserId)
  if (action !== 'local') {
    if (!input.currentUserId || input.getCurrentUserId() !== input.currentUserId || !input.isRoomCurrent()) {
      throw new Error('聊天室账号或房间已变更，请重新操作')
    }
    if (action === 'delete') await input.api.deleteRoom(input.room.roomId)
    else await input.api.leaveRoom(input.room.roomId)
    // 远端请求完成时可能已经切换账号，不能清理新账号的聊天室状态。
    if (input.getCurrentUserId() !== input.currentUserId || !input.isRoomCurrent()) return
  }

  input.removeRoom(input.room.roomId)
  const next = closeChatRoomTab(input.getTabs(), input.getActiveTabId(), input.room.roomId)
  input.setTabs(next.tabs)
  input.setActiveTabId(next.activeTabId)
}
