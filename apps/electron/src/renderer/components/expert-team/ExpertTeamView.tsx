import * as React from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { Check, ChevronRight, CircleAlert, FolderOpen, GitBranch, Loader2, MessageSquare, RotateCw, Search, Square, UsersRound, X } from 'lucide-react'
import type { AgentWorkspace, ExpertTeamEdge, ExpertTeamNode, ExpertTeamNodeStatus, ExpertTeamRun, ExpertTeamRunStatus, ExpertTeamWorkspaceBinding } from '@copis/shared'
import { toast } from 'sonner'
import {
  createExpertTeamRunAtom,
  expertTeamArtifactsAtom,
  expertTeamCurrentRunAtom,
  expertTeamCurrentRunIdAtom,
  expertTeamCurrentSchemaAtom,
  expertTeamCurrentSchemaIdAtom,
  expertTeamErrorAtom,
  expertTeamEventsAtom,
  expertTeamLoadStateAtom,
  expertTeamRunsAtom,
  expertTeamSchemasAtom,
  expertTeamWorkspaceBindingAtom,
  loadExpertTeamWorkspaceStateAtom,
} from '@/atoms/expert-team-atoms'
import { agentSessionsAtom, agentWorkspacesAtom, currentAgentWorkspaceIdAtom } from '@/atoms/agent-atoms'
import {
  createWorkspaceDialogOpenAtom,
  createdWorkspaceIdAtom,
  newExpertTeamDialogOpenAtom,
  openCreateWorkspaceDialogAtom,
  workspaceCreationSourceAtom,
} from '@/atoms/working-atoms'
import { expertTeamApi } from '@/lib/expert-team-api'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { useCreateSession } from '@/hooks/useCreateSession'
import { useOpenSession } from '@/hooks/useOpenSession'
import { CopisWorkingNewExpertTeamDialog } from '@/components/app-shell/CopisWorkingNewExpertTeamDialog'

const terminalStatuses: readonly ExpertTeamRunStatus[] = ['succeeded', 'failed', 'cancelled']

const statusLabels: Record<ExpertTeamRunStatus, string> = {
  queued: '等待中', running: '执行中', succeeded: '已完成', failed: '失败', cancelled: '已取消',
}

const nodeStatusLabels: Record<ExpertTeamNodeStatus, string> = {
  pending: '待处理', queued: '等待中', running: '执行中', succeeded: '已完成', failed: '失败', cancelled: '已取消', skipped: '已跳过',
}

function statusClass(status: string): string {
  if (status === 'running') return 'bg-amber-500/15 text-amber-700 dark:text-amber-300'
  if (status === 'succeeded' || status === 'completed') return 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
  if (status === 'failed') return 'bg-destructive/15 text-destructive'
  if (status === 'cancelled' || status === 'canceled') return 'bg-muted text-muted-foreground'
  return 'bg-primary/10 text-primary'
}

function formatTime(timestamp: number | string | undefined): string {
  if (timestamp === undefined) return '--'
  const date = new Date(timestamp)
  return Number.isNaN(date.getTime()) ? '--' : date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

function formatRunDisplayName(schemaName: string | undefined, run: ExpertTeamRun): string {
  const runNumber = run.id.match(/-(\d+)$/)?.[1] ?? 'n'
  return `${schemaName || '专家团队'}-${runNumber}`
}

function roleLabel(role: string | undefined): string {
  if (role === 'researcher') return '研究员'
  if (role === 'writer') return '总结员'
  if (role === 'reviewer') return '审查员'
  if (role === 'executor') return '执行员'
  return role || '专家'
}

function roleCode(role: string | undefined): string {
  return role === 'writer' ? 'summary' : role || 'agent'
}

function NodeRoleIcon({ role }: { role?: string }): React.ReactElement {
  if (role === 'researcher') return <Search aria-hidden="true" />
  if (role === 'reviewer') return <Check aria-hidden="true" />
  if (role === 'writer') return <MessageSquare aria-hidden="true" />
  return <GitBranch aria-hidden="true" />
}

/** 计算节点的前置依赖：优先使用 dependsOn，缺失时回退到 edges。 */
function nodeDependencies(node: ExpertTeamNode, edges: ExpertTeamEdge[]): string[] {
  return node.dependsOn?.length ? node.dependsOn : edges.filter((edge) => edge.to === node.id).map((edge) => edge.from)
}

/** 根据节点视口位置计算详情浮层定位：优先出现在节点下方，底部空间不足时翻转到上方。 */
function nodeDetailsPopoverStyle(rect: { left: number; top: number; bottom: number }): React.CSSProperties {
  const width = 320
  const height = 252
  const margin = 8
  const left = Math.max(margin, Math.min(rect.left, window.innerWidth - width - margin))
  const top = rect.bottom + margin + height <= window.innerHeight
    ? rect.bottom + margin
    : Math.max(margin, rect.top - height - margin)
  return { position: 'fixed', left, top, width, zIndex: 100 }
}

/** 悬停（或点击固定）节点详情浮层：锚定在对应节点附近展示角色、依赖与产物路径。 */
function NodeDetailsPopover({ node, status, dependencies, pinned, style, onClose }: {
  node: ExpertTeamNode
  status: ExpertTeamNodeStatus
  dependencies: string[]
  pinned: boolean
  style: React.CSSProperties
  onClose: () => void
}): React.ReactElement {
  return (
    <div
      role="tooltip"
      aria-label="节点详情悬浮层"
      className={cn('rounded-xl border border-border/60 bg-popover p-4 text-popover-foreground shadow-xl ring-1 ring-border/20 backdrop-blur-md', pinned ? 'pointer-events-auto' : 'pointer-events-none')}
      style={style}
    >
      <div className="mb-2 flex items-center gap-2">
        <span className="grid size-7 shrink-0 place-items-center rounded-lg ui-primary-surface shadow-xs"><NodeRoleIcon role={node.role} /></span>
        <div className="min-w-0 flex-1">
          <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--ui-primary)]">节点详情</span>
          <h3 className="mt-0.5 truncate text-sm font-semibold text-foreground">{node.name}</h3>
        </div>
        {pinned && <button type="button" aria-label="关闭节点详情" onClick={onClose} className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"><X className="size-4" /></button>}
      </div>
      <p className="text-xs leading-5 text-muted-foreground">{node.description || `${roleLabel(node.role)}负责当前专家团队中的受控工作。`}</p>
      <dl className="mt-3 grid gap-2 text-xs">
        <div><dt className="text-muted-foreground">专家标识</dt><dd className="mt-0.5 break-all font-mono text-foreground">{node.id}</dd></div>
        <div><dt className="text-muted-foreground">分工职责 / 状态</dt><dd className="mt-0.5 text-foreground">{roleLabel(node.role)} · {nodeStatusLabels[status]}</dd></div>
        <div><dt className="text-muted-foreground">前置协作</dt><dd className="mt-0.5 break-words text-foreground">{dependencies.length > 0 ? `承接 ${dependencies.join('、')}` : '首发协作（无前置）'}</dd></div>
      </dl>
      {node.path && <div className="mt-3 rounded-lg border border-border/50 bg-muted/60 px-3 py-2 text-[10px] text-muted-foreground">交付成果路径：<span className="break-all font-mono text-foreground">{node.path}</span></div>}
    </div>
  )
}

