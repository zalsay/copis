import * as React from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { Check, ChevronLeft, ChevronRight, RefreshCw, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import type { AgentWorkspace, CalendarEvent, CalendarEventStatus, PlanningTag } from '@copis/shared'
import { PLANNING_CONFLICT_ERROR } from '@copis/shared'
import { cn } from '@/lib/utils'
import { agentWorkspacesAtom, currentAgentWorkspaceIdAtom } from '@/atoms/agent-atoms'
import { calendarEventsAtom, planningCalendarCreateRequestAtom, planningSelectedCalendarEventIdAtom, planningTagsAtom } from '@/atoms/planning-atoms'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'

const DEFAULT_EVENT_DURATION = 60 * 60 * 1000
const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六']
const STATUS_OPTIONS: CalendarEventStatus[] = ['pending', 'in_progress', 'completed', 'expired']
const STATUS_LABELS: Record<CalendarEventStatus, string> = {
  pending: '待开始',
  in_progress: '进行中',
  completed: '已完成',
  expired: '已过期',
}

interface CalendarEditorState {
  event?: CalendarEvent
  title: string
  notes: string
  startAt: number
  endAt: number
  allDay: boolean
  workspaceId: string
  tagIds: string[]
  status: CalendarEventStatus
}

function startOfDay(value: number | Date): number {
  const date = new Date(value)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

function startOfMonth(value: number | Date): Date {
  const date = new Date(value)
  return new Date(date.getFullYear(), date.getMonth(), 1)
}

function addDays(value: number | Date, amount: number): number {
  const date = new Date(value)
  date.setDate(date.getDate() + amount)
  return date.getTime()
}

function addMonths(value: Date, amount: number): Date {
  return new Date(value.getFullYear(), value.getMonth() + amount, 1)
}

function nextDayStart(value: number | Date): number {
  return addDays(startOfDay(value), 1)
}

function previousDayStart(value: number | Date): number {
  return addDays(startOfDay(value), -1)
}

export function getCalendarEventEndAt(event: CalendarEvent): number {
  if (event.endAt !== undefined) return event.endAt
  return event.allDay ? nextDayStart(event.startAt) : event.startAt + 30 * 60 * 1000
}

function eventOccursOnDay(event: CalendarEvent, day: number): boolean {
  return event.startAt < nextDayStart(day) && getCalendarEventEndAt(event) > day
}

function calendarDateKey(value: number | Date): string {
  const date = new Date(value)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function buildCalendarGrid(month: Date): number[] {
  const first = startOfMonth(month)
  const firstWeekday = first.getDay()
  return Array.from({ length: 42 }, (_, index) => addDays(first, index - firstWeekday))
}

function formatTime(value: number): string {
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(value)
}

function formatMonth(value: Date): string {
  return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long' }).format(value)
}

function formatToday(value: number): string {
  return new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' }).format(value)
}

export function getCalendarStatus(event: CalendarEvent, now: number): CalendarEventStatus {
  if (event.status === 'completed') return 'completed'
  if (event.status === 'expired') return 'expired'
  if (event.status === 'in_progress' && event.startAt <= now && getCalendarEventEndAt(event) > now) return 'in_progress'
  if (getCalendarEventEndAt(event) <= now) return 'expired'
  if (event.startAt <= now) return 'in_progress'
  return 'pending'
}

function statusDotClass(status: CalendarEventStatus): string {
  return {
    pending: 'bg-blue-500',
    in_progress: 'bg-amber-500',
    completed: 'bg-emerald-500',
    expired: 'bg-muted-foreground/50',
  }[status]
}

function statusSurfaceClass(status: CalendarEventStatus): string {
  return {
    pending: 'bg-blue-500/10 hover:bg-blue-500/15',
    in_progress: 'bg-amber-500/10 hover:bg-amber-500/15',
    completed: 'bg-emerald-500/10 hover:bg-emerald-500/15',
    expired: 'bg-muted/65 hover:bg-muted',
  }[status]
}

function padInputPart(value: number): string {
  return String(value).padStart(2, '0')
}

function localDateInputValue(value: number): string {
  const date = new Date(value)
  return `${date.getFullYear()}-${padInputPart(date.getMonth() + 1)}-${padInputPart(date.getDate())}`
}

function localTimeInputValue(value: number): string {
  const date = new Date(value)
  return `${padInputPart(date.getHours())}:${padInputPart(date.getMinutes())}`
}

function replaceLocalDate(value: string, current: number): number {
  const parts = value.split('-').map(Number)
  const year = parts[0] ?? Number.NaN
  const month = parts[1] ?? Number.NaN
  const day = parts[2] ?? Number.NaN
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return current
  const source = new Date(current)
  const next = new Date(year, month - 1, day, source.getHours(), source.getMinutes(), 0, 0)
  return next.getFullYear() === year && next.getMonth() === month - 1 && next.getDate() === day ? next.getTime() : current
}

function replaceLocalTime(value: string, current: number): number {
  const parts = value.split(':').map(Number)
  const hours = parts[0] ?? Number.NaN
  const minutes = parts[1] ?? Number.NaN
  if (!Number.isInteger(hours) || !Number.isInteger(minutes) || hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return current
  const next = new Date(current)
  next.setHours(hours, minutes, 0, 0)
  return next.getTime()
}

function draftFromEvent(event: CalendarEvent | undefined, defaultWorkspaceId: string | undefined, startAt = startOfDay(Date.now()), endAt = nextDayStart(startAt)): CalendarEditorState {
  return {
    event,
    title: event?.title ?? '',
    notes: event?.notes ?? '',
    startAt: event?.startAt ?? startAt,
    endAt: event ? getCalendarEventEndAt(event) : endAt,
    allDay: event?.allDay ?? true,
    workspaceId: event?.workspaceId ?? defaultWorkspaceId ?? '__none__',
    tagIds: event?.tags.map((tag) => tag.id) ?? [],
    status: event ? getCalendarStatus(event, Date.now()) : 'pending',
  }
}

function eventRangeLabel(event: CalendarEvent): string {
  if (event.allDay) return '全天日程'
  return `${formatTime(event.startAt)} - ${formatTime(getCalendarEventEndAt(event))}`
}

export function CalendarWorkspace(): React.ReactElement {
  const [events, setEvents] = useAtom(calendarEventsAtom)
  const tags = useAtomValue(planningTagsAtom)
  const workspaces = useAtomValue(agentWorkspacesAtom)
  const currentWorkspaceId = useAtomValue(currentAgentWorkspaceIdAtom)
  const createRequest = useAtomValue(planningCalendarCreateRequestAtom)
  const setCreateRequest = useSetAtom(planningCalendarCreateRequestAtom)
  const selectedEventId = useAtomValue(planningSelectedCalendarEventIdAtom)
  const setSelectedEventId = useSetAtom(planningSelectedCalendarEventIdAtom)
  const [month, setMonth] = React.useState(() => startOfMonth(Date.now()))
  const [editor, setEditor] = React.useState<CalendarEditorState | null>(null)
  const [pendingDelete, setPendingDelete] = React.useState<CalendarEvent | null>(null)
  const [saving, setSaving] = React.useState(false)
  const [refreshing, setRefreshing] = React.useState(false)
  const [formError, setFormError] = React.useState('')
  const [now, setNow] = React.useState(() => Date.now())
  const defaultWorkspaceId = workspaces.some((workspace) => workspace.id === currentWorkspaceId)
    ? currentWorkspaceId ?? undefined
    : workspaces[0]?.id
  const grid = React.useMemo(() => buildCalendarGrid(month), [month])
  const today = startOfDay(now)
  const todayEvents = React.useMemo(
    () => events.filter((event) => eventOccursOnDay(event, today)).sort((left, right) => left.startAt - right.startAt),
    [events, today],
  )

  React.useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(timer)
  }, [])

  const openNewEvent = (day = today): void => {
    setFormError('')
    const startAt = startOfDay(day)
    setEditor(draftFromEvent(undefined, defaultWorkspaceId, startAt, nextDayStart(startAt)))
  }

  const openExistingEvent = (event: CalendarEvent): void => {
    setFormError('')
    setEditor(draftFromEvent(event, defaultWorkspaceId))
  }

  React.useEffect(() => {
    if (createRequest === 0) return
    setCreateRequest(0)
    openNewEvent()
  }, [createRequest, setCreateRequest])

  React.useEffect(() => {
    if (!selectedEventId) return
    const event = events.find((item) => item.id === selectedEventId)
    if (!event) return
    setSelectedEventId(null)
    openExistingEvent(event)
  }, [events, selectedEventId, setSelectedEventId])

  const refreshEvents = async (): Promise<void> => {
    setRefreshing(true)
    try {
      setEvents(await window.electronAPI.listCalendarEvents())
    } catch (error) {
      console.error('[日程] 刷新失败:', error)
      toast.error('刷新日程失败')
    } finally {
      setRefreshing(false)
    }
  }

  const saveEvent = async (statusOverride?: CalendarEventStatus): Promise<void> => {
    if (!editor) return
    const status = statusOverride ?? editor.status
    if (!editor.title.trim()) {
      setFormError('请输入日程标题')
      return
    }
    if (editor.endAt <= editor.startAt) {
      setFormError('结束时间必须晚于开始时间')
      return
    }
    if (!editor.workspaceId || editor.workspaceId === '__none__') {
      setFormError('请选择绑定工作区')
      return
    }
    setSaving(true)
    setFormError('')
    const isCreating = editor.event === undefined
    const saveStartedAt = Date.now()
    try {
      const common = {
        title: editor.title.trim(),
        notes: editor.notes,
        startAt: editor.startAt,
        endAt: editor.endAt,
        allDay: editor.allDay,
        status,
      }
      let event = editor.event
        ? await window.electronAPI.updateCalendarEvent({
          id: editor.event.id,
          ...common,
          groupId: editor.event.groupId ?? null,
          workspaceId: editor.workspaceId === '__none__' ? null : editor.workspaceId,
          tagIds: editor.tagIds,
          expectedUpdatedAt: editor.event.updatedAt,
        })
        : await window.electronAPI.createCalendarEvent({ ...common, workspaceId: editor.workspaceId })
      if (!event && isCreating) {
        const latestEvents = await window.electronAPI.listCalendarEvents()
        const recovered = latestEvents.find((item) => (
          item.title === common.title &&
          item.startAt === common.startAt &&
          item.endAt === common.endAt &&
          item.createdAt >= saveStartedAt
        ))
        if (recovered) {
          setEvents(latestEvents)
          setEditor(null)
          toast.success('已创建日程')
          return
        }
        throw new Error('创建日程后未找到记录，请重试')
      }
      if (!event) throw new Error('日程已不存在，请重新打开')
      setEvents((current) => {
        const next = current.some((item) => item.id === event.id)
          ? current.map((item) => item.id === event.id ? event : item)
          : [...current, event]
        return next.sort((left, right) => left.startAt - right.startAt)
      })
      setEditor(null)
      toast.success(editor.event ? '已更新日程' : '已创建日程')
    } catch (error) {
      if (error instanceof Error && error.message.includes(PLANNING_CONFLICT_ERROR)) {
        setFormError('日程已在其他窗口更新，请关闭后重新打开')
      } else {
        console.error('[日程] 保存失败:', error)
        setFormError(error instanceof Error ? error.message : '保存日程失败')
      }
    } finally {
      setSaving(false)
    }
  }

  const deleteEvent = async (): Promise<void> => {
    if (!pendingDelete) return
    try {
      const deleted = await window.electronAPI.deleteCalendarEvent(pendingDelete.id)
      if (!deleted) throw new Error('日程不存在')
      setEvents((current) => current.filter((event) => event.id !== pendingDelete.id))
      if (editor?.event?.id === pendingDelete.id) setEditor(null)
      setPendingDelete(null)
      toast.success('已删除日程')
    } catch (error) {
      console.error('[日程] 删除失败:', error)
      toast.error('删除日程失败')
    }
  }

  const monthLabel = formatMonth(month)
  return (
    <section className="flex h-full min-h-0 flex-col overflow-y-auto scrollbar-none px-4 py-6 text-foreground sm:px-6 sm:py-8 lg:px-8">
      <div className="mx-auto flex w-full max-w-[1320px] min-w-0 flex-1 flex-col">
        <div className="flex shrink-0 flex-col gap-3 rounded-t-lg border border-border/60 bg-card px-3 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-1.5">
            <Button type="button" variant="ghost" size="icon" className="size-9" aria-label="上个月" onClick={() => setMonth((current) => addMonths(current, -1))}><ChevronLeft size={18} /></Button>
            <strong className="min-w-32 text-center text-sm font-semibold tabular-nums">{monthLabel}</strong>
            <Button type="button" variant="ghost" size="icon" className="size-9" aria-label="下个月" onClick={() => setMonth((current) => addMonths(current, 1))}><ChevronRight size={18} /></Button>
            <Button type="button" variant="outline" size="sm" className="ml-1 h-9" onClick={() => setMonth(startOfMonth(Date.now()))}>今天</Button>
          </div>
          <div className="flex min-w-0 items-center gap-3 overflow-x-auto text-xs text-muted-foreground">
            {STATUS_OPTIONS.map((status) => <span className="inline-flex shrink-0 items-center gap-1.5" key={status}><i className={cn('size-2 rounded-full', statusDotClass(status))} />{STATUS_LABELS[status]}</span>)}
            <Button type="button" variant="ghost" size="icon" className="size-8 shrink-0" aria-label="刷新日程" title="刷新日程" disabled={refreshing} onClick={() => void refreshEvents()}><RefreshCw className={cn('size-4', refreshing && 'animate-spin')} /></Button>
          </div>
        </div>

        <div className="overflow-hidden border-x border-b border-border/60 bg-card" aria-busy={refreshing}>
          <div className="grid grid-cols-7 border-b border-border/60 text-center text-xs font-semibold text-muted-foreground">{WEEKDAYS.map((weekday) => <span className="px-1 py-2.5" key={weekday}>{weekday}</span>)}</div>
          <div className="grid min-h-[520px] grid-cols-7 grid-rows-6">
            {grid.map((day) => {
              const date = new Date(day)
              const isCurrentMonth = date.getMonth() === month.getMonth()
              const isToday = day === today
              const dayEvents = events.filter((event) => eventOccursOnDay(event, day)).sort((left, right) => left.startAt - right.startAt)
              return (
                <div className={cn('flex min-h-[86px] min-w-0 flex-col border-b border-r border-border/50 p-1.5 transition-colors hover:bg-muted/20 sm:min-h-[112px] sm:p-2', !isCurrentMonth && 'bg-muted/15')} key={calendarDateKey(day)}>
                  <button type="button" className={cn('mb-1 ml-auto inline-flex size-6 shrink-0 items-center justify-center rounded-full text-xs tabular-nums text-muted-foreground hover:bg-muted', isToday && 'bg-primary font-semibold text-primary-foreground hover:bg-primary/90', !isCurrentMonth && 'text-muted-foreground/45')} onClick={() => openNewEvent(day)} aria-label={`${calendarDateKey(day)} 添加日程`}>{date.getDate()}</button>
                  <div className="min-h-0 space-y-1 overflow-y-auto scrollbar-thin">
                    {dayEvents.slice(0, 3).map((event) => <CalendarEventMarker key={event.id} event={event} now={now} onSelect={() => openExistingEvent(event)} />)}
                    {dayEvents.length > 3 && <span className="block px-1 text-[11px] text-muted-foreground">还有 {dayEvents.length - 3} 项</span>}
                  </div>
                </div>
              )
            })}
          </div>
        </div>

        <TodayEvents events={todayEvents} now={now} onSelect={openExistingEvent} />
      </div>

      {editor && <CalendarEventDialog editor={editor} workspaces={workspaces} tags={tags} busy={saving} error={formError} onChange={setEditor} onClose={() => !saving && setEditor(null)} onSave={() => void saveEvent()} onComplete={() => void saveEvent('completed')} onDelete={() => setPendingDelete(editor.event ?? null)} />}
      <AlertDialog open={pendingDelete !== null} onOpenChange={(open) => { if (!open) setPendingDelete(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader><AlertDialogTitle>确认删除日程</AlertDialogTitle><AlertDialogDescription>删除「{pendingDelete?.title}」后无法恢复。</AlertDialogDescription></AlertDialogHeader>
          <AlertDialogFooter><AlertDialogCancel>取消</AlertDialogCancel><AlertDialogAction onClick={() => void deleteEvent()} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">删除</AlertDialogAction></AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}

function CalendarEventMarker({ event, now, onSelect }: { event: CalendarEvent; now: number; onSelect: () => void }): React.ReactElement {
  const status = getCalendarStatus(event, now)
  return (
    <button type="button" data-calendar-item onClick={(click) => { click.stopPropagation(); onSelect() }} className={cn('grid w-full min-w-0 grid-cols-[7px_auto_minmax(0,1fr)] items-center gap-1 rounded-md px-1.5 py-1 text-left text-[11px] text-foreground transition-colors', statusSurfaceClass(status), (status === 'completed' || status === 'expired') && 'text-muted-foreground')} title={event.title}>
      <i className={cn('size-1.5 rounded-full', statusDotClass(status))} />
      <span className="hidden truncate text-[10px] text-muted-foreground sm:inline">{event.allDay ? '' : formatTime(event.startAt)}</span>
      <strong className={cn('truncate font-medium', (status === 'completed' || status === 'expired') && 'line-through')}>{event.title}</strong>
    </button>
  )
}

function TodayEvents({ events, now, onSelect }: { events: CalendarEvent[]; now: number; onSelect: (event: CalendarEvent) => void }): React.ReactElement {
  return (
    <section className="mt-6 shrink-0 border-t border-border/60 pt-5" aria-labelledby="calendar-today-title">
      <header className="mb-3 flex items-start justify-between gap-3">
        <div><h2 id="calendar-today-title" className="text-base font-semibold">今日日程详情</h2><p className="mt-1 text-xs text-muted-foreground">{formatToday(now)}</p></div>
        <span className="text-xs text-muted-foreground">{events.length} 项</span>
      </header>
      {events.length > 0 ? <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">{events.map((event) => <TodayEventItem event={event} now={now} onSelect={() => onSelect(event)} key={event.id} />)}</div> : <p className="rounded-lg border border-dashed border-border/70 px-3 py-7 text-center text-sm text-muted-foreground">今天暂无日程</p>}
    </section>
  )
}

function TodayEventItem({ event, now, onSelect }: { event: CalendarEvent; now: number; onSelect: () => void }): React.ReactElement {
  const status = getCalendarStatus(event, now)
  return <button type="button" onClick={onSelect} className="grid min-h-16 w-full grid-cols-[8px_minmax(0,1fr)_auto] items-start gap-2.5 rounded-lg border border-border/60 bg-card px-3 py-2.5 text-left transition-colors hover:bg-muted/35"><i className={cn('mt-1 size-2 rounded-full', statusDotClass(status))} /><span className="min-w-0"><strong className={cn('block break-words text-sm leading-5', (status === 'completed' || status === 'expired') && 'text-muted-foreground line-through')}>{event.title}</strong><small className="mt-0.5 block text-xs text-muted-foreground">{eventRangeLabel(event)}</small>{event.notes && <span className="mt-1.5 block line-clamp-2 text-xs leading-5 text-muted-foreground">{event.notes}</span>}</span><em className="text-[11px] not-italic leading-5 text-muted-foreground">{STATUS_LABELS[status]}</em></button>
}

function CalendarEventDialog({ editor, workspaces, tags, busy, error, onChange, onClose, onSave, onComplete, onDelete }: { editor: CalendarEditorState; workspaces: AgentWorkspace[]; tags: PlanningTag[]; busy: boolean; error: string; onChange: (editor: CalendarEditorState) => void; onClose: () => void; onSave: () => void; onComplete: () => void; onDelete: () => void }): React.ReactElement {
  const update = <K extends keyof CalendarEditorState>(key: K, value: CalendarEditorState[K]): void => onChange({ ...editor, [key]: value })
  const setAllDay = (allDay: boolean): void => {
    const startAt = allDay ? startOfDay(editor.startAt) : editor.startAt
    const endAt = allDay
      ? Math.max(nextDayStart(startAt), nextDayStart(editor.endAt))
      : editor.allDay
        ? startAt + DEFAULT_EVENT_DURATION
        : Math.max(editor.endAt, startAt + DEFAULT_EVENT_DURATION)
    onChange({ ...editor, allDay, startAt, endAt })
  }
  const setStartDate = (value: string): void => {
    const startAt = replaceLocalDate(value, editor.startAt)
    const normalizedStart = editor.allDay ? startOfDay(startAt) : startAt
    onChange({ ...editor, startAt: normalizedStart, endAt: editor.endAt <= normalizedStart ? (editor.allDay ? nextDayStart(normalizedStart) : normalizedStart + DEFAULT_EVENT_DURATION) : editor.endAt })
  }
  const setEndDate = (value: string): void => {
    const currentEndDate = editor.allDay ? previousDayStart(editor.endAt) : editor.endAt
    const endAt = replaceLocalDate(value, currentEndDate)
    onChange({ ...editor, endAt: editor.allDay ? nextDayStart(endAt) : endAt })
  }
  const setStartTime = (value: string): void => {
    const startAt = replaceLocalTime(value, editor.startAt)
    onChange({ ...editor, startAt, endAt: editor.endAt <= startAt ? startAt + DEFAULT_EVENT_DURATION : editor.endAt })
  }
  const setEndTime = (value: string): void => onChange({ ...editor, endAt: replaceLocalTime(value, editor.endAt) })
  const status = editor.status

  return (
    <Dialog open onOpenChange={(nextOpen) => { if (!nextOpen) onClose() }}>
      <DialogContent className="max-h-[calc(100vh-2rem)] max-w-xl gap-0 overflow-y-auto p-0">
        <form onSubmit={(event) => { event.preventDefault(); onSave() }}>
          <DialogHeader className="border-b border-border/60 px-6 py-5">
            <div className="flex items-center gap-2"><DialogTitle>{editor.event ? '编辑日程' : '添加日程'}</DialogTitle><span className={cn('rounded-md px-2 py-0.5 text-[11px]', statusSurfaceClass(status))}>{STATUS_LABELS[status]}</span></div>
            <DialogDescription className="sr-only">配置日程标题、说明、状态和时间</DialogDescription>
          </DialogHeader>
          <div className="grid gap-5 px-6 py-5">
            {error && <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">{error}</div>}
            <label className="grid gap-2 text-sm font-medium" htmlFor="calendar-event-title"><span>日程标题</span><Input id="calendar-event-title" autoFocus required maxLength={500} value={editor.title} onChange={(event) => update('title', event.target.value)} placeholder="例如：产品方案评审" /></label>
            <label className="grid gap-2 text-sm font-medium" htmlFor="calendar-event-notes"><span>说明</span><Textarea id="calendar-event-notes" rows={3} value={editor.notes} onChange={(event) => update('notes', event.target.value)} placeholder="补充目标、参与人或需要准备的材料" className="resize-y" /></label>
            {editor.event && <label className="grid gap-2 text-sm font-medium"><span>状态</span><Select value={status} onValueChange={(value) => update('status', value as CalendarEventStatus)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{STATUS_OPTIONS.map((option) => <SelectItem key={option} value={option}>{STATUS_LABELS[option]}</SelectItem>)}</SelectContent></Select></label>}
            <label className="flex items-center justify-between rounded-lg border border-border/60 px-3 py-3 text-sm font-medium"><span>全天日程</span><input type="checkbox" checked={editor.allDay} onChange={(event) => setAllDay(event.target.checked)} className="size-4 accent-primary" /></label>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="grid gap-2 text-sm font-medium"><span>开始日期</span><Input type="date" required value={localDateInputValue(editor.startAt)} onChange={(event) => setStartDate(event.target.value)} /></label>
              {!editor.allDay && <label className="grid gap-2 text-sm font-medium"><span>开始时间</span><Input type="time" required value={localTimeInputValue(editor.startAt)} onChange={(event) => setStartTime(event.target.value)} /></label>}
              <label className="grid gap-2 text-sm font-medium"><span>结束日期</span><Input type="date" required min={localDateInputValue(editor.startAt)} value={localDateInputValue(editor.allDay ? previousDayStart(editor.endAt) : editor.endAt)} onChange={(event) => setEndDate(event.target.value)} /></label>
              {!editor.allDay && <label className="grid gap-2 text-sm font-medium"><span>结束时间</span><Input type="time" required value={localTimeInputValue(editor.endAt)} onChange={(event) => setEndTime(event.target.value)} /></label>}
            </div>
            <label className="grid gap-2 text-sm font-medium"><span>工作项目</span><Select value={editor.workspaceId} onValueChange={(value) => update('workspaceId', value)}><SelectTrigger><SelectValue placeholder="选择工作项目" /></SelectTrigger><SelectContent><SelectItem value="__none__">未选择工作区</SelectItem>{workspaces.map((workspace) => <SelectItem key={workspace.id} value={workspace.id}>{workspace.name}</SelectItem>)}</SelectContent></Select></label>
            {editor.event && <CalendarRelations editor={editor} tags={tags} onChange={onChange} />}
          </div>
          <DialogFooter className="border-t border-border/60 px-6 py-4 sm:flex-row sm:items-center sm:justify-between sm:space-x-0">
            <div className="flex items-center gap-2">{editor.event && <Button type="button" variant="ghost" disabled={busy} className="text-destructive hover:text-destructive" onClick={onDelete}><Trash2 size={15} />删除</Button>}{editor.event && editor.status !== 'completed' && <Button type="button" variant="secondary" disabled={busy} onClick={onComplete}><Check size={15} />完成</Button>}</div>
            <div className="flex items-center justify-end gap-2"><Button type="button" variant="ghost" disabled={busy} onClick={onClose}>取消</Button><Button type="submit" disabled={busy || !editor.title.trim() || editor.endAt <= editor.startAt || editor.workspaceId === '__none__'}>{busy ? '保存中…' : '保存日程'}</Button></div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function CalendarRelations({ editor, tags, onChange }: { editor: CalendarEditorState; tags: PlanningTag[]; onChange: (editor: CalendarEditorState) => void }): React.ReactElement {
  return <section className="grid gap-4 border-t border-border/60 pt-5"><p className="text-sm font-semibold">标签</p><div className="grid gap-2 text-sm font-medium"><span>日程标签</span><div className="flex flex-wrap gap-1.5">{tags.length > 0 ? tags.map((tag) => { const selected = editor.tagIds.includes(tag.id); return <button type="button" key={tag.id} onClick={() => onChange({ ...editor, tagIds: selected ? editor.tagIds.filter((id) => id !== tag.id) : [...editor.tagIds, tag.id] })} className={cn('rounded-md px-2 py-1 text-xs transition-colors', selected ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:bg-muted/80')}>#{tag.name}</button> }) : <span className="text-xs text-muted-foreground">暂无标签</span>}</div></div></section>
}
