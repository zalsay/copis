import * as React from 'react'
import { toast } from 'sonner'
import {
  Check,
  Download,
  Filter,
  Loader2,
  PackageOpen,
  RefreshCw,
  Search,
  Store,
  Trash2,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { AgentWorkspace, WorkingExpertSkillMarketItem } from '@copis/shared'
import { installWorkingSkill, listWorkingSkillMarket, uninstallWorkingSkill } from '@/lib/working-skill-market-api'
import { cn } from '@/lib/utils'

interface SkillMarketDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  workspaces: AgentWorkspace[]
  onChanged: () => void
}

type MarketView = 'all' | 'installed'

function hasUpdate(skill: WorkingExpertSkillMarketItem): boolean {
  return skill.localInstalled === true
    && Boolean(skill.localVersion)
    && Boolean(skill.version)
    && skill.localVersion !== skill.version
}

function accentClass(accent: string): string {
  switch (accent.toLowerCase()) {
    case 'emerald':
    case 'green':
      return 'bg-emerald-500/12 text-emerald-600 dark:text-emerald-400'
    case 'violet':
    case 'purple':
      return 'bg-violet-500/12 text-violet-600 dark:text-violet-400'
    case 'orange':
      return 'bg-orange-500/12 text-orange-600 dark:text-orange-400'
    case 'rose':
    case 'red':
      return 'bg-rose-500/12 text-rose-600 dark:text-rose-400'
    default:
      return 'bg-blue-500/12 text-blue-600 dark:text-blue-400'
  }
}