export function ExpertTeamView(): React.ReactElement {
  const schemas = useAtomValue(expertTeamSchemasAtom)
  const agentSessions = useAtomValue(agentSessionsAtom)
  const currentSchema = useAtomValue(expertTeamCurrentSchemaAtom)
  const runs = useAtomValue(expertTeamRunsAtom)
  const currentRun = useAtomValue(expertTeamCurrentRunAtom)
  const events = useAtomValue(expertTeamEventsAtom)
  const artifacts = useAtomValue(expertTeamArtifactsAtom)
  const binding = useAtomValue(expertTeamWorkspaceBindingAtom)
  const workspaces = useAtomValue(agentWorkspacesAtom)
  const currentWorkspaceId = useAtomValue(currentAgentWorkspaceIdAtom)
  const error = useAtomValue(expertTeamErrorAtom)
  const loadState = useAtomValue(expertTeamLoadStateAtom)
  const [schemaId, setSchemaId] = useAtom(expertTeamCurrentSchemaIdAtom)
  const setSchemas = useSetAtom(expertTeamSchemasAtom)
  const setCurrentSchemaId = useSetAtom(expertTeamCurrentSchemaIdAtom)
  const setRuns = useSetAtom(expertTeamRunsAtom)
  const setCurrentRunId = useSetAtom(expertTeamCurrentRunIdAtom)
  const setEvents = useSetAtom(expertTeamEventsAtom)
  const setArtifacts = useSetAtom(expertTeamArtifactsAtom)
  const setLoadState = useSetAtom(expertTeamLoadStateAtom)
  const setError = useSetAtom(expertTeamErrorAtom)
  const setCurrentWorkspaceId = useSetAtom(currentAgentWorkspaceIdAtom)
  const setWorkspaceBinding = useSetAtom(expertTeamWorkspaceBindingAtom)
  const createExpertTeamRun = useSetAtom(createExpertTeamRunAtom)
  const loadExpertTeamWorkspaceState = useSetAtom(loadExpertTeamWorkspaceStateAtom)
  const createWorkspaceDialogOpen = useAtomValue(createWorkspaceDialogOpenAtom)
  const [createdWorkspaceId, setCreatedWorkspaceId] = useAtom(createdWorkspaceIdAtom)
  const openCreateWorkspaceDialog = useSetAtom(openCreateWorkspaceDialogAtom)
  const setWorkspaceCreationSource = useSetAtom(workspaceCreationSourceAtom)
  const { createAgent } = useCreateSession()
  const openSession = useOpenSession()
  const initialLoadRef = React.useRef(false)
  const pendingWorkspaceBindingIdRef = React.useRef<string | null>(null)
  const [workspaceDialogOpen, setWorkspaceDialogOpen] = React.useState(false)
  const [pendingCreate, setPendingCreate] = React.useState(false)
  const [workspaceActionLoading, setWorkspaceActionLoading] = React.useState(false)
  const [workspaceActionError, setWorkspaceActionError] = React.useState<string | null>(null)
  const [newExpertTeamError, setNewExpertTeamError] = React.useState<string | null>(null)
  const [newExpertTeamDialogOpen, setNewExpertTeamDialogOpen] = useAtom(newExpertTeamDialogOpenAtom)
  /** 「新专家团」创建工作区后，主理人筹备会话优先于 Schema 绑定流程。 */
  const newExpertTeamPendingRef = React.useRef(false)
  /** 当前悬停的节点 ID；节点详情浮层据此展示对应节点（hover 触发，不再默认选中首个节点）。 */
  const [hoveredNodeId, setHoveredNodeId] = React.useState<string | null>(null)
  /** 点击固定的节点 ID；固定后浮层不随鼠标移出消失。 */
  const [pinnedNodeId, setPinnedNodeId] = React.useState<string | null>(null)
  /** 悬停/点击节点的视口位置，用于把详情浮层锚定在对应节点附近。 */
  const [nodeRect, setNodeRect] = React.useState<{ left: number; top: number; bottom: number } | null>(null)
  const currentRunSession = currentRun
    ? agentSessions.find((session) => session.expertTeamSession?.runId === currentRun.id)
      ?? [...agentSessions]
        .filter((session) => session.expertTeamSetup === true && session.workspaceId === workspaces.find((workspace) => workspace.slug === currentRun.workspaceSlug)?.id)
        .sort((a, b) => b.updatedAt - a.updatedAt)[0]
    : undefined

  const loadSchemas = React.useCallback(async (): Promise<void> => {
    setLoadState((state) => ({ ...state, schemas: true }))
    setError(null)
    try {
      const nextSchemas = await expertTeamApi.listSchemas()
      setSchemas(nextSchemas)
      const nextId = schemaId && nextSchemas.some((schema) => schema.id === schemaId) ? schemaId : nextSchemas[0]?.id ?? null
      setSchemaId(nextId)
      setCurrentSchemaId(nextId)
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : '加载专家团队方案失败')
    } finally {
      setLoadState((state) => ({ ...state, schemas: false }))
    }
  }, [schemaId, setCurrentSchemaId, setError, setLoadState, setSchemaId, setSchemas])

  React.useEffect(() => {
    if (initialLoadRef.current) return
    initialLoadRef.current = true
    void loadSchemas()
  }, [loadSchemas])

  // 监听主进程专家团队变更通知（Agent 创建/发布/绑定团队时直接热更新）
  React.useEffect(() => {
    const handleUpdate = async (): Promise<void> => {
      await loadSchemas()
      const workspace = workspaces.find((item) => item.id === currentWorkspaceId)
      if (workspace) {
        try {
          const latestBinding = await expertTeamApi.getWorkspaceBinding(workspace.slug)
          if (latestBinding?.schemaId) {
            setSchemaId(latestBinding.schemaId)
            setCurrentSchemaId(latestBinding.schemaId)
            void loadExpertTeamWorkspaceState({ workspaceSlug: workspace.slug, schemaId: latestBinding.schemaId })
          }
        } catch {
          // 忽略未绑定或离线时的加载错误
        }
      }
    }
    const unlisten = window.electronAPI?.onExpertTeamsChanged?.(() => {
      void handleUpdate()
    })
    const handleFocus = (): void => {
      void handleUpdate()
    }
    window.addEventListener('focus', handleFocus)
    return () => {
      unlisten?.()
      window.removeEventListener('focus', handleFocus)
    }
  }, [currentWorkspaceId, loadExpertTeamWorkspaceState, loadSchemas, setCurrentSchemaId, setSchemaId, workspaces])

  React.useEffect(() => {
    if (!currentSchema || !currentWorkspaceId) return
    const workspace = workspaces.find((item) => item.id === currentWorkspaceId)
    if (!workspace || (binding?.workspaceSlug === workspace.slug && binding.schemaId === currentSchema.id)) return
    void loadExpertTeamWorkspaceState({ workspaceSlug: workspace.slug, schemaId: currentSchema.id })
      .catch((nextError: unknown) => {
        setError(nextError instanceof Error ? nextError.message : '恢复专家团队工作区失败')
      })
  }, [binding?.schemaId, binding?.workspaceSlug, currentSchema, currentWorkspaceId, loadExpertTeamWorkspaceState, setError, workspaces])

  const loadRun = React.useCallback(async (runId: string): Promise<void> => {
    try {
      const [run, nextEvents, nextArtifacts] = await Promise.all([
        expertTeamApi.getRun(runId),
        expertTeamApi.listEvents(runId),
        expertTeamApi.listArtifacts(runId),
      ])
      setRuns((items) => [run, ...items.filter((item) => item.id !== run.id)])
      setCurrentRunId(run.id)
      setEvents(nextEvents)
      setArtifacts(nextArtifacts)
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : '加载运行状态失败')
    }
  }, [setArtifacts, setCurrentRunId, setError, setEvents, setRuns])

  React.useEffect(() => {
    if (!currentRun || terminalStatuses.includes(currentRun.status)) return
    const timer = window.setInterval(() => { void loadRun(currentRun.id) }, 2000)
    return () => window.clearInterval(timer)
  }, [currentRun, loadRun])

  const selectSchema = React.useCallback(async (nextId: string): Promise<void> => {
    setSchemaId(nextId)
    setCurrentSchemaId(nextId)
    const selected = schemas.find((schema) => schema.id === nextId)
    if (selected?.nodes.length) return
    setLoadState((state) => ({ ...state, schema: true }))
    try {
      const detail = await expertTeamApi.getSchema(nextId)
      setSchemas((items) => items.map((item) => item.id === nextId ? detail : item))
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : '加载团队方案详情失败')
    } finally {
      setLoadState((state) => ({ ...state, schema: false }))
    }
  }, [schemas, setCurrentSchemaId, setError, setLoadState, setSchemaId, setSchemas])

  const cancelRun = async (): Promise<void> => {
    if (!currentRun || currentRun.status !== 'queued') return
    setLoadState((state) => ({ ...state, run: true }))
    try {
      const run = await expertTeamApi.cancelRun(currentRun.id)
      setRuns((items) => items.map((item) => item.id === run.id ? run : item))
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : '取消运行失败')
    } finally {
      setLoadState((state) => ({ ...state, run: false }))
    }
  }

  const handleContinueConversation = React.useCallback((): void => {
    if (!currentRunSession) {
      toast.error('未找到对应的专家团队会话')
      return
    }
    openSession('agent', currentRunSession.id, currentRunSession.title)
  }, [currentRunSession, openSession])

  const bindWorkspaceToSchema = React.useCallback(async (workspace: AgentWorkspace): Promise<ExpertTeamWorkspaceBinding> => {
    if (!currentSchema) {
      const message = '请先选择一个团队方案'
      setWorkspaceActionError(message)
      toast.error(message)
      throw new Error(message)
    }

    const schemaRevisionId = currentSchema.currentRevisionId ?? binding?.schemaRevisionId
    const schemaRevision = currentSchema.revision ?? binding?.revision ?? schemaRevisionId
    const nextBinding = await expertTeamApi.bindWorkspace(workspace.slug, {
      schemaId: currentSchema.id,
      ...(schemaRevision !== undefined ? { schemaRevision } : {}),
      ...(schemaRevisionId !== undefined ? { schemaRevisionId } : {}),
    })
    setCurrentWorkspaceId(workspace.id)
    void window.electronAPI.updateSettings({ agentWorkspaceId: workspace.id }).catch((settingsError: unknown) => {
      console.error('[ExpertTeamView] 保存工作区设置失败:', settingsError)
    })
    setWorkspaceBinding(nextBinding)
    setRuns([])
    setCurrentRunId(null)
    setEvents([])
    setArtifacts([])
    setWorkspaceDialogOpen(false)
    return nextBinding
  }, [binding?.revision, binding?.schemaRevisionId, currentSchema, setArtifacts, setCurrentRunId, setCurrentWorkspaceId, setEvents, setRuns, setWorkspaceBinding])

  const createPersistedRun = React.useCallback(async (workspace: AgentWorkspace, workspaceBinding: ExpertTeamWorkspaceBinding): Promise<ExpertTeamRun> => {
    const run = await createExpertTeamRun({
      schemaId: workspaceBinding.schemaId,
      workspaceSlug: workspace.slug,
      ...(workspaceBinding.schemaRevisionId !== undefined ? { schemaRevisionId: workspaceBinding.schemaRevisionId } : {}),
      ...(workspaceBinding.revision !== undefined ? { schemaRevision: workspaceBinding.revision } : {}),
      input: { source: 'expert-team-workbench-start' },
    })
    await loadRun(run.id)
    return run
  }, [createExpertTeamRun, loadRun])

  const openExpertTeamAgentSession = React.useCallback(async (workspace: AgentWorkspace, workspaceBinding: ExpertTeamWorkspaceBinding, run: ExpertTeamRun): Promise<void> => {
    setCurrentWorkspaceId(workspace.id)
    void window.electronAPI.updateSettings({ agentWorkspaceId: workspace.id }).catch((settingsError: unknown) => {
      console.error('[ExpertTeamView] 保存工作区设置失败:', settingsError)
    })
    const sessionId = await createAgent({
      title: `专家团队 · ${currentSchema?.name ?? workspaceBinding.schemaId}`,
      workspaceId: workspace.id,
      expertTeamSession: {
        runId: run.id,
        schemaId: workspaceBinding.schemaId,
        ...(workspaceBinding.schemaRevisionId !== undefined ? { schemaRevisionId: workspaceBinding.schemaRevisionId } : {}),
      },
    })
    if (!sessionId) throw new Error('创建专家团队主控会话失败')
  }, [createAgent, currentSchema?.name, setCurrentWorkspaceId])

  const handleSelectWorkspace = React.useCallback(async (workspace: AgentWorkspace): Promise<void> => {
    if (workspaceActionLoading) return
    setWorkspaceActionLoading(true)
    setWorkspaceActionError(null)
    try {
      const nextBinding = await bindWorkspaceToSchema(workspace)
      const run = await createPersistedRun(workspace, nextBinding)
      await openExpertTeamAgentSession(workspace, nextBinding, run)
      toast.success(`已开始工作区「${workspace.name}」的专家团队运行`)
    } catch (nextError) {
      const message = nextError instanceof Error ? nextError.message : '开始专家团队运行失败'
      setWorkspaceActionError(message)
      toast.error(message)
    } finally {
      setWorkspaceActionLoading(false)
    }
  }, [bindWorkspaceToSchema, createPersistedRun, openExpertTeamAgentSession, workspaceActionLoading])

  const handleOpenCreateWorkspace = React.useCallback((): void => {
    if (workspaceActionLoading) return
    setWorkspaceDialogOpen(false)
    setWorkspaceActionError(null)
    setPendingCreate(true)
    openCreateWorkspaceDialog('expert-team')
  }, [openCreateWorkspaceDialog, workspaceActionLoading])

  /** 新专家团入口：创建主理人筹备会话，先询问需求再组建团队。 */
  const handleOpenNewExpertTeam = React.useCallback((): void => {
    if (workspaceActionLoading) return
    setNewExpertTeamError(null)
    setNewExpertTeamDialogOpen(true)
  }, [workspaceActionLoading])

  const handleSelectWorkspaceForNewExpertTeam = React.useCallback(async (workspace: AgentWorkspace): Promise<void> => {
    if (workspaceActionLoading) return
    setWorkspaceActionLoading(true)
    setNewExpertTeamError(null)
    try {
      setCurrentWorkspaceId(workspace.id)
      void window.electronAPI.updateSettings({ agentWorkspaceId: workspace.id }).catch((settingsError: unknown) => {
        console.error('[ExpertTeamView] 保存工作区设置失败:', settingsError)
      })
      const sessionId = await createAgent({
        title: '专家团队 · 组建新团队',
        workspaceId: workspace.id,
        expertTeamSetup: true,
      })
      if (!sessionId) throw new Error('创建主理人会话失败')
      setNewExpertTeamDialogOpen(false)
      toast.success(`已创建「${workspace.name}」的专家团队筹备会话，主理人将为你定制方案`)
    } catch (nextError) {
      const message = nextError instanceof Error ? nextError.message : '创建新专家团失败'
      setNewExpertTeamError(message)
      toast.error(message)
    } finally {
      setWorkspaceActionLoading(false)
    }
  }, [createAgent, setCurrentWorkspaceId, workspaceActionLoading])

  const handleOpenCreateWorkspaceForNewExpertTeam = React.useCallback((): void => {
    if (workspaceActionLoading) return
    setNewExpertTeamDialogOpen(false)
    setNewExpertTeamError(null)
    newExpertTeamPendingRef.current = true
    setPendingCreate(true)
    openCreateWorkspaceDialog('expert-team-new')
  }, [openCreateWorkspaceDialog, workspaceActionLoading])

  const handleWorkspaceDialogOpenChange = React.useCallback((open: boolean): void => {
    if (workspaceActionLoading) return
    setWorkspaceDialogOpen(open)
    if (open) {
      setWorkspaceActionError(null)
    }
  }, [workspaceActionLoading])

  const handleStart = React.useCallback(async (): Promise<void> => {
    if (workspaceActionLoading) return

    const workspaceBinding = binding?.schemaId === currentSchema?.id ? binding : null
    if (!workspaceBinding) {
      handleWorkspaceDialogOpenChange(true)
      return
    }

    const workspace = workspaces.find((item) => item.slug === workspaceBinding.workspaceSlug)
    if (!workspace) {
      handleWorkspaceDialogOpenChange(true)
      return
    }

    setWorkspaceActionLoading(true)
    setWorkspaceActionError(null)
    try {
      const run = await createPersistedRun(workspace, workspaceBinding)
      await openExpertTeamAgentSession(workspace, workspaceBinding, run)
      toast.success(`已开始工作区「${workspace.name}」的专家团队运行`)
    } catch (nextError) {
      const message = nextError instanceof Error ? nextError.message : '开始专家团队运行失败'
      setWorkspaceActionError(message)
      toast.error(message)
    } finally {
      setWorkspaceActionLoading(false)
    }
  }, [binding, createPersistedRun, currentSchema?.id, handleWorkspaceDialogOpenChange, openExpertTeamAgentSession, workspaceActionLoading, workspaces])

  React.useEffect(() => {
    if (!pendingCreate || createWorkspaceDialogOpen || createdWorkspaceId) return
    newExpertTeamPendingRef.current = false
    setPendingCreate(false)
    setWorkspaceCreationSource(null)
  }, [createWorkspaceDialogOpen, createdWorkspaceId, pendingCreate, setWorkspaceCreationSource])

  React.useEffect(() => {
    if (!pendingCreate || !createdWorkspaceId) return
    const workspace = workspaces.find((item) => item.id === createdWorkspaceId)
    if (!workspace || pendingWorkspaceBindingIdRef.current === createdWorkspaceId) return

    pendingWorkspaceBindingIdRef.current = createdWorkspaceId
    setWorkspaceActionLoading(true)
    setWorkspaceActionError(null)
    void (async (): Promise<void> => {
      try {
        if (newExpertTeamPendingRef.current) {
          setCurrentWorkspaceId(workspace.id)
          void window.electronAPI.updateSettings({ agentWorkspaceId: workspace.id }).catch((settingsError: unknown) => {
            console.error('[ExpertTeamView] 保存工作区设置失败:', settingsError)
          })
          const sessionId = await createAgent({
            title: '专家团队 · 组建新团队',
            workspaceId: workspace.id,
            expertTeamSetup: true,
          })
          if (!sessionId) throw new Error('创建主理人会话失败')
          toast.success(`已创建「${workspace.name}」的专家团队筹备会话，主理人将为你定制方案`)
          return
        }
        const nextBinding = await bindWorkspaceToSchema(workspace)
        const run = await createPersistedRun(workspace, nextBinding)
        await openExpertTeamAgentSession(workspace, nextBinding, run)
        toast.success(`已开始工作区「${workspace.name}」的专家团队运行`)
      } catch (nextError) {
        const message = nextError instanceof Error ? nextError.message : (newExpertTeamPendingRef.current ? '创建新专家团失败' : '绑定工作区失败')
        setWorkspaceActionError(message)
        toast.error(message)
      } finally {
        if (pendingWorkspaceBindingIdRef.current !== createdWorkspaceId) return
        pendingWorkspaceBindingIdRef.current = null
        newExpertTeamPendingRef.current = false
        setPendingCreate(false)
        setCreatedWorkspaceId(null)
        setWorkspaceCreationSource(null)
        setWorkspaceActionLoading(false)
      }
    })()
  }, [bindWorkspaceToSchema, createAgent, createPersistedRun, createdWorkspaceId, openExpertTeamAgentSession, pendingCreate, setCreatedWorkspaceId, setCurrentWorkspaceId, setWorkspaceCreationSource, workspaces])

  const nodeStates = new Map<string, ExpertTeamNodeStatus>((currentRun?.nodeStates ?? []).map((state) => [state.nodeId, state.status]))
  events.forEach((event) => {
    if (event.nodeId && event.status) nodeStates.set(event.nodeId, event.status)
  })
  const activeNodeId = pinnedNodeId ?? hoveredNodeId
  const activeNode = currentSchema
    ? currentSchema.nodes.find((node) => node.id === activeNodeId) ?? null
    : null
  const schemaEdges = currentSchema ? currentSchema.edges : []
  const showNodeDetails = (nodeId: string, event: React.MouseEvent<HTMLDivElement>): void => {
    const rect = event.currentTarget.getBoundingClientRect()
    setHoveredNodeId(nodeId)
    setNodeRect({ left: rect.left, top: rect.top, bottom: rect.bottom })
  }
  const hideNodeDetails = (): void => {
    setHoveredNodeId(null)
    setNodeRect(null)
  }
  const togglePinNode = (nodeId: string, event: React.MouseEvent<HTMLDivElement>): void => {
    showNodeDetails(nodeId, event)
    setPinnedNodeId((current) => (current === nodeId ? null : nodeId))
  }
  const schemaRevision = currentSchema?.revision ?? currentSchema?.currentRevisionId ?? binding?.revision ?? binding?.schemaRevisionId
  return (
    <div className="flex h-full min-h-0 bg-background text-foreground">
      <aside className="min-h-0 w-[230px] shrink-0 overflow-y-auto border-r border-border/60 bg-content-area/40 p-4">
          <button
            type="button"
            aria-label="新专家团"
            onClick={handleOpenNewExpertTeam}
            disabled={workspaceActionLoading}
            className="mb-3 flex min-h-9 w-full items-center justify-center gap-2 rounded-xl bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground shadow-xs transition-colors hover:bg-primary/90 disabled:opacity-50"
          >
            <UsersRound className="size-4" />
            新专家团
          </button>
          <div className="mb-3 flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">专家团队</span>
            <div className="flex items-center gap-1.5">
              <span className="text-xs tabular-nums text-muted-foreground">{schemas.length}</span>
              <button
                type="button"
                aria-label="刷新团队列表"
                title="刷新团队列表"
                onClick={() => void loadSchemas()}
                className="rounded-md p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <RotateCw className={cn('size-3', loadState.schemas && 'animate-spin text-[var(--ui-primary)]')} />
              </button>
            </div>
          </div>
          {loadState.schemas && schemas.length === 0 ? <div className="flex items-center gap-2 py-6 text-xs text-muted-foreground"><Loader2 className="size-4 animate-spin text-[var(--ui-primary)]" />加载中</div> : schemas.length === 0 ? <div className="py-6 text-xs text-muted-foreground">暂无可用的团队方案</div> : <div className="space-y-1">{schemas.map((schema) => <button key={schema.id} type="button" onClick={() => void selectSchema(schema.id)} className={cn('flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm font-medium transition-colors', schema.id === schemaId ? 'bg-primary/10 text-primary' : 'text-foreground/80 hover:bg-muted/60 hover:text-foreground')}><span className="min-w-0 truncate">{schema.name}</span><ChevronRight className={cn('size-3.5 shrink-0 transition-colors', schema.id === schemaId ? 'text-primary' : 'text-muted-foreground')} /></button>)}</div>}
          <div className="mt-6 border-t border-border/60 pt-4"><div className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">最近运行</div>{runs.length === 0 ? <p className="text-xs text-muted-foreground">启动专家团队后将在此记录运行历史</p> : <div className="space-y-1.5">{runs.slice(0, 8).map((run) => <button key={run.id} type="button" onClick={() => { setCurrentRunId(run.id); void loadRun(run.id) }} className={cn('w-full rounded-lg px-2.5 py-2 text-left transition-colors', run.id === currentRun?.id ? 'bg-primary/10 text-primary font-medium' : 'text-foreground/80 hover:bg-muted/60 hover:text-foreground')}><div className="flex items-center justify-between gap-2"><span className="truncate text-xs font-medium">{formatRunDisplayName(currentSchema?.name, run)}</span><span className={cn('rounded-full px-2 py-0.5 text-[10px] font-medium', statusClass(run.status))}>{statusLabels[run.status]}</span></div><div className="mt-1 text-[10px] text-muted-foreground">{formatTime(run.createdAt)}</div></button>)}</div>}</div>
      </aside>

      <div className="min-w-0 flex-1 overflow-y-auto bg-background" aria-label="专家团队右侧工作台">
        <header className="flex shrink-0 items-start justify-between gap-4 border-b border-border/60 bg-content-area/20 px-6 py-5">
          <div className="flex min-w-0 items-start">
            <div className="min-w-0">
              <h1 className="flex min-w-0 flex-wrap items-center gap-2 text-xl font-semibold">
                <span className="truncate">{currentSchema?.name ?? '专家团队'}</span>
                <span className="inline-flex min-h-6 items-center rounded-full border border-border/40 bg-muted/70 px-2.5 text-[11px] font-medium text-muted-foreground">方案版本 {schemaRevision ? `v${schemaRevision}` : '--'}</span>
              </h1>
              <p className="mt-1 max-w-2xl text-xs leading-5 text-muted-foreground">{currentSchema?.description || '由多位专业 AI 专家协同分工，自主规划并交付复杂任务成果'}</p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {!currentRun && binding?.workspaceSlug && binding.schemaId === currentSchema?.id && <span className="max-w-40 truncate text-[11px] text-muted-foreground" role="status">已绑定：{binding.workspaceSlug}</span>}
            {currentRun ? (
              <button
                type="button"
                className="inline-flex min-h-7 items-center rounded-md bg-primary px-2.5 text-[11px] font-medium text-primary-foreground shadow-xs transition-colors hover:bg-primary/90"
                role="status"
                title="继续对话"
                onClick={handleContinueConversation}
              >继续对话</button>
            ) : (
              <Button type="button" className="min-h-7 h-7 px-3 text-xs shadow-xs" onClick={handleStart} disabled={!currentSchema || workspaceActionLoading}>开始</Button>
            )}
          </div>
        </header>

        <Dialog open={workspaceDialogOpen} onOpenChange={handleWorkspaceDialogOpenChange}>
          <DialogContent className="border-border/60 bg-card text-card-foreground shadow-xl sm:max-w-md" hideClose={workspaceActionLoading}>
            <DialogHeader>
              <DialogTitle className="text-foreground">选择工作区</DialogTitle>
              <DialogDescription className="text-muted-foreground">选择一个已有工作区，或新建工作区以启动此专家团队方案。</DialogDescription>
            </DialogHeader>

            <div className="space-y-5">
              <section aria-label="已有工作区">
                <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--ui-primary)]">已有工作区</div>
                {workspaces.length === 0 ? <p className="rounded-xl border border-border/60 bg-content-area px-3 py-3 text-xs text-muted-foreground">暂无可用的项目工作区，请先创建工作区。</p> : <div className="max-h-48 space-y-1.5 overflow-y-auto pr-1">{workspaces.map((workspace) => <Button key={workspace.id} type="button" variant="ghost" className="h-auto min-h-10 w-full justify-between rounded-xl border border-border/40 bg-content-area px-3 py-2 text-left text-foreground/90 transition-colors hover:bg-[var(--ui-primary-background)] hover:text-[var(--ui-primary)] hover:border-[var(--ui-primary)]/40" onClick={() => void handleSelectWorkspace(workspace)} disabled={workspaceActionLoading}><span className="min-w-0"><span className="block truncate text-sm font-medium">{workspace.name}</span><span className="mt-0.5 block truncate text-[10px] text-muted-foreground">{workspace.projectRootPath || 'Copis 托管工作区'}</span></span><ChevronRight className="size-4 shrink-0 text-muted-foreground" /></Button>)}</div>}
              </section>

              <section className="border-t border-border/60 pt-4" aria-label="创建工作区">
                <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--ui-primary)]">创建工作区</div>
                <p className="text-xs leading-5 text-muted-foreground">创建新的项目工作区，专家团队将在该工作区中为你开展工作与交付成果。</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button type="button" size="sm" className="rounded-lg shadow-xs" onClick={handleOpenCreateWorkspace} disabled={workspaceActionLoading}><FolderOpen className="size-3.5" />创建工作区</Button>
                </div>
              </section>

              {workspaceActionError && <div className="flex items-start gap-2 rounded-xl bg-destructive/10 px-3 py-2 text-xs text-destructive" role="alert"><CircleAlert className="mt-0.5 size-4 shrink-0" />{workspaceActionError}</div>}
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" className="border-border/60 bg-content-area text-foreground/80 hover:bg-accent" onClick={() => handleWorkspaceDialogOpenChange(false)} disabled={workspaceActionLoading}>取消</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <CopisWorkingNewExpertTeamDialog
          open={newExpertTeamDialogOpen}
          onOpenChange={(open) => { if (!workspaceActionLoading) setNewExpertTeamDialogOpen(open) }}
          workspaces={workspaces}
          busy={workspaceActionLoading}
          error={newExpertTeamError}
          onSelectWorkspace={(workspace) => void handleSelectWorkspaceForNewExpertTeam(workspace)}
          onCreateWorkspace={handleOpenCreateWorkspaceForNewExpertTeam}
        />

        {error && <div className="mx-6 mt-4 flex items-start gap-2 rounded-xl bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert"><CircleAlert className="mt-0.5 size-4 shrink-0" />{error}</div>}

        <main className="min-h-0 p-6">
          {!currentSchema ? <div className="flex h-full items-center justify-center text-sm text-muted-foreground">请从左侧选择一个团队方案开始协作</div> : <div className="mx-auto max-w-6xl space-y-5">
            <section className="rounded-xl border border-border/60 bg-content-area p-5 shadow-xs" aria-label="专家团队执行阵容">
              <div className="flex items-end justify-between gap-4"><h2 className="text-lg font-semibold text-foreground">执行阵容</h2><span className="text-xs text-muted-foreground">{currentSchema.version ? `v${currentSchema.version}` : '标准版'} · {currentSchema.nodes.length} 位团队专家</span></div>
              <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3" role="list" aria-label="Schema 节点列表" onMouseLeave={hideNodeDetails}>
                {currentSchema.nodes.map((node) => {
                  const state = nodeStates.get(node.id) ?? 'pending'
                  return <div className={cn('flex min-w-0 cursor-pointer items-center gap-3 rounded-xl border border-border/60 bg-card p-3.5 shadow-xs transition-all hover:border-border hover:shadow-sm', hoveredNodeId === node.id && 'border-[var(--ui-primary)]/50 shadow-xs ring-1 ring-[var(--ui-primary)]/20')} key={node.id} role="listitem" onMouseEnter={(event) => showNodeDetails(node.id, event)} onClick={(event) => togglePinNode(node.id, event)}><span className="grid size-9 shrink-0 place-items-center rounded-xl ui-primary-surface shadow-xs"><NodeRoleIcon role={node.role} /></span><span className="min-w-0"><strong className="block truncate text-xs font-semibold text-foreground">{node.name}</strong><small className="mt-1 block truncate text-[10px] text-muted-foreground">{roleLabel(node.role)} · {nodeStatusLabels[state]}</small></span></div>
                })}
              </div>
            </section>

            <section className="rounded-xl border border-border/60 bg-content-area p-5 shadow-xs" aria-label="专家团队依赖编排">
                <div className="flex items-end justify-between gap-4"><h2 className="text-lg font-semibold text-foreground">任务路径</h2><span className={cn('inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-medium', currentRun ? statusClass(currentRun.status) : 'border border-border/40 bg-muted/70 text-muted-foreground')}>{currentRun ? statusLabels[currentRun.status] : '就绪待命'}</span></div>
                <div className="mt-4 overflow-x-auto rounded-xl border border-border/60 bg-card p-4 shadow-xs">
                  <div className="flex min-w-max items-center gap-3" onMouseLeave={hideNodeDetails}>
                    {currentSchema.nodes.map((node, index) => {
                      const state = nodeStates.get(node.id) ?? 'pending'
                      const dependencies = node.dependsOn?.length ? node.dependsOn : schemaEdges.filter((edge) => edge.to === node.id).map((edge) => edge.from)
                      return <React.Fragment key={node.id}><div className={cn('w-44 cursor-pointer rounded-xl border p-3.5 shadow-xs transition-all', state === 'running' ? 'border-[var(--ui-primary)]/70 bg-[var(--ui-primary-background)] shadow-sm' : hoveredNodeId === node.id ? 'border-[var(--ui-primary)]/50 bg-[var(--ui-primary-background)]/40 shadow-xs' : 'border-border/60 bg-content-area/60 hover:border-border hover:bg-content-area')} onMouseEnter={(event) => showNodeDetails(node.id, event)} onClick={(event) => togglePinNode(node.id, event)}><div className="flex items-center gap-2"><span className="grid size-7 shrink-0 place-items-center rounded-lg ui-primary-surface shadow-xs"><NodeRoleIcon role={node.role} /></span><span className="min-w-0 truncate text-xs font-semibold text-foreground">{node.name}</span></div><div className="mt-2 text-[10px] text-muted-foreground">{roleLabel(node.role)} · {nodeStatusLabels[state]}</div>{dependencies.length > 0 && <div className="mt-1 truncate text-[10px] text-muted-foreground">承接 {dependencies.join('、')}</div>}</div>{index < currentSchema.nodes.length - 1 && <ChevronRight className="size-4 shrink-0 text-[var(--ui-primary)]/70" />}</React.Fragment>
                    })}
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] text-muted-foreground"><span>{schemaEdges.length > 0 ? `${schemaEdges.length} 条协作流` : '多角色按序协同'}</span><span>多角色协同推进</span><span>自动化交付成果</span><span>方案版本 {schemaRevision ? `v${schemaRevision}` : '--'}</span></div>
            </section>

            <section className="rounded-xl border border-border/60 bg-content-area p-5 shadow-xs" aria-label="专家团队运行历史">
              <div className="mb-4 flex items-center justify-between gap-3"><div><span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--ui-primary)]">运行历史</span><h2 className="mt-1 text-lg font-semibold text-foreground">{currentRun ? formatRunDisplayName(currentSchema?.name, currentRun) : '尚未运行'}</h2></div>{currentRun && <div className="flex items-center gap-2"><span className={cn('rounded-full px-2.5 py-1 text-[11px] font-medium', statusClass(currentRun.status))}>{statusLabels[currentRun.status]}</span>{currentRun.status === 'queued' && <Button variant="outline" size="sm" className="border-border/60 bg-card text-foreground/80 hover:bg-accent" onClick={() => void cancelRun()} disabled={loadState.run}><Square className="size-3.5" />取消运行</Button>}</div>}</div>
              {!currentRun ? <p className="text-xs text-muted-foreground">选择左侧运行记录查看详细协作动态与交付成果。</p> : <div className="grid gap-5 lg:grid-cols-2"><div><h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">协作动态</h3>{events.length === 0 ? <p className="text-xs text-muted-foreground">等待专家团队更新协作动态，当前状态为 {statusLabels[currentRun.status]}。</p> : <div className="space-y-2">{events.map((event) => <div key={`${event.id}-${event.sequence ?? ''}`} className="flex gap-2 rounded-lg border border-border/40 bg-card px-3 py-2 text-xs text-foreground/90"><span className="w-12 shrink-0 font-mono text-muted-foreground">{formatTime(event.timestamp)}</span><span className="font-medium">{event.type}</span>{event.message && <span className="text-muted-foreground">{event.message}</span>}</div>)}</div>}</div><div><h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">交付成果</h3>{artifacts.length === 0 ? <p className="text-xs text-muted-foreground">暂无交付成果文件</p> : <div className="space-y-2">{artifacts.map((artifact) => <div key={artifact.id} className="flex items-center justify-between rounded-lg border border-border/60 bg-card px-3 py-2 text-xs shadow-xs"><span className="truncate font-medium text-foreground">{artifact.name}</span><span className="ml-3 shrink-0 font-mono text-muted-foreground">{artifact.path || artifact.mimeType || '--'}</span></div>)}</div>}</div></div>}
            </section>
          </div>}
        </main>
      </div>
      {activeNode && nodeRect && <NodeDetailsPopover node={activeNode} status={nodeStates.get(activeNode.id) ?? 'pending'} dependencies={nodeDependencies(activeNode, schemaEdges)} pinned={pinnedNodeId === activeNode.id} style={nodeDetailsPopoverStyle(nodeRect)} onClose={() => setPinnedNodeId(null)} />}
    </div>
  )
}
