import React, { useCallback, useState } from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { Lightbulb, Sparkles } from 'lucide-react'
import {
  appModeAtom,
  setAppModeAndRuntimeAtom,
  dshCordisStatusAtom,
  creationModeSkipConfirmAtom,
} from '@/atoms/app-mode'
import { agentSessionsAtom, currentAgentWorkspaceIdAtom } from '@/atoms/agent-atoms'
import { activeViewAtom } from '@/atoms/active-view'
import { useOpenSession } from '@/hooks/useOpenSession'
import { useCreateSession } from '@/hooks/useCreateSession'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { CopisCreationConfirmDialog } from '@/components/creation/CopisCreationConfirmDialog'
import { cn } from '@/lib/utils'

export interface CopisModeSwitcherProps {
  isCollapsed?: boolean
  className?: string
}

export function CopisModeSwitcher({
  isCollapsed = false,
  className,
}: CopisModeSwitcherProps): React.ReactElement {
  const [appMode, setAppModeAndRuntime] = useAtom(setAppModeAndRuntimeAtom)
  const currentMode = useAtomValue(appModeAtom)
  const skipConfirm = useAtomValue(creationModeSkipConfirmAtom)
  const setDshCordisStatus = useSetAtom(dshCordisStatusAtom)
  const agentSessions = useAtomValue(agentSessionsAtom)
  const currentWorkspaceId = useAtomValue(currentAgentWorkspaceIdAtom)
  const setActiveView = useSetAtom(activeViewAtom)
  const openSession = useOpenSession()
  const { createAgent } = useCreateSession()

  const [confirmDialogOpen, setConfirmDialogOpen] = useState(false)

  const executeSwitchToCreation = useCallback(() => {
    setAppModeAndRuntime('creation')
    setActiveView('conversations')

    // 进入创造模式时按需预热并启动 DSH Cordis Web 服务
    window.electronAPI.dshCordis.start()
      .then((status) => setDshCordisStatus(status))
      .catch((err) => {
        console.warn('[CopisModeSwitcher] 启动 DSH Cordis 服务失败:', err)
        setDshCordisStatus({
          running: false,
          error: err instanceof Error ? err.message : String(err),
        })
      })
  }, [setAppModeAndRuntime, setActiveView, setDshCordisStatus])

  const handleSwitchMode = useCallback((nextMode: 'agent' | 'creation') => {
    if (nextMode === currentMode) return

    if (nextMode === 'creation') {
      if (skipConfirm) {
        executeSwitchToCreation()
      } else {
        setConfirmDialogOpen(true)
      }
      return
    }

    // 切回 Agent 模式时，恢复当前工作区下的 Agent 会话
    setAppModeAndRuntime('agent')
    setActiveView('conversations')

    const matchedSession = agentSessions.find(
      (s) => !s.archived && s.workspaceId === currentWorkspaceId && s.mode !== 'creation' && s.agentRuntime !== 'dsh',
    )

    if (matchedSession) {
      openSession('agent', matchedSession.id, matchedSession.title)
    } else {
      createAgent({
        draft: true,
        mode: 'agent',
        agentRuntime: 'pi',
      })
    }
  }, [currentMode, skipConfirm, executeSwitchToCreation, currentWorkspaceId, agentSessions, setAppModeAndRuntime, setActiveView, openSession, createAgent])

  if (isCollapsed) {
    const isCreation = currentMode === 'creation'
    const tooltipText = isCreation
      ? '当前：创造模式（点击切换为 Agent 模式）'
      : '当前：Agent 模式（点击切换为创造模式）'

    return (
      <>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className={cn(
                'copis-working-sidebar-icon-button relative transition-all duration-200',
                isCreation
                  ? 'bg-[var(--creation-ui-primary-background)] text-[var(--creation-ui-primary)] hover:opacity-90'
                  : 'text-[var(--ui-primary)] hover:bg-muted/40',
                className,
              )}
              aria-label={tooltipText}
              onClick={() => handleSwitchMode(isCreation ? 'agent' : 'creation')}
            >
              {isCreation ? (
                <Lightbulb className="w-4 h-4 text-[var(--creation-ui-primary)]" aria-hidden="true" />
              ) : (
                <Sparkles className="w-4 h-4 text-[var(--ui-primary)]" aria-hidden="true" />
              )}
              <span
                className={cn(
                  'absolute bottom-1 right-1 w-1.5 h-1.5 rounded-full',
                  isCreation ? 'bg-[var(--creation-ui-primary)]' : 'bg-[var(--ui-primary)]',
                )}
              />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right" sideOffset={8}>
            {tooltipText}
          </TooltipContent>
        </Tooltip>
        <CopisCreationConfirmDialog
          open={confirmDialogOpen}
          onOpenChange={setConfirmDialogOpen}
          onConfirm={executeSwitchToCreation}
        />
      </>
    )
  }

  return (
    <>
      <div
        className={cn(
          'flex items-center p-1 rounded-xl bg-muted/60 border border-border/50 shadow-inner select-none transition-all',
          className,
        )}
        role="radiogroup"
        aria-label="模式切换"
      >
        <button
          type="button"
          role="radio"
          aria-checked={currentMode === 'agent'}
          className={cn(
            'flex-1 min-w-0 flex items-center justify-center gap-1.5 py-1.5 px-2 rounded-lg text-xs font-medium transition-all duration-150 whitespace-nowrap',
            currentMode === 'agent'
              ? 'bg-card text-foreground shadow-sm font-semibold border border-border/40'
              : 'text-muted-foreground hover:text-foreground hover:bg-muted/40',
          )}
          onClick={() => handleSwitchMode('agent')}
        >
          <Sparkles className="w-3.5 h-3.5 text-[var(--ui-primary)] shrink-0" aria-hidden="true" />
          <span className="whitespace-nowrap truncate">Agent 模式</span>
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={currentMode === 'creation'}
          className={cn(
            'flex-1 min-w-0 flex items-center justify-center gap-1.5 py-1.5 px-2 rounded-lg text-xs font-medium transition-all duration-150 whitespace-nowrap',
            currentMode === 'creation'
              ? 'bg-card text-[var(--creation-ui-primary)] shadow-sm font-semibold border border-border/40'
              : 'text-muted-foreground hover:text-foreground hover:bg-muted/40',
          )}
          onClick={() => handleSwitchMode('creation')}
        >
          <Lightbulb className="w-3.5 h-3.5 text-[var(--creation-ui-primary)] shrink-0" aria-hidden="true" />
          <span className="whitespace-nowrap truncate">创造模式</span>
        </button>
      </div>
      <CopisCreationConfirmDialog
        open={confirmDialogOpen}
        onOpenChange={setConfirmDialogOpen}
        onConfirm={executeSwitchToCreation}
      />
    </>
  )
}
