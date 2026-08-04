import * as React from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { BellRing, MessageCircle, X } from 'lucide-react'
import { toast } from 'sonner'
import type { ActivePlanningReminder } from '@copis/shared'
import { activePlanningRemindersAtom } from '@/atoms/planning-atoms'
import { agentChannelIdAtom, agentModelIdAtom, agentSessionsAtom, agentWorkspacesAtom, currentAgentWorkspaceIdAtom } from '@/atoms/agent-atoms'
import { activeViewAtom } from '@/atoms/active-view'
import { notificationsEnabledAtom, notificationSoundEnabledAtom, notificationSoundsAtom, playNotificationSoundForType } from '@/atoms/notifications'
import { Button } from '@/components/ui/button'
import { useOpenSession } from '@/hooks/useOpenSession'

function formatTriggerTime(timestamp: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(timestamp)
}

function mergeReminders(current: ActivePlanningReminder[], incoming: ActivePlanningReminder[]): ActivePlanningReminder[] {
  const items = new Map(current.map((item) => [item.id, item]))
  for (const item of incoming) items.set(item.id, item)
  return [...items.values()].sort((a, b) => (a.snoozedUntil ?? a.triggerAt) - (b.snoozedUntil ?? b.triggerAt))
}

/** 全局常驻提醒条。未确认提醒从 SQLite 恢复，不依赖一次性 toast 生命周期。 */
export function PlanningReminderRail({ playSound = true }: { playSound?: boolean } = {}): React.ReactElement | null {
  const [reminders, setReminders] = useAtom(activePlanningRemindersAtom)
  const setActiveView = useSetAtom(activeViewAtom)
  const setAgentSessions = useSetAtom(agentSessionsAtom)
  const setCurrentWorkspaceId = useSetAtom(currentAgentWorkspaceIdAtom)
  const agentWorkspaces = useAtomValue(agentWorkspacesAtom)
  const agentChannelId = useAtomValue(agentChannelIdAtom)
  const agentModelId = useAtomValue(agentModelIdAtom)
  const openSession = useOpenSession()
  const notificationsEnabled = useAtomValue(notificationsEnabledAtom)
  const soundEnabled = useAtomValue(notificationSoundEnabledAtom)
  const sounds = useAtomValue(notificationSoundsAtom)

  const load = React.useCallback(async () => {
    try {
      const nextReminders = await window.electronAPI.listActivePlanningReminders()
      setReminders(Array.isArray(nextReminders) ? nextReminders : [])
    } catch (error) {
      console.error('[任务/日程] 加载常驻提醒失败:', error)
    }
  }, [setReminders])

  React.useEffect(() => {
    void load()
    const unsubscribeDue = window.electronAPI.onPlanningRemindersDue((due) => {
      setReminders((current) => mergeReminders(current, due))
      if (playSound && notificationsEnabled && soundEnabled && due.length > 0) {
        void playNotificationSoundForType('planningReminder', sounds)
      }
    })
    const unsubscribeChanged = window.electronAPI.onPlanningChanged((change) => {
      if (change.resources.includes('reminders')) void load()
    })
    return () => { unsubscribeDue(); unsubscribeChanged() }
  }, [load, notificationsEnabled, playSound, setReminders, soundEnabled, sounds])

  const acknowledge = async (id: string) => {
    try {
      await window.electronAPI.acknowledgePlanningReminder(id)
    } catch (error) {
      console.error('[任务/日程] 确认提醒失败:', error)
      toast.error('确认提醒失败')
    }
  }
  const openWorkspaceConversation = async (reminder: ActivePlanningReminder): Promise<void> => {
    if (!reminder.workspaceId) {
      toast.error('该提醒没有绑定工作区')
      return
    }
    const workspace = agentWorkspaces.find((item) => item.id === reminder.workspaceId)
    if (!workspace) {
      toast.error('绑定的工作区已不可用')
      return
    }
    try {
      const session = await window.electronAPI.createAgentSession(
        `提醒：${reminder.targetTitle}`,
        agentChannelId ?? undefined,
        workspace.id,
        agentModelId ?? undefined,
      )
      setAgentSessions((current) => [session, ...current])
      setCurrentWorkspaceId(workspace.id)
      window.electronAPI.updateSettings({ agentWorkspaceId: workspace.id }).catch(console.error)
      openSession('agent', session.id, session.title)
      setActiveView('conversations')
    } catch (error) {
      console.error('[任务/日程] 打开提醒会话失败:', error)
      toast.error('打开提醒会话失败')
    }
  }

  const snooze = async (id: string, minutes: number) => {
    try {
      await window.electronAPI.snoozePlanningReminder({ id, minutes })
    } catch (error) {
      console.error('[任务/日程] 推迟提醒失败:', error)
      toast.error('推迟提醒失败')
    }
  }

  if (reminders.length === 0) return null

  return (
    <aside className="fixed right-4 top-16 z-[100] flex w-[min(380px,calc(100vw-2rem))] flex-col gap-2" aria-live="polite">
      {reminders.slice(0, 3).map((reminder) => {
        return (
          <section key={reminder.id} className="bg-background shadow-lg">
            <div className="flex items-start gap-3 px-3 py-3">
              <BellRing className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <div className="flex items-start justify-between gap-2">
                  <p className="truncate text-sm font-medium">{reminder.targetTitle}</p>
                  <span className="shrink-0 text-xs text-muted-foreground">{formatTriggerTime(reminder.snoozedUntil ?? reminder.triggerAt)}</span>
                </div>
                <div className="mt-1 flex flex-wrap gap-1.5 text-xs text-muted-foreground">
                  <span>{reminder.targetType === 'todo' ? '任务提醒' : '日程'}</span>
                  {reminder.workspaceId && <span>{agentWorkspaces.find((workspace) => workspace.id === reminder.workspaceId)?.name ?? '工作区不可用'}</span>}
                  {reminder.tags.map((tag) => <span key={tag.id}>#{tag.name}</span>)}
                </div>
              </div>
              <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={() => void acknowledge(reminder.id)} aria-label="关闭提醒" title="关闭提醒">
                <X className="h-4 w-4" />
              </Button>
            </div>
            <div className="flex flex-wrap items-center gap-1 bg-muted/20 px-3 py-2">
              {reminder.workspaceId && (
                <Button variant="secondary" size="sm" className="h-7" onClick={() => void openWorkspaceConversation(reminder)}>
                  <MessageCircle className="mr-1 h-3.5 w-3.5" />进入对话
                </Button>
              )}
              {[5, 10, 30, 60].map((minutes) => (
                <Button key={minutes} variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => void snooze(reminder.id, minutes)}>
                  {minutes} 分钟
                </Button>
              ))}
            </div>
          </section>
        )
      })}
      {reminders.length > 3 && <p className="px-2 text-right text-xs text-muted-foreground">另有 {reminders.length - 3} 条待处理提醒</p>}
    </aside>
  )
}
