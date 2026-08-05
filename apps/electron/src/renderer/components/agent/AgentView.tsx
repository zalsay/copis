import * as React from 'react'
import {
  AgentConversationSurface,
  type AgentConversationSurfaceVariant,
} from './AgentConversationSurface'

export interface AgentViewProps {
  sessionId: string
  compact?: boolean
}

/**
 * 主 Agent 视图的兼容入口。
 * 新的主界面和网页 Agent 都通过 AgentConversationSurface 共享实现。
 */
export function AgentView({ sessionId, compact = false }: AgentViewProps): React.ReactElement {
  const variant: AgentConversationSurfaceVariant = compact ? 'browser' : 'main'
  return <AgentConversationSurface sessionId={sessionId} variant={variant} />
}
