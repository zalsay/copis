import type { BrowserPageSnapshot } from '@copis/shared'
import type {
  BrowserCdpMethod,
  BrowserCdpOwner,
  BrowserCdpTarget,
  BrowserPagePort,
  CdpSessionRouter,
} from './browser-page-port'

export * from './browser-page-port'

interface PendingSend {
  port: BrowserPagePortImpl
  generation: number
  reject: (err: Error) => void
}

type TabLifecycleStatus = 'active' | 'replacing' | 'unregistering' | 'detaching' | 'destroyed'

interface TabEntry {
  target: BrowserCdpTarget
  generation: number
  documentEpoch: number
  activeLeases: Set<BrowserPagePortImpl>
  pendingSends: Set<PendingSend>
  cleanupTargetListeners: () => void
  status: TabLifecycleStatus
}

type PortState = 'active' | 'released' | 'invalidated' | 'destroyed' | 'unregistered' | 'disposed'

class BrowserPagePortImpl implements BrowserPagePort {
  readonly tabId: string
  readonly owner: BrowserCdpOwner
  readonly generation: number
  readonly documentEpoch: number

  private state: PortState = 'active'
  private readonly router: CdpSessionRouterImpl
  private readonly messageListeners = new Set<(method: string, params: Record<string, unknown>, sessionId?: string) => void>()
  private readonly detachListeners = new Set<(reason: string) => void>()
  private readonly destroyListeners = new Set<() => void>()

  constructor(
    tabId: string,
    owner: BrowserCdpOwner,
    generation: number,
    documentEpoch: number,
    router: CdpSessionRouterImpl,
  ) {
    this.tabId = tabId
    this.owner = owner
    this.generation = generation
    this.documentEpoch = documentEpoch
    this.router = router
  }

  getSnapshot(): BrowserPageSnapshot {
    this.assertUsable()
    return this.router.getSnapshot(this)
  }

  async send(method: BrowserCdpMethod, params?: Record<string, unknown>, sessionId?: string): Promise<unknown> {
    this.assertUsable()
    return this.router.sendCommand(this, method, params, sessionId)
  }

  onMessage(listener: (method: string, params: Record<string, unknown>, sessionId?: string) => void): () => void {
    this.messageListeners.add(listener)
    return () => {
      this.messageListeners.delete(listener)
    }
  }

  onDetached(listener: (reason: string) => void): () => void {
    this.detachListeners.add(listener)
    return () => {
      this.detachListeners.delete(listener)
    }
  }

  onDestroyed(listener: () => void): () => void {
    this.destroyListeners.add(listener)
    return () => {
      this.destroyListeners.delete(listener)
    }
  }

  release(): void {
    if (this.state !== 'active') {
      return
    }
    this.state = 'released'
    this.messageListeners.clear()
    this.detachListeners.clear()
    this.destroyListeners.clear()
    this.router.releasePort(this)
  }

  /**
   * 内部事件分发（异常隔离）
   */
  dispatchMessage(method: string, params: Record<string, unknown>, sessionId?: string): void {
    if (this.state !== 'active') return
    for (const listener of Array.from(this.messageListeners)) {
      try {
        listener(method, params, sessionId)
      } catch {
        // 隔离单个监听器异常，确保后续监听器正常执行
      }
    }
  }

  dispatchDetached(reason: string): void {
    if (this.state !== 'active') return
    for (const listener of Array.from(this.detachListeners)) {
      try {
        listener(reason)
      } catch {
        // 隔离单个监听器异常，确保后续监听器正常执行
      }
    }
  }

  dispatchDestroyed(): void {
    if (this.state !== 'active') return
    for (const listener of Array.from(this.destroyListeners)) {
      try {
        listener()
      } catch {
        // 隔离单个监听器异常，确保后续监听器正常执行
      }
    }
  }

