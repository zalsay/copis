import * as React from 'react'
import { Paperclip, Send } from 'lucide-react'
import { useAtomValue, useSetAtom } from 'jotai'
import type { ChatRoomAgent, ChatRoomTransferState } from '@copis/shared'
import { chatRoomConsumeTransfersAtom, chatRoomDraftsAtom, chatRoomMentionAgentIdsAtom, chatRoomRetrySendAtom, chatRoomSendMessageAtom, chatRoomSendStatesAtom, chatRoomSetDraftAtom, chatRoomSetMentionsAtom, chatRoomSetTransferAtom, chatRoomTransfersAtom } from '@/atoms/chatroom-atoms'
import { chatRoomApi } from '@/lib/chatroom-api'

export interface ChatroomComposerProps { roomId: string; agents: ChatRoomAgent[]; archived?: boolean; connectionStatus?: string }

export type ChatRoomTransferProgressSubscribe = (callback: (state: ChatRoomTransferState) => void) => () => void

export interface ChatRoomMentionTrigger {
  start: number
  query: string
}

/** 返回光标前最后一个独立 @ 触发词，普通邮箱或已完成的文本不会误触发。 */
export function getChatRoomMentionQuery(value: string, caret: number): ChatRoomMentionTrigger | undefined {
  const beforeCaret = value.slice(0, Math.max(0, Math.min(caret, value.length)))
  const match = /(?:^|\s)@([^\s@]*)$/.exec(beforeCaret)
  if (!match) return undefined
  const query = match[1] ?? ''
  return { start: match.index + match[0].length - query.length - 1, query }
}

export function filterChatRoomMentionCandidates(agents: ChatRoomAgent[], query: string): ChatRoomAgent[] {
  const normalized = query.trim().toLocaleLowerCase()
  return agents.filter((agent) => `${agent.displayName} ${agent.agentId}`.toLocaleLowerCase().includes(normalized))
}

export function formatChatRoomAgentStatus(agent: ChatRoomAgent): string {
  const status = String(agent.status)
  if (status === 'disabled') return '已禁用'
  if (status === 'offline') return '离线'
  if (status === 'pending' || status === 'pending_authorization' || status === 'waiting_authorization') return '待授权'
  if (status === 'busy' || agent.busy) return '忙碌'
  return '在线'
}

export function replaceChatRoomMentionTrigger(value: string, caret: number, displayName: string): { value: string; caret: number } {
  const trigger = getChatRoomMentionQuery(value, caret)
  if (!trigger) return { value, caret }
  const insertion = `@${displayName} `
  const nextValue = `${value.slice(0, trigger.start)}${insertion}${value.slice(Math.min(caret, value.length))}`
  return { value: nextValue, caret: trigger.start + insertion.length }
}

