import * as React from 'react'
import { AgentView } from './AgentView'

export interface AgentQuestionViewProps {
  sessionId: string
}

/** 右侧 Agent 问答子会话，复用完整 Agent Composer/流式消息链路的紧凑视图。 */
export function AgentQuestionView({ sessionId }: AgentQuestionViewProps): React.ReactElement {
  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-hidden">
      <AgentView sessionId={sessionId} compact />
    </div>
  )
}
