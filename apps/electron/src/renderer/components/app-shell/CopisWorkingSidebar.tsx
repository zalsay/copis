import * as React from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import {
  CalendarClock,
  BookOpen,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  FolderOpen,
  Gem,
  Loader2,
  LogOut,
  MessageSquare,
  MoreHorizontal,
  PanelLeftOpen,
  PencilLine,
  Plus,
  Puzzle,
  RefreshCw,
  Search,
  Settings,
  Sparkles,
  UsersRound,
} from 'lucide-react'
import { toast } from 'sonner'
import type { AgentWorkspace } from '@copis/shared'
import { cn } from '@/lib/utils'
import { sidebarCollapsedAtom } from '@/atoms/tab-atoms'
import {
  agentSessionsAtom,
  agentSettingsReadyAtom,
  agentStreamingStatesAtom,
  agentWorkspacesAtom,
  currentAgentSessionIdAtom,
  currentAgentWorkspaceIdAtom,
} from '@/atoms/agent-atoms'
import { appModeAtom } from '@/atoms/app-mode'
import { activeViewAtom } from '@/atoms/active-view'
import { searchDialogOpenAtom } from '@/atoms/search-atoms'
import { planningTabAtom } from '@/atoms/planning-atoms'
import { workingAuthStateAtom, workingHistorySelectionAtom, workingSettingsOpenAtom } from '@/atoms/working-atoms'
import { useCreateSession } from '@/hooks/useCreateSession'
import { useOpenSession } from '@/hooks/useOpenSession'
import { isAgentSessionMeta, sanitizeAgentSessions } from '@/lib/agent-session-list'
import { CopisWorkingConnectDialog, type WorkingFolderSelection } from './CopisWorkingConnectDialog'
import { CopisWorkingFeedbackDialog } from './CopisWorkingFeedbackDialog'
import './CopisWorkingSidebar.css'

interface CopisWorkingSidebarProps {
  width: number
  noTransition?: boolean
}

const CONVERSATION_PREVIEW_LIMIT = 5

