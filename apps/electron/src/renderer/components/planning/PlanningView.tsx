import * as React from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { CalendarDays, ChevronRight, ExternalLink, Plus, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import type { CalendarEvent } from '@copis/shared'
import { cn } from '@/lib/utils'
import { agentWorkspacesAtom } from '@/atoms/agent-atoms'
import { calendarEventsAtom, planningCalendarCreateRequestAtom, planningSelectedCalendarEventIdAtom, planningTabAtom, type PlanningTab } from '@/atoms/planning-atoms'
import { AutomationsListView } from '@/components/automation/AutomationsListView'
import { CalendarWorkspace, getCalendarEventEndAt, getCalendarStatus } from '@/components/planning/CalendarWorkspace'
import { Button } from '@/components/ui/button'
import { ShortcutKeycaps } from '@/components/shortcuts/ShortcutKeycaps'
import { useShortcut } from '@/hooks/useShortcut'
import { detectIsWindows, WINDOW_CONTROLS_INSET_RIGHT } from '@/lib/platform'

const TABS: Array<{ id: PlanningTab; label: string }> = [
  { id: 'schedule', label: '日程表' },
  { id: 'calendar', label: '日历' },
  { id: 'automations', label: '定时任务' },
]

const STATUS_LABELS = {
  pending: '待开始',
  in_progress: '进行中',
  completed: '已完成',
  expired: '已过期',
} as const

type ScheduleFilter = 'upcoming' | 'today' | 'all' | 'completed'

function CreateShortcutHint(): React.ReactElement | null {
  return (
    <ShortcutKeycaps
      shortcutId="new-session"
      className="ml-1.5"
      keycapClassName="border-primary-foreground/30 bg-primary-foreground/10 text-primary-foreground shadow-none"
      separatorClassName="text-primary-foreground/70"
    />
  )
}

function startOfDay(value: number | Date): number {
  const date = new Date(value)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

function isSameLocalDay(left: number, right: number): boolean {
  return startOfDay(left) === startOfDay(right)
}

function formatScheduleDate(value: number): string {
  return new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' }).format(value)
}

function formatScheduleTime(value: number): string {
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(value)
}

function formatScheduleRange(event: CalendarEvent): string {
  if (event.allDay) return `${formatScheduleDate(event.startAt)} · 全天`
  const endAt = getCalendarEventEndAt(event)
  const endLabel = isSameLocalDay(event.startAt, endAt)
    ? formatScheduleTime(endAt)
    : `${formatScheduleDate(endAt)} ${formatScheduleTime(endAt)}`
  return `${formatScheduleDate(event.startAt)} ${formatScheduleTime(event.startAt)} - ${endLabel}`
}

function statusDotClass(status: ReturnType<typeof getCalendarStatus>): string {
  return {
    pending: 'bg-blue-500',
    in_progress: 'bg-amber-500',
    completed: 'bg-emerald-500',
    expired: 'bg-muted-foreground/50',
  }[status]
}

function statusSurfaceClass(status: ReturnType<typeof getCalendarStatus>): string {
  return {
    pending: 'bg-blue-500/10 text-blue-700 dark:text-blue-300',
    in_progress: 'bg-amber-500/10 text-amber-800 dark:text-amber-200',
    completed: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
    expired: 'bg-muted text-muted-foreground',
  }[status]
}

function CalendarScheduleList(): React.ReactElement {
  const events = useAtomValue(calendarEventsAtom)
  const workspaces = useAtomValue(agentWorkspacesAtom)
  const setEvents = useSetAtom(calendarEventsAtom)
  const setTab = useSetAtom(planningTabAtom)
  const setSelectedEventId = useSetAtom(planningSelectedCalendarEventIdAtom)
  const [filter, setFilter] = React.useState<ScheduleFilter>('upcoming')
  const [now, setNow] = React.useState(() => Date.now())
  const [refreshing, setRefreshing] = React.useState(false)
  const workspaceNames = React.useMemo(() => new Map(workspaces.map((workspace) => [workspace.id, workspace.name])), [workspaces])

  React.useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(timer)
  }, [])

  const refreshEvents = async (): Promise<void> => {
    setRefreshing(true)
    try {
      // 统一从主进程重新读取，保证独立窗口之间的日程表及时同步。
      await window.electronAPI.listCalendarEvents().then(setEvents)
    } catch (error) {
      console.error('[日程表] 刷新失败:', error)
      toast.error('刷新日程失败')
    } finally {
      setRefreshing(false)
    }
  }

  const visibleEvents = React.useMemo(() => {
    const today = startOfDay(now)
    const upcomingEnd = today + 14 * 24 * 60 * 60 * 1000
    return [...events]
      .filter((event) => {
        const status = getCalendarStatus(event, now)
        if (filter === 'completed') return status === 'completed'
        if (filter === 'today') return event.startAt < today + 24 * 60 * 60 * 1000 && getCalendarEventEndAt(event) > today
        if (filter === 'upcoming') return status !== 'completed' && getCalendarEventEndAt(event) >= today && event.startAt <= upcomingEnd
        return true
      })
      .sort((left, right) => left.startAt - right.startAt || left.updatedAt - right.updatedAt)
  }, [events, filter, now])

  const openEvent = (event: CalendarEvent): void => {
    setSelectedEventId(event.id)
    setTab('calendar')
  }

  const filterItems: Array<{ id: ScheduleFilter; label: string }> = [
    { id: 'upcoming', label: '近期' },
    { id: 'today', label: '今天' },
    { id: 'all', label: '全部' },
    { id: 'completed', label: '已完成' },
  ]

  return (
    <section className="flex h-full min-h-0 flex-col overflow-hidden rounded-lg border border-border/60 bg-card" aria-labelledby="schedule-list-title">
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-border/60 px-4 py-3 sm:px-5">
        <div>
          <h2 id="schedule-list-title" className="text-base font-semibold">日程表</h2>
          <p className="mt-1 text-xs text-muted-foreground">按时间查看和管理已创建的日程</p>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="flex items-center rounded-lg bg-muted/60 p-1" role="tablist" aria-label="日程筛选">
            {filterItems.map((item) => <button key={item.id} type="button" role="tab" aria-selected={filter === item.id} onClick={() => setFilter(item.id)} className={cn('min-h-8 rounded-md px-2.5 text-xs transition-colors', filter === item.id ? 'bg-background font-medium text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}>{item.label}</button>)}
          </div>
          <Button type="button" variant="ghost" size="icon" className="size-8" aria-label="刷新日程表" title="刷新日程表" disabled={refreshing} onClick={() => void refreshEvents()}><RefreshCw className={cn('size-4', refreshing && 'animate-spin')} /></Button>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
        {visibleEvents.length > 0 ? visibleEvents.map((event) => {
          const status = getCalendarStatus(event, now)
          return (
            <button key={event.id} type="button" onClick={() => openEvent(event)} className="group grid min-h-[78px] w-full grid-cols-[52px_minmax(0,1fr)_auto] items-center gap-3 border-b border-border/50 px-4 py-3 text-left transition-colors hover:bg-muted/35 sm:grid-cols-[64px_minmax(0,1fr)_auto] sm:px-5">
              <span className="flex flex-col items-center justify-center border-r border-border/60 pr-3 text-center"><strong className="text-lg font-semibold leading-none tabular-nums">{new Date(event.startAt).getDate()}</strong><small className="mt-1 text-[11px] text-muted-foreground">{new Intl.DateTimeFormat('zh-CN', { month: 'short' }).format(event.startAt)}</small></span>
              <span className="min-w-0"><strong className={cn('block truncate text-sm font-medium', (status === 'completed' || status === 'expired') && 'text-muted-foreground line-through')}>{event.title}</strong><span className="mt-1 block truncate text-xs text-muted-foreground">{formatScheduleRange(event)}</span>{(event.notes || event.workspaceId) && <span className="mt-1.5 flex min-w-0 items-center gap-2 truncate text-xs text-muted-foreground">{event.workspaceId && <span className="truncate">{workspaceNames.get(event.workspaceId) ?? '工作区不可用'}</span>}{event.notes && <span className="truncate">{event.workspaceId ? `· ${event.notes}` : event.notes}</span>}</span>}</span>
              <span className="flex items-center gap-2"><span className={cn('hidden items-center gap-1.5 rounded-md px-2 py-1 text-[11px] sm:inline-flex', statusSurfaceClass(status))}><i className={cn('size-1.5 rounded-full', statusDotClass(status))} />{STATUS_LABELS[status]}</span><ChevronRight className="size-4 text-muted-foreground/60 transition-transform group-hover:translate-x-0.5" /></span>
            </button>
          )
        }) : <div className="flex min-h-56 flex-col items-center justify-center gap-3 px-6 text-center text-sm text-muted-foreground"><CalendarDays className="size-8 text-muted-foreground/50" /><p>{filter === 'completed' ? '还没有已完成的日程' : '暂无符合条件的日程'}</p></div>}
      </div>
    </section>
  )
}

export function PlanningView({ standalone = false }: { standalone?: boolean } = {}): React.ReactElement {
  const [tab, setTab] = useAtom(planningTabAtom)
  const isWindows = React.useMemo(() => detectIsWindows(), [])
  const requestCalendarCreate = useSetAtom(planningCalendarCreateRequestAtom)
  const triggerCalendarCreate = React.useCallback(() => {
    setTab('calendar')
    requestCalendarCreate((count) => count + 1)
  }, [requestCalendarCreate, setTab])
  const openPlanningWindow = React.useCallback((): void => {
    void window.electronAPI.openPlanningWindow().catch((error) => {
      console.error('[任务/日程] 打开独立窗口失败:', error)
      toast.error('打开独立窗口失败')
    })
  }, [])

  useShortcut('new-session', triggerCalendarCreate, true, { exclusive: true })

  const pageTitle = tab === 'schedule' ? '日程表' : tab === 'calendar' ? '日历' : '定时任务'
  const pageDescription = tab === 'schedule' || tab === 'calendar' ? '个人安排，可关联工作区' : '管理自动运行的任务'

  return (
    <div className="flex h-full flex-col overflow-hidden bg-content-area">
      <header className={cn('relative flex w-full items-center justify-between titlebar-no-drag', standalone ? 'px-5 pb-4 pt-8' : 'px-6 pb-5 pt-8 sm:px-8 xl:px-10')}>
        <div className={cn('absolute inset-y-0 left-0 z-0 titlebar-drag-region', isWindows ? WINDOW_CONTROLS_INSET_RIGHT : 'right-0')} />
        <div className="relative z-[1]"><h1 className="text-2xl font-semibold tracking-tight text-wrap-balance">{pageTitle}</h1><p className="mt-1 text-sm text-muted-foreground">{pageDescription}</p></div>
        <div className="relative z-[1] titlebar-no-drag flex items-center gap-2">
          {!standalone && <button type="button" onClick={openPlanningWindow} className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-border/60 bg-background px-3 text-sm font-medium text-foreground shadow-sm transition-colors hover:bg-muted/60 active:scale-[0.96]"><ExternalLink size={16} />独立窗口</button>}
          <button type="button" onClick={triggerCalendarCreate} aria-keyshortcuts="Meta+N Control+N" className="inline-flex min-h-10 items-center gap-1.5 rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 active:scale-[0.96]"><Plus size={16} />新建日程<CreateShortcutHint /></button>
        </div>
      </header>
      <div className={cn('titlebar-no-drag w-full', standalone ? 'px-5' : 'px-6 sm:px-8 xl:px-10')}>
        <nav className="inline-flex rounded-xl bg-muted/60 p-1 shadow-inner" aria-label="规划视图">
          {TABS.map((item) => <button key={item.id} type="button" onClick={() => setTab(item.id)} className={cn('min-h-9 rounded-lg px-3 text-sm transition-colors', tab === item.id ? 'bg-background font-medium text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}>{item.label}</button>)}
        </nav>
      </div>
      <main className={cn('min-h-0 flex-1 titlebar-no-drag', standalone ? 'px-5 pb-5 pt-4' : 'px-6 pb-8 pt-6 sm:px-8 xl:px-10', tab === 'schedule' || tab === 'calendar' ? 'overflow-hidden' : 'overflow-y-auto')}>
        <div className={cn('h-full w-full', (tab === 'schedule' || tab === 'calendar') && 'min-h-0')}>
          {tab === 'schedule' && <CalendarScheduleList />}
          {tab === 'calendar' && <CalendarWorkspace />}
          {tab === 'automations' && <AutomationsListView />}
        </div>
      </main>
    </div>
  )
}
