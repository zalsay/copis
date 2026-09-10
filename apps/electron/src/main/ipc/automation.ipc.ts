import { ipcMain } from 'electron'
import { isAgentRuntime } from '../lib/agent-runtime-validation'
import { AUTOMATION_IPC_CHANNELS } from '@copis/shared'
import type { Automation, CreateAutomationInput, UpdateAutomationInput } from '@copis/shared'
import { runtimeAutomationApiClient } from '../lib/automation-api-client'
import { broadcastChanged as broadcastAutomationsChanged } from '../lib/automation-scheduler'

export function registerAutomationIpcHandlers(): void {
  // ===== 定时任务（Automation）=====

  // 渲染进程可能被注入内容污染（XSS via markdown / MCP tool output），主进程必须自己校验入参,
  // 否则 NaN / -Infinity / 越界值会污染 ~/.copis/automations.json，无法回滚。
  const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.length > 0
  const isNonBlankString = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0
  const isFiniteInt = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v)
  const validScheduleType = (v: unknown): v is 'interval' | 'daily' | 'weekly' | 'monthly' | 'once' =>
    v === 'interval' || v === 'daily' || v === 'weekly' || v === 'monthly' || v === 'once'
  const validPermissionMode = (v: unknown): v is 'bypassPermissions' =>
    v === 'bypassPermissions'
  const validAutomationNotificationTrigger = (v: unknown): v is 'always' | 'success' | 'error' =>
    v === 'always' || v === 'success' || v === 'error'
  const validTimeOfDay = (v: unknown): boolean => typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v)

  const validateAutomationNotificationTargets = (targets: unknown): void => {
    if (targets === undefined) return
    if (!Array.isArray(targets)) throw new Error('notificationTargets 必须是数组')
    if (targets.length > 5) throw new Error('notificationTargets 最多 5 个')

    for (const target of targets) {
      if (!target || typeof target !== 'object') throw new Error('notificationTargets 包含非法目标')
      const t = target as Record<string, unknown>
      if (t.type !== 'feishu') throw new Error(`不支持的通知目标: ${String(t.type)}`)
      if (typeof t.enabled !== 'boolean') throw new Error('notificationTargets.enabled 必须是 boolean')
      if (!validAutomationNotificationTrigger(t.trigger)) {
        throw new Error(`非法的 notificationTargets.trigger: ${String(t.trigger)}`)
      }
      if (!isNonEmptyString(t.botId)) throw new Error('notificationTargets.botId 必填')
      if (!isNonEmptyString(t.chatId)) throw new Error('notificationTargets.chatId 必填')
    }
  }

  const validateAutomationFields = (i: Partial<CreateAutomationInput | UpdateAutomationInput>): void => {
    if (i.scheduleType !== undefined && !validScheduleType(i.scheduleType)) {
      throw new Error(`非法的 scheduleType: ${String(i.scheduleType)}`)
    }
    if (i.intervalMinutes !== undefined && (!isFiniteInt(i.intervalMinutes) || i.intervalMinutes < 1)) {
      throw new Error(`非法的 intervalMinutes: ${String(i.intervalMinutes)}`)
    }
    if (i.timeOfDay !== undefined && !validTimeOfDay(i.timeOfDay)) {
      throw new Error(`非法的 timeOfDay: ${String(i.timeOfDay)}`)
    }
    if (i.dayOfWeek !== undefined && (!isFiniteInt(i.dayOfWeek) || i.dayOfWeek < 0 || i.dayOfWeek > 6)) {
      throw new Error(`非法的 dayOfWeek: ${String(i.dayOfWeek)}`)
    }
    if (i.dayOfMonth !== undefined && (!isFiniteInt(i.dayOfMonth) || i.dayOfMonth < 1 || i.dayOfMonth > 31)) {
      throw new Error(`非法的 dayOfMonth: ${String(i.dayOfMonth)}`)
    }
    if (i.scheduledAt !== undefined && (typeof i.scheduledAt !== 'number' || !Number.isFinite(i.scheduledAt) || i.scheduledAt <= 0)) {
      throw new Error(`非法的 scheduledAt: ${String(i.scheduledAt)}`)
    }
    if (i.maxRuns !== undefined && (!isFiniteInt(i.maxRuns) || i.maxRuns < 1)) {
      throw new Error(`非法的 maxRuns: ${String(i.maxRuns)}`)
    }
    if (i.agentRuntime !== undefined && !isAgentRuntime(i.agentRuntime)) {
      throw new Error(`非法的 agentRuntime: ${String(i.agentRuntime)}`)
    }
    if (i.permissionMode !== undefined && !validPermissionMode(i.permissionMode)) {
      throw new Error(`非法的 permissionMode: ${String(i.permissionMode)}`)
    }
    if (i.sessionMode !== undefined && i.sessionMode !== 'daily' && i.sessionMode !== 'reuse') {
      throw new Error(`非法的 sessionMode: ${String(i.sessionMode)}`)
    }
    validateAutomationNotificationTargets(i.notificationTargets)
  }

  const validateAutomationRuntimePolicy = (
    input: Partial<CreateAutomationInput | UpdateAutomationInput>,
  ): void => {
    // Agent runtime 已统一为 Pi；旧任务会在读取索引时迁移。
    if (input.agentRuntime !== undefined && input.agentRuntime !== 'pi') {
      throw new Error('仅支持 Pi Agent runtime')
    }
  }

  const validateAutomationScheduleComplete = (
    input: Partial<CreateAutomationInput | UpdateAutomationInput>,
    existing?: Automation,
  ): void => {
    const scheduleType = input.scheduleType ?? existing?.scheduleType
    if (scheduleType === 'interval') {
      const intervalMinutes = input.intervalMinutes ?? existing?.intervalMinutes
      if (!isFiniteInt(intervalMinutes) || intervalMinutes < 1) throw new Error('scheduleType=interval 时 intervalMinutes 必填')
    }
    if (scheduleType === 'daily' || scheduleType === 'weekly' || scheduleType === 'monthly') {
      const timeOfDay = input.timeOfDay ?? existing?.timeOfDay
      if (!validTimeOfDay(timeOfDay)) throw new Error('scheduleType=daily/weekly/monthly 时 timeOfDay 必填')
    }
    if (scheduleType === 'weekly') {
      const dayOfWeek = input.dayOfWeek ?? existing?.dayOfWeek
      if (!isFiniteInt(dayOfWeek)) throw new Error('scheduleType=weekly 时 dayOfWeek 必填')
    }
    if (scheduleType === 'monthly') {
      const dayOfMonth = input.dayOfMonth ?? existing?.dayOfMonth
      if (!isFiniteInt(dayOfMonth)) throw new Error('scheduleType=monthly 时 dayOfMonth 必填')
    }
    if (scheduleType === 'once') {
      const scheduledAt = input.scheduledAt ?? existing?.scheduledAt
      if (typeof scheduledAt !== 'number' || !Number.isFinite(scheduledAt) || scheduledAt <= 0) {
        throw new Error('scheduleType=once 时 scheduledAt 必填')
      }
    }
  }

  ipcMain.handle(
    AUTOMATION_IPC_CHANNELS.LIST,
    async (): Promise<Automation[]> => runtimeAutomationApiClient.list()
  )

  ipcMain.handle(
    AUTOMATION_IPC_CHANNELS.CREATE,
    async (_, input: CreateAutomationInput): Promise<Automation> => {
      if (!input || typeof input !== 'object') throw new Error('input 必须是对象')
      if (!isNonEmptyString(input.name)) throw new Error('name 必填')
      if (!isNonEmptyString(input.prompt)) throw new Error('prompt 必填')
      // channelId / workspaceId 允许为空（草稿态），但此时任务不能被启用
      validateAutomationFields(input)
      validateAutomationRuntimePolicy(input)
      validateAutomationScheduleComplete(input)
      const a = await runtimeAutomationApiClient.create(input)
      broadcastAutomationsChanged()
      return a
    }
  )

  ipcMain.handle(
    AUTOMATION_IPC_CHANNELS.UPDATE,
    async (_, input: UpdateAutomationInput): Promise<Automation | undefined> => {
      if (!input || typeof input !== 'object') throw new Error('input 必须是对象')
      if (!isNonEmptyString(input.id)) throw new Error('id 必填')
      if (input.name !== undefined && !isNonBlankString(input.name)) throw new Error('name 不能为空')
      if (input.prompt !== undefined && !isNonBlankString(input.prompt)) throw new Error('prompt 不能为空')
      const existing = await runtimeAutomationApiClient.get(input.id)
      if (!existing) return undefined
      validateAutomationFields(input)
      validateAutomationRuntimePolicy(input)
      validateAutomationScheduleComplete(input, existing)
      const a = await runtimeAutomationApiClient.update(input)
      broadcastAutomationsChanged()
      return a
    }
  )

  ipcMain.handle(
    AUTOMATION_IPC_CHANNELS.DELETE,
    async (_, id: string): Promise<boolean> => {
      if (!isNonEmptyString(id)) throw new Error('id 必填')
      const ok = await runtimeAutomationApiClient.delete(id)
      broadcastAutomationsChanged()
      return ok
    }
  )

  ipcMain.handle(
    AUTOMATION_IPC_CHANNELS.TOGGLE,
    async (_, id: string, active: boolean): Promise<Automation | undefined> => {
      if (!isNonEmptyString(id)) throw new Error('id 必填')
      if (typeof active !== 'boolean') throw new Error('active 必须是 boolean')
      const a = await runtimeAutomationApiClient.update({ id, active })
      broadcastAutomationsChanged()
      return a
    }
  )

  ipcMain.handle(
    AUTOMATION_IPC_CHANNELS.RUN_NOW,
    async (_, id: string): Promise<void> => {
      if (!isNonEmptyString(id)) throw new Error('id 必填')
      await runtimeAutomationApiClient.runNow(id)
    }
  )
}
