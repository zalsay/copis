/**
 * ComposerModeTogglePill - 对话区 Composer 模式切换交互药丸
 *
 * 位于输入框工具栏模型选择器旁，支持直接点击在「标准模式」与「专业模式」间切换。
 * 契约：
 * - 只有在新对话未开始时（空会话、0 消息）允许切换模式；
 * - 对话开启后（已有历史消息、正在发送或正在流式输出）禁用切换，避免模式混用破坏会话一致性。
 */

import * as React from 'react'
import { useAtom, useAtomValue } from 'jotai'
import { Bot, Loader2 } from 'lucide-react'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { CodexLogoIcon } from '@/components/ui/codex-logo-icon'
import {
  professionalModeAtom,
  toggleProfessionalModeAtom,
} from '@/atoms/professional-mode-atoms'
import {
  currentAgentSessionIdAtom,
  agentSessionsAtom,
  agentSDKMessagesCacheAtom,
  liveMessagesMapAtom,
  agentStreamingStatesAtom,
} from '@/atoms/agent-atoms'
import { cn } from '@/lib/utils'

export interface ComposerModeTogglePillProps {
  className?: string
  onNotice?: (message: string) => void
  /**
   * 是否禁用切换。
   * 仅在新对话未开始时可切换模式；对话开启后（已有历史消息、正在发送或正在流式输出）禁用。
   */
  disabled?: boolean
  /** 当前会话 ID（可选，默认从 currentAgentSessionIdAtom 读取） */
  sessionId?: string
  /** 当前是否处于专业模式（可选，默认从 professionalModeAtom 读取） */
  isProfessional?: boolean
}

