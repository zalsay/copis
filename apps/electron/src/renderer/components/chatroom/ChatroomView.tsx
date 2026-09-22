import * as React from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { Copy, Users } from 'lucide-react'
import { chatRoomApi } from '@/lib/chatroom-api'
import { chatRoomActiveRoomIdAtom, chatRoomConnectionStatusAtom, chatRoomDeletedRoomIdsAtom, chatRoomDetailsAtom, chatRoomHydrateMessagesAtom, chatRoomInvocationsAtom, chatRoomMarkReadAtom, chatRoomMessagesAtom, chatRoomRemoveRoomAtom, chatRoomRoomsAtom } from '@/atoms/chatroom-atoms'
import { activeTabIdAtom, closeChatRoomTab, tabsAtom } from '@/atoms/tab-atoms'
import { workingAuthStateAtom } from '@/atoms/working-atoms'
import { ChatroomComposer } from './ChatroomComposer'
import { ChatroomMembersPanel } from './ChatroomMembersPanel'
import type { ChatRoomAgent, ChatRoomAttachment, ChatRoomInvocation, ChatRoomMember, ChatRoomMessage, ChatRoomSummary } from '@copis/shared'

export interface ChatroomViewProps { roomId: string }
type Details = { room: ChatRoomSummary; members: ChatRoomMember[]; agents: ChatRoomAgent[] }

export function getChatRoomIdentityLabel(message: Pick<ChatRoomMessage, 'senderType' | 'senderId'>, currentUserId: string | undefined, members: ChatRoomMember[], agents: ChatRoomAgent[]): string {
  if (message.senderType === 'agent') return agents.find((agent) => agent.agentId === message.senderId)?.displayName || message.senderId || 'Agent'
  if (message.senderType === 'user') {
    if (currentUserId !== undefined && currentUserId === message.senderId) return '我'
    return members.find((member) => member.userId === message.senderId)?.displayName || message.senderId || '我'
  }
  return '系统'
}

export function getChatRoomInvocationTargetLabel(targetAgentId: string, agents: ChatRoomAgent[]): string {
  return agents.find((agent) => agent.agentId === targetAgentId)?.displayName || targetAgentId || 'Agent'
}

export function hasDurableChatRoomReply(messages: ChatRoomMessage[], invocation: Pick<ChatRoomInvocation, 'traceId' | 'targetAgentId'>): boolean {
  return Boolean(invocation.traceId && messages.some((message) => message.senderType === 'agent' && message.traceId === invocation.traceId && message.senderId === invocation.targetAgentId))
}

export async function deleteChatRoomAndClose(input: { roomId: string; deleteRoom: () => Promise<void>; removeRoom: (roomId: string) => void; tabs: Parameters<typeof closeChatRoomTab>[0]; activeTabId: string | null; setTabs: (tabs: Parameters<typeof closeChatRoomTab>[0]) => void; setActiveTabId: (activeTabId: string | null) => void }): Promise<void> {
  await input.deleteRoom()
  input.removeRoom(input.roomId)
  const next = closeChatRoomTab(input.tabs, input.activeTabId, input.roomId)
  input.setTabs(next.tabs)
  input.setActiveTabId(next.activeTabId)
}

