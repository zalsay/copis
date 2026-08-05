import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { AlertTriangle, Loader2, RefreshCw, X } from 'lucide-react'
import type { SDKMessage, WorkingSessionHistory } from '@copis/shared'
import { AgentMessages } from '@/components/agent/AgentMessages'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { workingHistorySelectionAtom } from '@/atoms/working-atoms'
import { parseWorkingSessionHistory, type WorkingHistoryParseResult } from '@/lib/working-history-parser'

function sessionLabel(session: { runId: string; title?: string; finalText?: string }): string {
  return session.title?.trim() || session.finalText?.trim().slice(0, 42) || session.runId
}

function sessionModelId(session: Record<string, unknown>): string | undefined {
  const value = session.model_id ?? session.modelId ?? session.model
  return typeof value === 'string' && value.trim() ? value : undefined
}

export function WorkingSessionHistoryView(): React.ReactElement | null {
  const selection = useAtomValue(workingHistorySelectionAtom)
  const clearSelection = useSetAtom(workingHistorySelectionAtom)
  const [loadVersion, setLoadVersion] = React.useState(0)
  const [state, setState] = React.useState<{
    status: 'loading' | 'ready' | 'error'
    result?: WorkingHistoryParseResult
    error?: string
  }>({ status: 'loading' })

  const session = selection?.session
  const runId = session?.runId
  const sessionId = session?.sessionId

  React.useEffect(() => {
    if (!runId) return
    let disposed = false
    setState({ status: 'loading' })
    window.electronAPI.getWorkingSessionHistory(runId, sessionId)
      .then((history: WorkingSessionHistory) => {
        if (disposed) return
        setState({ status: 'ready', result: parseWorkingSessionHistory(history.jsonl) })
      })
      .catch((error: unknown) => {
        if (disposed) return
        setState({ status: 'error', error: error instanceof Error ? error.message : 'Working 历史加载失败' })
      })
    return () => { disposed = true }
  }, [loadVersion, runId, sessionId])

  if (!session) return null

  const result = state.result
  const messages: SDKMessage[] = result?.messages ?? []
  const historySessionId = result?.sessionId || session.sessionId || session.runId
  const title = sessionLabel(session)
  const modelId = sessionModelId(session as unknown as Record<string, unknown>)
  const workspacePath = session.workspace_path ?? session.workspacePath
  const statusLabel = result?.status === 'failed'
    ? '失败'
    : result?.status === 'stopped'
      ? '已停止'
      : result?.status === 'running'
        ? '运行中'
        : '已完成'

  return (
    <div className="flex h-full min-h-0 flex-col bg-content-area">
      <header className="titlebar-no-drag flex h-12 shrink-0 items-center gap-3 border-b border-border/60 px-4">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label="关闭 Working 历史"
              className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={() => clearSelection(null)}
            >
              <X size={16} />
            </button>
          </TooltipTrigger>
          <TooltipContent>关闭历史</TooltipContent>
        </Tooltip>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{title}</div>
          <div className="flex min-w-0 items-center gap-2 text-[10px] text-muted-foreground">
            <span>{statusLabel}</span>
            {typeof workspacePath === 'string' && workspacePath && <span className="truncate">{workspacePath}</span>}
          </div>
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label="重新加载 Working 历史"
              className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
              disabled={state.status === 'loading'}
              onClick={() => setLoadVersion((value) => value + 1)}
            >
              <RefreshCw size={15} className={cn(state.status === 'loading' && 'animate-spin')} />
            </button>
          </TooltipTrigger>
          <TooltipContent>重新加载历史</TooltipContent>
        </Tooltip>
      </header>

      {state.status === 'loading' && (
        <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
          <Loader2 size={16} className="animate-spin" />
          正在加载 Working 历史
        </div>
      )}

      {state.status === 'error' && (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <AlertTriangle size={20} className="text-destructive" />
          <p className="max-w-md text-sm text-muted-foreground">{state.error}</p>
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent"
            onClick={() => setLoadVersion((value) => value + 1)}
          >
            <RefreshCw size={13} />
            重试
          </button>
        </div>
      )}

      {state.status === 'ready' && result && (
        <>
          {result.diagnostics.length > 0 && (
            <div className="titlebar-no-drag flex shrink-0 items-center gap-2 border-b border-amber-500/20 bg-amber-500/5 px-4 py-2 text-xs text-amber-700 dark:text-amber-300">
              <AlertTriangle size={14} className="shrink-0" />
              <span>历史中有 {result.diagnostics.length} 行无法解析，已保留其余内容。</span>
            </div>
          )}
          <AgentMessages
            sessionId={`working-history:${historySessionId}`}
            sessionModelId={modelId}
            messagesLoaded
            persistedSDKMessages={messages}
            streaming={false}
            liveMessages={[]}
          />
        </>
      )}
    </div>
  )
}