export function SkillMarketDialog({ open, onOpenChange, workspaces, onChanged }: SkillMarketDialogProps): React.ReactElement {
  const [skills, setSkills] = React.useState<WorkingExpertSkillMarketItem[]>([])
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState('')
  const [query, setQuery] = React.useState('')
  const [category, setCategory] = React.useState('全部')
  const [view, setView] = React.useState<MarketView>('all')
  const [busyId, setBusyId] = React.useState<string | null>(null)
  const [selectedWorkspaceSlug, setSelectedWorkspaceSlug] = React.useState('')
  const requestIdRef = React.useRef(0)

  const invalidateMarket = React.useCallback((): void => {
    requestIdRef.current += 1
    setSkills([])
    setLoading(false)
    setError('')
  }, [])

  const resetDialogState = React.useCallback((): void => {
    invalidateMarket()
    setSelectedWorkspaceSlug('')
    setQuery('')
    setCategory('全部')
    setView('all')
  }, [invalidateMarket])

  const loadMarket = React.useCallback(async (targetWorkspaceSlug: string): Promise<void> => {
    const workspaceSlug = targetWorkspaceSlug.trim()
    if (!workspaceSlug) return

    const requestId = requestIdRef.current + 1
    requestIdRef.current = requestId
    setLoading(true)
    setError('')
    try {
      const nextSkills = await listWorkingSkillMarket(workspaceSlug)
      if (requestId !== requestIdRef.current) return
      setSkills(nextSkills)
    } catch (loadError: unknown) {
      if (requestId !== requestIdRef.current) return
      console.error('[技能市场] 加载失败:', loadError)
      setError(loadError instanceof Error ? loadError.message : '读取技能市场失败')
    } finally {
      if (requestId === requestIdRef.current) setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    if (!open) {
      resetDialogState()
      return
    }
    setQuery('')
    setCategory('全部')
    setView('all')
  }, [open, resetDialogState])

  React.useEffect(() => {
    if (!open || !selectedWorkspaceSlug) return
    if (!workspaces.some((workspace) => workspace.slug === selectedWorkspaceSlug)) {
      resetDialogState()
      return
    }
    void loadMarket(selectedWorkspaceSlug)
  }, [loadMarket, open, resetDialogState, selectedWorkspaceSlug, workspaces])

  const handleWorkspaceChange = (workspaceSlug: string): void => {
    if (!workspaces.some((workspace) => workspace.slug === workspaceSlug)) {
      resetDialogState()
      return
    }
    invalidateMarket()
    setSelectedWorkspaceSlug(workspaceSlug)
    setQuery('')
    setCategory('全部')
    setView('all')
  }

  const handleOpenChange = (nextOpen: boolean): void => {
    if (!nextOpen && busyId !== null) return
    if (!nextOpen) resetDialogState()
    onOpenChange(nextOpen)
  }

  const categories = React.useMemo(() => [
    '全部',
    ...Array.from(new Set(skills.map((skill) => skill.category).filter(Boolean))),
  ], [skills])

  const visibleSkills = React.useMemo(() => {
    const normalized = query.trim().toLowerCase()
    return skills.filter((skill) => {
      if (view === 'installed' && !skill.localInstalled) return false
      if (category !== '全部' && skill.category !== category) return false
      if (!normalized) return true
      return `${skill.name} ${skill.description} ${skill.slug} ${skill.category}`.toLowerCase().includes(normalized)
    })
  }, [category, query, skills, view])

  const localInstalledCount = React.useMemo(
    () => skills.filter((skill) => skill.localInstalled).length,
    [skills],
  )

  const runSkillAction = async (skill: WorkingExpertSkillMarketItem, action: 'install' | 'uninstall'): Promise<void> => {
    if (busyId !== null || !selectedWorkspaceSlug) return
    const id = String(skill.id)
    setBusyId(id)
    setError('')
    try {
      if (action === 'install') await installWorkingSkill(selectedWorkspaceSlug, skill.id)
      else await uninstallWorkingSkill(selectedWorkspaceSlug, skill.id)
      await loadMarket(selectedWorkspaceSlug)
      onChanged()
      toast.success(action === 'install' ? `已安装 Skill：${skill.name}` : `已卸载 Skill：${skill.name}`)
    } catch (actionError: unknown) {
      console.error(`[技能市场] ${action === 'install' ? '安装' : '卸载'}失败:`, actionError)
      const message = actionError instanceof Error ? actionError.message : '技能市场操作失败'
      toast.error(action === 'install' ? '安装 Skill 失败' : '卸载 Skill 失败', { description: message })
    } finally {
      setBusyId(null)
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-3xl gap-0 overflow-hidden p-0" onEscapeKeyDown={(event) => { if (busyId !== null) event.preventDefault() }}>
        <DialogHeader className="border-b border-border/60 px-6 pb-4 pt-6">
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-start gap-3">
              <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                <Store size={19} />
              </div>
              <div>
                <DialogTitle>技能市场</DialogTitle>
                <DialogDescription className="mt-1">选择目标项目后，从 Working 官方技能市场安装专家能力</DialogDescription>
              </div>
            </div>
          </div>

          <div className="mt-5 space-y-2">
            <div className="flex items-center justify-between gap-3">
              <label htmlFor="skill-market-workspace" className="text-sm font-medium text-foreground">
                目标项目 <span className="text-xs font-normal text-destructive">（必选）</span>
              </label>
              {workspaces.length === 0 && <span className="text-xs text-muted-foreground">暂无可用项目</span>}
            </div>
            <Select value={selectedWorkspaceSlug} onValueChange={handleWorkspaceChange} disabled={busyId !== null || workspaces.length === 0}>
              <SelectTrigger id="skill-market-workspace" aria-label="选择目标项目">
                <SelectValue placeholder="请选择项目（必选）" />
              </SelectTrigger>
              <SelectContent>
                {workspaces.map((workspace) => (
                  <SelectItem key={workspace.slug} value={workspace.slug}>
                    {workspace.name || workspace.slug}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <div className="flex h-9 min-w-[220px] flex-1 items-center gap-2 rounded-lg border border-border/60 bg-content-area px-3 focus-within:border-primary/40">
              <Search size={15} className="shrink-0 text-muted-foreground" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索技能名称、用途或分类"
                className="w-full bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground/60"
                aria-label="搜索技能市场"
                disabled={!selectedWorkspaceSlug}
              />
              {query && (
                <button type="button" onClick={() => setQuery('')} className="text-muted-foreground hover:text-foreground" aria-label="清除搜索">
                  <X size={14} />
                </button>
              )}
            </div>
            <div className="flex h-9 items-center rounded-lg bg-muted p-0.5" aria-label="技能市场视图">
              <button
                type="button"
                onClick={() => setView('all')}
                disabled={!selectedWorkspaceSlug}
                className={cn('h-8 rounded-md px-3 text-xs font-medium transition-colors', view === 'all' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}
              >
                全部技能
              </button>
              <button
                type="button"
                onClick={() => setView('installed')}
                disabled={!selectedWorkspaceSlug}
                className={cn('h-8 rounded-md px-3 text-xs font-medium transition-colors', view === 'installed' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}
              >
                已安装 {localInstalledCount}
              </button>
            </div>
          </div>

          <div className="mt-3 flex items-center gap-2 overflow-x-auto pb-0.5">
            <Filter size={14} className="shrink-0 text-muted-foreground" />
            {categories.map((item) => (
              <button
                key={item}
                type="button"
                onClick={() => setCategory(item)}
                disabled={!selectedWorkspaceSlug}
                className={cn('shrink-0 rounded-md px-2.5 py-1 text-xs transition-colors', category === item ? 'bg-primary/10 font-medium text-primary' : 'text-muted-foreground hover:bg-muted hover:text-foreground')}
              >
                {item}
              </button>
            ))}
          </div>
        </DialogHeader>

        <div className="max-h-[60vh] min-h-[280px] overflow-y-auto px-6 py-5 scrollbar-thin">
          {error && (
            <div className="mb-4 flex items-center justify-between gap-3 rounded-lg bg-destructive/10 px-3 py-2.5 text-sm text-destructive" role="alert">
              <span>{error}</span>
              <Button type="button" size="sm" variant="ghost" onClick={() => void loadMarket(selectedWorkspaceSlug)} disabled={loading || busyId !== null}>重试</Button>
            </div>
          )}

          {!selectedWorkspaceSlug ? (
            <div className="flex flex-col items-center justify-center gap-3 py-20 text-center text-muted-foreground" role="status">
              <PackageOpen size={30} className="text-foreground/25" />
              <div className="text-sm font-medium text-foreground/70">请先选择目标项目</div>
              <div className="text-xs">选择项目后才能查看和安装技能</div>
            </div>
          ) : loading ? (
            <div className="flex items-center justify-center gap-2 py-20 text-sm text-muted-foreground" role="status">
              <Loader2 size={16} className="animate-spin" />
              正在读取技能市场
            </div>
          ) : visibleSkills.length > 0 ? (
            <div className="flex flex-col divide-y divide-border/50">
              {visibleSkills.map((skill) => {
                const installed = skill.localInstalled === true
                const update = hasUpdate(skill)
                const busy = busyId === String(skill.id)
                return (
                  <div key={String(skill.id)} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
                    <div className={cn('flex size-10 shrink-0 items-center justify-center rounded-xl', accentClass(skill.accent))}>
                      <PackageOpen size={18} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-sm font-medium text-foreground">{skill.name}</span>
                        <span className="rounded-md bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">v{skill.version}</span>
                        {skill.category && <span className="text-[11px] text-muted-foreground">{skill.category}</span>}
                      </div>
                      <div className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">{skill.description || '暂无描述'}</div>
                      {installed && update && (
                        <div className="mt-1 text-[11px] text-blue-600 dark:text-blue-400">当前版本 v{skill.localVersion}，可更新至 v{skill.version}</div>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      {installed ? (
                        <>
                          <Button type="button" size="sm" variant={update ? 'default' : 'outline'} onClick={() => void runSkillAction(skill, 'install')} disabled={busyId !== null}>
                            {busy ? <Loader2 size={14} className="animate-spin" /> : update ? <RefreshCw size={14} /> : <Check size={14} />}
                            {busy ? '处理中' : update ? '更新' : '已安装'}
                          </Button>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button type="button" size="icon" variant="ghost" className="size-8 text-muted-foreground hover:text-destructive" onClick={() => void runSkillAction(skill, 'uninstall')} disabled={busyId !== null} aria-label={`卸载 ${skill.name}`}>
                                {busy && !update ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>卸载</TooltipContent>
                          </Tooltip>
                        </>
                      ) : (
                        <Button type="button" size="sm" onClick={() => void runSkillAction(skill, 'install')} disabled={busyId !== null}>
                          {busy ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
                          {busy ? '安装中' : skill.installed ? '安装到项目' : '安装'}
                        </Button>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center gap-3 py-20 text-center text-muted-foreground">
              <PackageOpen size={30} className="text-foreground/25" />
              <div className="text-sm font-medium text-foreground/70">{query || category !== '全部' ? '没有匹配的技能' : view === 'installed' ? '所选项目还没有安装市场 Skill' : '技能市场暂时没有可用内容'}</div>
              <div className="text-xs">{error ? '请稍后重试' : '可以更换筛选条件后再查看'}</div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
