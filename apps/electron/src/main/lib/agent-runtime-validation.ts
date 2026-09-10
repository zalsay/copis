import type { AgentRuntime } from '@copis/shared'

export function isAgentRuntime(value: unknown): value is AgentRuntime {
  return value === 'pi' || value === 'dsh'
}
