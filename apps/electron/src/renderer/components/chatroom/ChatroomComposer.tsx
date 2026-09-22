import * as React from 'react'
import { Paperclip, Send } from 'lucide-react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import type { ChatRoomAgent, ChatRoomTransferState } from '@copis/shared'
import { chatRoomConsumeTransfersAtom, chatRoomDraftsAtom, chatRoomMentionAgentIdsAtom, chatRoomRetrySendAtom, chatRoomSendMessageAtom, chatRoomSendStatesAtom, chatRoomSetDraftAtom, chatRoomSetMentionsAtom, chatRoomSetTransferAtom, chatRoomTransfersAtom } from '@/atoms/chatroom-atoms'
import { chatRoomApi } from '@/lib/chatroom-api'

export interface ChatroomComposerProps { roomId: string; agents: ChatRoomAgent[]; archived?: boolean; connectionStatus?: string }

export type ChatRoomTransferProgressSubscribe = (callback: (state: ChatRoomTransferState) => void) => () => void

export function subscribeChatRoomTransferProgress(roomId: string, setTransfer: (state: ChatRoomTransferState) => void, subscribe: ChatRoomTransferProgressSubscribe): () => void {
  return subscribe((state) => { if (state.roomId === roomId) setTransfer(state) })
}

export function ChatroomComposer({ roomId, agents, archived = false, connectionStatus = 'connected' }: ChatroomComposerProps): React.ReactElement {
  const draft = useAtomValue(chatRoomDraftsAtom).get(roomId) ?? ''
  const mentions = useAtomValue(chatRoomMentionAgentIdsAtom).get(roomId) ?? []
  const transfers = useAtomValue(chatRoomTransfersAtom)
  const sends = useAtomValue(chatRoomSendStatesAtom)
  const setDraft = useSetAtom(chatRoomSetDraftAtom)
  const setMentions = useSetAtom(chatRoomSetMentionsAtom)
  const send = useSetAtom(chatRoomSendMessageAtom)
  const retrySend = useSetAtom(chatRoomRetrySendAtom)
  const setTransfer = useSetAtom(chatRoomSetTransferAtom)
  const consumeTransfers = useSetAtom(chatRoomConsumeTransfersAtom)
  const [sending, setSending] = React.useState(false)
  const [uploading, setUploading] = React.useState(false)
  React.useEffect(() => subscribeChatRoomTransferProgress(roomId, setTransfer, window.electronAPI.chatrooms.onTransferProgress), [roomId, setTransfer])
  const roomTransfers = [...transfers.values()].filter((item) => item.roomId === roomId)
  const readyTransfers = roomTransfers.filter((item) => item.phase === 'ready')
  const readyAttachments = readyTransfers.flatMap((item) => item.attachmentId ? [item.attachmentId] : [])
  const unavailable = archived || connectionStatus === 'offline' || connectionStatus === 'auth_expired'
  const toggleMention = (agent: ChatRoomAgent): void => {
    if (agent.status === 'offline' || agent.status === 'disabled') return
    setMentions({ roomId, agentIds: mentions.includes(agent.agentId) ? mentions.filter((id) => id !== agent.agentId) : [...mentions, agent.agentId] })
  }
  const submit = async (): Promise<void> => {
    const content = draft.trim()
    if (!content || unavailable || sending) return
    const clientMessageId = crypto.randomUUID()
    setSending(true)
    try {
      await send({ api: chatRoomApi, roomId, content, mentionAgentIds: mentions, attachmentIds: readyAttachments, clientMessageId })
      consumeTransfers(readyAttachments); setDraft({ roomId, value: '' }); setMentions({ roomId, agentIds: [] })
    } finally { setSending(false) }
  }
  const chooseAttachment = async (): Promise<void> => {
    if (unavailable || uploading) return
    const transferId = crypto.randomUUID(); setUploading(true)
    setTransfer({ transferId, roomId, phase: 'waiting_authorization', progress: 0 })
    try { const result = await window.electronAPI.chatrooms.startUpload({ transferId, roomId }); setTransfer({ transferId, roomId, attachmentId: result.attachmentId, originalName: result.originalName, phase: result.phase, progress: result.phase === 'ready' ? 1 : 0, ...(result.errorCode ? { errorCode: result.errorCode } : {}) }) } catch (error) { setTransfer({ transferId, roomId, phase: 'failed', progress: 0, errorCode: error instanceof Error ? error.message : '上传失败' }) } finally { setUploading(false) }
  }
  return <div className="border-t border-border/50 bg-background/60 p-3 space-y-2">
    <div className="flex flex-wrap gap-1.5" aria-label="Agent 提及">
      {agents.map((agent) => <button key={agent.agentId} type="button" aria-label={`提及 ${agent.displayName}`} disabled={agent.status === 'offline' || agent.status === 'disabled'} onClick={() => toggleMention(agent)} className={`rounded-full px-2 py-1 text-[11px] ${mentions.includes(agent.agentId) ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'} disabled:opacity-40`}>@{agent.displayName}<span className="ml-1">{agent.status === 'offline' ? '离线' : agent.status === 'busy' ? '忙碌' : '在线'}</span></button>)}
    </div>
    {connectionStatus === 'offline' && <div role="status" className="text-xs text-destructive">Agent 离线，消息不会排队</div>}
    {connectionStatus === 'auth_expired' && <div role="status" className="text-xs text-destructive">登录已过期，请重新登录</div>}
    <div className="flex items-end gap-2">
      <button type="button" aria-label="添加附件" disabled={unavailable || uploading} onClick={() => void chooseAttachment()} className="rounded-lg p-2 text-muted-foreground hover:bg-muted disabled:opacity-40"><Paperclip className="size-4" /></button>
      <textarea aria-label="聊天室消息" value={draft} disabled={unavailable || sending} onChange={(e) => setDraft({ roomId, value: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void submit().catch(() => undefined) } }} placeholder={unavailable ? '聊天室当前不可发送' : '输入消息，选择 Agent 后发送'} className="min-h-10 max-h-32 flex-1 resize-y rounded-xl bg-muted/50 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/30" />
      <button type="button" aria-label="发送消息" onClick={() => void submit().catch(() => undefined)} disabled={unavailable || sending || !draft.trim()} className="rounded-xl bg-primary p-2 text-primary-foreground disabled:opacity-40"><Send className="size-4" /></button>
    </div>
    {sending && <div role="status" className="text-xs text-muted-foreground">发送中...</div>}
    {readyTransfers.map((item) => <div key={item.transferId} role="status" className="text-xs text-emerald-600">{item.originalName ?? '附件'} · 已就绪</div>)}
    {roomTransfers.filter((item) => item.phase !== 'ready').map((item) => <div key={item.transferId} role="status" className={`text-xs ${item.phase === 'failed' ? 'text-destructive' : 'text-muted-foreground'}`}>{item.originalName ?? '附件'} · {item.phase === 'waiting_authorization' ? '等待授权' : item.phase === 'uploading' ? `上传中 ${Math.round(item.progress * 100)}%` : item.phase === 'validating' ? '校验中' : '上传失败'}</div>)}
    {[...sends.values()].filter((item) => item.roomId === roomId && item.status === 'failed').map((item) => <div key={item.clientMessageId} className="flex items-center justify-between text-xs text-destructive"><span>{item.error ?? '发送失败'}</span><button type="button" className="underline" onClick={() => void retrySend({ api: chatRoomApi, ...item }).catch(() => undefined)}>重试</button></div>)}
  </div>
}
