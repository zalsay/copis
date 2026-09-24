import * as React from 'react'
import type { ChatRoomInvocation, ChatRoomMessage } from '@copis/shared'
import type { ChatRoomSendState } from '@/atoms/chatroom-atoms'
import { chatRoomExpirePendingInvocationAtom } from '@/atoms/chatroom-atoms'
import { useSetAtom } from 'jotai'
import { AgentRunningIndicator } from '../agent/AgentRunningIndicator'

const CALL_CONFIRMATION_TIMEOUT_MS = 60_000

/** 仅为本机刚提交的提及构造临时显示项，不创建或排队真实调用。 */
export function getPendingChatRoomInvocations(roomId: string, sends: Iterable<ChatRoomSendState>, messages: ChatRoomMessage[], invocations: ChatRoomInvocation[]): ChatRoomInvocation[] {
  return [...sends].filter((send) => send.roomId === roomId && send.status !== 'failed').flatMap((send) => {
    const message = messages.find((item) => item.clientMessageId === send.clientMessageId && item.senderType === 'user')
    const triggerMessageId = send.messageId || message?.messageId || ''
    return send.mentionAgentIds.filter((targetAgentId) => {
      if (invocations.some((item) => item.invocationId === `pending:${send.clientMessageId}:${targetAgentId}`)) return false
      if (!triggerMessageId) return true
      return !invocations.some((item) => item.targetAgentId === targetAgentId && item.triggerMessageId === triggerMessageId)
        && !messages.some((item) => item.senderType === 'agent' && item.senderId === targetAgentId && item.parentMessageId === triggerMessageId)
    }).map((targetAgentId) => ({ invocationId: `pending:${send.clientMessageId}:${targetAgentId}`, roomId, triggerMessageId, targetAgentId, traceId: message?.traceId ?? '', depth: 0, status: 'created' as const, startedAt: send.startedAt }))
  })
}

const FAILURE_LABELS: Record<string, string> = {
  agent_offline: 'Agent 离线，不排队', lease_expired: 'Agent 租约已过期，本次未执行',
  agent_busy: 'Agent 正在处理其他消息，本次未执行', agent_disabled: 'Agent 已禁用',
  gateway_disconnected: '实时连接已断开', internal_error: 'Agent 执行失败',
  host_approval_denied: '主理人拒绝了操作', host_approval_timeout: '等待主理人授权超时',
  invalid_output: 'Agent 返回内容无效', room_agent_not_found: 'Agent 不在当前聊天室',
  invocation_depth_exceeded: '已停止继续唤起：达到调用深度上限', depth_limit: '已停止继续唤起：达到调用深度上限',
  invocation_duplicate: '已停止继续唤起：同一链路不重复调用', app_quit: '主理人客户端已退出',
  invocation_unconfirmed: '未收到 Agent 调用确认，请检查主理人连接状态',
}

export function ChatroomAgentActivity({ invocation, connectionStatus }: { invocation: ChatRoomInvocation; connectionStatus: string }): React.ReactElement {
  const expirePending = useSetAtom(chatRoomExpirePendingInvocationAtom)
  const [fallbackStart] = React.useState(() => Date.now())
  const startedAt = invocation.startedAt ?? fallbackStart
  const [now, setNow] = React.useState(() => Date.now())
  const active = ['created', 'accepted', 'running'].includes(invocation.status)
  const timedOut = invocation.status === 'created' && now - startedAt >= CALL_CONFIRMATION_TIMEOUT_MS
  React.useEffect(() => {
    if (invocation.status !== 'created') return
    const expire = (): void => {
      setNow(Date.now())
      expirePending(invocation)
    }
    const remaining = startedAt + CALL_CONFIRMATION_TIMEOUT_MS - Date.now()
    if (remaining <= 0) { expire(); return }
    const timer = setTimeout(expire, remaining)
    return () => clearTimeout(timer)
  }, [invocation, startedAt, expirePending])
  if (invocation.status === 'completed') return <span>已完成</span>
  if (!active) return <span className="text-destructive">{FAILURE_LABELS[invocation.failureCode ?? ''] ?? `调用失败${invocation.failureCode ? `（${invocation.failureCode}）` : ''}`}</span>
  if (timedOut) return <span className="text-destructive">未收到 Agent 调用确认，请检查主理人连接状态</span>
  if (connectionStatus !== 'connected') return <span className="text-muted-foreground">连接中断，等待状态同步</span>
  return <AgentRunningIndicator startedAt={startedAt} label={invocation.status === 'created' ? '正在唤起' : '正在思考'} />
}
