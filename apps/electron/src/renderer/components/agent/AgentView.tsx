/**
 * AgentView 兼容适配器。
 *
 * AgentConversationSurface 承载唯一的会话状态与交互实现；保留 compact 参数
 * 兼容旧的主界面入口，避免旧调用方直接依赖内部实现。
 */

import type { ReactElement } from 'react'
import { AgentConversationSurface } from './AgentConversationSurface'

export interface AgentViewProps {
  sessionId: string
  compact?: boolean
}

export function AgentView({ sessionId, compact = false }: AgentViewProps): ReactElement {
  return (
    <AgentConversationSurface
      sessionId={sessionId}
      variant={compact ? 'browser' : 'main'}
    />
  )
}
