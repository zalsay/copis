import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { Copy, Users } from 'lucide-react'
import { chatRoomApi } from '@/lib/chatroom-api'
import { chatRoomActiveRoomIdAtom, chatRoomConnectionStatusAtom, chatRoomDetailsAtom, chatRoomMarkReadAtom, chatRoomMessagesAtom, chatRoomRoomsAtom } from '@/atoms/chatroom-atoms'
import { ChatroomComposer } from './ChatroomComposer'
import { ChatroomMembersPanel } from './ChatroomMembersPanel'
import type { ChatRoomAgent, ChatRoomMember, ChatRoomSummary } from '@copis/shared'

export interface ChatroomViewProps { roomId: string }
type Details = { room: ChatRoomSummary; members: ChatRoomMember[]; agents: ChatRoomAgent[] }

export function ChatroomView({ roomId }: ChatroomViewProps): React.ReactElement {
  const rooms = useAtomValue(chatRoomRoomsAtom)
  const status = useAtomValue(chatRoomConnectionStatusAtom).get(roomId) ?? rooms.find((r) => r.roomId === roomId)?.connectionStatus ?? 'offline'
  const messages = useAtomValue(chatRoomMessagesAtom).get(roomId) ?? []
  const detailsRaw = useAtomValue(chatRoomDetailsAtom)[roomId] as Details | undefined
  const setDetails = useSetAtom(chatRoomDetailsAtom)
  const setMessages = useSetAtom(chatRoomMessagesAtom)
  const setActive = useSetAtom(chatRoomActiveRoomIdAtom)
  const markRead = useSetAtom(chatRoomMarkReadAtom)
  const room = detailsRaw?.room ?? rooms.find((item) => item.roomId === roomId) ?? { roomId, name: '聊天室', role: 'member', status: 'active', memberCount: 0, unreadCount: 0, connectionStatus: status }
  const [showMembers, setShowMembers] = React.useState(true)
  React.useEffect(() => { setActive(roomId); markRead(roomId); return () => { setActive(undefined) } }, [roomId, setActive, markRead])
  React.useEffect(() => { let alive = true; void Promise.all([chatRoomApi.getRoom(roomId), chatRoomApi.getMessages(roomId, { limit: 100 })]).then(([detail, history]) => { if (!alive) return; setDetails((current) => ({ ...current, [roomId]: detail })); setMessages((current) => new Map(current).set(roomId, history.messages)) }).catch((error) => { console.warn('[聊天室] 加载失败:', error) }); return () => { alive = false } }, [roomId, setDetails, setMessages])
  const details = detailsRaw ?? { room, members: [], agents: [] }
  return <div className="flex h-full min-h-0 flex-col bg-background">
    <header className="flex shrink-0 items-center justify-between border-b border-border/50 px-4 py-3"><div className="min-w-0"><div className="flex items-center gap-2"><h1 className="truncate text-sm font-semibold">{room.name}</h1><span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">{room.role === 'host' ? '主理人' : '成员'}</span></div><div className="mt-1 flex items-center gap-3 text-[11px] text-muted-foreground"><span>成员 {room.memberCount}</span>{room.shareCode && <button type="button" aria-label="复制分享码" className="inline-flex items-center gap-1 hover:text-foreground" onClick={() => void navigator.clipboard?.writeText(room.shareCode!)}>分享码 {room.shareCode}<Copy className="size-3" /></button>}<span role="status">{status === 'connected' ? '已连接' : status === 'reconnecting' ? '重连中' : status === 'auth_expired' ? '登录已过期' : '离线'}</span></div></div><button type="button" aria-label="显示成员" onClick={() => setShowMembers((value) => !value)} className="rounded-lg p-2 hover:bg-muted"><Users className="size-4" /></button></header>
    <div className="flex min-h-0 flex-1"><main className="flex min-w-0 flex-1 flex-col"><div className="min-h-0 flex-1 overflow-y-auto p-4 space-y-3">{messages.length === 0 ? <div className="flex h-full items-center justify-center text-xs text-muted-foreground">还没有消息，邀请 Agent 一起开始讨论</div> : messages.map((message) => <article key={message.messageId || `${message.seq}-${message.clientMessageId}`} className={`max-w-[85%] rounded-2xl px-3 py-2 shadow-sm ${message.senderType === 'user' ? 'ml-auto bg-primary text-primary-foreground' : message.senderType === 'agent' ? 'bg-muted' : 'mx-auto bg-muted/40 text-muted-foreground'}`}><div className="mb-1 text-[10px] opacity-70">{message.senderType === 'agent' ? 'Agent' : message.senderType === 'user' ? '我' : '系统'}</div><div className="whitespace-pre-wrap break-words text-sm">{message.content}</div></article>)}</div><ChatroomComposer roomId={roomId} agents={details.agents} archived={room.status !== 'active'} connectionStatus={status} /></main>{showMembers && <ChatroomMembersPanel role={room.role} members={details.members} agents={details.agents} />}</div>
  </div>
}
