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
  Search,
  AlertCircle,
  Zap,
  ArrowUp,
  Bell,
  ChevronDown,
  Plus,
  Cpu,
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
            className="inline-flex items-center font-medium text-zinc-200 bg-white/[0.1] border border-white/[0.08] rounded px-1.5 py-0.2 mx-0.5 text-[11px]"
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
      <div className="flex-1 flex flex-col items-center justify-center text-zinc-500 bg-[#0c0d10] p-8 text-xs select-none">
        <UsersRound className="w-10 h-10 opacity-20 mb-3" />
        <p className="tracking-wide">请在左侧选择一个群聊开始协同</p>
      </div>
    )
  }

  return (
    <div className="flex-1 flex flex-col h-full bg-[#0c0d10] text-zinc-100 relative overflow-hidden select-none">
      {/* 顶部 Header（WorkBuddy 极简导航栏） */}
      <div className="h-12 border-b border-white/[0.06] px-4 flex items-center justify-between shrink-0 bg-[#0c0d10]/90 backdrop-blur-md z-10">
        <div className="flex items-center gap-2.5 min-w-0">
          <h2 className="text-sm font-semibold text-white/95 truncate tracking-tight">{groupDetail.name}</h2>

          {/* Agent 协作成员与模型配置入口 */}
          <button
            type="button"
            onClick={() => setActiveDrawer(activeDrawer === 'agents' ? 'none' : 'agents')}
            className="text-[11px] px-2.5 py-0.5 rounded-full bg-white/[0.05] hover:bg-white/[0.09] border border-white/[0.08] text-zinc-300 hover:text-white font-medium transition-all cursor-pointer flex items-center gap-1.5"
            title="点击配置智能体与推理模型"
          >
            <Bot className="w-3 h-3 text-zinc-300" />
            <span>{groupDetail.agents.length} Agent 协作</span>
          </button>
        </div>

        {/* 顶部操作工具栏（WorkBuddy 极简浅灰图标按钮） */}
        <div className="flex items-center gap-1 shrink-0">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0 text-zinc-400 hover:text-white hover:bg-white/[0.06] rounded-md"
            title="搜索群聊内容"
          >
            <Search className="w-3.5 h-3.5" />
          </Button>

          <Button
            variant={activeDrawer === 'tasks' ? 'secondary' : 'ghost'}
            size="sm"
            className={`h-7 px-2 text-xs rounded-md gap-1.5 transition-all ${
              activeDrawer === 'tasks'
                ? 'bg-white/[0.12] text-white border border-white/[0.1] shadow-xs'
                : 'text-zinc-400 hover:text-white hover:bg-white/[0.06] border border-transparent'
            }`}
            onClick={() => setActiveDrawer(activeDrawer === 'tasks' ? 'none' : 'tasks')}
            title="任务看板"
          >
            <Kanban className="w-3.5 h-3.5 text-zinc-300" />
            <span className="hidden sm:inline">任务看板</span>
          </Button>

          <Button
            variant={activeDrawer === 'invocation' ? 'secondary' : 'ghost'}
            size="sm"
            className={`h-7 px-2 text-xs rounded-md gap-1.5 transition-all ${
              activeDrawer === 'invocation'
                ? 'bg-white/[0.12] text-white border border-white/[0.1] shadow-xs'
                : 'text-zinc-400 hover:text-white hover:bg-white/[0.06] border border-transparent'
            }`}
            onClick={() => setActiveDrawer(activeDrawer === 'invocation' ? 'none' : 'invocation')}
            title="执行轨迹下钻"
          >
            <Activity className="w-3.5 h-3.5 text-zinc-300" />
            <span className="hidden sm:inline">执行轨迹</span>
          </Button>

          <Button
            variant={activeDrawer === 'agents' ? 'secondary' : 'ghost'}
            size="sm"
            className={`h-7 w-7 p-0 text-xs rounded-md transition-all ${
              activeDrawer === 'agents'
                ? 'bg-white/[0.12] text-white border border-white/[0.1] shadow-xs'
                : 'text-zinc-400 hover:text-white hover:bg-white/[0.06] border border-transparent'
            }`}
            onClick={() => setActiveDrawer(activeDrawer === 'agents' ? 'none' : 'agents')}
            title="智能体成员与模型配置"
          >
            <Bot className="w-3.5 h-3.5 text-zinc-300" />
          </Button>

          {onClose && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0 text-zinc-400 hover:text-white hover:bg-white/[0.06] rounded-md ml-1"
              onClick={onClose}
              title="关闭子视图"
            >
              <X className="w-3.5 h-3.5" />
            </Button>
          )}
        </div>
      </div>

      {/* 消息流主区域 */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
        {messages.length === 0 ? (
          /* WorkBuddy 风格纯粹极简空状态：居中无冗杂，极度舒适沉浸 */
          <div className="h-full flex flex-col items-center justify-center text-zinc-500 py-16 select-none">
            <span className="text-sm font-normal text-zinc-500/80 tracking-wide">暂无对话记录</span>
          </div>
        ) : (
          messages.map((msg) => {
            const isUser = msg.kind === 'user'

            return (
              <div
                key={msg.id}
                className={`group flex items-start gap-3 ${isUser ? 'flex-row-reverse' : 'flex-row'}`}
              >
                {/* 头像 */}
                <div
                  className={`w-7 h-7 rounded-full flex items-center justify-center font-medium text-xs shrink-0 ${
                    isUser
                      ? 'bg-white/[0.12] text-zinc-100 border border-white/[0.14] font-medium shadow-xs'
                      : 'bg-white/[0.08] text-zinc-300 border border-white/[0.08]'
                  }`}
                >
                  {isUser ? '我' : <Bot className="w-3.5 h-3.5 text-zinc-300" />}
                </div>

                {/* 气泡主体 */}
                <div className={`flex flex-col max-w-[76%] ${isUser ? 'items-end' : 'items-start'}`}>
                  {/* 发送者名称与角色 */}
                  <div className="flex items-center gap-2 mb-1 px-1 text-[11px] text-zinc-400">
                    <span className="font-medium text-zinc-200">
                      {isUser ? '我' : msg.agentName || 'Agent'}
                    </span>
                    {!isUser && (() => {
                      const matchedAgent = groupDetail.agents.find(
                        (a) => a.agentId === msg.agentId || a.name === msg.agentName,
                      )
                      const modelText =
                        (msg.metadata?.modelName as string | undefined) ||
                        matchedAgent?.modelName ||
                        matchedAgent?.modelId ||
                        '默认模型'
                      return (
                        <button
                          type="button"
                          onClick={() => setActiveDrawer('agents')}
                          className="inline-flex items-center gap-1 px-1.5 py-0.2 rounded-full bg-white/[0.05] hover:bg-white/10 border border-white/[0.08] text-[10px] font-mono text-zinc-400 hover:text-zinc-200 transition-all cursor-pointer"
                          title="点击在右侧配置群智能体模型"
                        >
                          <Cpu className="w-2.5 h-2.5 text-zinc-400 shrink-0" />
                          <span className="truncate max-w-[120px]">{modelText}</span>
                        </button>
                      )
                    })()}
                    <span className="text-[10px] text-zinc-500 font-mono">
                      {new Date(msg.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </div>

                  {/* 引用卡片预览 */}
                  {msg.quotes && msg.quotes.length > 0 && (
                    <div className="mb-1.5 p-2 rounded-lg bg-white/[0.03] border border-white/[0.08] text-xs text-zinc-400 flex items-start gap-2 w-full">
                      <Quote className="w-3 h-3 shrink-0 opacity-60 mt-0.5 text-zinc-500" />
                      <div className="min-w-0">
                        <span className="font-medium text-zinc-300 block text-[11px]">
                          {msg.quotes[0]?.authorName}
                        </span>
                        <p className="line-clamp-2 text-[11px] mt-0.5 text-zinc-400">{msg.quotes[0]?.text}</p>
                      </div>
                    </div>
                  )}

                  {/* 消息内容气泡 */}
                  <div
                    className={`relative p-3 rounded-2xl text-[13px] leading-relaxed break-words select-text ${
                      isUser
                        ? 'bg-[#27282e] text-zinc-100 border border-white/[0.1] rounded-tr-xs shadow-xs'
                        : 'bg-[#181a20] border border-white/[0.08] text-zinc-100 rounded-tl-xs shadow-md'
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
                      className="absolute -top-3 right-2 opacity-0 group-hover:opacity-100 transition-opacity bg-[#22242b] border border-white/10 shadow-lg p-1 rounded-md text-zinc-400 hover:text-white text-[10px] flex items-center gap-1 cursor-pointer"
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

      {/* 底部悬浮输入区域（WorkBuddy 签名级 Floating Input Capsule） */}
      <div className="p-4 pt-1 w-full max-w-4xl mx-auto flex flex-col items-center shrink-0 relative">
        {/* 引用暂存回显条 */}
        {pendingQuote && (
          <div className="w-full mb-2 flex items-center justify-between px-3 py-1.5 rounded-xl bg-white/[0.05] border border-white/[0.08] text-xs text-zinc-300 backdrop-blur-md animate-in fade-in duration-100">
            <div className="flex items-center gap-2 truncate">
              <CornerDownRight className="w-3.5 h-3.5 text-zinc-400 shrink-0" />
              <span className="font-medium text-white shrink-0">引用 {pendingQuote.authorName}:</span>
              <span className="truncate text-[11px] text-zinc-400">{pendingQuote.text}</span>
            </div>
            <button
              onClick={() => setPendingQuote(null)}
              className="text-zinc-500 hover:text-zinc-200 ml-2 cursor-pointer"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {/* 悬浮输入胶囊本体 */}
        <div className="w-full relative flex flex-col rounded-2xl bg-[#181a20]/95 border border-white/10 shadow-[0_16px_48px_-8px_rgba(0,0,0,0.6),inset_0_1px_0_rgba(255,255,255,0.08)] backdrop-blur-xl transition-all focus-within:border-white/20 focus-within:ring-1 focus-within:ring-white/10">
          {/* Mention 浮动候选菜单 */}
          {mentionSuggestions.length > 0 && (
            <div
              ref={suggestionsListRef}
              className="absolute bottom-full left-0 mb-3 w-80 max-h-64 rounded-xl border border-white/10 bg-[#1e2027]/98 text-zinc-200 shadow-2xl backdrop-blur-xl z-50 p-1 flex flex-col animate-in fade-in slide-in-from-bottom-2 duration-150"
              role="listbox"
              aria-label="提及智能体"
            >
              <div className="px-2.5 py-1.5 text-[10px] font-medium text-zinc-400 flex items-center justify-between border-b border-white/[0.06] mb-1">
                <span className="flex items-center gap-1.5 font-semibold text-white/90">
                  <AtSign className="w-3.5 h-3.5 text-zinc-300" />
                  提及智能体或角色
                </span>
                <span className="text-[9px] bg-white/[0.06] px-1.5 py-0.5 rounded text-zinc-400 font-mono">
                  ↑↓ 切换 · 回车选中
                </span>
              </div>
              <div className="flex flex-col gap-0.5 max-h-52 overflow-y-auto pr-0.5 scrollbar-thin">
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
                          ? 'bg-white/[0.12] text-white font-medium'
                          : 'hover:bg-white/[0.05] text-zinc-300'
                      }`}
                    >
                      <div className="w-6 h-6 rounded-md bg-white/[0.08] flex items-center justify-center shrink-0">
                        {candidate.type === 'all' ? (
                          <UsersRound className="w-3.5 h-3.5 text-zinc-300" />
                        ) : candidate.isLeader ? (
                          <Crown className="w-3.5 h-3.5 text-zinc-200" />
                        ) : (
                          <Bot className="w-3.5 h-3.5 text-zinc-300" />
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="truncate text-xs font-medium">{candidate.name}</span>
                          {candidate.isLeader && (
                            <span className="text-[9px] px-1 py-0.2 rounded bg-white/[0.08] text-zinc-300 font-medium shrink-0">
                              主控
                            </span>
                          )}
                          {candidate.type === 'all' && (
                            <span className="text-[9px] px-1 py-0.2 rounded bg-white/[0.08] text-zinc-300 font-medium shrink-0">
                              全员
                            </span>
                          )}
                        </div>
                        {candidate.responsibility && (
                          <p className="text-[10px] text-zinc-400 truncate max-w-full">
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

          {/* 文本输入框（带 WorkBuddy 专属 Placeholder） */}
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
            placeholder="今天帮你想些什么？ @ 添加上下文，/调用技能与指令"
            rows={2}
            className="border-0 focus-visible:ring-0 px-3.5 pt-3 pb-1 resize-none text-[13px] bg-transparent text-zinc-100 placeholder:text-zinc-500 min-h-[50px] max-h-[140px]"
          />

          {/* 胶囊底部操作栏 */}
          <div className="flex items-center justify-between px-3 pb-2.5 pt-1 border-t border-white/[0.04]">
            {/* 左侧：+ 附件按钮、(!) 允许完全访问 胶囊、@ 提及 */}
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="w-7 h-7 rounded-full bg-white/[0.05] hover:bg-white/[0.09] border border-white/[0.08] text-zinc-400 hover:text-white flex items-center justify-center transition-all cursor-pointer"
                title="添加附件或文件"
              >
                <Plus className="w-3.5 h-3.5" />
              </button>

              <div
                className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-normal bg-white/[0.05] hover:bg-white/[0.09] border border-white/[0.08] text-zinc-300 hover:text-white cursor-pointer transition-all select-none"
                title="创造模式完全访问权限"
              >
                <AlertCircle className="w-3 h-3 text-zinc-400" />
                <span>允许完全访问</span>
                <ChevronDown className="w-2.5 h-2.5 text-zinc-500" />
              </div>

              <button
                type="button"
                onClick={handleAtButtonClick}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] text-zinc-400 hover:text-zinc-200 hover:bg-white/[0.05] transition-all cursor-pointer"
                title="提及智能体 (@)"
              >
                <AtSign className="w-3 h-3 text-zinc-400" />
                <span>提及</span>
              </button>
            </div>

            {/* 右侧：⚡ 快速 胶囊、通知铃铛、圆形发送按钮 */}
            <div className="flex items-center gap-2 shrink-0">
              <div
                className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] text-zinc-300 bg-white/[0.05] hover:bg-white/[0.08] border border-white/[0.08] cursor-pointer transition-all"
                title="切换执行模式 / 速度"
              >
                <Zap className="w-3 h-3 text-zinc-400" />
                <span>快速</span>
                <ChevronDown className="w-2.5 h-2.5 text-zinc-500" />
              </div>

              <button
                type="button"
                className="w-7 h-7 rounded-full flex items-center justify-center text-zinc-400 hover:text-zinc-200 hover:bg-white/[0.05] transition-all cursor-pointer"
                title="通知提醒"
              >
                <Bell className="w-3.5 h-3.5" />
              </button>

              <button
                type="button"
                disabled={!inputText.trim() || sending}
                onClick={handleSend}
                className={`w-7 h-7 rounded-full flex items-center justify-center transition-all ${
                  inputText.trim() && !sending
                    ? 'bg-[#3f414a] hover:bg-[#4d505a] text-zinc-100 border border-white/[0.12] shadow-md cursor-pointer scale-105 active:scale-95'
                    : 'bg-white/[0.06] text-zinc-600 border border-transparent cursor-not-allowed'
                }`}
                title="发送消息"
              >
                <ArrowUp className="w-3.5 h-3.5 stroke-[2.5]" />
              </button>
            </div>
          </div>
        </div>

        {/* 胶囊底部细字免责声明（WorkBuddy 标志性尾注） */}
        <p className="text-[11px] text-zinc-500/70 text-center mt-2 font-normal select-none">
          内容由 AI 生成，请核实重要信息
        </p>
      </div>
    </div>
  )
}
