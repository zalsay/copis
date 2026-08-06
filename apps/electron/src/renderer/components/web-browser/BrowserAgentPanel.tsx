import * as React from 'react'
import { Check, CircleStop, MessageCircleQuestion, Play, ShieldCheck, X } from 'lucide-react'
import type { BrowserPageControlMode, BrowserWorkflowVersion } from '@copis/shared'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { agentSessionsAtom, agentWorkspacesAtom } from '@/atoms/agent-atoms'
import { browserWorkflowDraftAtom, browserWorkflowStatusAtom } from '@/atoms/browser-agent'
import { AgentConversationSurface } from '@/components/agent/AgentConversationSurface'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { CopisTemplateLogo } from '@/lib/model-logo'
import { toast } from 'sonner'
import { getBrowserAgentHeaderState } from './browser-agent-header-policy'

interface BrowserAgentPanelProps {
  sessionId: string
  tabId: string
  pageUrl: string
  tabTitle: string
  workspaceId: string | undefined
  width: number
  onStartRecording: () => Promise<void>
  onStopRecording: () => Promise<void>
  onClose: () => void
}

function draftOrigins(draft: BrowserWorkflowVersion): string[] {
  const origins = new Set<string>()
  try {
    origins.add(new URL(draft.start.url).origin)
  } catch {
    // 主进程会再次校验草稿地址。
  }
  for (const step of draft.steps) origins.add(step.origin)
  return [...origins]
}

