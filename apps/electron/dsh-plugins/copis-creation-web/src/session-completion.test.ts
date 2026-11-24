import { expect, test } from 'bun:test'
import { registerSessionCompletion, type CompletionContext } from './session-completion'

function source<T>(value: T) {
  const listeners = new Set<() => void>()
  return { getSnapshot: () => value, subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } }, set: (next: T) => { value = next; for (const fn of listeners) fn() }, listeners }
}

function fixture() {
  const row = (running: boolean, extra = {}) => ({ id: 'a', title: '测试会话', running, ...extra })
  const list = source({ ids: ['a'], byId: { a: row(false) }, phase: 'ready' })
  const mounted = source<string | undefined>(undefined)
  const events = new EventTarget()
  let focused = false
  let state = { running: false, queue: [] as unknown[], pendingInput: [] as unknown[] }
  let reason = 'completed'
  let seq = 10
  let reads = 0
  let historyGate: Promise<void> | undefined
  const completed: unknown[] = [], viewed: string[] = [], opened: string[] = [], disposers: (() => void)[] = []
  const bridge = { reportSessionCompleted: (value: unknown) => completed.push(value), reportSessionViewed: (id: string) => viewed.push(id), navigate: () => {} }
  const ctx = {
    effect: (fn: () => () => void) => { disposers.push(fn()) }, sessions: { list }, sidebarRight: { mounted }, uiWorkspace: { openSession: (id: string) => opened.push(id) },
    remote: { session: {
      events: async () => { reads++; await historyGate; return { ok: true, value: { records: [{ type: 'event', event: { type: 'turn/end', seq, data: { reason: { kind: reason } } } }] } } },
      state: async () => ({ ok: true, value: state }),
    } },
  } as unknown as CompletionContext
  const host = { events, hasFocus: () => focused, isConversationVisible: () => true }
  registerSessionCompletion(ctx, () => bridge, host)
  const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }
  return { list, mounted, events, row, completed, viewed, opened, flush, disposers,
    focus: (value: boolean) => { focused = value; events.dispatchEvent(new Event('focus')) },
    end: async (kind = 'completed', extra = {}) => { reason = kind; list.set({ ids: ['a'], byId: { a: row(true, extra) }, phase: 'ready' }); list.set({ ids: ['a'], byId: { a: row(false, extra) }, phase: 'ready' }); await flush() },
    state: (value: typeof state) => { state = value }, next: () => { seq++ }, reads: () => reads, gate: (value: Promise<void>) => { historyGate = value },
  }
}

test('Given 已有历史与正常完成的顶层会话 When 状态更新 Then 不重放历史且同一轮只提醒一次', async () => {
  const f = fixture()
  await f.flush(); expect(f.reads()).toBe(0)
  await f.end()
  expect(f.completed).toEqual([{ sessionId: 'a', title: '测试会话', completionSeq: 10, viewed: false, windowFocused: false }])
  f.list.set({ ...f.list.getSnapshot() }); await f.flush()
  expect(f.completed).toHaveLength(1)
  f.next(); await f.end(); expect(f.completed).toHaveLength(2)
})

test('Given 完成状态检查尚未返回 When 会话再次运行或客户端重连 Then 过期检查不能发送提醒', async () => {
  for (const reconnect of [false, true]) {
    const f = fixture()
    let release!: () => void
    f.gate(new Promise<void>((resolve) => { release = resolve }))
    await f.end()
    if (reconnect) f.list.set({ ...f.list.getSnapshot(), phase: 'loading' })
    f.list.set({ ids: ['a'], byId: { a: f.row(true) }, phase: 'ready' })
    release(); await f.flush(); expect(f.completed).toEqual([])
  }
})

test('Given 用户停止、错误、阻塞或截断 When 运行结束 Then 不伪装成成功通知', async () => {
  for (const reason of ['aborted', 'error', 'blocked', 'max-tokens', 'interrupted']) {
    const f = fixture(); await f.end(reason); expect(f.completed).toEqual([])
  }
})

test('Given 子会话、排队消息、待输入或活动目标 When 运行转为空闲 Then 不提前提醒完成', async () => {
  for (const extra of [{ parentId: 'p' }, { origin: 'subagent' }, { projectionValues: { goal: { goal: { phase: 'active' } } } }]) {
    const f = fixture(); await f.end('completed', extra); expect(f.completed).toEqual([])
  }
  for (const state of [{ running: true, queue: [], pendingInput: [] }, { running: false, queue: [1], pendingInput: [] }, { running: false, queue: [], pendingInput: [1] }]) {
    const f = fixture(); f.state(state); await f.end(); expect(f.completed).toEqual([])
  }
})

test('Given 官方 goal 投影已标记目标完成 When 顶层轮次成功结束 Then 正常提醒', async () => {
  const f = fixture()
  await f.end('completed', { projectionValues: { goal: { goal: { phase: 'complete' } } } })
  expect(f.completed).toHaveLength(1)
})

test('Given 正在查看该会话 When 正常完成 Then 标为已查看且重新聚焦或切换会话发送查看事件', async () => {
  const f = fixture(); f.focus(true); f.mounted.set('a'); await f.end()
  expect(f.completed).toEqual([{ sessionId: 'a', title: '测试会话', completionSeq: 10, viewed: true, windowFocused: true }])
  expect(f.viewed).toContain('a')
  f.focus(false); const count = f.viewed.length; f.mounted.set('b')
  expect(f.viewed).toHaveLength(count)
  f.focus(true); expect(f.viewed.at(-1)).toBe('b')
})

test('Given 已完成会话从列表删除 When 旧通知尝试导航 Then 清除其角标且不打开不存在的会话', async () => {
  const f = fixture(); await f.end()
  f.list.set({ ids: [], byId: {} as any, phase: 'ready' })
  expect(f.viewed).toContain('a')
  const event = new Event('message') as MessageEvent
  Object.defineProperty(event, 'data', { value: { type: 'COPIS_DSH_OPEN_SESSION', sessionId: 'a' } })
  f.events.dispatchEvent(event); expect(f.opened).toEqual([])
})

test('Given 通知导航和插件卸载 When 接收导航或继续状态变化 Then 使用官方入口并释放所有监听', async () => {
  const f = fixture()
  const event = new Event('message') as MessageEvent
  Object.defineProperty(event, 'data', { value: { type: 'COPIS_DSH_OPEN_SESSION', sessionId: 'a' } })
  f.events.dispatchEvent(event); expect(f.opened).toEqual(['a'])
  for (const dispose of f.disposers) dispose()
  expect(f.list.listeners.size).toBe(0); expect(f.mounted.listeners.size).toBe(0)
  await f.end(); expect(f.completed).toEqual([])
})