export function ComposerModeTogglePill({
  className,
  onNotice,
  disabled: propDisabled,
  sessionId: propSessionId,
  isProfessional: propIsProfessional,
}: ComposerModeTogglePillProps): React.ReactElement {
  const atomIsProfessional = useAtomValue(professionalModeAtom)
  const isProfessional = propIsProfessional ?? atomIsProfessional
  const [, toggleProfessionalMode] = useAtom(toggleProfessionalModeAtom)
  const currentSessionId = useAtomValue(currentAgentSessionIdAtom)
  const effectiveSessionId = propSessionId ?? currentSessionId
  const [sessions, setSessions] = useAtom(agentSessionsAtom)
  const messagesCache = useAtomValue(agentSDKMessagesCacheAtom)
  const liveMessagesMap = useAtomValue(liveMessagesMapAtom)
  const streamingStates = useAtomValue(agentStreamingStatesAtom)
  const [toggling, setToggling] = React.useState(false)

  // 内部派生当前会话是否已经开启（已有消息或正在运行）
  const isConversationStarted = React.useMemo(() => {
    if (!effectiveSessionId) return false
    const cached = messagesCache.get(effectiveSessionId)
    if (cached && cached.length > 0) return true
    const live = liveMessagesMap.get(effectiveSessionId)
    if (live && live.length > 0) return true
    const streaming = streamingStates.get(effectiveSessionId)
    if (streaming?.running) return true
    return false
  }, [effectiveSessionId, messagesCache, liveMessagesMap, streamingStates])

  const disabled = propDisabled ?? isConversationStarted

  const handleToggle = async (e: React.MouseEvent): Promise<void> => {
    e.preventDefault()
    e.stopPropagation()
    if (disabled || toggling) return

    // 欲开启专业模式时，先检测本机环境
    if (!isProfessional && window.electronAPI?.checkCodexCli) {
      try {
        const cliStatus = await window.electronAPI.checkCodexCli()
        if (!cliStatus?.available || !cliStatus?.canStartAppServer) {
          onNotice?.('未检测到专业模式核心模块，请前往「设置 - 模型管理」下载并安装')
          return
        }
      } catch {
        // 异常时交由后续 toggle 处理
      }
    }

    setToggling(true)
    const next = !isProfessional
    const targetRuntime = next ? 'codex' : 'pi'

    if (effectiveSessionId) {
      // 检测当前会话是否已有消息（双重安全防御）
      const cached = messagesCache.get(effectiveSessionId)
      let messageCount = cached?.length ?? 0
      if (messageCount === 0 && window.electronAPI?.getAgentSessionSDKMessages) {
        try {
          const persisted = await window.electronAPI.getAgentSessionSDKMessages(effectiveSessionId)
          messageCount = persisted.length
        } catch {
          // 忽略读取异常
        }
      }

      if (messageCount > 0) {
        setToggling(false)
        onNotice?.('当前对话已开启，无法切换模式。如需使用其他模式，请新建对话。')
        return
      }

      // 同步乐观更新当前会话 runtime，杜绝异步间隙导致状态错位或首次切换失败
      setSessions((prev) =>
        prev.map((s) => (s.id === effectiveSessionId ? { ...s, agentRuntime: targetRuntime } : s)),
      )
      if (window.electronAPI?.updateSessionAgentRuntime) {
        void window.electronAPI.updateSessionAgentRuntime(effectiveSessionId, targetRuntime).catch(console.error)
      }
    }

    try {
      await toggleProfessionalMode(next)
      onNotice?.(next ? '已开启专业模式' : '已切回标准模式')
    } catch (error) {
      // 切换失败时回滚会话 runtime
      if (effectiveSessionId) {
        const rollbackRuntime = isProfessional ? 'codex' : 'pi'
        setSessions((prev) =>
          prev.map((s) => (s.id === effectiveSessionId ? { ...s, agentRuntime: rollbackRuntime } : s)),
        )
        if (window.electronAPI?.updateSessionAgentRuntime) {
          void window.electronAPI.updateSessionAgentRuntime(effectiveSessionId, rollbackRuntime).catch(() => {})
        }
      }
      const msg = error instanceof Error ? error.message : '切换失败'
      onNotice?.(`切换模式失败: ${msg}`)
    } finally {
      setToggling(false)
    }
  }

  const pillButton = (
    <button
      type="button"
      disabled={disabled || toggling}
      onClick={handleToggle}
      aria-label={
        disabled
          ? `当前对话已开启，模式已锁定为${isProfessional ? '专业模式' : '标准模式'}`
          : isProfessional
            ? '切换为标准模式'
            : '切换为专业模式'
      }
      className={cn(
        'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium select-none transition-all duration-200 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
        isProfessional
          ? 'bg-primary/10 text-primary border border-primary/25 shadow-xs'
          : 'text-muted-foreground border border-border/40',
        !disabled && !toggling && (
          isProfessional
            ? 'cursor-pointer hover:bg-primary/15'
            : 'cursor-pointer hover:text-foreground hover:bg-muted/70'
        ),
        disabled && 'opacity-55 cursor-not-allowed',
        toggling && 'opacity-60 cursor-not-allowed',
        className,
      )}
    >
      {toggling ? (
        <Loader2 aria-hidden="true" className="size-3.5 animate-spin text-muted-foreground" />
      ) : isProfessional ? (
        <CodexLogoIcon size={14} className="animate-in fade-in zoom-in-95 duration-150" />
      ) : (
        <Bot aria-hidden="true" className="size-3.5 text-muted-foreground" />
      )}
      <span className="leading-none tracking-tight">
        {isProfessional ? '专业模式' : '标准模式'}
      </span>
    </button>
  )

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {disabled ? <span className="inline-flex cursor-not-allowed">{pillButton}</span> : pillButton}
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-xs text-xs">
        {disabled
          ? `对话已开启，已锁定为${isProfessional ? '专业模式' : '标准模式'}（仅在新对话未开始时可切换）`
          : isProfessional
            ? '当前处于专业模式（仅支持 Copis 快速/专家与自定义模型）。点击切回标准模式。'
            : '当前处于标准模式。点击开启专业模式。'}
      </TooltipContent>
    </Tooltip>
  )
}
