import type { BrowserWorkflowStatus } from '@copis/shared'

export type BrowserWorkflowToolbarAction = 'stop-recording' | 'open-agent'

export interface BrowserAgentContextRequest {
  requestId: number
  sessionId: string
  tabId: string
  pageUrl: string
}

export interface BrowserAgentTarget {
  tabId: string
  pageUrl: string
}

export function shouldFinalizeBrowserAgentUnmount(
  cleanupGeneration: number,
  currentGeneration: number,
  isMounted: boolean,
): boolean {
  return cleanupGeneration === currentGeneration && !isMounted
}

export interface BrowserAgentBindingResult {
  generation: number
  sessionId: string
  tabId: string
  status: BrowserWorkflowStatus
}

interface BrowserAgentBindingOperations {
  bindContext: (sessionId: string, tabId: string) => Promise<BrowserWorkflowStatus>
  unbindContext: (sessionId: string) => Promise<void>
}

export interface BrowserAgentBindingQueue {
  bind: (sessionId: string, tabId: string) => Promise<BrowserAgentBindingResult>
  runAfterPending: <T>(operation: () => Promise<T>) => Promise<T>
  unbindIfCurrent: (binding: BrowserAgentBindingResult) => Promise<boolean>
  unbindAfterPending: (sessionId: string) => Promise<void>
}

export function createBrowserAgentBindingQueue(
  operations: BrowserAgentBindingOperations,
): BrowserAgentBindingQueue {
  let generation = 0
  const latestGenerationBySession = new Map<string, number>()
  let pending: Promise<void> = Promise.resolve()

  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = pending.then(operation, operation)
    pending = result.then(() => undefined, () => undefined)
    return result
  }

  return {
    bind(sessionId, tabId) {
      const bindingGeneration = generation + 1
      generation = bindingGeneration
      latestGenerationBySession.set(sessionId, bindingGeneration)
      return enqueue(async () => ({
        generation: bindingGeneration,
        sessionId,
        tabId,
        status: await operations.bindContext(sessionId, tabId),
      }))
    },
    runAfterPending(operation) {
      return enqueue(operation)
    },
    unbindIfCurrent(binding) {
      if (binding.generation !== latestGenerationBySession.get(binding.sessionId)) return Promise.resolve(false)
      return enqueue(async () => {
        if (binding.generation !== latestGenerationBySession.get(binding.sessionId)) return false
        await operations.unbindContext(binding.sessionId)
        if (binding.generation === latestGenerationBySession.get(binding.sessionId)) {
          latestGenerationBySession.delete(binding.sessionId)
        }
        return true
      })
    },
    unbindAfterPending(sessionId) {
      const bindingGeneration = latestGenerationBySession.get(sessionId)
      return enqueue(async () => {
        await operations.unbindContext(sessionId)
        if (bindingGeneration === latestGenerationBySession.get(sessionId)) {
          latestGenerationBySession.delete(sessionId)
        }
      })
    },
  }
}

export function isCurrentBrowserAgentContextRequest(
  request: BrowserAgentContextRequest,
  latestRequest: BrowserAgentContextRequest | null,
  isMounted: boolean,
  currentTarget: BrowserAgentTarget,
): boolean {
  return isMounted
    && latestRequest !== null
    && request.requestId === latestRequest.requestId
    && request.sessionId === latestRequest.sessionId
    && request.tabId === latestRequest.tabId
    && request.pageUrl === latestRequest.pageUrl
    && request.tabId === currentTarget.tabId
    && request.pageUrl === currentTarget.pageUrl
}

export function shouldCommitBrowserAgentAction(
  requestId: number,
  latestRequestId: number,
  isMounted: boolean,
  requestedTarget: BrowserAgentTarget,
  currentTarget: BrowserAgentTarget,
): boolean {
  return isMounted
    && requestId === latestRequestId
    && requestedTarget.tabId === currentTarget.tabId
    && requestedTarget.pageUrl === currentTarget.pageUrl
}

export function getBrowserWorkflowToolbarAction(status: BrowserWorkflowStatus): BrowserWorkflowToolbarAction {
  if (status.state === 'recording' || (status.state === 'paused_cdp_detached' && !status.run)) {
    return 'stop-recording'
  }
  return 'open-agent'
}