export function ChatroomView({ roomId }: ChatroomViewProps): React.ReactElement {
  const rooms = useAtomValue(chatRoomRoomsAtom)
  const authState = useAtomValue(workingAuthStateAtom)
  const deletedRoomIds = useAtomValue(chatRoomDeletedRoomIdsAtom)
  const status = useAtomValue(chatRoomConnectionStatusAtom).get(roomId) ?? rooms.find((r) => r.roomId === roomId)?.connectionStatus ?? 'offline'
  const messages = useAtomValue(chatRoomMessagesAtom).get(roomId) ?? []
  const invocations = [...(useAtomValue(chatRoomInvocationsAtom).get(roomId)?.values() ?? [])]
  const detailsRaw = useAtomValue(chatRoomDetailsAtom)[roomId] as Details | undefined
  const setDetails = useSetAtom(chatRoomDetailsAtom)
  const hydrateMessages = useSetAtom(chatRoomHydrateMessagesAtom)
  const setActive = useSetAtom(chatRoomActiveRoomIdAtom)
  const removeRoom = useSetAtom(chatRoomRemoveRoomAtom)
  const markRead = useSetAtom(chatRoomMarkReadAtom)
  const [tabs, setTabs] = useAtom(tabsAtom)
  const [activeTabId, setActiveTabId] = useAtom(activeTabIdAtom)
  const deletedRoomIdsRef = React.useRef(deletedRoomIds)
  deletedRoomIdsRef.current = deletedRoomIds
  const room = detailsRaw?.room ?? rooms.find((item) => item.roomId === roomId) ?? { roomId, name: '聊天室', role: 'member', status: 'active', memberCount: 0, unreadCount: 0, connectionStatus: status }
  const [showMembers, setShowMembers] = React.useState(true)
  const [attachments, setAttachments] = React.useState<ChatRoomAttachment[]>([])
  const [actionError, setActionError] = React.useState('')
  React.useEffect(() => { setActive(roomId); const seq = messages.at(-1)?.seq ?? 0; markRead(roomId); if (seq > 0) void chatRoomApi.markRead(roomId, seq).catch(() => undefined); return () => { setActive(undefined) } }, [roomId, messages, setActive, markRead])
  React.useEffect(() => { let alive = true; void Promise.all([chatRoomApi.getRoom(roomId), chatRoomApi.getMessages(roomId, { limit: 100 }), chatRoomApi.listAttachments(roomId)]).then(([detail, history, nextAttachments]) => { if (!alive || deletedRoomIdsRef.current.has(roomId)) return; setDetails((current) => ({ ...current, [roomId]: detail })); hydrateMessages({ roomId, messages: history.messages, cursor: history.cursor }); setAttachments(nextAttachments) }).catch((error) => { if (alive && !deletedRoomIdsRef.current.has(roomId)) console.warn('[聊天室] 加载失败:', error) }); return () => { alive = false } }, [roomId, setDetails, hydrateMessages])
  const details = detailsRaw ?? { room, members: [], agents: [] }
  const download = async (attachmentId: string): Promise<void> => { const transferId = crypto.randomUUID(); try { await window.electronAPI.chatrooms.startDownload({ transferId, roomId, attachmentId, target: 'user' }) } catch (error) { console.warn('[聊天室] 下载失败:', error) } }
  const reloadRoom = (): void => { void chatRoomApi.getRoom(roomId).then((detail) => { if (!deletedRoomIdsRef.current.has(roomId)) setDetails((current) => ({ ...current, [roomId]: detail })) }).catch((error) => { if (!deletedRoomIdsRef.current.has(roomId)) setActionError(error instanceof Error ? error.message : '聊天室刷新失败') }) }
  const handleDelete = async (): Promise<void> => { setActionError(''); try { await deleteChatRoomAndClose({ roomId, deleteRoom: () => chatRoomApi.deleteRoom(roomId), removeRoom: (deletedRoomId) => { deletedRoomIdsRef.current = new Set(deletedRoomIdsRef.current).add(deletedRoomId); removeRoom(deletedRoomId) }, tabs, activeTabId, setTabs, setActiveTabId }) } catch (error) { setActionError(error instanceof Error ? error.message : '删除聊天室失败') } }
  if (deletedRoomIds.has(roomId)) return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">聊天室已删除</div>
  const currentUserId = authState?.user?.id === undefined && authState?.user?.userId === undefined ? undefined : String(authState.user?.id ?? authState.user?.userId)
  const sourceFor = (invocation: typeof invocations[number]): string | undefined => { const trigger = messages.find((message) => message.messageId === invocation.triggerMessageId); return trigger ? getChatRoomIdentityLabel(trigger, currentUserId, details.members, details.agents) : undefined }
  const invocationStopReason = (invocation: typeof invocations[number]): string | undefined => invocation.failureCode === 'invocation_depth_exceeded' || invocation.failureCode === 'invocation_duplicate' ? '已停止继续唤起' : undefined
  return <div className="flex h-full min-h-0 flex-col bg-background">
    {actionError && <div role="alert" className="px-4 py-2 text-xs text-destructive">{actionError}</div>}
    <header className="flex shrink-0 items-center justify-between border-b border-border/50 px-4 py-3"><div className="min-w-0"><div className="flex items-center gap-2"><h1 className="truncate text-sm font-semibold">{room.name}</h1><span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">{room.role === 'host' ? '主理人' : '成员'}</span></div><div className="mt-1 flex items-center gap-3 text-[11px] text-muted-foreground"><span>成员 {room.memberCount}</span>{room.shareCode && <button type="button" aria-label="复制分享码" className="inline-flex items-center gap-1 hover:text-foreground" onClick={() => void navigator.clipboard?.writeText(room.shareCode!)}>分享码 {room.shareCode}<Copy className="size-3" /></button>}<span role="status">{status === 'connected' ? '已连接' : status === 'reconnecting' ? '重连中' : status === 'auth_expired' ? '登录已过期' : '离线'}</span></div></div><div className="flex items-center gap-1">{room.role === 'host' && <><button type="button" aria-label={room.status === 'archived' ? '恢复聊天室' : '归档聊天室'} onClick={() => void (room.status === 'archived' ? chatRoomApi.restoreRoom(roomId) : chatRoomApi.archiveRoom(roomId)).then(reloadRoom).catch((error) => setActionError(error instanceof Error ? error.message : '聊天室操作失败'))} className="rounded-lg px-2 py-1 text-xs hover:bg-muted">{room.status === 'archived' ? '恢复' : '归档'}</button><button type="button" aria-label="删除聊天室" onClick={() => void handleDelete()} className="rounded-lg px-2 py-1 text-xs text-destructive hover:bg-muted">删除</button></>}<button type="button" aria-label="显示成员" onClick={() => setShowMembers((value) => !value)} className="rounded-lg p-2 hover:bg-muted"><Users className="size-4" /></button></div></header>
    <div className="flex min-h-0 flex-1"><main className="flex min-w-0 flex-1 flex-col"><div className="min-h-0 flex-1 overflow-y-auto p-4 space-y-3">{status !== 'connected' && <div role="status" className="rounded-lg bg-muted/50 px-3 py-2 text-xs text-muted-foreground">{status === 'reconnecting' ? '实时连接重连中' : status === 'auth_expired' ? '登录已过期' : '聊天室离线'}</div>}{invocations.map((invocation) => <div key={invocation.invocationId} role="status" className="rounded-lg border border-border/40 px-3 py-2 text-xs"><div>@{getChatRoomInvocationTargetLabel(invocation.targetAgentId, details.agents)} · {invocation.failureCode === 'agent_offline' ? 'Agent 离线，不排队' : invocationStopReason(invocation) ?? (invocation.status === 'running' ? '处理中' : invocation.status === 'completed' ? '已完成' : '调用失败')}</div>{sourceFor(invocation) && <div className="mt-1 text-muted-foreground">来源：{sourceFor(invocation)}</div>}{invocation.delta && (invocation.status === 'running' || !hasDurableChatRoomReply(messages, invocation)) && <div className="mt-1 whitespace-pre-wrap">{invocation.delta}</div>}</div>)}{messages.length === 0 ? <div className="flex h-full items-center justify-center text-xs text-muted-foreground">还没有消息，邀请 Agent 一起开始讨论</div> : messages.map((message) => <article key={message.messageId || `${message.seq}-${message.clientMessageId}`} className={`max-w-[85%] rounded-2xl px-3 py-2 shadow-sm ${message.senderType === 'user' ? 'ml-auto bg-primary text-primary-foreground' : message.senderType === 'agent' ? 'bg-muted' : 'mx-auto bg-muted/40 text-muted-foreground'}`}><div className="mb-1 text-[10px] opacity-70">{getChatRoomIdentityLabel(message, currentUserId, details.members, details.agents)}</div><div className="whitespace-pre-wrap break-words text-sm">{message.content}</div>{message.attachmentIds.map((id) => { const attachment = attachments.find((item) => item.attachmentId === id); return <button key={id} type="button" onClick={() => void download(id)} className="mt-2 block text-xs underline opacity-80">下载 {attachment?.originalName ?? '附件'}</button> })}</article>)}</div><ChatroomComposer roomId={roomId} agents={details.agents} archived={room.status !== 'active'} connectionStatus={status} /></main>{showMembers && <ChatroomMembersPanel roomId={roomId} role={room.role} members={details.members} agents={details.agents} onChanged={reloadRoom} />}</div>
  </div>
}
