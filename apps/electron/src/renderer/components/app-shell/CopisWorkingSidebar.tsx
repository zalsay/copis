import * as React from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import {
  CalendarClock,
  BookOpen,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  FolderCode,
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
  Trash2,
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
import { pinnedDevProjectsAtom } from '@/atoms/pinned-dev-projects'
import {
  createWorkspaceDialogOpenAtom,
  createdWorkspaceIdAtom,
  newExpertTeamDialogOpenAtom,
  openCreateWorkspaceDialogAtom,
  workspaceCreationSourceAtom,
  workingAuthStateAtom,
  workingHistorySelectionAtom,
  workingSettingsOpenAtom,
} from '@/atoms/working-atoms'
import { useCreateSession } from '@/hooks/useCreateSession'
import { useCloseTab } from '@/hooks/useCloseTab'
import { useOpenSession } from '@/hooks/useOpenSession'
import { isAgentSessionMeta, sanitizeAgentSessions } from '@/lib/agent-session-list'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { CopisWorkingConnectDialog, type WorkingFolderSelection } from './CopisWorkingConnectDialog'
import { CopisWorkingFeedbackDialog } from './CopisWorkingFeedbackDialog'
import './CopisWorkingSidebar.css'

interface CopisWorkingSidebarProps {
  width: number
  noTransition?: boolean
}

interface PendingDeleteSession {
  id: string
  title: string
}

const CONVERSATION_PREVIEW_LIMIT = 5
/** 项目菜单的估算高度，用于判断向下弹出是否会超出侧栏底部。 */
const PROJECT_MENU_ESTIMATED_HEIGHT = 44

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
  const [pinnedGroupCollapsed, setPinnedGroupCollapsed] = React.useState(false)
  const [workspaceGroupCollapsed, setWorkspaceGroupCollapsed] = React.useState(false)
  const [openMenuWorkspaceId, setOpenMenuWorkspaceId] = React.useState<string | null>(null)
  const [openMenuDirection, setOpenMenuDirection] = React.useState<'down' | 'up'>('down')
  const [pendingDeleteSession, setPendingDeleteSession] = React.useState<PendingDeleteSession | null>(null)
  const [createWorkspaceOpen, setCreateWorkspaceOpen] = useAtom(createWorkspaceDialogOpenAtom)
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
  const pinnedDevProjects = useAtomValue(pinnedDevProjectsAtom)
  const setCurrentWorkspaceId = useSetAtom(currentAgentWorkspaceIdAtom)
  const setAppMode = useSetAtom(appModeAtom)
  const setActiveView = useSetAtom(activeViewAtom)
  const setPlanningTab = useSetAtom(planningTabAtom)
  const setWorkingSettingsOpen = useSetAtom(workingSettingsOpenAtom)
  const setSearchDialogOpen = useSetAtom(searchDialogOpenAtom)
  const setWorkingHistorySelection = useSetAtom(workingHistorySelectionAtom)
  const setCreatedWorkspaceId = useSetAtom(createdWorkspaceIdAtom)
  const setNewExpertTeamDialogOpen = useSetAtom(newExpertTeamDialogOpenAtom)
  const workspaceCreationSource = useAtomValue(workspaceCreationSourceAtom)
  const setWorkspaceCreationSource = useSetAtom(workspaceCreationSourceAtom)
  const openCreateWorkspaceDialog = useSetAtom(openCreateWorkspaceDialogAtom)
  const { createAgent } = useCreateSession()
  const { executeClose } = useCloseTab()
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
      const isExpertTeamFlow = workspaceCreationSource === 'expert-team' || workspaceCreationSource === 'expert-team-new'
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
      if (!isExpertTeamFlow) {
        setLocalSessions((previous) => [project.session, ...sanitizeAgentSessions(previous)])
      }
      setExpandedWorkspaceId(project.workspace.id)
      setCurrentWorkspaceId(project.workspace.id)
      window.electronAPI.updateSettings({ agentWorkspaceId: project.workspace.id }).catch(console.error)
      if (workspaceCreationSource === 'sidebar') {
        openSession('agent', project.session.id, project.session.title)
      }
      // 'expert-team' / 'expert-team-new'：专家团队工作台绑定/筹备流程自行接管会话导航
      if (isExpertTeamFlow) {
        // createAgentProject 会自动生成项目首个默认会话；专家团队流程会另建主理人会话，这里删除多余默认会话，避免侧栏多出空对话。
        try {
          await window.electronAPI.deleteAgentSession(project.session.id)
        } catch (deleteError) {
          console.warn('[Copis Working] 清理专家团队流程默认会话失败:', deleteError)
        }
      }
      setCreatedWorkspaceId(project.workspace.id)
      setWorkspaceCreationSource(null)
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

  const requestRemoveSession = (sessionId: string, title: string): void => {
    const session = localSessions.find((item) => item.id === sessionId)
    if (!session) return
    if (streamingStates.get(sessionId)?.running) {
      toast.info('会话进行中，完成后再删除')
      return
    }
    setPendingDeleteSession({ id: sessionId, title })
  }

  const handleConfirmRemoveSession = async (): Promise<void> => {
    const pendingSession = pendingDeleteSession
    if (!pendingSession) return
    const sessionId = pendingSession.id
    if (streamingStates.get(sessionId)?.running) {
      setPendingDeleteSession(null)
      toast.info('会话进行中，暂不能删除')
      return
    }
    setPendingDeleteSession(null)

    try {
      setBusy(true)
      await window.electronAPI.deleteAgentSession(sessionId)
      executeClose(sessionId, { clearCompletionNotice: false })
      setLocalSessions((previous) => previous.filter((item) => item.id !== sessionId))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '删除会话失败')
    } finally {
      setBusy(false)
    }
  }

  const handleOpenMemory = (): void => {
    setWorkingHistorySelection(null)
    setActiveView('memory')
  }

  const handleOpenCreateWorkspace = React.useCallback((): void => {
    openCreateWorkspaceDialog('sidebar')
  }, [openCreateWorkspaceDialog])

  const handleCloseCreateWorkspace = React.useCallback((): void => {
    const reopenNewExpertTeam = workspaceCreationSource === 'expert-team-new'
    setCreateWorkspaceOpen(false)
    setWorkspaceCreationSource(null)
    if (reopenNewExpertTeam) setNewExpertTeamDialogOpen(true)
  }, [setCreateWorkspaceOpen, setWorkspaceCreationSource, workspaceCreationSource])

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
  const currentSessionWorkspaceId = currentSessionId === null
    ? null
    : validLocalSessions.find((session) => session.id === currentSessionId)?.workspaceId ?? null
  const activeSessionCount = validLocalSessions.filter((session) => !session.archived).length
  const accountName = auth?.user?.nickname || auth?.user?.email || '用户'
  const tokenBalance = typeof auth?.user?.tokens === 'number' && Number.isFinite(auth.user.tokens)
    ? new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(auth.user.tokens)
    : '--'
  const pinnedProjectEntries = localWorkspaces.flatMap((workspace) => {
    const paths = pinnedDevProjects[workspace.slug] ?? []
    return paths.map((projectPath) => ({ workspace, projectPath }))
  })

  const renderWorkspaceGroup = (workspace: AgentWorkspace): React.ReactElement => {
    const workspaceSessions = validLocalSessions
      .filter((session) => !session.archived && session.workspaceId === workspace.id)
      .sort((a, b) => b.updatedAt - a.updatedAt)
    const isWorkspaceExpanded = expandedWorkspaceId === workspace.id
    const isConversationListExpanded = expandedConversationWorkspaceIds.has(workspace.id)
    const visibleSessions = isConversationListExpanded ? workspaceSessions : workspaceSessions.slice(0, CONVERSATION_PREVIEW_LIMIT)
    const hasHiddenSessions = workspaceSessions.length > visibleSessions.length
    const isActiveWorkspace = workspace.id === currentWorkspaceId
    const isCurrentSessionWorkspace = workspace.id === currentSessionWorkspaceId
    const isMenuOpen = openMenuWorkspaceId === workspace.id
    const isMenuOpenUp = isMenuOpen && openMenuDirection === 'up'

    return (
      <div className="copis-working-project-group" key={workspace.id}>
        <div
          className={cn(
            'copis-working-project-row',
            isActiveWorkspace && 'active',
            isCurrentSessionWorkspace && 'current-session-workspace',
            isMenuOpen && 'menu-open',
            isMenuOpenUp && 'menu-up',
          )}
          onClick={() => selectLocalWorkspace(workspace.id)}
        >
          <button type="button" className="copis-working-project-main" onClick={(event) => { event.stopPropagation(); selectLocalWorkspace(workspace.id) }}>
            <FolderOpen className="copis-working-project-workspace-row-icon" aria-hidden="true" />
            <span>{workspace.name}</span>
          </button>
          <button type="button" className="copis-working-project-collapse" aria-label={isWorkspaceExpanded ? '折叠项目会话' : '展开项目会话'} aria-expanded={isWorkspaceExpanded} onClick={(event) => { event.stopPropagation(); toggleWorkspace(workspace.id) }}>
            {isWorkspaceExpanded ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
          </button>
          {workspace.slug !== 'default' && (
            <button type="button" className="copis-working-project-menu-trigger" aria-label={`${workspace.name} 项目菜单`} aria-haspopup="menu" aria-expanded={isMenuOpen} onClick={(event) => {
              event.stopPropagation()
              if (isMenuOpen) {
                setOpenMenuWorkspaceId(null)
                return
              }
              // 靠近侧栏底部时向下弹出会被下方组件遮挡，改为向上弹出。
              const triggerRect = event.currentTarget.getBoundingClientRect()
              const spaceBelow = window.innerHeight - triggerRect.bottom
              setOpenMenuDirection(spaceBelow < PROJECT_MENU_ESTIMATED_HEIGHT ? 'up' : 'down')
              setOpenMenuWorkspaceId(workspace.id)
            }}>
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
              const sessionTitle = session.title || '未命名会话'
              const isExpertTeamSession = session.expertTeamSession !== undefined || session.expertTeamSetup === true
              const displaySessionTitle = isExpertTeamSession
                ? sessionTitle.replace(/^专家团队\s*·\s*/, '')
                : sessionTitle
              return (
                <div key={session.id} className={cn('copis-working-conversation-row', session.id === currentSessionId && 'active')}>
                  <button type="button" className="copis-working-conversation-main" onClick={() => selectLocalSession(session.id, workspace.id, sessionTitle)}>
                    <span className="copis-working-conversation-label">
                      {isExpertTeamSession && <small className="ui-primary-badge">{session.expertTeamSession ? '专家团队' : '组建中'}</small>}
                      <span>{displaySessionTitle}</span>
                    </span>
                  </button>
                  <span className="copis-working-conversation-meta">
                    {streamState?.running ? <Loader2 className="loading" aria-label="会话进行中" /> : session.completedButUnconfirmed ? <CircleCheck className="completed" aria-label="会话已完成" /> : <small>{formatSessionTime(session.updatedAt)}</small>}
                  </span>
                  <button
                    type="button"
                    className="copis-working-conversation-delete"
                    aria-label={`删除会话 ${sessionTitle}`}
                    title={streamState?.running ? '会话进行中，暂不能删除' : '删除会话'}
                    disabled={busy || streamState?.running === true}
                    onClick={(event) => {
                      event.stopPropagation()
                      requestRemoveSession(session.id, sessionTitle)
                    }}
                  >
                    <Trash2 aria-hidden="true" />
                  </button>
                </div>
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
  }

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
        <button
          type="button"
          className={cn('copis-working-sidebar-icon-button', activeView === 'expert-team' && 'active')}
          aria-label="专家团队"
          onClick={() => { setWorkingHistorySelection(null); setAppMode('agent'); setActiveView('expert-team') }}
        >
          <UsersRound aria-hidden="true" />
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
          <button type="button" className={cn('copis-working-menu-button', activeView === 'expert-team' && 'active')} onClick={() => { setWorkingHistorySelection(null); setAppMode('agent'); setActiveView('expert-team') }}>
            <UsersRound aria-hidden="true" />
            <span>专家团队</span>
          </button>
          <button type="button" className="copis-working-menu-button" onClick={() => { setWorkingHistorySelection(null); setAppMode('agent'); setActiveView('agent-skills') }}>
            <Puzzle aria-hidden="true" />
            <span>技能市场</span>
          </button>
        </nav>

        <section className="copis-working-project-section" aria-label="工作区">
          <div className="copis-working-project-group-section">
            <div className="copis-working-project-heading copis-working-project-group-heading">
              <button
                type="button"
                className="copis-working-project-group-toggle copis-working-project-pinned-toggle"
                aria-expanded={!pinnedGroupCollapsed}
                onClick={() => setPinnedGroupCollapsed((current) => !current)}
              >
                <span>我的项目</span>
                <ChevronRight className={cn('copis-working-project-group-chevron', !pinnedGroupCollapsed && 'expanded')} aria-hidden="true" />
                <small className="copis-working-project-group-count">{pinnedProjectEntries.length}</small>
              </button>
              <div className="copis-working-project-heading-actions">
                <button type="button" className={cn('copis-working-project-refresh', refreshingProjects && 'refreshing')} aria-label="刷新项目" title="刷新项目" disabled={refreshingProjects || busy} onClick={() => void refreshProjects()}>
                  <RefreshCw aria-hidden="true" />
                </button>
              </div>
            </div>
            {!pinnedGroupCollapsed && (
              pinnedProjectEntries.length > 0 ? (
                pinnedProjectEntries.map((entry) => (
                  <button
                    type="button"
                    key={`${entry.workspace.id}:${entry.projectPath}`}
                    className="copis-working-project-pinned-row"
                    title={`${entry.workspace.name} · project/${entry.projectPath}`}
                    onClick={() => selectLocalWorkspace(entry.workspace.id)}
                  >
                    <FolderCode className="copis-working-project-pinned-icon" aria-hidden="true" />
                    <span className="copis-working-project-pinned-copy">
                      <span className="copis-working-project-pinned-name">{entry.workspace.name}</span>
                      <small>project/{entry.projectPath}</small>
                    </span>
                  </button>
                ))
              ) : (
                <div className="copis-working-project-pinned-empty">暂无固定项目，在右侧项目列表点击图钉添加</div>
              )
            )}
          </div>
          <div className="copis-working-project-group-section">
            <div className="copis-working-project-heading copis-working-project-group-heading">
              <button
                type="button"
                className="copis-working-project-group-toggle copis-working-project-workspace-toggle"
                aria-expanded={!workspaceGroupCollapsed}
                onClick={() => setWorkspaceGroupCollapsed((current) => !current)}
              >
                <span>工作区</span>
                <ChevronRight className={cn('copis-working-project-group-chevron', !workspaceGroupCollapsed && 'expanded')} aria-hidden="true" />
                <small className="copis-working-project-group-count">{localWorkspaces.length}</small>
              </button>
              <div className="copis-working-project-heading-actions">
                <button type="button" className="copis-working-project-create" aria-label="创建工作区" title="创建工作区" disabled={busy} onClick={handleOpenCreateWorkspace}>
                  <Plus aria-hidden="true" />
                </button>
              </div>
            </div>
            {!workspaceGroupCollapsed && (
              <div className="copis-working-project-list">
                {!agentSettingsReady && (
                  <div className="copis-working-project-loading" role="status" aria-live="polite">
                    <div><Loader2 aria-hidden="true" />正在加载项目</div>
                    <span aria-hidden="true" /><span aria-hidden="true" />
                  </div>
                )}
                {agentSettingsReady && localWorkspaces.map(renderWorkspaceGroup)}
                {agentSettingsReady && localWorkspaces.length === 0 && (
                  <button type="button" className="copis-working-sidebar-muted" onClick={handleOpenCreateWorkspace} disabled={busy}>
                    创建工作区后显示项目对话
                  </button>
                )}
              </div>
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
          onClose={handleCloseCreateWorkspace}
          onConfirm={createLocalWorkspace}
        />
      )}
      <CopisWorkingFeedbackDialog open={feedbackOpen} onClose={() => setFeedbackOpen(false)} />
      <AlertDialog
        open={pendingDeleteSession !== null}
        onOpenChange={(open) => { if (!open) setPendingDeleteSession(null) }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认删除会话</AlertDialogTitle>
            <AlertDialogDescription>
              确定要删除“{pendingDeleteSession?.title || '未命名会话'}”吗？会话消息和工作文件也会被移除，且无法恢复。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => void handleConfirmRemoveSession()}
              disabled={busy}
              className="bg-[var(--ui-primary)] text-[var(--ui-primary-foreground)] hover:brightness-105"
            >
              删除会话
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </aside>
  )
}
