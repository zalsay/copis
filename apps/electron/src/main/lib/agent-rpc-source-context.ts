import type { AgentExternalRunSource } from '@copis/shared'

interface TrustedSourceEntry {
  token: symbol
  runId?: string
  source: AgentExternalRunSource
}

/**
 * 外部桥接运行期间的可信来源上下文。
 *
 * 来源不通过 RPC 请求体传递，避免 renderer 或本地 HTTP 调用方伪造连接器身份；
 * 只在主进程 runAgentHeadless 的 Promise 生命周期内生效。
 */
const trustedSources = new Map<string, TrustedSourceEntry[]>()
interface TrustedAgentRunEntry { token: symbol; runId: string; signal?: AbortSignal }
const trustedAgentRuns = new Map<string, TrustedAgentRunEntry[]>()

export function registerTrustedAgentRpcRun(
  sessionId: string,
  runId: string,
  signal?: AbortSignal,
): () => void {
  if (!sessionId.trim() || !runId.trim()) throw new Error('Agent RPC run identity 不正确')
  const entry: TrustedAgentRunEntry = { token: Symbol('trusted-agent-rpc-run'), runId, signal }
  const entries = trustedAgentRuns.get(sessionId) ?? []
  entries.push(entry)
  trustedAgentRuns.set(sessionId, entries)
  let released = false
  const release = () => {
    if (released) return
    released = true
    signal?.removeEventListener('abort', release)
    const current = trustedAgentRuns.get(sessionId)
    if (!current) return
    const index = current.findIndex((candidate) => candidate.token === entry.token)
    if (index === -1) return
    current.splice(index, 1)
    if (current.length === 0) trustedAgentRuns.delete(sessionId)
  }
  if (signal?.aborted) release()
  else signal?.addEventListener('abort', release, { once: true })
  return release
}

export function hasTrustedAgentRpcRun(sessionId: string, runId: string): boolean {
  return trustedAgentRuns.get(sessionId)?.some((entry) => entry.runId === runId && !entry.signal?.aborted) === true
}

export function registerTrustedAgentExternalSource(
  sessionId: string,
  source: AgentExternalRunSource,
  options: { runId?: string; signal?: AbortSignal } = {},
): () => void {
  const entries = trustedSources.get(sessionId) ?? []
  const entry: TrustedSourceEntry = {
    token: Symbol('trusted-agent-source'),
    ...(options.runId ? { runId: options.runId } : {}),
    source,
  }
  entries.push(entry)
  trustedSources.set(sessionId, entries)

  let released = false
  const release = () => {
    if (released) return
    released = true
    options.signal?.removeEventListener('abort', release)
    const currentEntries = trustedSources.get(sessionId)
    if (!currentEntries) return
    const index = currentEntries.findIndex((candidate) => candidate.token === entry.token)
    if (index === -1) return
    currentEntries.splice(index, 1)
    if (currentEntries.length === 0) trustedSources.delete(sessionId)
  }
  if (options.signal?.aborted) release()
  else options.signal?.addEventListener('abort', release, { once: true })
  return release
}

export function getTrustedAgentExternalSource(sessionId: string, runId?: string): AgentExternalRunSource | undefined {
  const entries = trustedSources.get(sessionId)
  if (runId) return entries?.find((entry) => entry.runId === runId)?.source
  return entries?.[entries.length - 1]?.source
}
