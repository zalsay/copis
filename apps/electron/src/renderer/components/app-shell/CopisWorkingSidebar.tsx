import * as React from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import {
  ChevronDown,
  ChevronRight,
  CircleUserRound,
  Blocks,
  CalendarClock,
  Cloud,
  FolderOpen,
  HardDrive,
  KeyRound,
  Loader2,
  LogOut,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
} from 'lucide-react'
import { toast } from 'sonner'
import type { WorkingAuthState, WorkingSessionSummary, WorkingWorkspace } from '@proma/shared'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { sidebarCollapsedAtom } from '@/atoms/tab-atoms'
import {
  agentSessionsAtom,
  agentWorkspacesAtom,
  currentAgentSessionIdAtom,
  currentAgentWorkspaceIdAtom,
} from '@/atoms/agent-atoms'
import { appModeAtom } from '@/atoms/app-mode'
import { activeViewAtom } from '@/atoms/active-view'
import { searchDialogOpenAtom } from '@/atoms/search-atoms'
import { workingEventsAtom, workingHistorySelectionAtom } from '@/atoms/working-atoms'
import { useCreateSession } from '@/hooks/useCreateSession'
import { useOpenSession } from '@/hooks/useOpenSession'
import { deriveWorkingRunState } from '@/lib/working-run-state'

interface CopisWorkingSidebarProps {
  width: number
  noTransition?: boolean
}

function getWorkspaceLabel(workspace: WorkingWorkspace): string {
  return workspace.workspacePath.split(/[\\/]/).filter(Boolean).at(-1) || workspace.workspacePath
}

function getSessionLabel(session: WorkingSessionSummary): string {
  return session.title?.trim() || session.finalText?.trim().slice(0, 42) || session.runId
}

function getRunStatusLabel(status: ReturnType<typeof deriveWorkingRunState>['status']): string {
  switch (status) {
    case 'running': return '运行中'
    case 'completed': return '已完成'
    case 'failed': return '运行失败'
    case 'stopped': return '已停止'
    default: return '本地 Agent 可用'
  }
}