  /**
   * 终态 Detach 分发：通知前将 port 置为对应终态并清空监听器快照
   */
  dispatchTerminalDetached(reason: string, nextState: PortState): void {
    if (this.state !== 'active') return
    const listeners = Array.from(this.detachListeners)
    this.state = nextState
    this.messageListeners.clear()
    this.detachListeners.clear()
    this.destroyListeners.clear()

    for (const listener of listeners) {
      try {
        listener(reason)
      } catch {
        // 隔离单个监听器异常，确保后续监听器正常执行
      }
    }
  }

  /**
   * 终态 Destroy 分发：通知前将 port 置为对应终态并清空监听器快照
   */
  dispatchTerminalDestroyed(nextState: PortState): void {
    if (this.state !== 'active') return
    const listeners = Array.from(this.destroyListeners)
    this.state = nextState
    this.messageListeners.clear()
    this.detachListeners.clear()
    this.destroyListeners.clear()

    for (const listener of listeners) {
      try {
        listener()
      } catch {
        // 隔离单个监听器异常，确保后续监听器正常执行
      }
    }
  }

  markTerminalState(nextState: PortState): void {
    this.state = nextState
    this.messageListeners.clear()
    this.detachListeners.clear()
    this.destroyListeners.clear()
  }

  private assertUsable(): void {
    if (this.state === 'released') {
      throw new Error('CDP lease 已释放')
    }
    if (this.state === 'invalidated') {
      throw new Error('CDP lease 已失效')
    }
    if (this.state === 'destroyed') {
      throw new Error('网页页签已销毁')
    }
    if (this.state === 'unregistered') {
      throw new Error('网页页签已注销')
    }
    if (this.state === 'disposed') {
      throw new Error('CDP Router 已释放')
    }
  }
}

class CdpSessionRouterImpl implements CdpSessionRouter {
  private readonly entries = new Map<string, TabEntry>()
  private readonly leaseStateListeners = new Map<string, Set<(active: boolean) => void>>()
  private isDisposed = false

  registerTarget(tabId: string, target: BrowserCdpTarget): void {
    if (this.isDisposed) {
      throw new Error('CDP Router 已释放')
    }

    const existing = this.entries.get(tabId)
    if (existing) {
      this.replaceTarget(tabId, target)
      return
    }

    const entry: TabEntry = {
      target,
      generation: 1,
      documentEpoch: 1,
      activeLeases: new Set(),
      pendingSends: new Set(),
      cleanupTargetListeners: () => {},
      status: target.isDestroyed() ? 'destroyed' : 'active',
    }

    this.bindTargetEvents(tabId, entry)
    this.entries.set(tabId, entry)
  }

  replaceTarget(tabId: string, target: BrowserCdpTarget): void {
    if (this.isDisposed) {
      throw new Error('CDP Router 已释放')
    }

    const entry = this.entries.get(tabId)
    if (!entry) {
      throw new Error(`页签未注册: ${tabId}`)
    }

    entry.status = 'replacing'

    // 1. 取消旧 target 上所有挂起的 CDP 指令
    this.rejectPendingCommands(entry, new Error('网页目标已替换'))

    // 2. 解除旧 target 监听
    entry.cleanupTargetListeners()

    // 3. 通知 leaseStateChange(false) 在 target.detach 之前执行
    const hadLeases = entry.activeLeases.size > 0
    if (hadLeases) {
      this.notifyLeaseStateChange(tabId, false)
    }

    // 4. 分发 onDetached 给所有旧代际活跃 port，并在通知前置为 invalidated 终态
    for (const lease of Array.from(entry.activeLeases)) {
      lease.dispatchTerminalDetached('网页目标已替换', 'invalidated')
    }
    entry.activeLeases.clear()

    // 5. 若旧 target 仍处于 attached 状态，则执行 detach
    const oldTarget = entry.target
    if (oldTarget.isAttached() && !oldTarget.isDestroyed()) {
      try {
        oldTarget.detach()
      } catch {
        // 忽略 detach 异常
      }
    }

    // 6. 递增代际与文档纪元，绑定新 target 并恢复状态
    entry.generation += 1
    entry.documentEpoch += 1
    entry.target = target
    entry.status = target.isDestroyed() ? 'destroyed' : 'active'

    this.bindTargetEvents(tabId, entry)
  }

