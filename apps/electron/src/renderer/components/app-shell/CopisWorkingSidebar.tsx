import * as React from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import {
  ArrowDown,
  ArrowUp,
  ArrowUpToLine,
  CalendarClock,
  BookOpen,
  Brain,
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
  Pin,
  PinOff,
  Plus,
  Puzzle,
  RefreshCw,
  Search,
  Settings,
  Sparkles,
  Timer,
  Trash2,
  TrendingUp,
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
import { hasUpdateAtom } from '@/atoms/updater'
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
import {
  hiddenSidebarMenuItemsAtom,
  hideSidebarMenuItem,
  type SidebarMenuItemId,
} from '@/atoms/sidebar-menu-atoms'
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
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { CopisWorkingConnectDialog, type WorkingFolderSelection } from './CopisWorkingConnectDialog'
import { CopisWorkingFeedbackDialog } from './CopisWorkingFeedbackDialog'
import { CopisModeSwitcher } from './CopisModeSwitcher'
import './CopisWorkingSidebar.css'

interface CopisWorkingSidebarProps {
  width: number
  noTransition?: boolean
}

interface PendingDeleteSession {
  id: string
  title: string
}

interface PendingDeleteWorkspace {
  id: string
  name: string
}

const CONVERSATION_PREVIEW_LIMIT = 5
/** 项目菜单的估算高度，用于判断向下弹出是否会超出侧栏底部。 */
const PROJECT_MENU_ESTIMATED_HEIGHT = 180

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
  const [pendingDeleteWorkspace, setPendingDeleteWorkspace] = React.useState<PendingDeleteWorkspace | null>(null)
  const [createWorkspaceOpen, setCreateWorkspaceOpen] = useAtom(createWorkspaceDialogOpenAtom)
  const [feedbackOpen, setFeedbackOpen] = React.useState(false)
  const initialProjectsLoadedRef = React.useRef(false)

  const localWorkspaces = useAtomValue(agentWorkspacesAtom)
  const [localSessions, setLocalSessions] = useAtom(agentSessionsAtom)
  const setLocalWorkspaces = useSetAtom(agentWorkspacesAtom)
  const currentWorkspaceId = useAtomValue(currentAgentWorkspaceIdAtom)
  const currentSessionId = useAtomValue(currentAgentSessionIdAtom)
  const activeView = useAtomValue(activeViewAtom)
  const hasUpdate = useAtomValue(hasUpdateAtom)
  const agentSettingsReady = useAtomValue(agentSettingsReadyAtom)
  const streamingStates = useAtomValue(agentStreamingStatesAtom)
  const pinnedDevProjects = useAtomValue(pinnedDevProjectsAtom)
  const setCurrentWorkspaceId = useSetAtom(currentAgentWorkspaceIdAtom)
  const [appMode, setAppMode] = useAtom(appModeAtom)
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
  const [hiddenMenuItems, setHiddenMenuItems] = useAtom(hiddenSidebarMenuItemsAtom)

  const isMenuHidden = React.useCallback(
    (id: string): boolean => hiddenMenuItems.includes(id),
    [hiddenMenuItems],
  )

  const handleHideMenuItem = React.useCallback((id: SidebarMenuItemId, label: string, targetView?: string): void => {
    void hideSidebarMenuItem(setHiddenMenuItems, hiddenMenuItems, id).catch((error) => {
      console.error('[Copis Working] 隐藏菜单失败:', error)
      toast.error('隐藏菜单失败')
    })
    if (targetView && activeView === targetView) {
      setActiveView('conversations')
    }
    toast.success(`已隐藏「${label}」，可在「设置 - 菜单管理」中恢复`)
  }, [activeView, hiddenMenuItems, setActiveView, setHiddenMenuItems])

  const loadWorkingData = React.useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      const state = await window.electronAPI.getWorkingAuthState()
      setAuth(state)
      if (!state.authenticated) setWorkingHistorySelection(null)
    } catch (error) {
      console.error('[Copis Working] 加载账号状态失败:', error)
      toast.error(error instanceof Error ? error.message : 'Copis 数据加载失败')
    } finally {
      setLoading(false)
    }
  }, [setAuth, setWorkingHistorySelection])

  React.useEffect(() => {
    void loadWorkingData()
  }, [loadWorkingData])

  React.useEffect(() => {
    if (!openMenuWorkspaceId) return
    const handleOutsideClick = (event: MouseEvent): void => {
      const target = event.target as HTMLElement | null
      if (target?.closest('.copis-working-project-menu') || target?.closest('.copis-working-project-menu-trigger')) {
        return
      }
      setOpenMenuWorkspaceId(null)
    }
    window.addEventListener('click', handleOutsideClick)
    return () => {
      window.removeEventListener('click', handleOutsideClick)
    }
  }, [openMenuWorkspaceId])

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
      toast.error(error instanceof Error ? error.message : '退出 Copis 失败')
    } finally {
      setBusy(false)
    }
  }

  const selectLocalWorkspace = (workspaceId: string): void => {
    setWorkingHistorySelection(null)
    setExpandedWorkspaceId(workspaceId)
    setCurrentWorkspaceId(workspaceId)
    if (appMode !== 'creation') {
      setAppMode('agent')
    }
    setActiveView('conversations')
    window.electronAPI.updateSettings({ agentWorkspaceId: workspaceId }).catch(console.error)
  }

  const selectLocalSession = (sessionId: string, workspaceId: string, title: string): void => {
    setWorkingHistorySelection(null)
    setExpandedWorkspaceId(workspaceId)
    setCurrentWorkspaceId(workspaceId)
    const targetSession = localSessions.find((s) => s.id === sessionId)
    if (targetSession?.mode === 'creation' || targetSession?.agentRuntime === 'dsh') {
      setAppMode('creation')
    } else {
      setAppMode('agent')
    }
    setActiveView('conversations')
    window.electronAPI.updateSettings({ agentWorkspaceId: workspaceId }).catch(console.error)
    openSession('agent', sessionId, title)
  }

  const createLocalWorkspace = async (selection: WorkingFolderSelection): Promise<void> => {
    try {
      setBusy(true)
      setWorkingHistorySelection(null)
      const isExpertTeamFlow = workspaceCreationSource === 'expert-team' || workspaceCreationSource === 'expert-team-new'
      const project = await window.electronAPI.createAgentProject({
        name: selection.name,
        projectRootPath: selection.path,
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
    if (!sessionId) toast.error(appMode === 'creation' ? '新建创造模式会话失败' : '新建 Agent 会话失败')
  }

  const handleNewSessionForWorkspace = async (workspaceId: string): Promise<void> => {
    setExpandedWorkspaceId(workspaceId)
    setCurrentWorkspaceId(workspaceId)
    if (appMode !== 'creation') {
      setAppMode('agent')
    }
    setActiveView('conversations')
    window.electronAPI.updateSettings({ agentWorkspaceId: workspaceId }).catch(console.error)
    setWorkingHistorySelection(null)
    const sessionId = await createAgent({ workspaceId })
    if (!sessionId) toast.error(appMode === 'creation' ? '新建创造模式会话失败' : '新建 Agent 会话失败')
  }

  const handleOpenWorkspaceFolder = async (workspace: AgentWorkspace): Promise<void> => {
    setOpenMenuWorkspaceId(null)
    try {
      const folderPath = await window.electronAPI.getWorkspaceFilesPath(workspace.slug)
      await window.electronAPI.openFile(folderPath, { workspaceSlug: workspace.slug })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '打开工作区文件夹失败')
    }
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

  const handleOpenKnowledge = (): void => {
    setWorkingHistorySelection(null)
    setActiveView('knowledge')
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

  const handleTogglePinWorkspace = React.useCallback(async (workspaceId: string): Promise<void> => {
    setOpenMenuWorkspaceId(null)
    const ws = localWorkspaces.find((w) => w.id === workspaceId)
    if (!ws) return

    const willPin = !ws.pinned
    const updated: AgentWorkspace[] = localWorkspaces.map((item) => {
      if (item.id !== workspaceId) return item
      if (willPin) {
        return { ...item, pinned: true, pinnedAt: Date.now() }
      }
      const next: AgentWorkspace = { ...item }
      delete next.pinned
      delete next.pinnedAt
      return next
    })

    const pinnedList = updated.filter((w) => w.pinned).sort((a, b) => (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0))
    const unpinnedList = updated.filter((w) => !w.pinned)
    const reordered = [...pinnedList, ...unpinnedList]

    setLocalWorkspaces(reordered)
    try {
      const result = await window.electronAPI.togglePinAgentWorkspace(workspaceId)
      if (Array.isArray(result) && result.length > 0) {
        setLocalWorkspaces(result)
      }
      toast.success(willPin ? '已置顶工作区' : '已取消置顶')
    } catch (error) {
      console.error('切换工作区置顶状态失败:', error)
      toast.error(willPin ? '置顶工作区失败' : '取消置顶失败')
      setLocalWorkspaces(localWorkspaces)
    }
  }, [localWorkspaces, setLocalWorkspaces])

  const handlePinWorkspaceToTop = handleTogglePinWorkspace

  const handleMoveWorkspaceUp = React.useCallback(async (workspaceId: string): Promise<void> => {
    setOpenMenuWorkspaceId(null)
    const fromIdx = localWorkspaces.findIndex((w) => w.id === workspaceId)
    if (fromIdx <= 0) return
    const targetIdx = fromIdx - 1
    const currentWs = localWorkspaces[fromIdx]
    const targetWs = localWorkspaces[targetIdx]
    if (!currentWs || !targetWs) return
    // 不能跨越置顶与未置顶分界
    if (Boolean(currentWs.pinned) !== Boolean(targetWs.pinned)) return

    const reordered = [...localWorkspaces]
    const [moved] = reordered.splice(fromIdx, 1)
    if (!moved) return
    reordered.splice(targetIdx, 0, moved)

    if (moved.pinned) {
      const pinnedList = reordered.filter((w) => w.pinned)
      const now = Date.now()
      pinnedList.forEach((w, idx) => {
        w.pinnedAt = now - idx * 1000
      })
    }

    setLocalWorkspaces(reordered)
    try {
      await window.electronAPI.reorderAgentWorkspaces(reordered.map((w) => w.id))
    } catch (error) {
      console.error('上移工作区失败:', error)
      toast.error('上移工作区失败')
    }
  }, [localWorkspaces, setLocalWorkspaces])

  const handleMoveWorkspaceDown = React.useCallback(async (workspaceId: string): Promise<void> => {
    setOpenMenuWorkspaceId(null)
    const fromIdx = localWorkspaces.findIndex((w) => w.id === workspaceId)
    if (fromIdx === -1 || fromIdx >= localWorkspaces.length - 1) return
    const targetIdx = fromIdx + 1
    const currentWs = localWorkspaces[fromIdx]
    const targetWs = localWorkspaces[targetIdx]
    if (!currentWs || !targetWs) return
    // 不能跨越置顶与未置顶分界
    if (Boolean(currentWs.pinned) !== Boolean(targetWs.pinned)) return

    const reordered = [...localWorkspaces]
    const [moved] = reordered.splice(fromIdx, 1)
    if (!moved) return
    reordered.splice(targetIdx, 0, moved)

    if (moved.pinned) {
      const pinnedList = reordered.filter((w) => w.pinned)
      const now = Date.now()
      pinnedList.forEach((w, idx) => {
        w.pinnedAt = now - idx * 1000
      })
    }

    setLocalWorkspaces(reordered)
    try {
      await window.electronAPI.reorderAgentWorkspaces(reordered.map((w) => w.id))
    } catch (error) {
      console.error('下移工作区失败:', error)
      toast.error('下移工作区失败')
    }
  }, [localWorkspaces, setLocalWorkspaces])

  const requestRemoveWorkspace = (workspaceId: string): void => {
    setOpenMenuWorkspaceId(null)
    const workspace = localWorkspaces.find((item) => item.id === workspaceId)
    if (!workspace || workspace.slug === 'default') {
      toast.error('默认工作区不能删除')
      return
    }
    setPendingDeleteWorkspace({ id: workspace.id, name: workspace.name })
  }

  const handleConfirmRemoveWorkspace = async (): Promise<void> => {
    const pendingWorkspace = pendingDeleteWorkspace
    if (!pendingWorkspace) return
    try {
      setBusy(true)
      await window.electronAPI.deleteAgentWorkspace(pendingWorkspace.id)
      const remainingWorkspaces = await refreshProjects()
      setOpenMenuWorkspaceId(null)
      setPendingDeleteWorkspace(null)
      if (currentWorkspaceId === pendingWorkspace.id) {
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

  const renderWorkspaceGroup = (
    workspace: AgentWorkspace,
    index: number,
    allWorkspaces: AgentWorkspace[],
  ): React.ReactElement => {
    const isPinned = Boolean(workspace.pinned)
    const pinnedCount = allWorkspaces.filter((w) => w.pinned).length
    const canMoveUp = isPinned ? index > 0 : index > pinnedCount
    const canMoveDown = isPinned ? index < pinnedCount - 1 : index < allWorkspaces.length - 1
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
      <div className={cn('copis-working-project-group', isMenuOpen && 'menu-open')} key={workspace.id}>
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
            {isPinned && (
              <Pin className="copis-working-project-pin-badge" aria-label="已置顶" />
            )}
          </button>
          <button type="button" className="copis-working-project-collapse" aria-label={isWorkspaceExpanded ? '折叠项目会话' : '展开项目会话'} aria-expanded={isWorkspaceExpanded} onClick={(event) => { event.stopPropagation(); toggleWorkspace(workspace.id) }}>
            {isWorkspaceExpanded ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
          </button>
          <button type="button" className="copis-working-project-menu-trigger" aria-label={`${workspace.name} 项目菜单`} aria-haspopup="menu" aria-expanded={isMenuOpen} onClick={(event) => {
            event.stopPropagation()
            if (isMenuOpen) {
              setOpenMenuWorkspaceId(null)
              return
            }
            // 靠近侧栏滚动容器底部时向下弹出会被遮挡，改为向上弹出。
            const triggerRect = event.currentTarget.getBoundingClientRect()
            const bodyEl = event.currentTarget.closest('.copis-working-sidebar-body')
            const bodyBottom = bodyEl ? bodyEl.getBoundingClientRect().bottom : window.innerHeight
            const spaceBelow = bodyBottom - triggerRect.bottom
            setOpenMenuDirection(spaceBelow < PROJECT_MENU_ESTIMATED_HEIGHT ? 'up' : 'down')
            setOpenMenuWorkspaceId(workspace.id)
          }}>
            <MoreHorizontal aria-hidden="true" />
          </button>
          <button type="button" className="copis-working-project-new-task" aria-label={`在 ${workspace.name} 发起新会话`} title="新会话" onClick={(event) => { event.stopPropagation(); void handleNewSessionForWorkspace(workspace.id) }}>
            <PencilLine aria-hidden="true" />
          </button>
          {isMenuOpen && (
            <div className="copis-working-project-menu" role="menu">
              <button
                type="button"
                role="menuitem"
                disabled={busy}
                onClick={(event) => {
                  event.stopPropagation()
                  void handleTogglePinWorkspace(workspace.id)
                }}
              >
                {isPinned ? (
                  <>
                    <PinOff aria-hidden="true" />
                    <span>取消置顶</span>
                  </>
                ) : (
                  <>
                    <ArrowUpToLine aria-hidden="true" />
                    <span>置顶</span>
                  </>
                )}
              </button>
              <button
                type="button"
                role="menuitem"
                disabled={busy || !canMoveUp}
                onClick={(event) => {
                  event.stopPropagation()
                  void handleMoveWorkspaceUp(workspace.id)
                }}
              >
                <ArrowUp aria-hidden="true" />
                <span>上移</span>
              </button>
              <button
                type="button"
                role="menuitem"
                disabled={busy || !canMoveDown}
                onClick={(event) => {
                  event.stopPropagation()
                  void handleMoveWorkspaceDown(workspace.id)
                }}
              >
                <ArrowDown aria-hidden="true" />
                <span>下移</span>
              </button>
              <div className="copis-working-project-menu-divider" role="separator" />
              <button
                type="button"
                role="menuitem"
                onClick={(event) => {
                  event.stopPropagation()
                  void handleOpenWorkspaceFolder(workspace)
                }}
              >
                <FolderOpen aria-hidden="true" />
                <span>打开文件夹</span>
              </button>
              {workspace.slug !== 'default' && workspace.slug !== 'investment' && (
                <button
                  type="button"
                  className="copis-working-project-delete"
                  role="menuitem"
                  disabled={busy || localWorkspaces.length <= 1}
                  onClick={(event) => {
                    event.stopPropagation()
                    requestRemoveWorkspace(workspace.id)
                  }}
                >
                  <Trash2 aria-hidden="true" />
                  <span>删除工作区</span>
                </button>
              )}
            </div>
          )}
        </div>
        {isWorkspaceExpanded && (
          <div className="copis-working-conversation-list">
            {visibleSessions.map((session) => {
              const streamState = streamingStates.get(session.id)
              const sessionTitle = session.title || '未命名会话'
              const isExpertTeamSession = session.expertTeamSession !== undefined || session.expertTeamSetup === true
              const isFeishuSession = session.source === 'feishu'
                || session.feishuDedicated === true
                || (session as unknown as { sourceChannel?: string }).sourceChannel === 'feishu'
                || sessionTitle === '飞书专属会话'
                || sessionTitle === '飞书会话'
                || sessionTitle.startsWith('飞书')
                || sessionTitle.startsWith('[飞书]')
              const isWeChatSession = session.source === 'wechat'
                || session.wechatDedicated === true
                || (session as unknown as { sourceChannel?: string }).sourceChannel === 'wechat'
                || sessionTitle === '微信专属会话'
                || sessionTitle === '微信会话'
                || sessionTitle.startsWith('微信')
                || sessionTitle.startsWith('[微信]')
              const isDingTalkSession = session.source === 'dingtalk'
                || session.dingtalkDedicated === true
                || (session as unknown as { sourceChannel?: string }).sourceChannel === 'dingtalk'
                || sessionTitle === '钉钉专属会话'
                || sessionTitle === '钉钉会话'
                || sessionTitle.startsWith('钉钉')
                || sessionTitle.startsWith('[钉钉]')
              const displaySessionTitle = isExpertTeamSession
                ? sessionTitle.replace(/^专家团队\s*·\s*/, '')
                : isFeishuSession
                ? sessionTitle.replace(/^(?:飞书专属会话|飞书会话|飞书\s*·\s*|\[飞书\]\s*)/, (m) => (m === '飞书专属会话' || m === '飞书会话') ? '专属会话' : '')
                : isWeChatSession
                ? sessionTitle.replace(/^(?:微信专属会话|微信会话|微信\s*·\s*|\[微信\]\s*)/, (m) => (m === '微信专属会话' || m === '微信会话') ? '专属会话' : '')
                : isDingTalkSession
                ? sessionTitle.replace(/^(?:钉钉专属会话|钉钉会话|钉钉\s*·\s*|\[钉钉\]\s*)/, (m) => (m === '钉钉专属会话' || m === '钉钉会话') ? '专属会话' : '')
                : sessionTitle
              return (
                <div key={session.id} className={cn('copis-working-conversation-row', session.id === currentSessionId && 'active')}>
                  <button type="button" className="copis-working-conversation-main" onClick={() => selectLocalSession(session.id, workspace.id, sessionTitle)}>
                    <span className="copis-working-conversation-label">
                      {isExpertTeamSession && <small className="ui-primary-badge">{session.expertTeamSession ? '专家团队' : '组建中'}</small>}
                      {isFeishuSession && <small className="ui-feishu-badge">飞书</small>}
                      {isWeChatSession && <small className="ui-wechat-badge">微信</small>}
                      {isDingTalkSession && <small className="ui-dingtalk-badge">钉钉</small>}
                      {(session.mode === 'creation' || session.agentRuntime === 'dsh') && (
                        <small className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-amber-500/15 text-amber-600 dark:text-amber-400">
                          创造
                        </small>
                      )}
                      <span>{displaySessionTitle || sessionTitle}</span>
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
        <CopisModeSwitcher isCollapsed={true} />
        {!isMenuHidden('search') && (
          <button type="button" className="copis-working-sidebar-icon-button" aria-label="搜索" onClick={() => setSearchDialogOpen(true)}>
            <Search aria-hidden="true" />
          </button>
        )}
        {!isMenuHidden('memory') && (
          <button
            type="button"
            className={cn('copis-working-sidebar-icon-button', activeView === 'memory' && 'active')}
            aria-label="记忆"
            title="记忆"
            onClick={handleOpenMemory}
          >
            <Brain aria-hidden="true" />
          </button>
        )}
        {!isMenuHidden('knowledge') && (
          <button
            type="button"
            className={cn('copis-working-sidebar-icon-button', activeView === 'knowledge' && 'active')}
            aria-label="知识库"
            title="知识库"
            onClick={handleOpenKnowledge}
          >
            <BookOpen aria-hidden="true" />
          </button>
        )}
        {!isMenuHidden('automations') && (
          <button
            type="button"
            className={cn('copis-working-sidebar-icon-button', activeView === 'automations' && 'active')}
            aria-label="定时任务"
            onClick={() => { setWorkingHistorySelection(null); setActiveView('automations') }}
          >
            <Timer aria-hidden="true" />
          </button>
        )}
        {!isMenuHidden('expert-team') && (
          <button
            type="button"
            className={cn('copis-working-sidebar-icon-button', activeView === 'expert-team' && 'active')}
            aria-label="专家团队"
            onClick={() => { setWorkingHistorySelection(null); setActiveView('expert-team') }}
          >
            <UsersRound aria-hidden="true" />
          </button>
        )}
        <Sparkles className="copis-working-sidebar-collapsed-mark" aria-hidden="true" />
        <span className="copis-working-sidebar-session-count">{activeSessionCount}</span>
      </aside>
    )
  }

  return (
    <aside className={cn('copis-working-sidebar', !noTransition && 'transition-width')} style={{ width }}>
      <div className="copis-working-sidebar-body">
        <div className="px-3 pt-2.5 pb-1">
          <CopisModeSwitcher isCollapsed={false} />
        </div>
        <nav className="copis-working-sidebar-nav" aria-label="Copis 菜单">
          {!isMenuHidden('new-task') && (
            <div className="copis-working-menu-item">
              <button type="button" className="copis-working-menu-button" onClick={() => void handleNewSession()}>
                <Plus aria-hidden="true" />
                <span>新任务</span>
              </button>
              <button
                type="button"
                className="copis-working-menu-hide-btn"
                onClick={(event) => {
                  event.stopPropagation()
                  handleHideMenuItem('new-task', '新任务')
                }}
                aria-label="隐藏新任务"
                title="隐藏此菜单"
              >
                隐藏
              </button>
            </div>
          )}
          {!isMenuHidden('search') && (
            <div className="copis-working-menu-item">
              <button type="button" className="copis-working-menu-button" onClick={() => setSearchDialogOpen(true)}>
                <Search aria-hidden="true" />
                <span>搜索</span>
              </button>
              <button
                type="button"
                className="copis-working-menu-hide-btn"
                onClick={(event) => {
                  event.stopPropagation()
                  handleHideMenuItem('search', '搜索')
                }}
                aria-label="隐藏搜索"
                title="隐藏此菜单"
              >
                隐藏
              </button>
            </div>
          )}
          {!isMenuHidden('schedule') && (
            <div className="copis-working-menu-item">
              <button type="button" className="copis-working-menu-button" onClick={() => { setWorkingHistorySelection(null); setPlanningTab('schedule'); setActiveView('planning') }}>
                <CalendarClock aria-hidden="true" />
                <span>日程表</span>
              </button>
              <button
                type="button"
                className="copis-working-menu-hide-btn"
                onClick={(event) => {
                  event.stopPropagation()
                  handleHideMenuItem('schedule', '日程表', 'planning')
                }}
                aria-label="隐藏日程表"
                title="隐藏此菜单"
              >
                隐藏
              </button>
            </div>
          )}
          {!isMenuHidden('automations') && (
            <div className="copis-working-menu-item">
              <button type="button" className={cn('copis-working-menu-button', activeView === 'automations' && 'active')} onClick={() => { setWorkingHistorySelection(null); setActiveView('automations') }}>
                <Timer aria-hidden="true" />
                <span>定时任务</span>
              </button>
              <button
                type="button"
                className="copis-working-menu-hide-btn"
                onClick={(event) => {
                  event.stopPropagation()
                  handleHideMenuItem('automations', '定时任务', 'automations')
                }}
                aria-label="隐藏定时任务"
                title="隐藏此菜单"
              >
                隐藏
              </button>
            </div>
          )}
          {!isMenuHidden('memory') && (
            <div className="copis-working-menu-item">
              <button type="button" className={cn('copis-working-menu-button', activeView === 'memory' && 'active')} onClick={handleOpenMemory}>
                <Brain aria-hidden="true" />
                <span>记忆</span>
              </button>
              <button
                type="button"
                className="copis-working-menu-hide-btn"
                onClick={(event) => {
                  event.stopPropagation()
                  handleHideMenuItem('memory', '记忆', 'memory')
                }}
                aria-label="隐藏记忆"
                title="隐藏此菜单"
              >
                隐藏
              </button>
            </div>
          )}
          {!isMenuHidden('knowledge') && (
            <div className="copis-working-menu-item">
              <button type="button" className={cn('copis-working-menu-button', activeView === 'knowledge' && 'active')} onClick={handleOpenKnowledge}>
                <BookOpen aria-hidden="true" />
                <span>知识库</span>
              </button>
              <button
                type="button"
                className="copis-working-menu-hide-btn"
                onClick={(event) => {
                  event.stopPropagation()
                  handleHideMenuItem('knowledge', '知识库', 'knowledge')
                }}
                aria-label="隐藏知识库"
                title="隐藏此菜单"
              >
                隐藏
              </button>
            </div>
          )}
          {!isMenuHidden('expert-team') && (
            <div className="copis-working-menu-item">
              <button type="button" className={cn('copis-working-menu-button', activeView === 'expert-team' && 'active')} onClick={() => { setWorkingHistorySelection(null); setActiveView('expert-team') }}>
                <UsersRound aria-hidden="true" />
                <span>专家团队</span>
              </button>
              <button
                type="button"
                className="copis-working-menu-hide-btn"
                onClick={(event) => {
                  event.stopPropagation()
                  handleHideMenuItem('expert-team', '专家团队', 'expert-team')
                }}
                aria-label="隐藏专家团队"
                title="隐藏此菜单"
              >
                隐藏
              </button>
            </div>
          )}
          {!isMenuHidden('agent-skills') && (
            <div className="copis-working-menu-item">
              <button type="button" className="copis-working-menu-button" onClick={() => { setWorkingHistorySelection(null); setActiveView('agent-skills') }}>
                <Puzzle aria-hidden="true" />
                <span>技能市场</span>
              </button>
              <button
                type="button"
                className="copis-working-menu-hide-btn"
                onClick={(event) => {
                  event.stopPropagation()
                  handleHideMenuItem('agent-skills', '技能市场', 'agent-skills')
                }}
                aria-label="隐藏技能市场"
                title="隐藏此菜单"
              >
                隐藏
              </button>
            </div>
          )}
          {!isMenuHidden('fund-stock') && (
            <div className="copis-working-menu-item">
              <button type="button" className={cn('copis-working-menu-button', activeView === 'fund-stock' && 'active')} onClick={() => { setWorkingHistorySelection(null); setActiveView('fund-stock') }}>
                <TrendingUp aria-hidden="true" />
                <span>我的投资</span>
              </button>
              <button
                type="button"
                className="copis-working-menu-hide-btn"
                onClick={(event) => {
                  event.stopPropagation()
                  handleHideMenuItem('fund-stock', '我的投资', 'fund-stock')
                }}
                aria-label="隐藏我的投资"
                title="隐藏此菜单"
              >
                隐藏
              </button>
            </div>
          )}
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
          <button
            type="button"
            className="copis-working-sidebar-account with-balance"
            aria-label={hasUpdate ? '设置，有可用更新' : '设置'}
            onClick={() => setWorkingSettingsOpen(true)}
          >
            <span className="copis-working-account-mark">
              <Settings aria-hidden="true" />
              {hasUpdate && <span className="copis-working-update-dot" aria-hidden="true" />}
            </span>
            <span className="copis-working-account-copy"><strong>设置</strong><small>{accountName}</small></span>
            <span className="copis-working-account-balance" title="当前积分" aria-label={`当前积分 ${tokenBalance}`}><Gem aria-hidden="true" /><b>{tokenBalance}</b></span>
          </button>
          <button type="button" className="copis-working-logout" aria-label="退出 Copis" title="退出 Copis" disabled={busy || loading} onClick={() => void handleLogout()}>
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
      <ConfirmDialog
        open={pendingDeleteWorkspace !== null}
        onOpenChange={(open) => { if (!open) setPendingDeleteWorkspace(null) }}
        title={`确认删除项目「${pendingDeleteWorkspace?.name}」？`}
        description="删除后项目配置将被移除，但目录文件会保留。确定要删除吗？"
        confirmLabel="删除"
        loadingLabel="删除中..."
        loading={busy}
        onConfirm={handleConfirmRemoveWorkspace}
      />
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
