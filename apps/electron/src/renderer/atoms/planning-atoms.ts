import { atom } from 'jotai'
import type { ActivePlanningReminder, CalendarEvent, PlanningGroup, PlanningTag, Todo } from '@copis/shared'

export type PlanningTab = 'schedule' | 'calendar' | 'automations'

export const todosAtom = atom<Todo[]>([])
export const calendarEventsAtom = atom<CalendarEvent[]>([])
export const todoPlanningGroupsAtom = atom<PlanningGroup[]>([])
export const planningTagsAtom = atom<PlanningTag[]>([])
export const activePlanningRemindersAtom = atom<ActivePlanningReminder[]>([])
export const planningTabAtom = atom<PlanningTab>('schedule')
/** 外部入口指定要在日历编辑器中打开的日程。 */
export const planningSelectedCalendarEventIdAtom = atom<string | null>(null)
/** 页头等外部入口递增该值，日历工作区收到后打开创建表单。 */
export const planningCalendarCreateRequestAtom = atom(0)
