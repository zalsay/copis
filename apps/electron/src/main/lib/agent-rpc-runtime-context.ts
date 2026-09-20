import type { ChatRoomAgentRuntimeContext } from '@copis/shared'

interface TrustedRuntimeEntry {
  token: symbol
  context: ChatRoomAgentRuntimeContext
}

/**
 * 聊天室运行时能力只存在主进程内，不能从 AgentSendInput、IPC 或 HTTP 请求体恢复。
 * 同一 session 的嵌套调用按栈读取，释放必须带着自己的 token，避免外层 finally
 * 意外释放仍在运行的内层聊天室调用。
 */
const trustedRuntimeContexts = new Map<string, TrustedRuntimeEntry[]>()

function cloneAndFreeze<T>(value: T, seen = new WeakMap<object, unknown>()): T {
  if (value === null || typeof value !== 'object') return value
  const objectValue = value as object
  const existing = seen.get(objectValue)
  if (existing) return existing as T

  const copy: Record<string, unknown> | unknown[] = Array.isArray(value) ? [] : {}
  seen.set(objectValue, copy)
  for (const key of Reflect.ownKeys(objectValue)) {
    if (typeof key !== 'string') continue
    const child = (value as Record<string, unknown>)[key]
    ;(copy as Record<string, unknown>)[key] = cloneAndFreeze(child, seen)
  }
  Object.freeze(copy)
  return copy as T
}

export function registerTrustedAgentRuntimeContext(
  sessionId: string,
  context: ChatRoomAgentRuntimeContext,
): () => void {
  if (!sessionId.trim()) throw new Error('sessionId 不能为空')
  const entry: TrustedRuntimeEntry = {
    token: Symbol('trusted-agent-runtime-context'),
    context: cloneAndFreeze(context),
  }
  const entries = trustedRuntimeContexts.get(sessionId) ?? []
  entries.push(entry)
  trustedRuntimeContexts.set(sessionId, entries)

  let released = false
  return () => {
    if (released) return
    released = true
    const currentEntries = trustedRuntimeContexts.get(sessionId)
    if (!currentEntries) return
    const index = currentEntries.findIndex((candidate) => candidate.token === entry.token)
    if (index < 0) return
    currentEntries.splice(index, 1)
    if (currentEntries.length === 0) trustedRuntimeContexts.delete(sessionId)
  }
}

export function getTrustedAgentRuntimeContext(
  sessionId: string,
): ChatRoomAgentRuntimeContext | undefined {
  const entries = trustedRuntimeContexts.get(sessionId)
  return entries?.[entries.length - 1]?.context
}
