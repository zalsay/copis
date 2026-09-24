import * as React from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { Copy, Users } from 'lucide-react'
import { cn } from '@/lib/utils'
import { chatRoomApi, ChatRoomApiError, type ChatRoomApi } from '@/lib/chatroom-api'
import {
  chatRoomActiveRoomIdAtom,
  chatRoomConnectionStatusAtom,
  chatRoomDeletedRoomIdsAtom,
  chatRoomDetailsAtom,
  chatRoomHydrateMessagesAtom,
  chatRoomInvocationsAtom,
  chatRoomMarkReadAtom,
  chatRoomMessagesAtom,
  chatRoomRemoveRoomAtom,
  chatRoomRoomsAtom,
  chatRoomSendStatesAtom,
} from '@/atoms/chatroom-atoms'
import { activeTabIdAtom, closeChatRoomTab, tabsAtom } from '@/atoms/tab-atoms'
import { workingAuthStateAtom } from '@/atoms/working-atoms'
import { ChatroomComposer } from './ChatroomComposer'
import { ChatroomMembersPanel } from './ChatroomMembersPanel'
import { ChatroomAgentProvisionDialog } from './ChatroomAgentProvisionDialog'
import { ChatroomAgentActivity, getPendingChatRoomInvocations } from './ChatroomAgentActivity'
import type { ChatRoomAgent, ChatRoomAttachment, ChatRoomInvocation, ChatRoomMember, ChatRoomMessage, ChatRoomSummary } from '@copis/shared'

export interface ChatroomViewProps { roomId: string }
type Details = { room: ChatRoomSummary; members: ChatRoomMember[]; agents: ChatRoomAgent[] }

export function getChatRoomMemberCount(room: Pick<ChatRoomSummary, 'memberCount'>, detail?: Pick<Details, 'members'>): number {
  return detail?.members.length ?? room.memberCount
}

export function getChatRoomHostRole(room: Pick<ChatRoomSummary, 'hostUserId' | 'role'>, currentUserId: string | undefined): ChatRoomSummary['role'] {
  return currentUserId && room.hostUserId === currentUserId ? 'host' : 'member'
}

export function getChatRoomIdentityLabel(message: Pick<ChatRoomMessage, 'senderType' | 'senderId'>, currentUserId: string | undefined, members: ChatRoomMember[], agents: ChatRoomAgent[]): string {
  if (message.senderType === 'agent') return agents.find((agent) => agent.agentId === message.senderId)?.displayName || message.senderId || 'Agent'
  if (message.senderType === 'user') {
    if (currentUserId !== undefined && currentUserId === message.senderId) return '我'
    return members.find((member) => member.userId === message.senderId)?.displayName || message.senderId || '成员'
  }
  return '系统'
}

export function getChatRoomInvocationTargetLabel(targetAgentId: string, agents: ChatRoomAgent[]): string {
  return agents.find((agent) => agent.agentId === targetAgentId)?.displayName || targetAgentId || 'Agent'
}

export function getChatRoomAvatarInitial(name: string): string {
  const cleaned = name.replace(/^@+/, '').trim()
  if (!cleaned) return '?'
  const char = Array.from(cleaned)[0] ?? '?'
  return char.toUpperCase()
}

export function getChatRoomMessageClassName(message: Pick<ChatRoomMessage, 'senderType' | 'senderId'>, currentUserId: string | undefined): string {
  if (message.senderType === 'user' && currentUserId === message.senderId) {
    return 'ml-auto bg-primary/10 text-foreground border border-primary/15'
  }
  if (message.senderType === 'user') {
    return 'mr-auto bg-muted/80 text-foreground border border-border/50 dark:bg-muted/50 dark:border-border/40'
  }
  if (message.senderType === 'agent') {
    return 'mr-auto bg-card text-card-foreground border border-border/60 shadow-xs dark:bg-muted/30 dark:border-border/40'
  }
  return 'mx-auto bg-muted/40 text-muted-foreground border border-border/30'
}

