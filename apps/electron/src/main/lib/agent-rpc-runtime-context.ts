import { CHATROOM_MAX_DEPTH, type ChatRoomAgentRuntimeContext } from '@copis/shared'

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

function trustedContextError(): Error {
  return new Error('trustedRuntimeContext 不可信')
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function assertNonEmptyString(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '') throw trustedContextError()
}

function assertExactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
  const allowed = new Set([...required, ...optional])
  const keys = Reflect.ownKeys(value)
  if (keys.some((key) => typeof key !== 'string' || !allowed.has(key))) throw trustedContextError()
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) throw trustedContextError()
  }
}

function assertDataProperties(value: object): void {
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') throw trustedContextError()
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !('value' in descriptor) || descriptor.get || descriptor.set) throw trustedContextError()
  }
}

function assertPlainArray(value: unknown): asserts value is unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) throw trustedContextError()
  assertDataProperties(value)
  for (const key of Reflect.ownKeys(value)) {
    if (key === 'length') continue
    if (typeof key !== 'string' || !/^\d+$/.test(key) || Number(key) >= value.length) throw trustedContextError()
  }
}

function validateRuntimeContext(context: unknown): asserts context is ChatRoomAgentRuntimeContext {
  try {
    if (!isPlainObject(context)) throw trustedContextError()
    assertDataProperties(context)
    assertExactKeys(context, ['executionWorkspace', 'permissionContext'], ['memorySource', 'skillSnapshotPath'])

    const execution = context.executionWorkspace
    if (!isPlainObject(execution)) throw trustedContextError()
    assertDataProperties(execution)
    assertExactKeys(execution, ['root', 'projectRoot', 'inboxRoot', 'sessionRoot'])
    assertNonEmptyString(execution.root)
    assertNonEmptyString(execution.projectRoot)
    assertNonEmptyString(execution.inboxRoot)
    assertNonEmptyString(execution.sessionRoot)

    if (context.memorySource !== undefined) {
      if (!isPlainObject(context.memorySource)) throw trustedContextError()
      assertDataProperties(context.memorySource)
      assertExactKeys(context.memorySource, ['workspaceSlug', 'policy'])
      assertNonEmptyString(context.memorySource.workspaceSlug)
      if (context.memorySource.policy !== 'visible') throw trustedContextError()
    }
    if (context.skillSnapshotPath !== undefined) assertNonEmptyString(context.skillSnapshotPath)

    const permission = context.permissionContext
    if (!isPlainObject(permission)) throw trustedContextError()
    assertDataProperties(permission)
    assertExactKeys(permission, ['roomId', 'roomAgentId', 'invocationId', 'traceId', 'originalSender', 'invocationChain'])
    for (const key of ['roomId', 'roomAgentId', 'invocationId', 'traceId']) assertNonEmptyString(permission[key])

    const sender = permission.originalSender
    if (!isPlainObject(sender)) throw trustedContextError()
    assertDataProperties(sender)
    assertExactKeys(sender, ['type', 'id', 'displayName'])
    if (sender.type !== 'user' && sender.type !== 'agent') throw trustedContextError()
    assertNonEmptyString(sender.id)
    assertNonEmptyString(sender.displayName)

    assertPlainArray(permission.invocationChain)
    if (permission.invocationChain.length > CHATROOM_MAX_DEPTH) throw trustedContextError()
    for (const item of permission.invocationChain) {
      if (!isPlainObject(item)) throw trustedContextError()
      assertDataProperties(item)
      assertExactKeys(item, ['agentId', 'invocationId'])
      assertNonEmptyString(item.agentId)
      assertNonEmptyString(item.invocationId)
    }
  } catch (error) {
    if (error instanceof Error && error.message === 'trustedRuntimeContext 不可信') throw error
    throw trustedContextError()
  }
}

function cloneAndFreeze<T>(value: T, seen = new WeakMap<object, unknown>()): T {
  if (value === null || typeof value !== 'object') return value
  const objectValue = value as object
  const existing = seen.get(objectValue)
  if (existing) return existing as T

  let copy: Record<string, unknown> | unknown[]
  try {
    copy = Array.isArray(value) ? [] : Object.create(null) as Record<string, unknown>
    seen.set(objectValue, copy)
    for (const key of Reflect.ownKeys(objectValue)) {
      if (typeof key !== 'string') throw trustedContextError()
      const descriptor = Object.getOwnPropertyDescriptor(objectValue, key)
      if (!descriptor || !('value' in descriptor) || descriptor.get || descriptor.set) throw trustedContextError()
      const child = cloneAndFreeze(descriptor.value, seen)
      Object.defineProperty(copy, key, { value: child, enumerable: descriptor.enumerable, configurable: false, writable: false })
    }
    Object.freeze(copy)
    return copy as T
  } catch (error) {
    if (error instanceof Error && error.message === 'trustedRuntimeContext 不可信') throw error
    throw trustedContextError()
  }
}

export function registerTrustedAgentRuntimeContext(
  sessionId: string,
  context: ChatRoomAgentRuntimeContext,
): () => void {
  if (!sessionId.trim()) throw new Error('sessionId 不能为空')
  validateRuntimeContext(context)
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