export function CopisWorkingSidebar({ width, noTransition = false }: CopisWorkingSidebarProps): React.ReactElement {
  const [collapsed, setCollapsed] = useAtom(sidebarCollapsedAtom)
  const [auth, setAuth] = React.useState<WorkingAuthState | null>(null)
  const [remoteWorkspaces, setRemoteWorkspaces] = React.useState<WorkingWorkspace[]>([])
  const [remoteSessions, setRemoteSessions] = React.useState<WorkingSessionSummary[]>([])
  const [skillsCount, setSkillsCount] = React.useState(0)
  const [expandedRemote, setExpandedRemote] = React.useState(false)
  const [loginOpen, setLoginOpen] = React.useState(false)
  const [email, setEmail] = React.useState('')
  const [password, setPassword] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [loading, setLoading] = React.useState(false)
  const authenticatedRef = React.useRef(false)

  const localWorkspaces = useAtomValue(agentWorkspacesAtom)
  const [localSessions, setLocalSessions] = useAtom(agentSessionsAtom)
  const setLocalWorkspaces = useSetAtom(agentWorkspacesAtom)
  const currentWorkspaceId = useAtomValue(currentAgentWorkspaceIdAtom)
  const currentSessionId = useAtomValue(currentAgentSessionIdAtom)
  const setCurrentWorkspaceId = useSetAtom(currentAgentWorkspaceIdAtom)
  const setAppMode = useSetAtom(appModeAtom)
  const setActiveView = useSetAtom(activeViewAtom)
  const setSearchDialogOpen = useSetAtom(searchDialogOpenAtom)
  const setWorkingHistorySelection = useSetAtom(workingHistorySelectionAtom)
  const workingEvents = useAtomValue(workingEventsAtom)
  const { createAgent } = useCreateSession()
  const openSession = useOpenSession()

  const loadWorkingData = React.useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      const state = await window.electronAPI.getWorkingAuthState()
      setAuth(state)
      authenticatedRef.current = state.authenticated
      if (!state.authenticated) {
        setRemoteWorkspaces([])
        setRemoteSessions([])
        setSkillsCount(0)
        setWorkingHistorySelection(null)
        return
      }

      const [workspaces, sessions, skills] = await Promise.all([
        window.electronAPI.listWorkingWorkspaces(),
        window.electronAPI.listWorkingSessions(),
        window.electronAPI.listWorkingSkills(),
      ])
      setRemoteWorkspaces(workspaces)
      setRemoteSessions(sessions)
      setSkillsCount(skills.length)
    } catch (error) {
      console.error('[Copis Working] 加载后端数据失败:', error)
      if (authenticatedRef.current) toast.error(error instanceof Error ? error.message : 'Working 数据加载失败')
    } finally {
      setLoading(false)
    }
  }, [setWorkingHistorySelection])

  React.useEffect(() => {
    void loadWorkingData()
  }, [loadWorkingData])

  React.useEffect(() => {
    let disposed = false
    window.electronAPI.listAgentSessions().then((sessions) => {
      if (!disposed) setLocalSessions(sessions)
    }).catch((error) => console.error('[Copis] 加载本地会话失败:', error))
    return () => { disposed = true }
  }, [setLocalSessions])

  const handleLogin = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    if (!email.trim() || !password) return
    setBusy(true)
    try {
      const nextAuth = await window.electronAPI.loginWorking({ email, password })
      setAuth(nextAuth)
      authenticatedRef.current = nextAuth.authenticated
      setLoginOpen(false)
      setPassword('')
      toast.success('Working 已登录')
      await loadWorkingData()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Working 登录失败')
    } finally {
      setBusy(false)
    }
  }

  const handleLogout = async (): Promise<void> => {
    setBusy(true)
    try {
      setAuth(await window.electronAPI.logoutWorking())
      authenticatedRef.current = false
      setRemoteWorkspaces([])
      setRemoteSessions([])
      setSkillsCount(0)
      setWorkingHistorySelection(null)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '退出 Working 失败')
    } finally {
      setBusy(false)
    }
  }

  const selectLocalWorkspace = (workspaceId: string): void => {
    setWorkingHistorySelection(null)
    setCurrentWorkspaceId(workspaceId)
    setAppMode('agent')
    setActiveView('conversations')
    window.electronAPI.updateSettings({ agentWorkspaceId: workspaceId }).catch(console.error)

    const session = localSessions.find((item) => item.workspaceId === workspaceId && !item.archived)
    if (session) openSession('agent', session.id, session.title)
  }

  const createLocalWorkspace = async (): Promise<void> => {
    try {
      setWorkingHistorySelection(null)
      const selected = await window.electronAPI.openFolderDialog()
      if (!selected) return
      const project = await window.electronAPI.createAgentProject({
        name: selected.name,
        projectRootPath: selected.path,
      })
      setLocalWorkspaces((previous) => [
        project.workspace,
        ...previous.filter((workspace) => workspace.id !== project.workspace.id),
      ])
      setLocalSessions((previous) => [project.session, ...previous])
      openSession('agent', project.session.id, project.session.title)
      setCurrentWorkspaceId(project.workspace.id)
      window.electronAPI.updateSettings({ agentWorkspaceId: project.workspace.id }).catch(console.error)

      if (auth?.authenticated) {
        try {
          await window.electronAPI.saveWorkingWorkspace({
            workspacePath: selected.path,
            workspaceType: 'local',
            pcId: '',
            allowWorkspaceWrite: true,
          })
          await loadWorkingData()
        } catch (error) {
          // 本地 Agent 项目已经创建成功；后端元数据失败不应破坏本地工作区。
          console.warn('[Copis Working] 保存本地工作区元数据失败:', error)
        }
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '创建本地工作区失败')
    }
  }

  const handleNewSession = async (): Promise<void> => {
    setWorkingHistorySelection(null)
    const sessionId = await createAgent()
    if (!sessionId) toast.error('新建 Agent 会话失败')
  }

  const selectWorkingSession = (session: WorkingSessionSummary): void => {
    setWorkingHistorySelection({ session })
    setAppMode('agent')
    setActiveView('conversations')
  }

  const activeLocalSessions = localSessions
    .filter((session) => !session.archived && (!currentWorkspaceId || session.workspaceId === currentWorkspaceId))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 40)

  const currentWorkingRun = React.useMemo(
    () => deriveWorkingRunState(currentSessionId ? workingEvents.get(currentSessionId) ?? [] : []),
    [currentSessionId, workingEvents],
  )

  if (collapsed) {
    return (
      <aside className="flex h-full w-14 flex-col items-center rounded-xl border border-border/70 bg-sidebar/95 py-3 shadow-sm">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label="展开 Copis Working 侧栏"
              className="titlebar-no-drag rounded-lg p-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              onClick={() => setCollapsed(false)}
            >
              <PanelLeftOpen size={17} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">展开侧栏</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label="搜索 Working 会话"
              className="titlebar-no-drag rounded-lg p-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              onClick={() => setSearchDialogOpen(true)}
            >
              <Search size={17} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">搜索</TooltipContent>
        </Tooltip>
        <Sparkles className="mt-5 text-primary" size={18} />
        <div className="mt-auto flex flex-col items-center gap-2">
          <span className={cn('h-2 w-2 rounded-full', auth?.authenticated ? 'bg-emerald-500' : 'bg-muted-foreground/40')} />
          <span className="text-[10px] text-muted-foreground">{activeLocalSessions.length}</span>
        </div>
      </aside>
    )
  }

  return (
    <aside
      className={cn(
        'flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-border/70 bg-sidebar/95 shadow-sm',
        !noTransition && 'transition-[width] duration-200',
      )}
      style={{ width }}
    >
      <header className="titlebar-no-drag flex h-14 shrink-0 items-center justify-between border-b border-border/60 px-4">
        <div className="flex min-w-0 items-center gap-2.5">
          <div className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Sparkles size={16} />
          </div>
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold tracking-tight">Copis</div>
            <div className="truncate text-[11px] text-muted-foreground">Working</div>
          </div>
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label="收起侧栏"
              className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              onClick={() => setCollapsed(true)}
            >
              <PanelLeftClose size={16} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">收起侧栏</TooltipContent>
        </Tooltip>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        <nav className="mb-5 space-y-1" aria-label="Working 菜单">
          <button
            type="button"
            className="titlebar-no-drag flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] text-muted-foreground transition-colors hover:bg-accent/70 hover:text-foreground"
            onClick={() => setSearchDialogOpen(true)}
          >
            <Search size={15} className="shrink-0" />
            <span>搜索</span>
          </button>
          <button
            type="button"
            className="titlebar-no-drag flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] text-muted-foreground transition-colors hover:bg-accent/70 hover:text-foreground"
            onClick={() => {
              setWorkingHistorySelection(null)
              setAppMode('agent')
              setActiveView('planning')
            }}
          >
            <CalendarClock size={15} className="shrink-0" />
            <span>任务 / 日程</span>
          </button>
          <button
            type="button"
            className="titlebar-no-drag flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] text-muted-foreground transition-colors hover:bg-accent/70 hover:text-foreground"
            onClick={() => {
              setWorkingHistorySelection(null)
              setAppMode('agent')
              setActiveView('agent-skills')
            }}
          >
            <Blocks size={15} className="shrink-0" />
            <span>技能</span>
          </button>
        </nav>

        <section>
          <div className="mb-2 flex items-center justify-between px-1">
            <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">本地工作区</span>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label="添加本地工作区"
                  className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                  onClick={() => void createLocalWorkspace()}
                >
                  <Plus size={15} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="right">添加本地工作区</TooltipContent>
            </Tooltip>
          </div>
          <div className="space-y-1">
            {localWorkspaces.map((workspace) => (
              <button
                type="button"
                key={workspace.id}
                className={cn(
                  'titlebar-no-drag flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] transition-colors',
                  workspace.id === currentWorkspaceId
                    ? 'bg-accent text-foreground'
                    : 'text-muted-foreground hover:bg-accent/70 hover:text-foreground',
                )}
                onClick={() => selectLocalWorkspace(workspace.id)}
              >
                <HardDrive size={15} className="shrink-0 text-primary/80" />
                <span className="min-w-0 flex-1 truncate">{workspace.name}</span>
                {workspace.projectRootPath && <FolderOpen size={13} className="shrink-0 text-muted-foreground/70" />}
              </button>
            ))}
          </div>
        </section>

        <section className="mt-5">
          <div className="mb-2 flex items-center justify-between px-1">
            <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">会话</span>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label="新建 Agent 会话"
                  className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                  onClick={() => void handleNewSession()}
                >
                  <Plus size={15} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="right">新建 Agent 会话</TooltipContent>
            </Tooltip>
          </div>
          <div className="space-y-0.5">
            {activeLocalSessions.length === 0 && (
              <div className="rounded-lg px-2.5 py-3 text-xs text-muted-foreground">还没有本地会话</div>
            )}
            {activeLocalSessions.map((session) => (
              <button
                type="button"
                key={session.id}
                className={cn(
                  'titlebar-no-drag flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] transition-colors',
                  session.id === currentSessionId
                    ? 'bg-accent text-foreground'
                    : 'text-muted-foreground hover:bg-accent/70 hover:text-foreground',
                )}
                onClick={() => {
                  setWorkingHistorySelection(null)
                  openSession('agent', session.id, session.title)
                }}
              >
                <CircleUserRound size={14} className="shrink-0 opacity-60" />
                <span className="min-w-0 flex-1 truncate">{session.title || '未命名会话'}</span>
              </button>
            ))}
          </div>
        </section>

        <section className="mt-5">
          <button
            type="button"
            className="titlebar-no-drag flex w-full items-center justify-between rounded-lg px-1 py-1 text-left text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground hover:text-foreground"
            onClick={() => setExpandedRemote((value) => !value)}
          >
            <span>Working 云端</span>
            {expandedRemote ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>
          {expandedRemote && (
            <div className="mt-1 space-y-1">
              {remoteWorkspaces.map((workspace) => (
                <div key={String(workspace.id)} className="flex items-center gap-2 rounded-lg px-2.5 py-2 text-xs text-muted-foreground">
                  {workspace.workspaceType === 'cloud' ? <Cloud size={14} /> : <HardDrive size={14} />}
                  <span className="min-w-0 flex-1 truncate">{getWorkspaceLabel(workspace)}</span>
                </div>
              ))}
              {remoteWorkspaces.length === 0 && <div className="px-2.5 py-2 text-xs text-muted-foreground">暂无云端工作区</div>}
              {remoteSessions.slice(0, 8).map((session) => (
                <button
                  type="button"
                  key={session.runId}
                  className="titlebar-no-drag w-full rounded-lg bg-muted/40 px-2.5 py-2 text-left text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  onClick={() => selectWorkingSession(session)}
                >
                  <div className="truncate text-foreground/80">{getSessionLabel(session)}</div>
                  {session.status && <div className="mt-0.5 truncate text-[10px]">{session.status}</div>}
                </button>
              ))}
            </div>
          )}
        </section>
      </div>

      <footer className="titlebar-no-drag shrink-0 border-t border-border/60 px-3 py-3">
        {loginOpen && !auth?.authenticated && (
          <form className="mb-3 space-y-2 rounded-lg border border-border/70 bg-background/50 p-2.5" onSubmit={(event) => void handleLogin(event)}>
            <input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="邮箱"
              autoComplete="username"
              className="h-8 w-full rounded-md border border-border bg-background px-2 text-xs outline-none focus:border-primary"
            />
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="密码"
              autoComplete="current-password"
              className="h-8 w-full rounded-md border border-border bg-background px-2 text-xs outline-none focus:border-primary"
            />
            <button type="submit" disabled={busy} className="flex h-8 w-full items-center justify-center gap-1.5 rounded-md bg-primary px-2 text-xs font-medium text-primary-foreground disabled:opacity-60">
              {busy && <Loader2 size={13} className="animate-spin" />}
              登录
            </button>
          </form>
        )}
        <div className="flex items-center gap-2">
          <div className={cn('flex size-8 shrink-0 items-center justify-center rounded-full', auth?.authenticated ? 'bg-emerald-500/10 text-emerald-600' : 'bg-muted text-muted-foreground')}>
            {auth?.authenticated ? <CircleUserRound size={16} /> : <KeyRound size={16} />}
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-xs font-medium">
              {auth?.authenticated ? (auth.user?.nickname || auth.user?.email || 'Working 账号') : '未登录 Working'}
            </div>
            <div className="truncate text-[10px] text-muted-foreground">
              {auth?.authenticated ? `${skillsCount} 个技能` : '本地 Agent 仍可使用'}
            </div>
          </div>
          {auth?.authenticated ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <button type="button" aria-label="退出 Working" disabled={busy} className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground" onClick={() => void handleLogout()}>
                  <LogOut size={15} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="right">退出 Working</TooltipContent>
            </Tooltip>
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>
                <button type="button" aria-label="登录 Working" className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground" onClick={() => setLoginOpen((value) => !value)}>
                  <KeyRound size={15} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="right">登录 Working</TooltipContent>
            </Tooltip>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <button type="button" aria-label="刷新 Working 数据" disabled={loading} className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50" onClick={() => void loadWorkingData()}>
                <RefreshCw size={14} className={cn(loading && 'animate-spin')} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">刷新 Working 数据</TooltipContent>
          </Tooltip>
        </div>
        <div className="mt-2 flex items-center gap-2 px-1 text-[10px] text-muted-foreground" role="status" aria-live="polite">
          <span
            className={cn(
              'h-1.5 w-1.5 shrink-0 rounded-full',
              currentWorkingRun.status === 'running' && 'animate-pulse bg-amber-500',
              currentWorkingRun.status === 'failed' && 'bg-destructive',
              currentWorkingRun.status === 'completed' && 'bg-emerald-500',
              currentWorkingRun.status === 'stopped' && 'bg-slate-400',
              currentWorkingRun.status === 'idle' && 'bg-muted-foreground/40',
            )}
          />
          <span className="truncate">{getRunStatusLabel(currentWorkingRun.status)}</span>
        </div>
      </footer>
    </aside>
  )
}