export function hasDurableChatRoomReply(messages: ChatRoomMessage[], invocation: Pick<ChatRoomInvocation, 'traceId' | 'targetAgentId'>): boolean {
  return Boolean(invocation.traceId && messages.some((message) => message.senderType === 'agent' && message.traceId === invocation.traceId && message.senderId === invocation.targetAgentId))
}

export async function loadChatRoomViewData(roomId: string, api: Pick<ChatRoomApi, 'getRoom' | 'getMessages' | 'listAttachments'> = chatRoomApi) {
  if (!roomId.trim()) throw new ChatRoomApiError('聊天室 ID 不能为空', 400, 'invalid_room_id')
  const [detail, history, attachments] = await Promise.all([
    api.getRoom(roomId),
    api.getMessages(roomId, { limit: 100 }),
    api.listAttachments(roomId).catch((error: unknown) => {
      if (error instanceof ChatRoomApiError && error.status === 404 && error.code === 'chatroom_route_not_found') return []
      throw error
    }),
  ])
  return { detail, history, attachments }
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
  const sendStates = useAtomValue(chatRoomSendStatesAtom)
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
  const [showMembers, setShowMembers] = React.useState(false)
  const [showProvision, setShowProvision] = React.useState(false)
  const [attachments, setAttachments] = React.useState<ChatRoomAttachment[]>([])
  const [actionError, setActionError] = React.useState('')
  const roomWasRemoved = deletedRoomIds.has(roomId)
  React.useEffect(() => { setActive(roomId); const seq = messages.at(-1)?.seq ?? 0; markRead(roomId); if (seq > 0) void chatRoomApi.markRead(roomId, seq).catch(() => undefined); return () => { setActive(undefined) } }, [roomId, messages, setActive, markRead])
  React.useEffect(() => { if (roomWasRemoved) return; let alive = true; void loadChatRoomViewData(roomId).then(({ detail, history, attachments: nextAttachments }) => { if (!alive || deletedRoomIdsRef.current.has(roomId)) return; setDetails((current) => ({ ...current, [roomId]: detail })); hydrateMessages({ roomId, messages: history.messages, cursor: history.cursor }); setAttachments(nextAttachments) }).catch((error) => { if (alive && !deletedRoomIdsRef.current.has(roomId)) console.warn('[聊天室] 加载失败:', error) }); return () => { alive = false } }, [roomId, roomWasRemoved, setDetails, hydrateMessages])
  const details = detailsRaw ?? { room, members: [], agents: [] }
  const memberCount = getChatRoomMemberCount(room, detailsRaw)
  const download = async (attachmentId: string): Promise<void> => { const transferId = crypto.randomUUID(); try { await window.electronAPI.chatrooms.startDownload({ transferId, roomId, attachmentId, target: 'user' }) } catch (error) { console.warn('[聊天室] 下载失败:', error) } }
  const reloadRoom = (): void => { void chatRoomApi.getRoom(roomId).then((detail) => { if (!deletedRoomIdsRef.current.has(roomId)) setDetails((current) => ({ ...current, [roomId]: detail })) }).catch((error) => { if (!deletedRoomIdsRef.current.has(roomId)) setActionError(error instanceof Error ? error.message : '聊天室刷新失败') }) }
  const handleDelete = async (): Promise<void> => { setActionError(''); try { await deleteChatRoomAndClose({ roomId, deleteRoom: () => chatRoomApi.deleteRoom(roomId), removeRoom: (deletedRoomId) => { deletedRoomIdsRef.current = new Set(deletedRoomIdsRef.current).add(deletedRoomId); removeRoom(deletedRoomId) }, tabs, activeTabId, setTabs, setActiveTabId }) } catch (error) { setActionError(error instanceof Error ? error.message : '删除聊天室失败') } }
  if (deletedRoomIds.has(roomId)) return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">聊天室已删除</div>
  const currentUserId = authState?.user?.id === undefined && authState?.user?.userId === undefined ? undefined : String(authState.user?.id ?? authState.user?.userId)
  const hostRole = getChatRoomHostRole(room, authState?.authenticated ? currentUserId : undefined)
  const sourceFor = (invocation: typeof invocations[number]): string | undefined => { const trigger = messages.find((message) => message.messageId === invocation.triggerMessageId); return trigger ? getChatRoomIdentityLabel(trigger, currentUserId, details.members, details.agents) : undefined }
  const pendingInvocations = getPendingChatRoomInvocations(roomId, sendStates.values(), messages, invocations)
  return <div className="flex h-full min-h-0 flex-col bg-background">
    {actionError && <div role="alert" className="px-4 py-2 text-xs text-destructive">{actionError}</div>}
    <header className="flex shrink-0 items-center justify-between border-b border-border/50 px-4 py-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2"><h1 className="truncate text-sm font-semibold">{room.name}</h1><span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">{hostRole === 'host' ? '主理人' : '成员'}</span></div>
        <div className="mt-1 flex items-center gap-3 text-[11px] text-muted-foreground">
          <span>成员 {memberCount}</span>
          {room.shareCode && <button type="button" aria-label="复制分享码" className="inline-flex items-center gap-1 hover:text-foreground" onClick={() => void navigator.clipboard?.writeText(room.shareCode!)}>分享码 {room.shareCode}<Copy className="size-3" /></button>}
          <span role="status">{status === 'connected' ? '已连接' : status === 'reconnecting' ? '重连中' : status === 'auth_expired' ? '登录已过期' : '离线'}</span>
        </div>
      </div>
      <div className="flex items-center gap-1">
        {hostRole === 'host' && <>
          <button type="button" aria-label="添加 Agent" disabled={room.status !== 'active' || details.agents.length >= 3} onClick={() => setShowProvision(true)} className="rounded-lg px-2 py-1 text-xs hover:bg-muted disabled:opacity-50">添加 Agent</button>
          <button type="button" aria-label={room.status === 'archived' ? '恢复聊天室' : '归档聊天室'} onClick={() => void (room.status === 'archived' ? chatRoomApi.restoreRoom(roomId) : chatRoomApi.archiveRoom(roomId)).then(reloadRoom).catch((error) => setActionError(error instanceof Error ? error.message : '聊天室操作失败'))} className="rounded-lg px-2 py-1 text-xs hover:bg-muted">{room.status === 'archived' ? '恢复' : '归档'}</button>
          <button type="button" aria-label="删除聊天室" onClick={() => void handleDelete()} className="rounded-lg px-2 py-1 text-xs text-destructive hover:bg-muted">删除</button>
        </>}
        <button type="button" aria-label="显示成员" onClick={() => setShowMembers((value) => !value)} className="rounded-lg p-2 hover:bg-muted"><Users className="size-4" /></button>
      </div>
    </header>
    <div className="flex min-h-0 flex-1">
      <main className="flex min-w-0 flex-1 flex-col">
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto scrollbar-none p-4 space-y-3">
          {status !== 'connected' && (
            <div role="status" className="rounded-lg bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
              {status === 'reconnecting' ? '实时连接重连中' : status === 'auth_expired' ? '登录已过期' : '聊天室离线'}
            </div>
          )}
          {[...invocations, ...pendingInvocations].filter((invocation) => invocation.targetAgentId).map((invocation) => (
            <div key={invocation.invocationId} role="status" className="rounded-lg border border-border/40 bg-muted/20 dark:bg-muted/10 px-3 py-2 text-xs">
              <div className="font-medium text-foreground">
                @{getChatRoomInvocationTargetLabel(invocation.targetAgentId, details.agents)}
              </div>
              <ChatroomAgentActivity invocation={invocation} connectionStatus={status} />
              {sourceFor(invocation) && <div className="mt-1 text-muted-foreground">来源：{sourceFor(invocation)}</div>}
              {invocation.delta && (invocation.status === 'running' || !hasDurableChatRoomReply(messages, invocation)) && (
                <div className="mt-1 whitespace-pre-wrap text-foreground/90">{invocation.delta}</div>
              )}
            </div>
          ))}
          {messages.length === 0 ? (
            <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
              还没有消息，邀请 Agent 一起开始讨论
            </div>
          ) : (
            messages.map((message) => {
              const isSelf =
                (message.senderType === 'user' && currentUserId === message.senderId) ||
                Boolean(message.senderType === 'user' && message.clientMessageId && sendStates.has(message.clientMessageId))
              const isAgent = message.senderType === 'agent'
              const isSystem = message.senderType === 'system'

              if (isSystem) {
                return (
                  <div
                    key={message.messageId || `${message.seq}-${message.clientMessageId}`}
                    className="flex w-full justify-center"
                  >
                    <article
                      className={cn(
                        'w-fit max-w-[80%] rounded-full px-4 py-1.5 text-xs',
                        getChatRoomMessageClassName(message, currentUserId)
                      )}
                    >
                      <div className="whitespace-pre-wrap break-words">{message.content}</div>
                    </article>
                  </div>
                )
              }

              const senderLabel = getChatRoomIdentityLabel(message, currentUserId, details.members, details.agents)
              const avatarInitial = getChatRoomAvatarInitial(senderLabel)

              return (
                <div
                  key={message.messageId || `${message.seq}-${message.clientMessageId}`}
                  className={cn(
                    'flex w-full items-start gap-2.5',
                    isSelf ? 'justify-end' : isSystem ? 'justify-center' : 'justify-start'
                  )}
                >
                  {!isSelf && (
                    <div
                      aria-label={senderLabel}
                      title={senderLabel}
                      className={cn(
                        'flex size-8 shrink-0 select-none items-center justify-center rounded-full text-xs font-semibold shadow-xs',
                        isAgent
                          ? 'bg-primary/15 text-primary border border-primary/25'
                          : 'bg-muted text-foreground border border-border/60'
                      )}
                    >
                      {avatarInitial}
                    </div>
                  )}

                  <div className={cn('flex flex-col min-w-0 max-w-[80%]', isSelf ? 'items-end' : 'items-start')}>
                    {!isSelf && (
                      <div className="mb-1 flex items-center gap-1.5 px-0.5 text-[11px] text-muted-foreground">
                        <span className="truncate max-w-[200px]">{senderLabel}</span>
                        {isAgent && (
                          <span className="rounded bg-primary/10 px-1 py-0.2 text-[9px] font-medium text-primary">
                            Agent
                          </span>
                        )}
                      </div>
                    )}
                    <article
                      className={cn(
                        'w-fit max-w-full rounded-2xl px-3.5 py-2.5 shadow-xs transition-colors',
                        isSelf ? 'rounded-tr-xs ml-auto' : 'rounded-tl-xs mr-auto',
                        getChatRoomMessageClassName(message, currentUserId)
                      )}
                    >
                      <div className="whitespace-pre-wrap break-words text-sm">{message.content}</div>
                      {message.attachmentIds.length > 0 && (
                        <div className={cn('mt-2 flex flex-col gap-1', isSelf ? 'items-end' : 'items-start')}>
                          {message.attachmentIds.map((id) => {
                            const attachment = attachments.find((item) => item.attachmentId === id)
                            return (
                              <button
                                key={id}
                                type="button"
                                onClick={() => void download(id)}
                                className={cn(
                                  'block text-xs underline opacity-80 hover:opacity-100',
                                  isSelf ? 'text-foreground' : ''
                                )}
                              >
                                下载 {attachment?.originalName ?? '附件'}
                              </button>
                            )
                          })}
                        </div>
                      )}
                    </article>
                  </div>

                  {isSelf && (
                    <div
                      aria-label="我"
                      title="我"
                      className="flex size-8 shrink-0 select-none items-center justify-center rounded-full text-xs font-semibold shadow-xs bg-[var(--ui-primary)] text-white"
                      style={{ backgroundColor: 'var(--ui-primary)', color: '#ffffff' }}
                    >
                      我
                    </div>
                  )}
                </div>
              )
            })
          )}
        </div>
        <ChatroomComposer roomId={roomId} agents={details.agents} archived={room.status !== 'active'} connectionStatus={status} />
      </main>
      {showMembers && <ChatroomMembersPanel roomId={roomId} role={hostRole} members={details.members} agents={details.agents} onChanged={reloadRoom} />}
    </div>
    {hostRole === 'host' && <ChatroomAgentProvisionDialog open={showProvision} room={room} agents={details.agents} onOpenChange={setShowProvision} onProvisioned={reloadRoom} />}
  </div>
}