export function removeChatRoomMentionToken(value: string, displayName: string): string {
  const escapedName = displayName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return value.replace(new RegExp(`(^|\\s)@${escapedName}(?=\\s|$)\\s?`, 'u'), '$1')
}

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
  const textareaRef = React.useRef<HTMLTextAreaElement>(null)
  const [mentionQuery, setMentionQuery] = React.useState<ChatRoomMentionTrigger | undefined>()
  const [activeMentionIndex, setActiveMentionIndex] = React.useState(0)
  React.useEffect(() => subscribeChatRoomTransferProgress(roomId, setTransfer, window.electronAPI.chatrooms.onTransferProgress), [roomId, setTransfer])
  const roomTransfers = [...transfers.values()].filter((item) => item.roomId === roomId)
  const readyTransfers = roomTransfers.filter((item) => item.phase === 'ready')
  const readyAttachments = readyTransfers.flatMap((item) => item.attachmentId ? [item.attachmentId] : [])
  const unavailable = archived || connectionStatus === 'offline' || connectionStatus === 'auth_expired'
  const candidates = React.useMemo(() => filterChatRoomMentionCandidates(agents, mentionQuery?.query ?? ''), [agents, mentionQuery?.query])
  const refreshMentionQuery = (value: string, caret: number): void => {
    const next = getChatRoomMentionQuery(value, caret)
    setMentionQuery(next)
    setActiveMentionIndex(0)
  }
  const selectMention = (agent: ChatRoomAgent): void => {
    if (agent.status === 'disabled' || !mentionQuery) return
    const textarea = textareaRef.current
    const caret = textarea?.selectionStart ?? draft.length
    const replacement = replaceChatRoomMentionTrigger(draft, caret, agent.displayName)
    setDraft({ roomId, value: replacement.value })
    if (!mentions.includes(agent.agentId)) setMentions({ roomId, agentIds: [...mentions, agent.agentId] })
    setMentionQuery(undefined)
    setActiveMentionIndex(0)
    window.setTimeout(() => {
      const nextTextarea = textareaRef.current
      if (!nextTextarea) return
      nextTextarea.focus()
      if (typeof nextTextarea.setSelectionRange === 'function') nextTextarea.setSelectionRange(replacement.caret, replacement.caret)
    }, 0)
  }
  const removeMention = (agent: ChatRoomAgent): void => {
    setDraft({ roomId, value: removeChatRoomMentionToken(draft, agent.displayName) })
    setMentions({ roomId, agentIds: mentions.filter((id) => id !== agent.agentId) })
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
    {mentions.length > 0 && <div className="flex flex-wrap gap-1.5" aria-label="已提及 Agent">
      {mentions.map((agentId) => {
        const agent = agents.find((item) => item.agentId === agentId)
        if (!agent) return null
        return <span key={agent.agentId} className="inline-flex items-center gap-1 rounded-full bg-primary/15 px-2 py-1 text-[11px] text-primary">
          @{agent.displayName}
          <button type="button" aria-label={`移除提及 ${agent.displayName}`} onClick={() => removeMention(agent)} className="rounded-full px-0.5 hover:bg-primary/20">×</button>
        </span>
      })}
    </div>}
    {connectionStatus === 'offline' && <div role="status" className="text-xs text-destructive">Agent 离线，消息不会排队</div>}
    {connectionStatus === 'auth_expired' && <div role="status" className="text-xs text-destructive">登录已过期，请重新登录</div>}
    <div className="relative flex items-end gap-2">
      <button type="button" aria-label="添加附件" disabled={unavailable || uploading} onClick={() => void chooseAttachment()} className="rounded-lg p-2 text-muted-foreground hover:bg-muted disabled:opacity-40"><Paperclip className="size-4" /></button>
      <textarea ref={textareaRef} aria-label="聊天室消息" role="combobox" aria-autocomplete="list" aria-controls="chatroom-agent-mentions" aria-expanded={Boolean(mentionQuery && candidates.length > 0)} value={draft} disabled={unavailable || sending} onChange={(e) => { setDraft({ roomId, value: e.target.value }); refreshMentionQuery(e.target.value, e.target.selectionStart) }} onClick={(e) => refreshMentionQuery(e.currentTarget.value, e.currentTarget.selectionStart)} onKeyDown={(e) => {
        if (mentionQuery && candidates.length > 0) {
          if (e.key === 'ArrowDown') { e.preventDefault(); setActiveMentionIndex((index) => (index + 1) % candidates.length); return }
          if (e.key === 'ArrowUp') { e.preventDefault(); setActiveMentionIndex((index) => (index - 1 + candidates.length) % candidates.length); return }
          if (e.key === 'Escape') { e.preventDefault(); setMentionQuery(undefined); return }
          if (e.key === 'Enter' || e.key === 'Tab') { const candidate = candidates[activeMentionIndex] ?? candidates[0]; if (candidate) { e.preventDefault(); selectMention(candidate) }; return }
        }
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void submit().catch(() => undefined) }
      }} placeholder={unavailable ? '聊天室当前不可发送' : '输入 @ 选择 Agent，或直接输入消息'} className="min-h-10 max-h-32 flex-1 resize-y rounded-xl bg-muted/50 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/30" />
      {mentionQuery && candidates.length > 0 && <div id="chatroom-agent-mentions" role="listbox" aria-label="Agent 候选" className="absolute bottom-full left-10 z-20 mb-2 min-w-56 max-w-80 overflow-hidden rounded-xl bg-popover p-1 shadow-lg ring-1 ring-border/50">
        {candidates.map((agent, index) => <button key={agent.agentId} type="button" role="option" aria-selected={index === activeMentionIndex} aria-disabled={agent.status === 'disabled'} disabled={agent.status === 'disabled'} onMouseDown={(e) => e.preventDefault()} onClick={() => selectMention(agent)} className={`flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left text-xs ${index === activeMentionIndex ? 'bg-muted' : ''} disabled:cursor-not-allowed disabled:opacity-50`}>
          <span className="min-w-0 truncate">@{agent.displayName}</span><span className={`shrink-0 ${formatChatRoomAgentStatus(agent) === '离线' ? 'text-destructive' : 'text-muted-foreground'}`}>{formatChatRoomAgentStatus(agent)}</span>
        </button>)}
      </div>}
      <button type="button" aria-label="发送消息" onClick={() => void submit().catch(() => undefined)} disabled={unavailable || sending || !draft.trim()} className="rounded-xl bg-primary p-2 text-primary-foreground disabled:opacity-40"><Send className="size-4" /></button>
    </div>
    {sending && <div role="status" className="text-xs text-muted-foreground">发送中...</div>}
    {readyTransfers.map((item) => <div key={item.transferId} role="status" className="text-xs text-emerald-600">{item.originalName ?? '附件'} · 已就绪</div>)}
    {roomTransfers.filter((item) => item.phase !== 'ready').map((item) => <div key={item.transferId} role="status" className={`text-xs ${item.phase === 'failed' ? 'text-destructive' : 'text-muted-foreground'}`}>{item.originalName ?? '附件'} · {item.phase === 'waiting_authorization' ? '等待授权' : item.phase === 'uploading' ? `上传中 ${Math.round(item.progress * 100)}%` : item.phase === 'validating' ? '校验中' : '上传失败'}</div>)}
    {[...sends.values()].filter((item) => item.roomId === roomId && item.status === 'failed').map((item) => <div key={item.clientMessageId} className="flex items-center justify-between text-xs text-destructive"><span>{item.error ?? '发送失败'}</span><button type="button" className="underline" onClick={() => void retrySend({ api: chatRoomApi, ...item }).catch(() => undefined)}>重试</button></div>)}
  </div>
}
