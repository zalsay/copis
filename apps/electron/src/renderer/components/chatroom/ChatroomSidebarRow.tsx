import type { ChatRoomConnectionStatus, ChatRoomSummary } from '@copis/shared'
import { CheckCircle2, Circle, CircleAlert, Loader2, UsersRound, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ChatRoomCloseAction } from './chatroom-sidebar-close'

export function getChatRoomConnectionLabel(status: ChatRoomConnectionStatus): string {
  if (status === 'connected') return '已连接'
  if (status === 'connecting') return '连接中'
  if (status === 'reconnecting') return '重连中'
  if (status === 'auth_expired') return '登录已过期'
  return '离线'
}

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
  const statusLabel = getChatRoomConnectionLabel(status)
  return (
    <div className={cn('copis-working-chatroom-entry', active && 'active')}>
      <button type="button" className="copis-working-chatroom-row" onClick={onOpen}>
        <UsersRound className="copis-working-chatroom-icon" aria-hidden="true" />
        <span className="copis-working-chatroom-copy">
          <span className="copis-working-chatroom-title flex items-center gap-1.5 min-w-0">
            <span className="copis-working-chatroom-name">{room.name}</span>
            <span
              className="copis-working-chatroom-status inline-flex shrink-0 items-center"
              role="img"
              title={statusLabel}
              aria-label={statusLabel}
            >
              {status === 'connected' && (
                <CheckCircle2
                  className="copis-working-chatroom-status-icon size-3 text-emerald-500"
                  aria-hidden="true"
                />
              )}
              {status === 'connecting' && (
                <Loader2
                  className="copis-working-chatroom-status-icon size-3 animate-spin text-blue-500"
                  aria-hidden="true"
                />
              )}
              {status === 'reconnecting' && (
                <Loader2
                  className="copis-working-chatroom-status-icon size-3 animate-spin text-amber-500"
                  aria-hidden="true"
                />
              )}
              {status === 'auth_expired' && (
                <CircleAlert
                  className="copis-working-chatroom-status-icon size-3 text-amber-500/70"
                  aria-hidden="true"
                />
              )}
              {status === 'offline' && (
                <Circle
                  className="copis-working-chatroom-status-icon size-2.5 text-muted-foreground/35"
                  aria-hidden="true"
                />
              )}
            </span>
          </span>
          {Boolean(room.unreadCount) && (
            <small>{room.unreadCount} 条未读</small>
          )}
        </span>
      </button>
      <button type="button" className="copis-working-chatroom-close" aria-label={closeLabel} title={closeLabel} disabled={busy} onClick={(event) => { event.stopPropagation(); onRequestClose() }}>
        <X aria-hidden="true" />
      </button>
    </div>
  )
}