  unregisterTarget(tabId: string): void {
    const entry = this.entries.get(tabId)
    if (!entry) {
      return
    }

    entry.status = 'unregistering'

    // 1. 取消挂起指令
    this.rejectPendingCommands(entry, new Error('网页页签已注销'))

    // 2. 解除事件监听
    entry.cleanupTargetListeners()

    // 3. 通知 leaseStateChange(false) 在 target.detach 之前执行
    const hadLeases = entry.activeLeases.size > 0
    if (hadLeases) {
      this.notifyLeaseStateChange(tabId, false)
    }

    // 4. 分发 onDestroyed 并在通知前置为 unregistered 终态
    for (const lease of Array.from(entry.activeLeases)) {
      lease.dispatchTerminalDestroyed('unregistered')
    }
    entry.activeLeases.clear()

    // 5. Detach 目标
    if (entry.target.isAttached() && !entry.target.isDestroyed()) {
      try {
        entry.target.detach()
      } catch {
        // 忽略 detach 异常
      }
    }

    this.entries.delete(tabId)
  }

  acquire(tabId: string, owner: BrowserCdpOwner): BrowserPagePort {
    if (this.isDisposed) {
      throw new Error('CDP Router 已释放')
    }

    const entry = this.entries.get(tabId)
    if (!entry) {
      throw new Error(`页签未注册: ${tabId}`)
    }

    if (entry.status === 'replacing') {
      throw new Error('网页页签正在替换中')
    }

    if (entry.status === 'unregistering') {
      throw new Error('网页页签正在注销')
    }

    if (entry.status === 'detaching') {
      throw new Error('网页页签正在断开连接')
    }

    if (entry.status === 'destroyed' || entry.target.isDestroyed()) {
      throw new Error('网页页签已销毁')
    }

    const wasEmpty = entry.activeLeases.size === 0
    const port = new BrowserPagePortImpl(tabId, owner, entry.generation, entry.documentEpoch, this)

    // 保证 acquire 操作原子性：若 attach 抛出异常，best-effort detach 并回滚 port 且不残留 lease
    if (wasEmpty && !entry.target.isAttached()) {
      try {
        entry.target.attach()
      } catch (err) {
        if (entry.target.isAttached()) {
          try {
            entry.target.detach()
          } catch {
            // 忽略回滚 detach 异常，优先抛出 attach 原始异常
          }
        }
        port.markTerminalState('released')
        throw err
      }
    }

    entry.activeLeases.add(port)

    if (wasEmpty) {
      this.notifyLeaseStateChange(tabId, true)
    }

    return port
  }

  hasLease(tabId: string): boolean {
    if (this.isDisposed) return false
    const entry = this.entries.get(tabId)
    return entry ? entry.activeLeases.size > 0 : false
  }

  getLeaseCount(tabId: string): number {
    if (this.isDisposed) return 0
    const entry = this.entries.get(tabId)
    return entry ? entry.activeLeases.size : 0
  }

  onLeaseStateChange(tabId: string, listener: (active: boolean) => void): () => void {
    let listeners = this.leaseStateListeners.get(tabId)
    if (!listeners) {
      listeners = new Set()
      this.leaseStateListeners.set(tabId, listeners)
    }
    listeners.add(listener)

    return () => {
      const set = this.leaseStateListeners.get(tabId)
      if (set) {
        set.delete(listener)
        if (set.size === 0) {
          this.leaseStateListeners.delete(tabId)
        }
      }
    }
  }

  dispose(): void {
    if (this.isDisposed) {
      return
    }
    this.isDisposed = true

    for (const [tabId, entry] of Array.from(this.entries.entries())) {
      entry.status = 'destroyed'
      this.rejectPendingCommands(entry, new Error('CDP Router 已释放'))
      entry.cleanupTargetListeners()

      const hadLeases = entry.activeLeases.size > 0
      if (hadLeases) {
        this.notifyLeaseStateChange(tabId, false)
      }

      for (const lease of Array.from(entry.activeLeases)) {
        lease.dispatchTerminalDetached('CDP Router 已释放', 'disposed')
      }
      entry.activeLeases.clear()

      if (entry.target.isAttached() && !entry.target.isDestroyed()) {
        try {
          entry.target.detach()
        } catch {
          // 忽略 detach 异常
        }
      }
    }

    this.entries.clear()
    this.leaseStateListeners.clear()
  }

