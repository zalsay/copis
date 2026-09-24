import * as React from 'react'
import { CornerDownLeft, Paperclip, X } from 'lucide-react'
import { useAtomValue, useSetAtom } from 'jotai'
import type { ChatRoomAgent, ChatRoomTransferState } from '@copis/shared'
import {
  chatRoomConsumeTransfersAtom,
  chatRoomDraftsAtom,
  chatRoomMentionAgentIdsAtom,
  chatRoomPermissionRequestsAtom,
  chatRoomRetrySendAtom,
  chatRoomSendMessageAtom,
  chatRoomSendStatesAtom,
  chatRoomSetDraftAtom,
  chatRoomSetMentionsAtom,
  chatRoomSetTransferAtom,
  chatRoomTransfersAtom,
} from '@/atoms/chatroom-atoms'
import { chatRoomApi } from '@/lib/chatroom-api'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  inputToolbarButtonClass,
  inputToolbarDisabledButtonClass,
  inputToolbarSendButtonClass,
} from '@/components/ai-elements/input-toolbar-styles'

export interface ChatroomComposerProps { roomId: string; agents: ChatRoomAgent[]; archived?: boolean; connectionStatus?: string }

export type ChatRoomTransferProgressSubscribe = (callback: (state: ChatRoomTransferState) => void) => () => void

export interface ChatRoomMentionTrigger {
  start: number
  query: string
}