function formatSessionTime(timestamp: number): string {
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return ''
  const diff = Date.now() - date.getTime()
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.max(1, Math.floor(diff / 60_000))}分钟前`
  if (diff < 86_400_000) return `${Math.max(1, Math.floor(diff / 3_600_000))}小时前`
  if (diff < 7 * 86_400_000) return `${Math.max(1, Math.floor(diff / 86_400_000))}天前`
  return date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
}

export function CopisWorkingSidebar({ width, noTransition = false }: CopisWorkingSidebarProps): React.ReactElement {
  const [collapsed, setCollapsed] = useAtom(sidebarCollapsedAtom)
  const [auth, setAuth] = useAtom(workingAuthStateAtom)
  const [busy, setBusy] = React.useState(false)
  const [loading, setLoading] = React.useState(false)
  const [refreshingProjects, setRefreshingProjects] = React.useState(false)
  const [expandedWorkspaceId, setExpandedWorkspaceId] = React.useState<string | null>(null)
  const [expandedConversationWorkspaceIds, setExpandedConversationWorkspaceIds] = React.useState<Set<string>>(new Set())
  const [openMenuWorkspaceId, setOpenMenuWorkspaceId] = React.useState<string | null>(null)
  const [createWorkspaceOpen, setCreateWorkspaceOpen] = React.useState(false)
  const [feedbackOpen, setFeedbackOpen] = React.useState(false)
  const initialProjectsLoadedRef = React.useRef(false)

  const localWorkspaces = useAtomValue(agentWorkspacesAtom)
  const [localSessions, setLocalSessions] = useAtom(agentSessionsAtom)
  const setLocalWorkspaces = useSetAtom(agentWorkspacesAtom)
  const currentWorkspaceId = useAtomValue(currentAgentWorkspaceIdAtom)
  const currentSessionId = useAtomValue(currentAgentSessionIdAtom)
  const activeView = useAtomValue(activeViewAtom)
  const agentSettingsReady = useAtomValue(agentSettingsReadyAtom)
  const streamingStates = useAtomValue(agentStreamingStatesAtom)
  const setCurrentWorkspaceId = useSetAtom(currentAgentWorkspaceIdAtom)
  const setAppMode = useSetAtom(appModeAtom)
  const setActiveView = useSetAtom(activeViewAtom)
  const setPlanningTab = useSetAtom(planningTabAtom)
  const setWorkingSettingsOpen = useSetAtom(workingSettingsOpenAtom)
  const setSearchDialogOpen = useSetAtom(searchDialogOpenAtom)
  const setWorkingHistorySelection = useSetAtom(workingHistorySelectionAtom)
  const { createAgent } = useCreateSession()
  const openSession = useOpenSession()

  const loadWorkingData = React.useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      const state = await window.electronAPI.getWorkingAuthState()
      setAuth(state)
      if (!state.authenticated) setWorkingHistorySelection(null)
    } catch (error) {
      console.error('[Copis Working] 加载账号状态失败:', error)
      toast.error(error instanceof Error ? error.message : 'Working 数据加载失败')
    } finally {
      setLoading(false)
    }
  }, [setAuth, setWorkingHistorySelection])

  React.useEffect(() => {
    void loadWorkingData()
  }, [loadWorkingData])

  const refreshProjects = React.useCallback(async (): Promise<AgentWorkspace[]> => {
    setRefreshingProjects(true)
    try {
      const [workspaces, sessions] = await Promise.all([
        window.electronAPI.listAgentWorkspaces(),
        window.electronAPI.listAgentSessions(),
      ])
      setLocalWorkspaces(workspaces)
      setLocalSessions(sanitizeAgentSessions(sessions))
      return workspaces
    } catch (error) {
      console.error('[Copis Working] 刷新项目失败:', error)
      toast.error(error instanceof Error ? error.message : '刷新项目失败')
      return []
    } finally {
      setRefreshingProjects(false)
    }
  }, [setLocalSessions, setLocalWorkspaces])

  React.useEffect(() => {
    if (initialProjectsLoadedRef.current) return
    initialProjectsLoadedRef.current = true
    void refreshProjects()
  }, [refreshProjects])

  React.useEffect(() => {
    if (currentWorkspaceId) setExpandedWorkspaceId(currentWorkspaceId)
  }, [currentWorkspaceId])

  const handleLogout = async (): Promise<void> => {
    setBusy(true)
    try {
      setAuth(await window.electronAPI.logoutWorking())
      setWorkingHistorySelection(null)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '退出 Working 失败')
    } finally {
      setBusy(false)
    }
  }

  const selectLocalWorkspace = (workspaceId: string): void => {
    setWorkingHistorySelection(null)
    setExpandedWorkspaceId(workspaceId)
    setCurrentWorkspaceId(workspaceId)
    setAppMode('agent')
    setActiveView('conversations')
    window.electronAPI.updateSettings({ agentWorkspaceId: workspaceId }).catch(console.error)
  }

  const selectLocalSession = (sessionId: string, workspaceId: string, title: string): void => {
    setWorkingHistorySelection(null)
    setExpandedWorkspaceId(workspaceId)
    setCurrentWorkspaceId(workspaceId)
    setAppMode('agent')
    setActiveView('conversations')
    window.electronAPI.updateSettings({ agentWorkspaceId: workspaceId }).catch(console.error)
    openSession('agent', sessionId, title)
  }

  const createLocalWorkspace = async (selection: WorkingFolderSelection, allowWorkspaceWrite: boolean): Promise<void> => {
    try {
      setBusy(true)
      setWorkingHistorySelection(null)
      const project = await window.electronAPI.createAgentProject({
        name: selection.name,
        projectRootPath: selection.path,
        allowWorkspaceWrite,
      })
      if (!isAgentSessionMeta(project.session)) throw new Error('创建工作区未返回有效会话')
      setLocalWorkspaces((previous) => [
        project.workspace,
        ...previous.filter((workspace) => workspace.id !== project.workspace.id),
      ])
      setLocalSessions((previous) => [project.session, ...sanitizeAgentSessions(previous)])
      setExpandedWorkspaceId(project.workspace.id)
      setCurrentWorkspaceId(project.workspace.id)
      window.electronAPI.updateSettings({ agentWorkspaceId: project.workspace.id }).catch(console.error)
      openSession('agent', project.session.id, project.session.title)
      setCreateWorkspaceOpen(false)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '创建工作区失败')
    } finally {
      setBusy(false)
    }
  }

  const handleNewSession = async (): Promise<void> => {
    setWorkingHistorySelection(null)
    const sessionId = await createAgent()
    if (!sessionId) toast.error('新建 Agent 会话失败')
  }

  const handleNewSessionForWorkspace = async (workspaceId: string): Promise<void> => {
    setExpandedWorkspaceId(workspaceId)
    setCurrentWorkspaceId(workspaceId)
    setAppMode('agent')
    setActiveView('conversations')
    window.electronAPI.updateSettings({ agentWorkspaceId: workspaceId }).catch(console.error)
    setWorkingHistorySelection(null)
    const sessionId = await createAgent({ workspaceId })
    if (!sessionId) toast.error('新建 Agent 会话失败')
  }

  const handleOpenMemory = (): void => {
    setWorkingHistorySelection(null)
    setActiveView('memory')
  }

  const handleRemoveWorkspace = async (workspaceId: string): Promise<void> => {
    const workspace = localWorkspaces.find((item) => item.id === workspaceId)
    if (!workspace || workspace.slug === 'default') {
      toast.error('默认项目不能删除')
      return
    }
    if (!window.confirm(`确定删除项目“${workspace.name}”吗？该项目下的会话和配置也会被移除。`)) return

    try {
      setBusy(true)
      await window.electronAPI.deleteAgentWorkspace(workspaceId)
      const remainingWorkspaces = await refreshProjects()
      setOpenMenuWorkspaceId(null)
      if (currentWorkspaceId === workspaceId) {
        const fallback = remainingWorkspaces.find((item) => item.slug === 'default') ?? remainingWorkspaces[0]
        setCurrentWorkspaceId(fallback?.id ?? null)
        window.electronAPI.updateSettings({ agentWorkspaceId: fallback?.id }).catch(console.error)
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '删除项目失败')
    } finally {
      setBusy(false)
    }
  }

  const toggleWorkspace = (workspaceId: string): void => {
    setExpandedWorkspaceId((current) => current === workspaceId ? null : workspaceId)
  }

  const toggleWorkspaceConversations = (workspaceId: string): void => {
    setExpandedConversationWorkspaceIds((current) => {
      const next = new Set(current)
      if (next.has(workspaceId)) next.delete(workspaceId)
      else next.add(workspaceId)
      return next
    })
  }

  const validLocalSessions = sanitizeAgentSessions(localSessions)
  const activeSessionCount = validLocalSessions.filter((session) => !session.archived).length
  const accountName = auth?.user?.nickname || auth?.user?.email || '用户'
  const tokenBalance = typeof auth?.user?.tokens === 'number' && Number.isFinite(auth.user.tokens)
    ? new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(auth.user.tokens)
    : '--'

  if (collapsed) {
    return (
      <aside className="copis-working-sidebar collapsed">
        <button type="button" className="copis-working-sidebar-icon-button" aria-label="展开侧栏" onClick={() => setCollapsed(false)}>
          <PanelLeftOpen aria-hidden="true" />
        </button>
        <button type="button" className="copis-working-sidebar-icon-button" aria-label="搜索" onClick={() => setSearchDialogOpen(true)}>
          <Search aria-hidden="true" />
        </button>
        <button
          type="button"
          className={cn('copis-working-sidebar-icon-button', activeView === 'memory' && 'active')}
          aria-label="记忆"
          onClick={handleOpenMemory}
        >
          <BookOpen aria-hidden="true" />
        </button>
        <Sparkles className="copis-working-sidebar-collapsed-mark" aria-hidden="true" />
        <span className="copis-working-sidebar-session-count">{activeSessionCount}</span>
      </aside>
    )
  }

  return (
    <aside className={cn('copis-working-sidebar', !noTransition && 'transition-width')} style={{ width }}>
      <div className="copis-working-sidebar-body">
        <nav className="copis-working-sidebar-nav" aria-label="Working 菜单">
          <button type="button" className="copis-working-menu-button" onClick={() => void handleNewSession()}>
            <Plus aria-hidden="true" />
            <span>新任务</span>
          </button>
          <button type="button" className="copis-working-menu-button" onClick={() => setSearchDialogOpen(true)}>
            <Search aria-hidden="true" />
            <span>搜索</span>
          </button>
          <button type="button" className="copis-working-menu-button" onClick={() => { setWorkingHistorySelection(null); setAppMode('agent'); setPlanningTab('schedule'); setActiveView('planning') }}>
            <CalendarClock aria-hidden="true" />
            <span>日程表</span>
          </button>
          <button type="button" className={cn('copis-working-menu-button', activeView === 'memory' && 'active')} onClick={handleOpenMemory}>
            <BookOpen aria-hidden="true" />
            <span>记忆</span>
          </button>
          <button type="button" className="copis-working-menu-button" onClick={() => { setWorkingHistorySelection(null); setAppMode('agent'); setActiveView('agent-skills') }}>
            <UsersRound aria-hidden="true" />
            <span>专家团队</span>
          </button>
          <button type="button" className="copis-working-menu-button" onClick={() => { setWorkingHistorySelection(null); setAppMode('agent'); setActiveView('agent-skills') }}>
            <Puzzle aria-hidden="true" />
            <span>技能市场</span>
          </button>
          <button type="button" className="copis-working-menu-button" onClick={() => setCreateWorkspaceOpen(true)}>
            <FolderOpen aria-hidden="true" />
            <span>创建工作区</span>
          </button>
        </nav>

        <section className="copis-working-project-section" aria-label="项目">
          <div className="copis-working-project-heading">
            <span>项目</span>
            <button type="button" className={cn('copis-working-project-refresh', refreshingProjects && 'refreshing')} aria-label="刷新项目" title="刷新项目" disabled={refreshingProjects || busy} onClick={() => void refreshProjects()}>
              <RefreshCw aria-hidden="true" />
            </button>
          </div>
          <div className="copis-working-project-list">
            {!agentSettingsReady && (
              <div className="copis-working-project-loading" role="status" aria-live="polite">
                <div><Loader2 aria-hidden="true" />正在加载项目</div>
                <span aria-hidden="true" /><span aria-hidden="true" />
              </div>
            )}
            {agentSettingsReady && localWorkspaces.map((workspace) => {
              const workspaceSessions = validLocalSessions
                .filter((session) => !session.archived && session.workspaceId === workspace.id)
                .sort((a, b) => b.updatedAt - a.updatedAt)
              const isWorkspaceExpanded = expandedWorkspaceId === workspace.id
              const isConversationListExpanded = expandedConversationWorkspaceIds.has(workspace.id)
              const visibleSessions = isConversationListExpanded ? workspaceSessions : workspaceSessions.slice(0, CONVERSATION_PREVIEW_LIMIT)
              const hasHiddenSessions = workspaceSessions.length > visibleSessions.length
              const isActiveWorkspace = workspace.id === currentWorkspaceId
              const isMenuOpen = openMenuWorkspaceId === workspace.id

              return (
                <div className="copis-working-project-group" key={workspace.id}>
                  <div className={cn('copis-working-project-row', isActiveWorkspace && 'active', isMenuOpen && 'menu-open')} onClick={() => selectLocalWorkspace(workspace.id)}>
                    <button type="button" className="copis-working-project-main" onClick={(event) => { event.stopPropagation(); selectLocalWorkspace(workspace.id) }}>
                      <FolderOpen aria-hidden="true" />
                      <span>{workspace.name}</span>
                      {workspace.projectRootPath && <small>本地</small>}
                    </button>
                    <button type="button" className="copis-working-project-collapse" aria-label={isWorkspaceExpanded ? '折叠项目会话' : '展开项目会话'} aria-expanded={isWorkspaceExpanded} onClick={(event) => { event.stopPropagation(); toggleWorkspace(workspace.id) }}>
                      {isWorkspaceExpanded ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
                    </button>
                    {workspace.slug !== 'default' && (
                      <button type="button" className="copis-working-project-menu-trigger" aria-label={`${workspace.name} 项目菜单`} aria-haspopup="menu" aria-expanded={isMenuOpen} onClick={(event) => { event.stopPropagation(); setOpenMenuWorkspaceId(isMenuOpen ? null : workspace.id) }}>
                        <MoreHorizontal aria-hidden="true" />
                      </button>
                    )}
                    <button type="button" className="copis-working-project-new-task" aria-label={`在 ${workspace.name} 发起新会话`} title="新会话" onClick={(event) => { event.stopPropagation(); void handleNewSessionForWorkspace(workspace.id) }}>
                      <PencilLine aria-hidden="true" />
                    </button>
                    {isMenuOpen && workspace.slug !== 'default' && (
                      <div className="copis-working-project-menu" role="menu">
                        <button type="button" role="menuitem" disabled={busy || localWorkspaces.length <= 1} onClick={(event) => { event.stopPropagation(); void handleRemoveWorkspace(workspace.id) }}>
                          删除工作区
                        </button>
                      </div>
                    )}
                  </div>
                  {isWorkspaceExpanded && (
                    <div className="copis-working-conversation-list">
                      {visibleSessions.map((session) => {
                        const streamState = streamingStates.get(session.id)
                        return (
                          <button type="button" key={session.id} className={cn('copis-working-conversation-row', session.id === currentSessionId && 'active')} onClick={() => selectLocalSession(session.id, workspace.id, session.title)}>
                            <span>{session.title || '未命名会话'}</span>
                            {streamState?.running ? <Loader2 className="loading" aria-label="会话进行中" /> : session.completedButUnconfirmed ? <CircleCheck className="completed" aria-label="会话已完成" /> : <small>{formatSessionTime(session.updatedAt)}</small>}
                          </button>
                        )
                      })}
                      {workspaceSessions.length === 0 && (
                        <button type="button" className="copis-working-conversation-empty" onClick={() => void handleNewSessionForWorkspace(workspace.id)}>
                          还没有会话，开始一个新任务
                        </button>
                      )}
                      {workspaceSessions.length > CONVERSATION_PREVIEW_LIMIT && (
                        <button type="button" className="copis-working-conversation-toggle" onClick={() => toggleWorkspaceConversations(workspace.id)}>
                          {hasHiddenSessions ? '展开更多' : '折叠显示'}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
            {agentSettingsReady && localWorkspaces.length === 0 && (
              <button type="button" className="copis-working-sidebar-muted" onClick={() => setCreateWorkspaceOpen(true)} disabled={busy}>
                创建工作区后显示项目对话
              </button>
            )}
          </div>
        </section>
      </div>

      <footer className="copis-working-sidebar-footer">
        <button type="button" className="copis-working-sidebar-account" onClick={() => setFeedbackOpen(true)}>
          <span className="copis-working-account-mark"><MessageSquare aria-hidden="true" /></span>
          <span><strong>意见反馈</strong><small>问题与建议</small></span>
        </button>
        <div className="copis-working-settings-row">
          <button type="button" className="copis-working-sidebar-account with-balance" onClick={() => setWorkingSettingsOpen(true)}>
            <span className="copis-working-account-mark"><Settings aria-hidden="true" /></span>
            <span className="copis-working-account-copy"><strong>设置</strong><small>{accountName}</small></span>
            <span className="copis-working-account-balance" title="当前积分" aria-label={`当前积分 ${tokenBalance}`}><Gem aria-hidden="true" /><b>{tokenBalance}</b></span>
          </button>
          <button type="button" className="copis-working-logout" aria-label="退出 Working" title="退出 Working" disabled={busy || loading} onClick={() => void handleLogout()}>
            <LogOut aria-hidden="true" />
          </button>
        </div>
      </footer>
      {createWorkspaceOpen && (
        <CopisWorkingConnectDialog
          busy={busy}
          onClose={() => setCreateWorkspaceOpen(false)}
          onConfirm={createLocalWorkspace}
        />
      )}
      <CopisWorkingFeedbackDialog open={feedbackOpen} onClose={() => setFeedbackOpen(false)} />
    </aside>
  )
}
