/**
 * Session Context — 为 AgentView 提供 sessionId
 *
 * 避免逐层 props 透传，子组件通过 useAgentSessionId() 获取。
 */

import * as React from 'react'

const AgentSessionContext = React.createContext<string | null>(null)

export function AgentSessionProvider({
  sessionId,
  children,
}: {
  sessionId: string
  children: React.ReactNode
}): React.ReactElement {
  return (
    <AgentSessionContext.Provider value={sessionId}>
      {children}
    </AgentSessionContext.Provider>
  )
}

export function useAgentSessionId(): string {
  const id = React.useContext(AgentSessionContext)
  if (!id) throw new Error('useAgentSessionId 必须在 AgentSessionProvider 内使用')
  return id
}
