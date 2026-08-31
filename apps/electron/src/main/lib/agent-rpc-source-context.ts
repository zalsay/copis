import type { AgentExternalRunSource } from '@copis/shared'

interface TrustedSourceEntry {
  token: symbol
  source: AgentExternalRunSource
}

/**
 * 外部桥接运行期间的可信来源上下文。
 *
 * 来源不通过 RPC 请求体传递，避免 renderer 或本地 HTTP 调用方伪造连接器身份；
 * 只在主进程 runAgentHeadless 的 Promise 生命周期内生效。
 */
const trustedSources = new Map<string, TrustedSourceEntry[]>()

export function registerTrustedAgentExternalSource(
  sessionId: string,
  source: AgentExternalRunSource,
): () => void {
  const entries = trustedSources.get(sessionId) ?? []
  const entry: TrustedSourceEntry = { token: Symbol('trusted-agent-source'), source }
  entries.push(entry)
  trustedSources.set(sessionId, entries)

  return () => {
    const currentEntries = trustedSources.get(sessionId)
    if (!currentEntries) return
    const index = currentEntries.findIndex((candidate) => candidate.token === entry.token)
    if (index === -1) return
    currentEntries.splice(index, 1)
    if (currentEntries.length === 0) trustedSources.delete(sessionId)
  }
}

export function getTrustedAgentExternalSource(sessionId: string): AgentExternalRunSource | undefined {
  const entries = trustedSources.get(sessionId)
  return entries?.[entries.length - 1]?.source
}
