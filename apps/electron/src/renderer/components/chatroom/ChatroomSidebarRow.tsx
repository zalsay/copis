import type { ChatRoomConnectionStatus, ChatRoomSummary } from '@copis/shared'
import { UsersRound, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ChatRoomCloseAction } from './chatroom-sidebar-close'

export function ChatroomSidebarRow({ room, connectionStatus, action, busy, active = false, onOpen, onRequestClose }: {
  room: ChatRoomSummary
  connectionStatus?: ChatRoomConnectionStatus
  action: ChatRoomCloseAction
  busy: boolean
  active?: boolean
  onOpen: () => void
  onRequestClose: () => void
}): React.ReactElement {
  const closeLabel = action === 'delete' ? `删除聊天室「${room.name}」` : action === 'leave' ? `退出聊天室「${room.name}」` : '移除无效聊天室入口'
  const status = connectionStatus ?? room.connectionStatus
  return (
    <div className={cn('copis-working-chatroom-entry', active && 'active')}>
      <button type="button" className="copis-working-chatroom-row" onClick={onOpen}>
        <UsersRound className="copis-working-chatroom-icon" aria-hidden="true" />
        <span className="copis-working-chatroom-copy">
          <span className="copis-working-chatroom-name">{room.name}</span>
          <small>{status === 'connected' ? '已连接' : status === 'reconnecting' ? '重连中' : '离线'}{room.unreadCount ? ` · ${room.unreadCount} 条未读` : ''}</small>
        </span>
      </button>
      <button type="button" className="copis-working-chatroom-close" aria-label={closeLabel} title={closeLabel} disabled={busy} onClick={(event) => { event.stopPropagation(); onRequestClose() }}>
        <X aria-hidden="true" />
      </button>
    </div>
  )
}
