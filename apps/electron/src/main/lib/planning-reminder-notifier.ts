/**
 * 日程提醒的外部 Bridge 通知。
 *
 * 工作区是唯一的路由键：只通知当前绑定在该工作区的微信和飞书聊天，
 * 这样用户回复提醒时会继续进入该工作区现有的 Agent 会话。
 */

import type { ActivePlanningReminder } from '@copis/shared'
import { getAgentWorkspace } from './agent-workspace-manager'
import { feishuBridgeManager } from './feishu-bridge-manager'
import { redactSensitiveLogValue } from './bridge-log-redaction'
import { wechatBridge } from './wechat-bridge'

function formatReminderTime(timestamp: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(timestamp)
}

function buildReminderText(reminder: ActivePlanningReminder, workspaceName: string): string {
  const kind = reminder.targetType === 'todo' ? 'Todo' : '日程'
  return [
    `${kind}提醒`,
    `标题：${reminder.targetTitle}`,
    `时间：${formatReminderTime(reminder.snoozedUntil ?? reminder.triggerAt)}`,
    `工作区：${workspaceName}`,
    '',
    '请继续发送消息，后续对话将进入该工作区的当前会话。',
  ].join('\n')
}

function buildFeishuReminderCard(reminder: ActivePlanningReminder, workspaceName: string): Record<string, unknown> {
  const kind = reminder.targetType === 'todo' ? 'Todo' : '日程'
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: `${kind}提醒` },
      template: 'blue',
    },
    elements: [{
      tag: 'markdown',
      content: [
        `**${reminder.targetTitle}**`,
        `时间：${formatReminderTime(reminder.snoozedUntil ?? reminder.triggerAt)}`,
        `工作区：${workspaceName}`,
        '',
        '请继续发送消息，后续对话将进入该工作区的当前会话。',
      ].join('\n'),
    }],
  }
}

async function notifyOneReminder(reminder: ActivePlanningReminder): Promise<void> {
  if (!reminder.workspaceId) return

  const workspaceName = getAgentWorkspace(reminder.workspaceId)?.name ?? '目标工作区'
  const text = buildReminderText(reminder, workspaceName)
  const wechatTargets = wechatBridge.listBindings().filter((binding) => binding.workspaceId === reminder.workspaceId)
  const feishuTargets = feishuBridgeManager.listAllBindings().filter((binding) => (
    binding.workspaceId === reminder.workspaceId
    && binding.archived !== true
    && binding.source !== 'session-mirror'
  ))

  await Promise.all([
    ...wechatTargets.map(async (binding) => {
      try {
        await wechatBridge.sendTextToChat(binding.chatId, text)
      } catch (error) {
        console.error(`[任务/日程] 微信提醒发送失败 (${binding.chatId.slice(0, 8)}...):`, redactSensitiveLogValue(error))
      }
    }),
    ...feishuTargets.map(async (binding) => {
      try {
        await feishuBridgeManager.sendCardToChat(binding.botId, binding.chatId, buildFeishuReminderCard(reminder, workspaceName))
      } catch (error) {
        console.error(`[任务/日程] 飞书提醒发送失败 (${binding.chatId.slice(0, 8)}...):`, redactSensitiveLogValue(error))
      }
    }),
  ])
}

export async function notifyPlanningReminders(reminders: ActivePlanningReminder[]): Promise<void> {
  await Promise.all(reminders.map((reminder) => notifyOneReminder(reminder)))
}
