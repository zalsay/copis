/**
 * DSH 群聊协同主工作台（GroupChatWorkspace）
 */

import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import {
  Kanban,
  Activity,
  UsersRound,
  X,
  Send,
  Quote,
  CornerDownRight,
  Bot,
  Crown,
  Sparkles,
  Paperclip,
  Smile,
  ArrowDown,
  AtSign,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import {
  dshActiveGroupIdAtom,
  dshActiveGroupDetailAtom,
  dshMessagesMapAtom,
  dshActiveMessagesAtom,
  dshActiveDrawerAtom,
  dshActiveInvocationIdAtom,
  dshPendingQuoteAtom,
  dshTasksMapAtom,
} from '@/atoms/dsh-group-chat-atoms'
import type { DshGroupChatMessage, DshGroupChatMention } from '@copis/shared'

interface DshGroupChatWorkspaceProps {
  onClose?: () => void
}

interface MentionCandidate {
  type: 'agent' | 'all'
  id: string | null
  name: string
  responsibility?: string
  isLeader?: boolean
}

function renderMessageContent(text: string, agents?: { name: string }[]) {
  if (!text) return null
  const parts = text.split(/([@＠][^\s@＠]+)/g)
  return parts.map((part, i) => {
    if (part.startsWith('@') || part.startsWith('＠')) {
      const name = part.slice(1)
      const isAgent = agents?.some((a) => a.name === name) || name === '所有人' || name === 'all'
      if (isAgent) {
        return (
          <span
            key={i}
            className="inline-flex items-center font-semibold text-primary bg-primary/10 rounded px-1.5 py-0.2 mx-0.5 text-[11px]"
          >
            {part}
          </span>
        )
      }
    }
    return <React.Fragment key={i}>{part}</React.Fragment>
  })
}

export function DshGroupChatWorkspace({ onClose }: DshGroupChatWorkspaceProps): React.ReactElement {
  const activeGroupId = useAtomValue(dshActiveGroupIdAtom)
  const [groupDetail, setGroupDetail] = useAtom(dshActiveGroupDetailAtom)
  const [messagesMap, setMessagesMap] = useAtom(dshMessagesMapAtom)
  const messages = useAtomValue(dshActiveMessagesAtom)
  const [activeDrawer, setActiveDrawer] = useAtom(dshActiveDrawerAtom)
  const setActiveInvocationId = useSetAtom(dshActiveInvocationIdAtom)
  const [pendingQuote, setPendingQuote] = useAtom(dshPendingQuoteAtom)
  const setTasksMap = useSetAtom(dshTasksMapAtom)

  const [inputText, setInputText] = useState('')
  const [cursorPos, setCursorPos] = useState(0)
  const [sending, setSending] = useState(false)
  const [activeMentionIndex, setActiveMentionIndex] = useState(0)
  const [dismissedMentionDraft, setDismissedMentionDraft] = useState<string | null>(null)
  const [isComposing, setIsComposing] = useState(false)

  const messagesEndRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const suggestionsListRef = useRef<HTMLDivElement>(null)

  // 1. 加载群详情、消息流与任务看板
  useEffect(() => {
    if (!activeGroupId) return
    let mounted = true

    const load = async () => {
      try {
        const [detail, msgs, board] = await Promise.all([
          window.electronAPI.dshGroupChat.getGroup(activeGroupId),
          window.electronAPI.dshGroupChat.getMessages(activeGroupId),
          window.electronAPI.dshGroupChat.getTasks(activeGroupId),
        ])
        if (mounted) {
          setGroupDetail(detail)
          setMessagesMap((prev) => ({ ...prev, [activeGroupId]: msgs }))
          setTasksMap((prev) => ({ ...prev, [activeGroupId]: board }))
          // 标记已读
          if (detail && detail.lastMessageSeq > detail.lastReadSeq) {
            void window.electronAPI.dshGroupChat.markRead(activeGroupId, detail.lastMessageSeq)
          }
        }
      } catch (err) {
        console.error('[DshGroupChatWorkspace] 加载群数据失败:', err)
      }
    }

    load()
    return () => {
      mounted = false
    }
  }, [activeGroupId, setGroupDetail, setMessagesMap, setTasksMap])

  // 2. 实时事件流监听
  useEffect(() => {
    const unsubscribe = window.electronAPI.dshGroupChat.onEventStream((event) => {
      if (event.type === 'message_created') {
        setMessagesMap((prev) => {
          const current = prev[event.groupId] || []
          if (current.some((m) => m.id === event.message.id)) return prev
          return { ...prev, [event.groupId]: [...current, event.message] }
        })
      } else if (event.type === 'tasks_updated') {
        setTasksMap((prev) => ({ ...prev, [event.groupId]: event.board }))
      } else if (event.type === 'group_updated' && event.groupId === activeGroupId) {
        setGroupDetail(event.group)
      }
    })

    return () => {
      unsubscribe()
    }
  }, [activeGroupId, setMessagesMap, setTasksMap, setGroupDetail])

  // 自动滚动到底部
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages.length])

  // 提取光标前最新的 @ 提及 query
  const mentionMatch = useMemo(() => {
    const textBeforeCursor = inputText.slice(0, cursorPos)
    return /[@＠]([^\s@＠]*)$/u.exec(textBeforeCursor)
  }, [inputText, cursorPos])

  // 计算智能体候选列表（支持搜索名称与职责描述）
  const mentionSuggestions = useMemo<MentionCandidate[]>(() => {
    if (!groupDetail || dismissedMentionDraft === inputText || isComposing || !mentionMatch) {
      return []
    }
    const query = (mentionMatch[1] ?? '').trim().toLowerCase()
    const allCandidates: MentionCandidate[] = [
      {
        type: 'all',
        id: null,
        name: '所有人',
        responsibility: '通知并委派所有群智能体协同执行',
        isLeader: false,
      },
      ...groupDetail.agents.map((agent) => ({
        type: 'agent' as const,
        id: agent.agentId,
        name: agent.name,
        responsibility: agent.responsibility,
        isLeader: agent.isLeader,
      })),
    ]

    if (!query) {
      return allCandidates
    }

    return allCandidates.filter(
      (c) =>
        c.name.toLowerCase().includes(query) ||
        (c.responsibility && c.responsibility.toLowerCase().includes(query))
    )
  }, [groupDetail, dismissedMentionDraft, inputText, isComposing, mentionMatch])

  // 候选列表变化时重置选中的 index
  useEffect(() => {
    setActiveMentionIndex(0)
  }, [mentionSuggestions.length, mentionMatch?.[1]])

  // 保证激活项处于视口内
  useEffect(() => {
    if (!suggestionsListRef.current) return
    const items = suggestionsListRef.current.querySelectorAll('[role="option"]')
    items[activeMentionIndex]?.scrollIntoView({ block: 'nearest' })
  }, [activeMentionIndex])

  // 选中并插入 @ 智能体
  const selectMention = (candidate: MentionCandidate) => {
    if (!mentionMatch) return
    const currentCursor = textareaRef.current?.selectionStart ?? cursorPos
    const atOffset = mentionMatch.index
    const beforeAt = inputText.slice(0, atOffset)
    const afterCursor = inputText.slice(currentCursor)

    const insertText = `@${candidate.name} `
    const nextText = `${beforeAt}${insertText}${afterCursor}`
    const nextPos = beforeAt.length + insertText.length

    setInputText(nextText)
    setCursorPos(nextPos)
    setDismissedMentionDraft(null)

    requestAnimationFrame(() => {
      if (textareaRef.current) {
        textareaRef.current.focus()
        textareaRef.current.setSelectionRange(nextPos, nextPos)
      }
    })
  }

  // 点击 @ 快捷按钮触发提及
  const handleAtButtonClick = () => {
    const currentCursor = textareaRef.current?.selectionStart ?? inputText.length
    const before = inputText.slice(0, currentCursor)
    const after = inputText.slice(currentCursor)
    const needsSpace = before.length > 0 && !/\s$/.test(before)
    const insert = needsSpace ? ' @' : '@'
    const nextText = `${before}${insert}${after}`
    const nextPos = before.length + insert.length

    setInputText(nextText)
    setCursorPos(nextPos)
    setDismissedMentionDraft(null)

    requestAnimationFrame(() => {
      if (textareaRef.current) {
        textareaRef.current.focus()
        textareaRef.current.setSelectionRange(nextPos, nextPos)
      }
    })
  }

  // 发送消息
  const handleSend = async () => {
    if (!inputText.trim() || !activeGroupId || sending) return
    setSending(true)

    try {
      // 检查 mentions
      const mentions: DshGroupChatMention[] = []
      const hasMentionAll =
        inputText.includes('@所有人') ||
        inputText.includes('＠所有人') ||
        inputText.includes('@all') ||
        inputText.includes('＠all')

      if (hasMentionAll) {
        mentions.push({
          type: 'all',
          id: null,
          name: '所有人',
        })
      }
      if (groupDetail?.agents) {
        for (const agent of groupDetail.agents) {
          if (inputText.includes(`@${agent.name}`) || inputText.includes(`＠${agent.name}`)) {
            mentions.push({
              type: 'agent',
              id: agent.agentId,
              name: agent.name,
            })
          }
        }
      }

      await window.electronAPI.dshGroupChat.postMessage({
        groupId: activeGroupId,
        text: inputText.trim(),
        quotes: pendingQuote
          ? [
              {
                messageId: pendingQuote.messageId,
                authorName: pendingQuote.authorName,
                text: pendingQuote.text,
              },
            ]
          : undefined,
        mentions: mentions.length > 0 ? mentions : undefined,
      })

      setInputText('')
      setCursorPos(0)
      setDismissedMentionDraft(null)
      setPendingQuote(null)
    } catch (err) {
      console.error('[DshGroupChatWorkspace] 发送失败:', err)
    } finally {
      setSending(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (isComposing) return

    // 如果提及菜单打开中，拦截上下键导航、回车与 Tab 选择
    if (mentionSuggestions.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActiveMentionIndex((prev) => (prev + 1) % mentionSuggestions.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActiveMentionIndex((prev) => (prev - 1 + mentionSuggestions.length) % mentionSuggestions.length)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setDismissedMentionDraft(inputText)
        return
      }
      if ((e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey) {
        e.preventDefault()
        const candidate = mentionSuggestions[activeMentionIndex] ?? mentionSuggestions[0]
        if (candidate) {
          selectMention(candidate)
        }
        return
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void handleSend()
    }
  }

  if (!activeGroupId || !groupDetail) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground p-8 text-xs select-none">
        <UsersRound className="w-12 h-12 opacity-30 mb-3" />
        <p>请在左侧选择一个群聊开始协同</p>
      </div>
    )
  }

  return (
    <div className="flex-1 flex flex-col h-full bg-background relative overflow-hidden">
      {/* 顶部 Header */}
      <div className="h-13 border-b border-border/60 px-4 flex items-center justify-between shrink-0 bg-background/80 backdrop-blur-xs select-none">
        <div className="flex items-center gap-3 min-w-0">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold text-foreground truncate">{groupDetail.name}</h2>
              <span className="text-[10px] px-1.5 py-0.2 rounded bg-muted text-muted-foreground font-medium">
                {groupDetail.agents.length} Agent 协作
              </span>
            </div>
            {groupDetail.description && (
              <p className="text-[11px] text-muted-foreground truncate max-w-md mt-0.5">
                {groupDetail.description}
              </p>
            )}
          </div>
        </div>

        {/* 顶部操作工具栏 */}
        <div className="flex items-center gap-1.5 shrink-0">
          <Button
            variant={activeDrawer === 'tasks' ? 'secondary' : 'ghost'}
            size="sm"
            className="h-8 gap-1.5 text-xs text-muted-foreground hover:text-foreground"
            onClick={() => setActiveDrawer(activeDrawer === 'tasks' ? 'none' : 'tasks')}
            title="任务看板"
          >
            <Kanban className="w-3.5 h-3.5 text-primary" />
            <span>任务看板</span>
          </Button>

          <Button
            variant={activeDrawer === 'invocation' ? 'secondary' : 'ghost'}
            size="sm"
            className="h-8 gap-1.5 text-xs text-muted-foreground hover:text-foreground"
            onClick={() => setActiveDrawer(activeDrawer === 'invocation' ? 'none' : 'invocation')}
            title="执行轨迹下钻"
          >
            <Activity className="w-3.5 h-3.5 text-amber-500" />
            <span>执行轨迹</span>
          </Button>

          {onClose && (
            <Button
              variant="ghost"
              size="sm"
              className="h-8 w-8 p-0 text-muted-foreground hover:text-foreground ml-1"
              onClick={onClose}
              title="关闭子视图"
            >
              <X className="w-4 h-4" />
            </Button>
          )}
        </div>
      </div>

      {/* 消息流主区域 */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-muted-foreground text-xs gap-2 py-12">
            <Sparkles className="w-8 h-8 text-primary/40 animate-pulse" />
            <p className="font-medium text-foreground/80">协同空间已就绪</p>
            <p className="text-[11px]">发送消息并 @ 架构总监或专业 Agent 开始分工落地</p>
          </div>
        ) : (
          messages.map((msg) => {
            const isUser = msg.kind === 'user'

            return (
              <div
                key={msg.id}
                className={`group flex items-start gap-2.5 ${isUser ? 'flex-row-reverse' : 'flex-row'}`}
              >
                {/* 头像 */}
                <div
                  className={`w-8 h-8 rounded-lg flex items-center justify-center font-medium text-xs shrink-0 ${
                    isUser ? 'bg-primary text-primary-foreground' : 'bg-muted border border-border/80 text-foreground'
                  }`}
                >
                  {isUser ? '我' : <Bot className="w-4 h-4" />}
                </div>

                {/* 气泡主体 */}
                <div className={`flex flex-col max-w-[75%] ${isUser ? 'items-end' : 'items-start'}`}>
                  {/* 发送者名称与角色 */}
                  <div className="flex items-center gap-1.5 mb-1 px-1 text-[11px] text-muted-foreground">
                    <span className="font-medium text-foreground/80">
                      {isUser ? '我' : msg.agentName || 'Agent'}
                    </span>
                    <span className="text-[10px]">
                      {new Date(msg.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </div>

                  {/* 引用卡片预览 */}
                  {msg.quotes && msg.quotes.length > 0 && (
                    <div className="mb-1.5 p-2 rounded-lg bg-muted/60 border border-border/60 text-xs text-muted-foreground flex items-start gap-2 w-full">
                      <Quote className="w-3.5 h-3.5 shrink-0 opacity-60 mt-0.5" />
                      <div className="min-w-0">
                        <span className="font-medium text-foreground/80 block text-[11px]">
                          {msg.quotes[0]?.authorName}
                        </span>
                        <p className="line-clamp-2 text-[11px] mt-0.5">{msg.quotes[0]?.text}</p>
                      </div>
                    </div>
                  )}

                  {/* 消息内容气泡 */}
                  <div
                    className={`relative p-3 rounded-2xl text-xs leading-relaxed break-words shadow-xs select-text ${
                      isUser
                        ? 'bg-primary text-primary-foreground rounded-tr-xs'
                        : 'bg-card border border-border/70 text-card-foreground rounded-tl-xs'
                    }`}
                  >
                    <p className="whitespace-pre-wrap">{renderMessageContent(msg.text, groupDetail?.agents)}</p>

                    {/* 悬浮引用快捷操作 */}
                    <button
                      onClick={() =>
                        setPendingQuote({
                          messageId: msg.id,
                          authorName: isUser ? '我' : msg.agentName || 'Agent',
                          text: msg.text,
                        })
                      }
                      className="absolute -top-3 right-2 opacity-0 group-hover:opacity-100 transition-opacity bg-background border border-border/80 shadow-md p-1 rounded-md text-muted-foreground hover:text-foreground text-[10px] flex items-center gap-1 cursor-pointer"
                      title="引用这条消息"
                    >
                      <Quote className="w-3 h-3" />
                    </button>
                  </div>
                </div>
              </div>
            )
          })
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* 底部输入框与操作栏 */}
      <div className="p-3 border-t border-border/60 bg-background/90 backdrop-blur-xs flex flex-col gap-2 shrink-0">
        {/* 引用暂存回显条 */}
        {pendingQuote && (
          <div className="flex items-center justify-between px-3 py-1.5 rounded-lg bg-muted/60 border border-border/60 text-xs text-muted-foreground animate-in fade-in duration-100">
            <div className="flex items-center gap-2 truncate">
              <CornerDownRight className="w-3.5 h-3.5 text-primary shrink-0" />
              <span className="font-medium text-foreground/90 shrink-0">引用 {pendingQuote.authorName}:</span>
              <span className="truncate text-[11px]">{pendingQuote.text}</span>
            </div>
            <button
              onClick={() => setPendingQuote(null)}
              className="text-muted-foreground hover:text-foreground ml-2"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {/* 消息输入区域与 Mention 浮层 */}
        <div className="relative flex flex-col bg-muted/30 border border-border/60 rounded-xl focus-within:border-primary/50 focus-within:ring-1 focus-within:ring-primary/20 transition-all">
          {/* Mention 浮动候选菜单 */}
          {mentionSuggestions.length > 0 && (
            <div
              ref={suggestionsListRef}
              className="absolute bottom-full left-0 mb-2 w-80 max-h-64 rounded-xl border border-border/80 bg-popover/95 text-popover-foreground shadow-xl backdrop-blur-md z-50 p-1 flex flex-col animate-in fade-in slide-in-from-bottom-2 duration-150"
              role="listbox"
              aria-label="提及智能体"
            >
              <div className="px-2.5 py-1.5 text-[10px] font-medium text-muted-foreground flex items-center justify-between border-b border-border/40 mb-1">
                <span className="flex items-center gap-1.5 font-semibold text-foreground/80">
                  <AtSign className="w-3.5 h-3.5 text-primary" />
                  提及智能体或角色
                </span>
                <span className="text-[9px] bg-muted px-1.5 py-0.5 rounded text-muted-foreground">
                  ↑↓ 切换 · 回车选中
                </span>
              </div>
              <div className="flex flex-col gap-0.5 max-h-52 overflow-y-auto pr-0.5">
                {mentionSuggestions.map((candidate, idx) => {
                  const isSelected = activeMentionIndex === idx
                  return (
                    <button
                      key={`${candidate.type}-${candidate.id ?? 'all'}`}
                      type="button"
                      role="option"
                      aria-selected={isSelected}
                      onMouseDown={(e) => {
                        e.preventDefault()
                        selectMention(candidate)
                      }}
                      onMouseEnter={() => setActiveMentionIndex(idx)}
                      className={`w-full text-left px-2.5 py-1.5 rounded-lg text-xs transition-colors flex items-center gap-2.5 cursor-pointer ${
                        isSelected
                          ? 'bg-primary/10 text-primary font-medium'
                          : 'hover:bg-muted/60 text-foreground'
                      }`}
                    >
                      <div className="w-6 h-6 rounded-md bg-muted/80 flex items-center justify-center shrink-0">
                        {candidate.type === 'all' ? (
                          <UsersRound className="w-3.5 h-3.5 text-indigo-500" />
                        ) : candidate.isLeader ? (
                          <Crown className="w-3.5 h-3.5 text-amber-500" />
                        ) : (
                          <Bot className="w-3.5 h-3.5 text-primary" />
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="truncate text-xs font-medium">{candidate.name}</span>
                          {candidate.isLeader && (
                            <span className="text-[9px] px-1 py-0.2 rounded bg-amber-500/10 text-amber-600 dark:text-amber-400 font-medium shrink-0">
                              主控
                            </span>
                          )}
                          {candidate.type === 'all' && (
                            <span className="text-[9px] px-1 py-0.2 rounded bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 font-medium shrink-0">
                              全员
                            </span>
                          )}
                        </div>
                        {candidate.responsibility && (
                          <p className="text-[10px] text-muted-foreground truncate max-w-full">
                            {candidate.responsibility}
                          </p>
                        )}
                      </div>
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          <Textarea
            ref={textareaRef}
            value={inputText}
            onChange={(e) => {
              setInputText(e.target.value)
              setCursorPos(e.target.selectionStart ?? e.target.value.length)
              setDismissedMentionDraft(null)
            }}
            onClick={(e) => setCursorPos(e.currentTarget.selectionStart ?? inputText.length)}
            onKeyUp={(e) => setCursorPos(e.currentTarget.selectionStart ?? inputText.length)}
            onKeyDown={handleKeyDown}
            onCompositionStart={() => setIsComposing(true)}
            onCompositionEnd={() => setIsComposing(false)}
            placeholder="输入消息，输入 @ 提及智能体进行委派... (Enter 发送，Shift+Enter 换行)"
            rows={2}
            className="border-0 focus-visible:ring-0 p-2.5 resize-none text-xs bg-transparent min-h-[48px] max-h-[140px]"
          />

          <div className="flex items-center justify-between px-2 pb-2 pt-0.5 border-t border-border/30">
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="sm"
                type="button"
                onClick={handleAtButtonClick}
                className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground rounded-lg gap-1"
                title="提及智能体 (@)"
              >
                <AtSign className="w-3.5 h-3.5 text-primary" />
                <span className="text-[11px]">提及</span>
              </Button>
            </div>

            <div className="flex items-center gap-1.5 shrink-0">
              <span className="text-[10px] text-muted-foreground mr-1 hidden sm:inline-block">
                Enter 发送 · Shift+Enter 换行
              </span>
              <Button
                size="sm"
                disabled={!inputText.trim() || sending}
                onClick={handleSend}
                className="h-7 px-3 rounded-lg shrink-0 gap-1 text-xs"
                title="发送消息"
              >
                <Send className="w-3.5 h-3.5" />
                <span>发送</span>
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