export function BrowserAgentPanel({ sessionId, tabId, pageUrl, tabTitle, workspaceId, width, onStartRecording, onStopRecording, onClose }: BrowserAgentPanelProps): React.ReactElement {
  const [status, setStatus] = useAtom(browserWorkflowStatusAtom)
  const [draft, setDraft] = useAtom(browserWorkflowDraftAtom)
  const setAgentSessions = useSetAtom(agentSessionsAtom)
  const workspaces = useAtomValue(agentWorkspacesAtom)
  const [isActionPending, setIsActionPending] = React.useState(false)
  const [unattendedAllowed, setUnattendedAllowed] = React.useState(false)
  const defaultWorkspaceId = workspaces.find((workspace) => workspace.slug === 'default')?.id ?? workspaces[0]?.id ?? ''
  const [selectedProjectId, setSelectedProjectId] = React.useState(workspaceId ?? defaultWorkspaceId)
  const headerState = getBrowserAgentHeaderState(status)

  React.useEffect(() => {
    setSelectedProjectId(workspaceId ?? defaultWorkspaceId)
  }, [defaultWorkspaceId, workspaceId])

  React.useEffect(() => {
    let active = true
    setDraft(null)
    setUnattendedAllowed(false)
    void window.electronAPI.browserWorkflow.getStatus(sessionId).then((next) => {
      if (active) setStatus(next)
    }).catch((error) => {
      console.error('[Browser Workflow] 获取状态失败:', error)
    })
    return () => {
      active = false
    }
  }, [sessionId, setStatus, setDraft])

  React.useEffect(() => {
    if (status.state !== 'awaiting_review') {
      setDraft(null)
      return
    }
    let active = true
    void window.electronAPI.browserWorkflow.getDraft(sessionId).then((next) => {
      if (active) setDraft(next ?? null)
    }).catch((error) => {
      console.error('[Browser Workflow] 获取待审核草稿失败:', error)
      if (active) setDraft(null)
    })
    return () => {
      active = false
    }
  }, [sessionId, setDraft, status.state])

  const changeProject = React.useCallback(async (nextProjectId: string): Promise<void> => {
    if (!nextProjectId || nextProjectId === selectedProjectId) return
    const nextProject = workspaces.find((workspace) => workspace.id === nextProjectId)
    if (!nextProject) return

    const previousProjectId = selectedProjectId
    setSelectedProjectId(nextProjectId)
    setIsActionPending(true)
    try {
      await window.electronAPI.moveAgentSessionToWorkspace({
        sessionId,
        targetWorkspaceId: nextProjectId,
      })
      setAgentSessions((sessions) => sessions.map((session) => (
        session.id === sessionId ? { ...session, workspaceId: nextProjectId, sdkSessionId: undefined } : session
      )))
      await window.electronAPI.browserWorkflow.bindContext(sessionId, { tabId })
      if (pageUrl !== 'about:blank') {
        await window.electronAPI.webTabs.saveProjectAssociation({
          url: pageUrl,
          workspaceId: nextProjectId,
        })
      }
      toast.success(`当前页面已关联到项目「${nextProject.name}」`)
    } catch (error) {
      setSelectedProjectId(previousProjectId)
      toast.error(error instanceof Error ? error.message : '切换网页 Agent 项目失败')
    } finally {
      setIsActionPending(false)
    }
  }, [pageUrl, selectedProjectId, sessionId, setAgentSessions, tabId, workspaces])

  const projectSelectionLocked = isActionPending || (status.state !== 'idle' && status.state !== 'error')

  const changeControlMode = React.useCallback(async (mode: BrowserPageControlMode): Promise<void> => {
    if (mode === headerState.mode || (mode === 'authorized' && !headerState.canAuthorize)) return
    setIsActionPending(true)
    try {
      setStatus(await window.electronAPI.browserWorkflow.setControlMode(sessionId, mode))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '切换页面授权失败')
    } finally {
      setIsActionPending(false)
    }
  }, [headerState.canAuthorize, headerState.mode, sessionId, setStatus])

  const requestRecording = React.useCallback(async (): Promise<void> => {
    setIsActionPending(true)
    try {
      await onStartRecording()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '无法开始记录网页操作')
    } finally {
      setIsActionPending(false)
    }
  }, [onStartRecording])

  const stopRun = React.useCallback(async (): Promise<void> => {
    setIsActionPending(true)
    try {
      await window.electronAPI.browserWorkflow.stopRun(sessionId)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '无法停止 Workflow')
    } finally {
      setIsActionPending(false)
    }
  }, [sessionId])

  const stopRecording = React.useCallback(async (): Promise<void> => {
    setIsActionPending(true)
    try {
      await onStopRecording()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '无法停止网页操作记录')
    } finally {
      setIsActionPending(false)
    }
  }, [onStopRecording])

  const continueRun = React.useCallback(async (): Promise<void> => {
    setIsActionPending(true)
    try {
      await window.electronAPI.browserWorkflow.continueRun(sessionId)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Workflow 当前没有等待人工接管')
    } finally {
      setIsActionPending(false)
    }
  }, [sessionId])
  const approveDraft = React.useCallback(async (): Promise<void> => {
    setIsActionPending(true)
    try {
      const manifest = await window.electronAPI.browserWorkflow.approveDraft(sessionId, '网页操作 Workflow', undefined, unattendedAllowed)
      toast.success(`Workflow「${manifest.name}」已保存`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '无法保存 Workflow')
    } finally {
      setIsActionPending(false)
    }
  }, [sessionId, unattendedAllowed])

  const rejectDraft = React.useCallback(async (): Promise<void> => {
    setIsActionPending(true)
    try {
      await window.electronAPI.browserWorkflow.rejectDraft(sessionId)
      toast.success('Workflow 草稿已丢弃，可重新让 Agent 提炼')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '无法丢弃 Workflow 草稿')
    } finally {
      setIsActionPending(false)
    }
  }, [sessionId])

  return (
    <aside style={{ width }} className="flex h-full min-w-[320px] max-w-[560px] shrink-0 flex-col border-l border-border/70 bg-background shadow-[-8px_0_24px_rgba(15,23,42,0.08)]">
      <header className="shrink-0 border-b border-border/60 bg-muted/30">
        <div className="flex h-11 items-center gap-2 px-3">
          <img src={CopisTemplateLogo} alt="" className="size-5 shrink-0 rounded object-cover" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-xs font-semibold">{tabTitle || '当前页面'}</div>
            <div className="truncate text-[10px] text-muted-foreground">{headerState.originLabel || '未打开 HTTP(S) 页面'}</div>
          </div>
          <div className="flex items-center gap-1">
          {status.state === 'running' || status.state === 'waiting_user' || (status.state === 'paused_cdp_detached' && Boolean(status.run)) ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-7 text-destructive hover:bg-destructive/10"
              aria-label={status.state === 'paused_cdp_detached' ? '停止暂停中的网页 Workflow' : '停止网页 Workflow'}
              disabled={isActionPending}
              onClick={() => void stopRun()}
            >
              <CircleStop className="size-4" />
            </Button>
          ) : status.state === 'recording' || (status.state === 'paused_cdp_detached' && !status.run) ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-7 text-destructive hover:bg-destructive/10"
              aria-label="停止记录网页操作"
              disabled={isActionPending}
              onClick={() => void stopRecording()}
            >
              <CircleStop className="size-4" />
            </Button>
          ) : (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className={cn('size-7', status.state === 'error' && 'text-destructive')}
              aria-label="记录网页操作"
              disabled={isActionPending || status.state === 'compiling' || status.state === 'awaiting_summary' || status.state === 'awaiting_review'}
              onClick={() => void requestRecording()}
            >
              <Play className="size-3.5" />
            </Button>
          )}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label="关闭网页 Agent"
            onClick={onClose}
          >
            <X className="size-4" />
          </Button>
          </div>
        </div>
        <div className="flex h-9 items-center gap-2 border-t border-border/40 px-3">
          <div role="group" aria-label="页面控制模式" className="grid h-7 w-[146px] shrink-0 grid-cols-2 rounded-md bg-muted p-0.5 shadow-inner">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className={cn(
                'h-6 gap-1 rounded px-2 text-[11px] shadow-none',
                headerState.mode === 'ask' && headerState.tone === 'safe'
                  && 'bg-emerald-600 text-white shadow-sm hover:bg-emerald-600 hover:text-white dark:bg-emerald-500 dark:text-emerald-950',
              )}
              aria-pressed={headerState.mode === 'ask'}
              disabled={isActionPending}
              onClick={() => void changeControlMode('ask')}
            >
              <MessageCircleQuestion className="size-3.5" />
              询问
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className={cn(
                'h-6 gap-1 rounded px-2 text-[11px] shadow-none',
                headerState.mode === 'authorized' && headerState.tone === 'warning'
                  ? 'bg-amber-400 text-amber-950 shadow-sm hover:bg-amber-400 hover:text-amber-950 dark:bg-amber-400 dark:text-amber-950'
                  : 'text-muted-foreground',
              )}
              aria-pressed={headerState.mode === 'authorized'}
              disabled={isActionPending || !headerState.canAuthorize}
              onClick={() => void changeControlMode('authorized')}
            >
              <ShieldCheck className="size-3.5" />
              授权
            </Button>
          </div>
          <Select value={selectedProjectId} onValueChange={(value) => void changeProject(value)} disabled={projectSelectionLocked || workspaces.length === 0}>
            <SelectTrigger aria-label="选择网页 Agent 项目" className="ml-auto h-7 min-w-0 max-w-[180px] border-0 bg-transparent px-2 text-[11px] shadow-none hover:bg-accent/50 focus:bg-accent/50">
              <SelectValue placeholder="选择项目" />
            </SelectTrigger>
            <SelectContent align="end">
              {workspaces.map((workspace) => (
                <SelectItem key={workspace.id} value={workspace.id}>
                  {workspace.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </header>
      {status.state === 'recording' ? (
        <div className="flex shrink-0 items-center gap-2 border-b border-destructive/20 bg-destructive/5 px-3 py-1.5 text-[10px] text-destructive">
          <span className="size-1.5 rounded-full bg-destructive" />
          正在记录当前页面操作
        </div>
      ) : null}
      {status.state === 'paused_cdp_detached' && status.run ? (
        <div className="flex shrink-0 items-center gap-2 border-b border-amber-500/20 bg-amber-500/5 px-3 py-1.5 text-[10px] text-amber-700 dark:text-amber-300">
          <span className="min-w-0 flex-1">Workflow 已暂停：网页调试连接断开，请确认页面后继续</span>
          <Button type="button" variant="outline" size="sm" className="h-6 shrink-0 gap-1 px-2 text-[10px]" disabled={isActionPending} onClick={() => void continueRun()}>
            <Check className="size-3" />
            继续
          </Button>
        </div>
      ) : null}
      {status.state === 'awaiting_summary' ? (
        <div className="flex shrink-0 items-center gap-2 border-b border-amber-500/20 bg-amber-500/5 px-3 py-1.5 text-[10px] text-amber-700 dark:text-amber-300">
          Agent 正在读取 Rust 生成的网页操作 JSONL，并提炼 Workflow 草稿。
        </div>
      ) : null}
      {status.state === 'awaiting_review' ? (
        <div className="shrink-0 border-b border-amber-500/20 bg-amber-500/5 px-3 py-2 text-[10px] text-amber-700 dark:text-amber-300">
          {draft ? (
            <>
              <div className="flex items-center justify-between gap-2 font-medium">
                <span>Workflow 草稿待审核</span>
                <span>{draft.steps.length} 步 · {draft.variables.length} 个变量</span>
              </div>
              <div className="mt-1 truncate">Origin：{draftOrigins(draft).join('、')}</div>
              <div className="mt-1 max-h-20 space-y-0.5 overflow-y-auto text-muted-foreground">
                {draft.steps.map((step, index) => (
                  <div key={step.id} className="truncate">
                    {index + 1}. {step.type}{step.type === 'manual' ? '（需人工确认）' : ''} · {step.origin}
                  </div>
                ))}
              </div>
              <label className="mt-2 flex items-center gap-1.5 text-foreground">
                <input
                  type="checkbox"
                  checked={unattendedAllowed}
                  onChange={(event) => setUnattendedAllowed(event.target.checked)}
                  disabled={isActionPending}
                />
                允许该版本无人值守运行
              </label>
              <div className="mt-1.5 flex justify-end gap-1.5">
                <Button type="button" variant="ghost" size="sm" className="h-6 px-2 text-[10px]" disabled={isActionPending} onClick={() => void rejectDraft()}>
                  丢弃
                </Button>
                <Button type="button" variant="outline" size="sm" className="h-6 px-2 text-[10px]" disabled={isActionPending} onClick={() => void approveDraft()}>
                  保存
                </Button>
              </div>
            </>
          ) : (
            <span>Workflow 草稿加载中…</span>
          )}
        </div>
      ) : null}
      {status.state === 'waiting_user' ? (
        <div className="flex shrink-0 items-center gap-2 border-b border-amber-500/20 bg-amber-500/5 px-3 py-1.5 text-[10px] text-amber-700 dark:text-amber-300">
          <span className="min-w-0 flex-1">{status.run?.error || 'Workflow 等待你在网页中完成一步操作'}</span>
          <Button type="button" variant="outline" size="sm" className="h-6 shrink-0 gap-1 px-2 text-[10px]" disabled={isActionPending} onClick={() => void continueRun()}>
            <Check className="size-3" />
            继续
          </Button>
        </div>
      ) : null}
      {status.state === 'error' ? (
        <div className="shrink-0 border-b border-destructive/20 bg-destructive/5 px-3 py-1.5 text-[10px] text-destructive">
          {status.error || status.run?.error || 'Workflow 执行失败'}
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-hidden">
        <AgentConversationSurface sessionId={sessionId} variant="browser" />
      </div>
    </aside>
  )
}