export interface ChatRoomMentionToken {
  start: number
  end: number
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

export function getChatRoomKeyboardCandidates(agents: ChatRoomAgent[], query: string): ChatRoomAgent[] {
  return filterChatRoomMentionCandidates(agents, query).filter((agent) => agent.status !== 'disabled')
}

export function formatChatRoomAgentStatus(agent: ChatRoomAgent, pendingAuthorization = false): string {
  const status = String(agent.status)
  if (status === 'disabled') return '已禁用'
  if (pendingAuthorization) return '待授权'
  if (status === 'offline') return '离线'
  if (status === 'busy' || agent.busy) return '忙碌'
  return '在线'
}

/** 根据一次文本编辑保留未被编辑触及的结构化 token，并平移其后的范围。 */
export function reconcileChatRoomMentionTokens(tokens: Map<string, ChatRoomMentionToken>, previous: string, next: string): Map<string, ChatRoomMentionToken> {
  if (previous === next) return new Map(tokens)
  let prefix = 0
  while (prefix < previous.length && prefix < next.length && previous[prefix] === next[prefix]) prefix += 1
  let suffix = 0
  while (suffix < previous.length - prefix && suffix < next.length - prefix && previous[previous.length - suffix - 1] === next[next.length - suffix - 1]) suffix += 1
  const oldEnd = previous.length - suffix
  const delta = (next.length - suffix) - oldEnd
  const result = new Map<string, ChatRoomMentionToken>()
  for (const [agentId, token] of tokens) {
    if (token.end <= prefix) { result.set(agentId, token); continue }
    const tokenText = previous.slice(token.start, token.end)
    const shiftedStart = token.start + delta
    if (shiftedStart >= 0 && next.slice(shiftedStart, shiftedStart + tokenText.length) === tokenText) result.set(agentId, { start: shiftedStart, end: shiftedStart + tokenText.length })
  }
  return result
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

export function removeChatRoomMentionTrigger(value: string, caret: number): { value: string; caret: number } {
  const trigger = getChatRoomMentionQuery(value, caret)
  if (!trigger) return { value, caret }
  return { value: `${value.slice(0, trigger.start)}${value.slice(Math.min(caret, value.length)).replace(/^\s/u, '')}`, caret: trigger.start }
}

/** 仅从唯一、边界完整的已选文本恢复 token；歧义或手写重复文本不会恢复为 Agent ID。 */
export function reconstructChatRoomMentionTokens(value: string, agentIds: string[], agents: ChatRoomAgent[]): Map<string, ChatRoomMentionToken> {
  const result = new Map<string, ChatRoomMentionToken>()
  for (const agentId of agentIds) {
    const agent = agents.find((item) => item.agentId === agentId)
    if (!agent) continue
    const tokenText = `@${agent.displayName}`
    const occurrences: ChatRoomMentionToken[] = []
    let from = 0
    while (from <= value.length - tokenText.length) {
      const start = value.indexOf(tokenText, from)
      if (start < 0) break
      const end = start + tokenText.length
      if ((start === 0 || /\s/u.test(value[start - 1]!)) && (end === value.length || /\s/u.test(value[end]!))) occurrences.push({ start, end })
      from = start + tokenText.length
    }
    if (occurrences.length === 1) result.set(agentId, occurrences[0]!)
  }
  return result
}

export function subscribeChatRoomTransferProgress(roomId: string, setTransfer: (state: ChatRoomTransferState) => void, subscribe: ChatRoomTransferProgressSubscribe): () => void {
  return subscribe((state) => { if (state.roomId === roomId) setTransfer(state) })
}

export function ChatroomComposer({ roomId, agents, archived = false, connectionStatus = 'connected' }: ChatroomComposerProps): React.ReactElement {
  const draft = useAtomValue(chatRoomDraftsAtom).get(roomId) ?? ''
  const mentions = useAtomValue(chatRoomMentionAgentIdsAtom).get(roomId) ?? []
  const transfers = useAtomValue(chatRoomTransfersAtom)
  const sends = useAtomValue(chatRoomSendStatesAtom)
  const permissionRequests = useAtomValue(chatRoomPermissionRequestsAtom)
  const setDraft = useSetAtom(chatRoomSetDraftAtom)
  const setMentions = useSetAtom(chatRoomSetMentionsAtom)
  const send = useSetAtom(chatRoomSendMessageAtom)
  const retrySend = useSetAtom(chatRoomRetrySendAtom)
  const setTransfer = useSetAtom(chatRoomSetTransferAtom)
  const consumeTransfers = useSetAtom(chatRoomConsumeTransfersAtom)
  const [sending, setSending] = React.useState(false)
  const [uploading, setUploading] = React.useState(false)
  const textareaRef = React.useRef<HTMLTextAreaElement>(null)
  const [mentionTokens, setMentionTokens] = React.useState<Map<string, ChatRoomMentionToken>>(() => reconstructChatRoomMentionTokens(draft, mentions, agents))
  const [mentionQuery, setMentionQuery] = React.useState<ChatRoomMentionTrigger | undefined>()
  const [activeMentionIndex, setActiveMentionIndex] = React.useState(0)
  React.useEffect(() => subscribeChatRoomTransferProgress(roomId, setTransfer, window.electronAPI.chatrooms.onTransferProgress), [roomId, setTransfer])
  const roomTransfers = [...transfers.values()].filter((item) => item.roomId === roomId)
  const readyTransfers = roomTransfers.filter((item) => item.phase === 'ready')
  const readyAttachments = readyTransfers.flatMap((item) => item.attachmentId ? [item.attachmentId] : [])
  const unavailable = archived || connectionStatus === 'offline' || connectionStatus === 'auth_expired'
  const canSend = !unavailable && !sending && Boolean(draft.trim())
  const candidates = React.useMemo(() => filterChatRoomMentionCandidates(agents, mentionQuery?.query ?? ''), [agents, mentionQuery?.query])
  const keyboardCandidates = React.useMemo(() => getChatRoomKeyboardCandidates(agents, mentionQuery?.query ?? ''), [agents, mentionQuery?.query])
  const pendingAuthorizationAgentIds = React.useMemo(() => new Set([...permissionRequests.values()].filter((request) => request.roomId === roomId).map((request) => request.roomAgentId)), [permissionRequests, roomId])
  const previousDraftRef = React.useRef(draft)
  React.useEffect(() => {
    setMentionTokens(reconstructChatRoomMentionTokens(draft, mentions, agents))
    previousDraftRef.current = draft
  }, [roomId])
  const refreshMentionQuery = (value: string, caret: number): void => {
    const next = getChatRoomMentionQuery(value, caret)
    setMentionQuery(next)
    setActiveMentionIndex(0)
  }
  const selectMention = (agent: ChatRoomAgent): void => {
    if (agent.status === 'disabled' || !mentionQuery) return
    const textarea = textareaRef.current
    const caret = textarea?.selectionStart ?? draft.length
    if (mentions.includes(agent.agentId)) {
      const duplicateRemoval = removeChatRoomMentionTrigger(draft, caret)
      const nextTokens = reconcileChatRoomMentionTokens(mentionTokens, draft, duplicateRemoval.value)
      setMentionTokens(nextTokens)
      previousDraftRef.current = duplicateRemoval.value
      setDraft({ roomId, value: duplicateRemoval.value })
      setMentionQuery(undefined)
      setActiveMentionIndex(0)
      return
    }
    const replacement = replaceChatRoomMentionTrigger(draft, caret, agent.displayName)
    const nextTokens = reconcileChatRoomMentionTokens(mentionTokens, draft, replacement.value)
    nextTokens.set(agent.agentId, { start: mentionQuery.start, end: mentionQuery.start + agent.displayName.length + 1 })
    setMentionTokens(nextTokens)
    previousDraftRef.current = replacement.value
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
    const token = mentionTokens.get(agent.agentId)
    const nextDraft = token ? `${draft.slice(0, token.start)}${draft.slice(token.end).replace(/^\s/, '')}` : removeChatRoomMentionToken(draft, agent.displayName)
    const removedEnd = token ? token.end + (draft[token.end] && /\s/u.test(draft[token.end]!) ? 1 : 0) : undefined
    const delta = nextDraft.length - draft.length
    const nextTokens = new Map<string, ChatRoomMentionToken>()
    for (const [agentId, otherToken] of mentionTokens) {
      if (agentId === agent.agentId) continue
      if (!token || removedEnd === undefined || otherToken.end <= token.start) nextTokens.set(agentId, otherToken)
      else if (otherToken.start >= removedEnd) nextTokens.set(agentId, { start: otherToken.start + delta, end: otherToken.end + delta })
    }
    setMentionTokens(nextTokens)
    previousDraftRef.current = nextDraft
    setDraft({ roomId, value: nextDraft })
    setMentions({ roomId, agentIds: mentions.filter((id) => nextTokens.has(id)) })
  }
  const handleDraftChange = (value: string, caret: number): void => {
    const nextTokens = reconcileChatRoomMentionTokens(mentionTokens, previousDraftRef.current, value)
    setMentionTokens(nextTokens)
    previousDraftRef.current = value
    setDraft({ roomId, value })
    setMentions({ roomId, agentIds: mentions.filter((id) => nextTokens.has(id)) })
    refreshMentionQuery(value, caret)
  }
  const submit = async (): Promise<void> => {
    const content = draft.trim()
    if (!content || unavailable || sending) return
    const effectiveMentionTokens = mentionTokens.size > 0 ? mentionTokens : reconstructChatRoomMentionTokens(draft, mentions, agents)
    const mentionAgentIds = mentions.filter((agentId) => {
      const token = effectiveMentionTokens.get(agentId)
      const agent = agents.find((item) => item.agentId === agentId)
      return token !== undefined && agent !== undefined && draft.slice(token.start, token.end) === `@${agent.displayName}`
    })
    const clientMessageId = crypto.randomUUID()
    setSending(true)
    try {
      await send({ api: chatRoomApi, roomId, content, mentionAgentIds, attachmentIds: readyAttachments, clientMessageId })
      consumeTransfers(readyAttachments); setDraft({ roomId, value: '' }); setMentions({ roomId, agentIds: [] }); setMentionTokens(new Map()); previousDraftRef.current = ''
    } finally { setSending(false) }
  }
  const chooseAttachment = async (): Promise<void> => {
    if (unavailable || uploading) return
    const transferId = crypto.randomUUID(); setUploading(true)
    setTransfer({ transferId, roomId, phase: 'waiting_authorization', progress: 0 })
    try { const result = await window.electronAPI.chatrooms.startUpload({ transferId, roomId }); setTransfer({ transferId, roomId, attachmentId: result.attachmentId, originalName: result.originalName, phase: result.phase, progress: result.phase === 'ready' ? 1 : 0, ...(result.errorCode ? { errorCode: result.errorCode } : {}) }) } catch (error) { setTransfer({ transferId, roomId, phase: 'failed', progress: 0, errorCode: error instanceof Error ? error.message : '上传失败' }) } finally { setUploading(false) }
  }

  const failedSends = [...sends.values()].filter((item) => item.roomId === roomId && item.status === 'failed')

  return (
    <div className="w-full shrink-0 px-2.5 pb-2.5 md:px-[18px] md:pb-[18px]">
      <div className="mx-auto w-full max-w-[760px]" data-input-mode="agent">
        {/* 发送失败错误条目 */}
        {failedSends.map((item) => (
          <div
            key={item.clientMessageId}
            role="alert"
            className="mb-1.5 flex items-center justify-between rounded-lg bg-destructive/10 px-3 py-1.5 text-xs text-destructive"
          >
            <span>{item.error ?? '发送失败'}</span>
            <button
              type="button"
              className="underline hover:opacity-80 transition-opacity"
              onClick={() => void retrySend({ api: chatRoomApi, ...item }).catch(() => undefined)}
            >
              重试
            </button>
          </div>
        ))}

        {/* 核心卡片容器：对齐 Agent Composer 的圆角、毛玻璃、微边框与阴影 */}
        <div className="copis-agent-composer-card relative rounded-[17px] border-[0.5px] border-border bg-background/70 backdrop-blur-sm shadow-[0_20px_60px_rgba(0,0,0,0.26)] transition-all duration-200 focus-within:border-foreground/20">
          {/* 连接状态警告提示 */}
          {connectionStatus === 'offline' && (
            <div role="status" className="px-3.5 pt-2 text-xs text-destructive">
              Agent 离线，消息不会排队
            </div>
          )}
          {connectionStatus === 'auth_expired' && (
            <div role="status" className="px-3.5 pt-2 text-xs text-destructive">
              登录已过期，请重新登录
            </div>
          )}

          {/* 已提及 Agent Chip 区域 */}
          {mentions.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 px-3 pt-2.5 pb-1" aria-label="已提及 Agent">
              {mentions.map((agentId) => {
                const agent = agents.find((item) => item.agentId === agentId)
                if (!agent) return null
                return (
                  <span
                    key={agent.agentId}
                    className="inline-flex items-center gap-1 rounded-full bg-primary/15 px-2.5 py-0.5 text-[11px] font-medium text-primary shadow-xs transition-colors"
                  >
                    @{agent.displayName}
                    <button
                      type="button"
                      aria-label={`移除提及 ${agent.displayName}`}
                      onClick={() => removeMention(agent)}
                      className="rounded-full p-0.5 hover:bg-primary/20 text-primary/70 hover:text-primary transition-colors"
                    >
                      <X className="size-3" />
                    </button>
                  </span>
                )
              })}
            </div>
          )}

          {/* 附件上传状态/已就绪 Chips 区域 */}
          {(readyTransfers.length > 0 || roomTransfers.some((item) => item.phase !== 'ready')) && (
            <div className="flex flex-wrap items-center gap-1.5 px-3 pt-1.5 pb-1">
              {readyTransfers.map((item) => (
                <span
                  key={item.transferId}
                  role="status"
                  className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 border border-emerald-500/20 px-2.5 py-0.5 text-[11px] text-emerald-600 dark:text-emerald-400"
                >
                  <Paperclip className="size-3" />
                  <span className="max-w-[140px] truncate">{item.originalName ?? '附件'}</span>
                  <span>· 已就绪</span>
                </span>
              ))}
              {roomTransfers
                .filter((item) => item.phase !== 'ready')
                .map((item) => (
                  <span
                    key={item.transferId}
                    role="status"
                    className={cn(
                      'inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px]',
                      item.phase === 'failed'
                        ? 'bg-destructive/10 border border-destructive/20 text-destructive'
                        : 'bg-muted/70 text-muted-foreground'
                    )}
                  >
                    <Paperclip className="size-3" />
                    <span className="max-w-[140px] truncate">{item.originalName ?? '附件'}</span>
                    <span>
                      · {item.phase === 'waiting_authorization'
                        ? '等待授权'
                        : item.phase === 'uploading'
                          ? `上传中 ${Math.round(item.progress * 100)}%`
                          : item.phase === 'validating'
                            ? '校验中'
                            : '上传失败'}
                    </span>
                  </span>
                ))}
            </div>
          )}

          {/* 纯净通透的输入区 */}
          <textarea
            ref={textareaRef}
            aria-label="聊天室消息"
            role="combobox"
            aria-autocomplete="list"
            aria-controls="chatroom-agent-mentions"
            aria-expanded={Boolean(mentionQuery && candidates.length > 0)}
            value={draft}
            disabled={unavailable || sending}
            onChange={(e) => handleDraftChange(e.target.value, e.target.selectionStart)}
            onClick={(e) => refreshMentionQuery(e.currentTarget.value, e.currentTarget.selectionStart)}
            onKeyDown={(e) => {
              if (mentionQuery && keyboardCandidates.length > 0) {
                if (e.key === 'ArrowDown') {
                  e.preventDefault()
                  setActiveMentionIndex((index) => (index + 1) % keyboardCandidates.length)
                  return
                }
                if (e.key === 'ArrowUp') {
                  e.preventDefault()
                  setActiveMentionIndex((index) => (index - 1 + keyboardCandidates.length) % keyboardCandidates.length)
                  return
                }
                if (e.key === 'Escape') {
                  e.preventDefault()
                  setMentionQuery(undefined)
                  return
                }
                if (e.key === 'Enter' || e.key === 'Tab') {
                  const candidate = keyboardCandidates[activeMentionIndex] ?? keyboardCandidates[0]
                  if (candidate) {
                    e.preventDefault()
                    selectMention(candidate)
                  }
                  return
                }
              }
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void submit().catch(() => undefined)
              }
            }}
            placeholder={unavailable ? '聊天室当前不可发送' : '输入 @ 选择 Agent，或直接输入消息'}
            rows={1}
            className="w-full resize-none border-0 bg-transparent px-3.5 pt-3 pb-2 text-sm outline-none placeholder:text-muted-foreground/50 focus:ring-0 focus:outline-none min-h-[44px] max-h-36 scrollbar-none"
          />

          {/* 候选 Agent 浮动菜单 */}
          {mentionQuery && candidates.length > 0 && (
            <div
              id="chatroom-agent-mentions"
              role="listbox"
              aria-label="Agent 候选"
              className="absolute bottom-full left-3 z-30 mb-2 min-w-56 max-w-80 overflow-hidden rounded-xl bg-popover p-1 shadow-lg ring-1 ring-border/50"
            >
              {candidates.map((agent) => (
                <button
                  key={agent.agentId}
                  type="button"
                  role="option"
                  aria-selected={keyboardCandidates[activeMentionIndex]?.agentId === agent.agentId}
                  aria-disabled={agent.status === 'disabled'}
                  disabled={agent.status === 'disabled'}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => selectMention(agent)}
                  className={cn(
                    'flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-50',
                    keyboardCandidates[activeMentionIndex]?.agentId === agent.agentId ? 'bg-muted' : 'hover:bg-muted/60'
                  )}
                >
                  <span className="min-w-0 truncate font-medium">@{agent.displayName}</span>
                  <span
                    className={cn(
                      'shrink-0 text-[11px]',
                      formatChatRoomAgentStatus(agent, pendingAuthorizationAgentIds.has(agent.agentId)) === '离线'
                        ? 'text-destructive'
                        : 'text-muted-foreground'
                    )}
                  >
                    {formatChatRoomAgentStatus(agent, pendingAuthorizationAgentIds.has(agent.agentId))}
                  </span>
                </button>
              ))}
            </div>
          )}