  /**
   * 内部方法：获取快照（严格校验代际、销毁与释放状态，仅允许 active 状态）
   */
  getSnapshot(port: BrowserPagePortImpl): BrowserPageSnapshot {
    if (this.isDisposed) {
      throw new Error('CDP Router 已释放')
    }

    const entry = this.entries.get(port.tabId)
    if (!entry) {
      throw new Error(`页签未注册: ${port.tabId}`)
    }

    if (port.generation !== entry.generation) {
      throw new Error('CDP lease 已失效')
    }

    if (entry.status === 'replacing') {
      throw new Error('网页页签正在替换中')
    }

    if (entry.status === 'unregistering') {
      throw new Error('网页页签正在注销')
    }

    if (entry.status === 'detaching') {
      throw new Error('网页页签正在断开连接')
    }

    if (entry.status === 'destroyed' || entry.target.isDestroyed()) {
      throw new Error('网页页签已销毁')
    }

    return entry.target.getSnapshot()
  }

  /**
   * 内部方法：发送受控 CDP 命令并追踪 pending 状态（严格校验状态，仅允许 active）
   */
  async sendCommand(
    port: BrowserPagePortImpl,
    method: BrowserCdpMethod,
    params?: Record<string, unknown>,
    sessionId?: string,
  ): Promise<unknown> {
    if (this.isDisposed) {
      throw new Error('CDP Router 已释放')
    }

    const entry = this.entries.get(port.tabId)
    if (!entry) {
      throw new Error(`页签未注册: ${port.tabId}`)
    }

    if (port.generation !== entry.generation) {
      throw new Error('CDP lease 已失效')
    }

    if (entry.status === 'replacing') {
      throw new Error('网页页签正在替换中')
    }

    if (entry.status === 'unregistering') {
      throw new Error('网页页签正在注销')
    }

    if (entry.status === 'detaching') {
      throw new Error('网页页签正在断开连接')
    }

    if (entry.status === 'destroyed' || entry.target.isDestroyed()) {
      throw new Error('网页页签已销毁')
    }

    if (!entry.target.isAttached()) {
      throw new Error('CDP 会话未连接')
    }

    return new Promise<unknown>((resolve, reject) => {
      const pendingItem: PendingSend = { port, generation: port.generation, reject }
      entry.pendingSends.add(pendingItem)

      entry.target
        .sendCommand(method, params, sessionId)
        .then((res) => {
          entry.pendingSends.delete(pendingItem)
          resolve(res)
        })
        .catch((err) => {
          entry.pendingSends.delete(pendingItem)
          reject(err)
        })
    })
  }

  /**
   * 内部方法：释放 port（精准取消该 port 挂起指令，且重入与状态变更安全）
   */
  releasePort(port: BrowserPagePortImpl): void {
    const entry = this.entries.get(port.tabId)
    if (!entry) {
      return
    }

    // 代际不匹配说明是旧 target 的 lease，不影响当前 target
    if (port.generation !== entry.generation) {
      return
    }

    const boundTarget = entry.target
    const boundIdentity = boundTarget.identity
    const boundGeneration = entry.generation

    // 精准取消属于当前 release port 的挂起指令
    this.rejectPortPendingCommands(entry, port, new Error('CDP lease 已释放'))

    if (entry.activeLeases.has(port)) {
      entry.activeLeases.delete(port)
      if (entry.activeLeases.size === 0) {
        // 必须先通知 leaseStateChange(false)
        this.notifyLeaseStateChange(port.tabId, false)
        // 关键重入与状态变化防护：校验 entry 仍存在且未被 replace/unregister/dispose，且未被重新 acquire
        const currentEntry = this.entries.get(port.tabId)
        if (
          !this.isDisposed &&
          currentEntry === entry &&
          entry.target === boundTarget &&
          entry.target.identity === boundIdentity &&
          entry.generation === boundGeneration &&
          entry.status === 'active' &&
          entry.activeLeases.size === 0 &&
          boundTarget.isAttached() &&
          !boundTarget.isDestroyed()
        ) {
          try {
            boundTarget.detach()
          } catch {
            // 忽略 detach 异常
          }
        }
      }
    }
  }

