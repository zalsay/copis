import { registerSessionCompletion, type CompletionContext } from '../session-completion'

async function runCompletionCases() {
  const listeners = new Set<() => void>()
  const disposers: (() => void)[] = []
  const opened: string[] = []
  const row = { id: 'native-test', title: 'Electron 完成回归', running: false }
  let reason = 'completed'
  let seq = 10
  const ctx: CompletionContext = {
    effect: register => { disposers.push(register()) },
    sessions: { list: {
      getSnapshot: () => ({ ids: [row.id], byId: { [row.id]: row }, phase: 'ready' }),
      subscribe: fn => { listeners.add(fn); return () => { listeners.delete(fn) } },
    } },
    sidebarRight: { mounted: { getSnapshot: () => undefined, subscribe: () => () => {} } },
    uiWorkspace: { openSession: id => { opened.push(id) } },
    remote: { session: {
      events: async () => ({ ok: true, value: { records: [{ event: { type: 'turn/end', seq, data: { reason: { kind: reason } } } }] } }),
      state: async () => ({ ok: true, value: { running: false, queue: [], pendingInput: [] } }),
    } },
  }
  registerSessionCompletion(ctx, () => (window as any).copisBridge)
  for (const result of ['completed', 'completed', 'aborted', 'error']) {
    reason = result
    if (result !== 'completed') seq++
    for (const running of [true, false]) {
      row.running = running
      for (const listener of listeners) listener()
    }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  Object.assign(window, {
    completionOpened: opened,
    disposeCompletion: () => { for (const dispose of disposers) dispose(); return listeners.size },
  })
}
Object.assign(window, { runCompletionCases })
