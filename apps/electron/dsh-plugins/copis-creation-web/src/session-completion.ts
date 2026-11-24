interface Observable<T> {
  getSnapshot(): T
  subscribe(listener: () => void): () => void
}

interface SessionRow {
  id: string
  title?: string
  displayTitle?: string
  running: boolean
  parentId?: string
  origin?: string
  projectionValues?: { goal?: { goal: { phase: string } } | null }
}

export interface SessionCompletion {
  sessionId: string
  title: string
  completionSeq: number
  viewed: boolean
  windowFocused: boolean
}

export interface CompletionBridge {
  reportSessionCompleted?(completion: SessionCompletion): void
  reportSessionViewed?(sessionId: string): void
  navigate?(view: string): void
}

type RemoteResult<T> = { ok: true; value: T } | { ok: false }
export interface CompletionContext {
  effect(register: () => () => void): unknown
  sessions: { list: Observable<{ ids?: string[]; byId?: Record<string, SessionRow>; phase?: string }> }
  remote: { session: {
    events(request: { address: { kind: 'session'; sessionId: string }; maxMessages: number }, signal: AbortSignal): Promise<RemoteResult<{ records: { event: { type: string; seq: number; data: { reason?: { kind: string } } } }[] }>>
    state(request: { sessionId: string }, signal: AbortSignal): Promise<RemoteResult<{ running: boolean; queue: readonly unknown[] | null; pendingInput: readonly unknown[] }>>
  } }
  sidebarRight: { mounted: Observable<string | undefined> }
  uiWorkspace: { openSession(id: string): void }
}

interface CompletionHost {
  events: EventTarget
  hasFocus(): boolean
  isConversationVisible(): boolean
}

/** 只在本次客户端实际观察到运行结束后做被动读取，不打开历史会话或唤醒 Agent。 */
export function registerSessionCompletion(
  ctx: CompletionContext,
  getBridge: () => CompletionBridge | undefined,
  host: CompletionHost = {
    events: window,
    hasFocus: () => document.hasFocus(),
    isConversationVisible: () => !document.hidden && !document.body?.classList.contains('copis-subview-active'),
  },
): void {
  ctx.effect(() => {
    const controller = new AbortController()
    const previous = new Map<string, boolean>()
    const generations = new Map<string, number>()
    const delivered = new Map<string, number>()
    let generationCounter = 0
    const isViewed = (id: string) => host.hasFocus() && host.isConversationVisible() && ctx.sidebarRight.mounted.getSnapshot() === id
    const acknowledge = () => {
      const id = ctx.sidebarRight.mounted.getSnapshot()
      if (id && isViewed(id)) getBridge()?.reportSessionViewed?.(id)
    }
    const inspect = async (id: string, generation: number) => {
      try {
        const history = await ctx.remote.session.events({ address: { kind: 'session', sessionId: id }, maxMessages: 1 }, controller.signal)
        if (!history.ok) return
        const end = history.value.records.findLast(({ event }) => event.type === 'turn/end')?.event
        if (!end || end.data.reason?.kind !== 'completed' || end.seq <= (delivered.get(id) ?? -1)) return
        const state = await ctx.remote.session.state({ sessionId: id }, controller.signal)
        const row = ctx.sessions.list.getSnapshot().byId?.[id]
        if (controller.signal.aborted || generations.get(id) !== generation || !row || row.running || !state.ok
          || state.value.running || state.value.queue?.length || state.value.pendingInput.length
          || (row.projectionValues?.goal && row.projectionValues.goal.goal.phase !== 'complete')) return
        delivered.set(id, end.seq)
        getBridge()?.reportSessionCompleted?.({
          sessionId: id, title: row.title || row.displayTitle || '创造模式会话', completionSeq: end.seq,
          viewed: isViewed(id), windowFocused: host.hasFocus(),
        })
      } catch {
        if (!controller.signal.aborted) console.warn('[创造模式通知] 无法确认会话完成状态，已跳过本次提醒')
      }
    }
    const observe = () => {
      const snapshot = ctx.sessions.list.getSnapshot()
      // 初始化只记录当前运行状态，不把已有历史当作新完成事件。
      if (snapshot.phase && snapshot.phase !== 'ready') { previous.clear(); generations.clear(); return }
      const ids = new Set(snapshot.ids ?? Object.keys(snapshot.byId ?? {}))
      for (const id of previous.keys()) {
        if (!ids.has(id)) {
          previous.delete(id); generations.delete(id); delivered.delete(id)
          getBridge()?.reportSessionViewed?.(id)
        }
      }
      for (const id of ids) {
        const row = snapshot.byId?.[id]
        if (!row || row.parentId || row.origin === 'subagent') continue
        const wasRunning = previous.get(id)
        previous.set(id, row.running)
        if (wasRunning !== row.running) generations.set(id, ++generationCounter)
        if (wasRunning && !row.running) void inspect(id, generations.get(id)!)
      }
    }
    const onMessage = (event: Event) => {
      const data = (event as MessageEvent).data
      if (data?.type === 'COPIS_DSH_OPEN_SESSION' && typeof data.sessionId === 'string' && ctx.sessions.list.getSnapshot().byId?.[data.sessionId]) {
        ctx.uiWorkspace.openSession(data.sessionId)
        getBridge()?.navigate?.('conversations')
      }
      acknowledge()
    }
    const stopList = ctx.sessions.list.subscribe(observe)
    const stopMounted = ctx.sidebarRight.mounted.subscribe(acknowledge)
    host.events.addEventListener('focus', acknowledge)
    host.events.addEventListener('message', onMessage)
    observe()
    acknowledge()
    return () => {
      controller.abort()
      stopList(); stopMounted()
      host.events.removeEventListener('focus', acknowledge)
      host.events.removeEventListener('message', onMessage)
    }
  })
}