  private bindTargetEvents(tabId: string, entry: TabEntry): void {
    const boundTarget = entry.target
    const boundIdentity = boundTarget.identity

    const isCurrent = (): boolean => {
      const current = this.entries.get(tabId)
      return (
        !this.isDisposed &&
        current === entry &&
        entry.target === boundTarget &&
        entry.target.identity === boundIdentity &&
        entry.status === 'active'
      )
    }

    const unsubMsg = boundTarget.onMessage((method, params, sessionId) => {
      if (!isCurrent()) return
      for (const lease of Array.from(entry.activeLeases)) {
        if (lease.generation === entry.generation) {
          lease.dispatchMessage(method, params, sessionId)
        }
      }
    })

    const unsubDetach = boundTarget.onDetach((reason) => {
      if (!isCurrent()) return
      const previousStatus = entry.status
      entry.status = 'detaching'
      try {
        const hadLeases = entry.activeLeases.size > 0
        // 意外 detach 时拒绝所有 pending 命令，通知各 owner 但不静默重连
        this.rejectPendingCommands(entry, new Error(`CDP 会话已断开: ${reason}`))
        if (hadLeases) {
          this.notifyLeaseStateChange(tabId, false)
        }
        for (const lease of Array.from(entry.activeLeases)) {
          lease.dispatchTerminalDetached(reason, 'invalidated')
        }
        entry.activeLeases.clear()
        entry.generation += 1
        entry.documentEpoch += 1
      } finally {
        if (entry.status === 'detaching') {
          if (previousStatus === 'destroyed' || boundTarget.isDestroyed()) {
            entry.status = 'destroyed'
            entry.cleanupTargetListeners()
          } else {
            entry.status = 'active'
          }
        }
      }
    })

    const unsubDestroyed = boundTarget.onDestroyed(() => {
      if (!isCurrent()) return
      entry.status = 'destroyed'
      this.rejectPendingCommands(entry, new Error('网页页签已销毁'))
      const hadLeases = entry.activeLeases.size > 0
      if (hadLeases) {
        this.notifyLeaseStateChange(tabId, false)
      }
      for (const lease of Array.from(entry.activeLeases)) {
        lease.dispatchTerminalDestroyed('destroyed')
      }
      entry.activeLeases.clear()
      entry.cleanupTargetListeners()
    })

    entry.cleanupTargetListeners = () => {
      unsubMsg()
      unsubDetach()
      unsubDestroyed()
    }
  }

  private rejectPortPendingCommands(entry: TabEntry, port: BrowserPagePortImpl, error: Error): void {
    for (const pending of Array.from(entry.pendingSends)) {
      if (pending.port === port) {
        pending.reject(error)
        entry.pendingSends.delete(pending)
      }
    }
  }

  private rejectPendingCommands(entry: TabEntry, error: Error): void {
    for (const pending of Array.from(entry.pendingSends)) {
      pending.reject(error)
    }
    entry.pendingSends.clear()
  }

  private notifyLeaseStateChange(tabId: string, active: boolean): void {
    const listeners = this.leaseStateListeners.get(tabId)
    if (listeners) {
      for (const listener of Array.from(listeners)) {
        try {
          listener(active)
        } catch {
          // 忽略 listener 抛出的异常，确保不阻断后续清理流程
        }
      }
    }
  }
}

/**
 * 创建 CDP 会话路由器实例
 */
export function createCdpSessionRouter(): CdpSessionRouter {
  return new CdpSessionRouterImpl()
}