          {/* 底部工具栏：左侧附件与发送中提示，右侧 Agent 风格发送按钮 */}
          <div className="flex items-center justify-between px-3 pb-2 pt-1 border-t border-border/20">
            <div className="flex items-center gap-1.5">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className={inputToolbarButtonClass}
                disabled={unavailable || uploading}
                onClick={() => void chooseAttachment()}
                aria-label="添加附件"
                title="添加附件"
              >
                <Paperclip className="size-[17px]" />
              </Button>
              {sending && (
                <span role="status" className="text-xs text-muted-foreground ml-1">
                  发送中...
                </span>
              )}
            </div>
            <div className="flex items-center gap-1.5">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="发送消息"
                title="发送消息"
                className={cn(
                  canSend ? inputToolbarSendButtonClass : inputToolbarDisabledButtonClass
                )}
                onClick={() => void submit().catch(() => undefined)}
                disabled={!canSend}
              >
                <CornerDownLeft className="size-[20px]" />
              </Button>
            </div>
          </div>
        </div>

        {/* 底部合规/提示文案，与 Agent 对话一致 */}
        <p className="mt-1.5 text-center text-[11px] leading-tight text-muted-foreground/60 select-none">
          内容由 AI 生成，请核实重要信息
        </p>
      </div>
    </div>
  )
}
