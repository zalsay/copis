import { beforeEach, describe, expect, test } from 'bun:test'
import type { BrowserPageSnapshot } from '@copis/shared'
import type {
  BrowserCdpMethod,
  BrowserCdpOwner,
  BrowserCdpTarget,
  BrowserPagePort,
  CdpSessionRouter,
} from './browser-page-port'
import { createCdpSessionRouter } from './cdp-session-router'

class MockCdpTarget implements BrowserCdpTarget {
  readonly identity: number
  private destroyed = false
  private attached = false
  attachCalls = 0
  detachCalls = 0
  shouldThrowOnAttach = false
  onAttachCallback?: () => void
  onDetachCallback?: () => void
  sendCommandCalls: Array<{ method: BrowserCdpMethod; params?: Record<string, unknown>; sessionId?: string }> = []
  private messageListeners = new Set<(method: string, params: Record<string, unknown>, sessionId?: string) => void>()
  private detachListeners = new Set<(reason: string) => void>()
  private destroyedListeners = new Set<() => void>()
  private snapshot: BrowserPageSnapshot
  deferredCommands: Array<{
    method: BrowserCdpMethod
    params?: Record<string, unknown>
    sessionId?: string
    resolve: (val: unknown) => void
    reject: (err: unknown) => void
  }> = []

  constructor(identity = 101, snapshot?: BrowserPageSnapshot) {
    this.identity = identity
    this.snapshot = snapshot ?? ({
      title: '测试页面',
      url: 'https://example.com',
      elements: [],
    } as unknown as BrowserPageSnapshot)
  }

  isDestroyed(): boolean {
    return this.destroyed
  }

  isAttached(): boolean {
    return this.attached
  }

  getSnapshot(): BrowserPageSnapshot {
    return this.snapshot
  }

  attach(): void {
    this.attachCalls++
    if (this.shouldThrowOnAttach) {
      throw new Error('Attach 模拟失败')
    }
    this.attached = true
    this.onAttachCallback?.()
  }

  detach(): void {
    this.detachCalls++
    this.attached = false
    this.onDetachCallback?.()
  }

  sendCommand(method: BrowserCdpMethod, params?: Record<string, unknown>, sessionId?: string): Promise<unknown> {
    this.sendCommandCalls.push({ method, params, sessionId })
    return new Promise((resolve, reject) => {
      this.deferredCommands.push({ method, params, sessionId, resolve, reject })
    })
  }

  onMessage(listener: (method: string, params: Record<string, unknown>, sessionId?: string) => void): () => void {
    this.messageListeners.add(listener)
    return () => {
      this.messageListeners.delete(listener)
    }
  }

  onDetach(listener: (reason: string) => void): () => void {
    this.detachListeners.add(listener)
    return () => {
      this.detachListeners.delete(listener)
    }
  }

  onDestroyed(listener: () => void): () => void {
    this.destroyedListeners.add(listener)
    return () => {
      this.destroyedListeners.delete(listener)
    }
  }

  emitMessage(method: string, params: Record<string, unknown> = {}, sessionId?: string): void {
    for (const listener of Array.from(this.messageListeners)) {
      listener(method, params, sessionId)
    }
  }

  emitDetach(reason: string): void {
    this.attached = false
    for (const listener of Array.from(this.detachListeners)) {
      listener(reason)
    }
  }

  emitDestroyed(): void {
    this.destroyed = true
    this.attached = false
    for (const listener of Array.from(this.destroyedListeners)) {
      listener()
    }
  }

  listenerCount(): number {
    return this.messageListeners.size + this.detachListeners.size + this.destroyedListeners.size
  }

  resolveNextCommand(value: unknown = {}): void {
    const cmd = this.deferredCommands.shift()
    if (cmd) {
      cmd.resolve(value)
    }
  }

  rejectNextCommand(error: unknown): void {
    const cmd = this.deferredCommands.shift()
    if (cmd) {
      cmd.reject(error)
    }
  }
}

describe('CdpSessionRouter & BrowserPagePort', () => {
  let router: CdpSessionRouter

  beforeEach(() => {
    router = createCdpSessionRouter()
  })

  test('Given 同一页签有多个 owner When 依次释放 Then 只 attach 一次且最后一个 lease 才 detach', async () => {
    const target = new MockCdpTarget(101)
    router.registerTarget('tab-1', target)
    const agent = router.acquire('tab-1', 'agent')
    const recording = router.acquire('tab-1', 'recording')
    expect(target.attachCalls).toBe(1)
    expect(router.hasLease('tab-1')).toBe(true)
    expect(router.getLeaseCount('tab-1')).toBe(2)

    agent.release()
    expect(target.detachCalls).toBe(0)
    expect(router.hasLease('tab-1')).toBe(true)
    expect(router.getLeaseCount('tab-1')).toBe(1)

    recording.release()
    expect(target.detachCalls).toBe(1)
    expect(router.hasLease('tab-1')).toBe(false)
    expect(router.getLeaseCount('tab-1')).toBe(0)
  })

  test('Given 旧 generation lease When target 被替换且新 lease 已创建 Then 旧 release 不 detach 新 target', () => {
    const first = new MockCdpTarget(101)
    const second = new MockCdpTarget(202)
    router.registerTarget('tab-1', first)
    const stale = router.acquire('tab-1', 'agent')
    expect(stale.generation).toBe(1)

    router.replaceTarget('tab-1', second)
    const current = router.acquire('tab-1', 'agent')
    expect(current.generation).toBe(2)
    expect(current.documentEpoch).toBe(2)

    stale.release()
    expect(second.detachCalls).toBe(0)

    current.release()
    expect(second.detachCalls).toBe(1)
  })

  test('Given command 尚未返回 When target destroyed Then command reject 且监听器全部清理', async () => {
    const target = new MockCdpTarget(101)
    router.registerTarget('tab-1', target)
    const port = router.acquire('tab-1', 'workflow')
    const pending = port.send('Runtime.enable')

    target.emitDestroyed()
    await expect(pending).rejects.toThrow('网页页签已销毁')
    expect(target.listenerCount()).toBe(0)
  })

  test('Given debugger 意外 detach When owner 仍持有 lease Then 旧 lease 终态失效且清理 activeLeases，未自动 attach，重新 acquire 才 attach 且代际/epoch 递增', async () => {
    const target = new MockCdpTarget(101)
    router.registerTarget('tab-1', target)
    const leaseStateChanges: boolean[] = []
    let falseListenerReacquireError: Error | undefined
    let onDetachedReacquireError: Error | undefined

    router.onLeaseStateChange('tab-1', (active) => {
      leaseStateChanges.push(active)
      if (!active) {
        try {
          router.acquire('tab-1', 'workflow')
        } catch (err) {
          falseListenerReacquireError = err as Error
        }
      }
    })

    const port = router.acquire('tab-1', 'workflow')
    expect(leaseStateChanges).toEqual([true])
    expect(router.hasLease('tab-1')).toBe(true)
    expect(router.getLeaseCount('tab-1')).toBe(1)
    expect(port.generation).toBe(1)
    expect(port.documentEpoch).toBe(1)

    const reasons: string[] = []
    port.onDetached((reason) => {
      reasons.push(reason)
      try {
        router.acquire('tab-1', 'workflow')
      } catch (err) {
        onDetachedReacquireError = err as Error
      }
    })

    // 触发意外 detach
    target.emitDetach('target closed')
    expect(reasons).toEqual(['target closed'])
    // 验证在 detach 处理过渡期同步重入 acquire 被明确拒绝
    expect(falseListenerReacquireError?.message).toBe('网页页签正在断开连接')
    expect(onDetachedReacquireError?.message).toBe('网页页签正在断开连接')

    // 验证 leaseState 通知 false、leaseCount 为 0、未自动 attach
    expect(leaseStateChanges).toEqual([true, false])
    expect(router.hasLease('tab-1')).toBe(false)
    expect(router.getLeaseCount('tab-1')).toBe(0)
    expect(target.attachCalls).toBe(1)

    // 验证旧 port 不可用
    expect(() => port.getSnapshot()).toThrow('CDP lease 已失效')
    await expect(port.send('Page.enable')).rejects.toThrow('CDP lease 已失效')

    // detach 处理结束后，下一次显式 acquire 正常 attach，并且代际和 epoch 仅递增 1 次
    const newPort = router.acquire('tab-1', 'workflow')
    expect(target.attachCalls).toBe(2)
    expect(newPort.generation).toBe(2)
    expect(newPort.documentEpoch).toBe(2)
    expect(leaseStateChanges).toEqual([true, false, true])
    expect(router.hasLease('tab-1')).toBe(true)
  })

  test('Given router dispose When 多页签有活动 lease Then reject pending、detach 并拒绝新 acquire', async () => {
    const target1 = new MockCdpTarget(101)
    const target2 = new MockCdpTarget(102)
    router.registerTarget('tab-1', target1)
    router.registerTarget('tab-2', target2)

    const port1 = router.acquire('tab-1', 'agent')
    const port2 = router.acquire('tab-2', 'workflow')
    const pending1 = port1.send('Page.enable')

    router.dispose()

    expect(target1.detachCalls).toBe(1)
    expect(target2.detachCalls).toBe(1)
    await expect(pending1).rejects.toThrow('CDP Router 已释放')
    expect(() => router.acquire('tab-1', 'agent')).toThrow('CDP Router 已释放')
    expect(() => port2.release()).not.toThrow()
  })

  test('Given 已释放的 port When 再次 release 或 send Then release 幂等且 send 拒绝', async () => {
    const target = new MockCdpTarget(101)
    router.registerTarget('tab-1', target)
    const port = router.acquire('tab-1', 'agent')

    port.release()
    // 第二次 release 应当幂等无副作用
    expect(() => port.release()).not.toThrow()
    expect(target.detachCalls).toBe(1)

    // 已释放的 port 再次 send 必须 reject
    await expect(port.send('Runtime.evaluate', { expression: '1 + 1' })).rejects.toThrow('CDP lease 已释放')
  })

  test('Given target 替换 When 旧 port 尝试发送命令 Then reject 且不影响新 target', async () => {
    const target1 = new MockCdpTarget(101)
    const target2 = new MockCdpTarget(202)
    router.registerTarget('tab-1', target1)
    const stalePort = router.acquire('tab-1', 'agent')

    const pendingStale = stalePort.send('Page.enable')
    router.replaceTarget('tab-1', target2)

    // 替换时 pending 的命令被 reject
    await expect(pendingStale).rejects.toThrow('网页目标已替换')

    // 替换后旧 port 再发命令也被 reject
    await expect(stalePort.send('Page.enable')).rejects.toThrow('CDP lease 已失效')

    // 新 port 正常工作
    const currentPort = router.acquire('tab-1', 'agent')
    const newSend = currentPort.send('Page.enable')
    target2.resolveNextCommand({ result: 'ok' })
    await expect(newSend).resolves.toEqual({ result: 'ok' })
  })

  test('Given unregisterTarget When 有活动 lease 和 pending 命令 Then reject pending 且 detach', async () => {
    const target = new MockCdpTarget(101)
    router.registerTarget('tab-1', target)
    const port = router.acquire('tab-1', 'agent')

    const pending = port.send('DOM.setFileInputFiles', { files: ['/path/to/file'] })
    router.unregisterTarget('tab-1')

    await expect(pending).rejects.toThrow('网页页签已注销')
    expect(target.detachCalls).toBe(1)
    expect(target.listenerCount()).toBe(0)
    expect(router.hasLease('tab-1')).toBe(false)
  })

  test('Given port 监听 message 和 destroyed When 触发对应事件 Then 正确分发且支持取消监听', () => {
    const target = new MockCdpTarget(101)
    router.registerTarget('tab-1', target)
    const port = router.acquire('tab-1', 'recording')

    const messages: Array<{ method: string; params: Record<string, unknown> }> = []
    const unsubMessage = port.onMessage((method, params) => {
      messages.push({ method, params })
    })

    let destroyedCalled = false
    const unsubDestroyed = port.onDestroyed(() => {
      destroyedCalled = true
    })

    target.emitMessage('Page.javascriptDialogOpening', { message: 'hello', type: 'alert' })
    expect(messages).toEqual([{ method: 'Page.javascriptDialogOpening', params: { message: 'hello', type: 'alert' } }])

    unsubMessage()
    target.emitMessage('Page.javascriptDialogClosed', {})
    expect(messages.length).toBe(1)

    target.emitDestroyed()
    expect(destroyedCalled).toBe(true)
    unsubDestroyed()
  })

  test('Given lease 状态变更 When 注册 onLeaseStateChange Then 在 0->1 与 1->0 转换时通知', () => {
    const target = new MockCdpTarget(101)
    router.registerTarget('tab-1', target)

    const stateChanges: boolean[] = []
    const unsub = router.onLeaseStateChange('tab-1', (active) => {
      stateChanges.push(active)
    })

    const agent = router.acquire('tab-1', 'agent')
    const recording = router.acquire('tab-1', 'recording')
    agent.release()
    recording.release()

    expect(stateChanges).toEqual([true, false])
    unsub()

    const reacquire = router.acquire('tab-1', 'workflow')
    reacquire.release()
    // 已取消监听，不再追加
    expect(stateChanges).toEqual([true, false])
  })

  test('Given port 实例 When 调用 getSnapshot Then 委托给底层 target.getSnapshot', () => {
    const customSnapshot = {
      title: '自定义页面',
      url: 'https://example.org',
      elements: [{ tagName: 'button', text: 'Click me' }],
    } as unknown as BrowserPageSnapshot

    const target = new MockCdpTarget(101, customSnapshot)
    router.registerTarget('tab-1', target)
    const port = router.acquire('tab-1', 'agent')

    expect(port.getSnapshot()).toBe(customSnapshot)
    expect(port.tabId).toBe('tab-1')
    expect(port.owner).toBe('agent')
  })

  test('Given 未注册页签或已销毁 target When 调用 acquire Then 抛出中文错误', () => {
    expect(() => router.acquire('non-existent', 'agent')).toThrow('页签未注册: non-existent')

    const target = new MockCdpTarget(101)
    target.emitDestroyed()
    router.registerTarget('tab-1', target)
    expect(() => router.acquire('tab-1', 'agent')).toThrow('网页页签已销毁')
  })

  // === 评审意见 1: 原子 acquire 与 attach 失败回滚 ===
  test('Given attach 抛出异常 When acquire 失败 Then 不残留半激活 lease 且后续 acquire 可以正常 attach', () => {
    const target = new MockCdpTarget(101)
    target.shouldThrowOnAttach = true
    router.registerTarget('tab-1', target)

    let failedPort: BrowserPagePort | undefined
    expect(() => {
      failedPort = router.acquire('tab-1', 'agent')
    }).toThrow('Attach 模拟失败')

    expect(failedPort).toBeUndefined()
    expect(router.hasLease('tab-1')).toBe(false)
    expect(router.getLeaseCount('tab-1')).toBe(0)
    expect(target.isAttached()).toBe(false)

    // 修复后再次 acquire 应该能正常触发 attach
    target.shouldThrowOnAttach = false
    const successPort = router.acquire('tab-1', 'agent')
    expect(router.hasLease('tab-1')).toBe(true)
    expect(router.getLeaseCount('tab-1')).toBe(1)
    expect(target.attachCalls).toBe(2)
    expect(target.isAttached()).toBe(true)
    expect(successPort.tabId).toBe('tab-1')
  })

  // === 评审意见 2: lease:false 先于 target:detach 执行顺序 ===
  test('Given 注册了 onLeaseStateChange When 释放最后一个 lease / 注销 / 替换 / dispose Then 保证 lease:false 先于 target.detach 执行', () => {
    const events: string[] = []

    const target = new MockCdpTarget(101)
    target.onDetachCallback = () => {
      events.push('target:detach')
    }

    router.registerTarget('tab-1', target)
    router.onLeaseStateChange('tab-1', (active) => {
      events.push(`lease:${active}`)
    })

    const port = router.acquire('tab-1', 'agent')
    expect(events).toEqual(['lease:true'])

    // 1. 正常释放最后一个 lease
    port.release()
    expect(events).toEqual(['lease:true', 'lease:false', 'target:detach'])

    // 2. unregisterTarget 路径
    events.length = 0
    const port2 = router.acquire('tab-1', 'recording')
    expect(events).toEqual(['lease:true'])
    router.unregisterTarget('tab-1')
    expect(events).toEqual(['lease:true', 'lease:false', 'target:detach'])

    // 3. replaceTarget 路径
    events.length = 0
    const target2 = new MockCdpTarget(202)
    target2.onDetachCallback = () => {
      events.push('target:detach')
    }
    router.registerTarget('tab-2', target2)
    router.onLeaseStateChange('tab-2', (active) => {
      events.push(`lease:${active}`)
    })
    router.acquire('tab-2', 'workflow')
    expect(events).toEqual(['lease:true'])

    const target3 = new MockCdpTarget(203)
    router.replaceTarget('tab-2', target3)
    expect(events).toEqual(['lease:true', 'lease:false', 'target:detach'])

    // 4. dispose 路径
    events.length = 0
    const target4 = new MockCdpTarget(303)
    target4.onDetachCallback = () => {
      events.push('target:detach')
    }
    router.registerTarget('tab-3', target4)
    router.onLeaseStateChange('tab-3', (active) => {
      events.push(`lease:${active}`)
    })
    router.acquire('tab-3', 'agent')
    expect(events).toEqual(['lease:true'])

    router.dispose()
    expect(events).toEqual(['lease:true', 'lease:false', 'target:detach'])
  })

  test('Given listener 抛出异常 When notifyLeaseStateChange 触发 Then 不阻断后续 target.detach 清理', () => {
    const events: string[] = []
    const target = new MockCdpTarget(101)
    target.onDetachCallback = () => {
      events.push('target:detach')
    }
    router.registerTarget('tab-1', target)
    router.onLeaseStateChange('tab-1', (active) => {
      if (!active) {
        throw new Error('Listener 故意抛错')
      }
    })

    const port = router.acquire('tab-1', 'agent')
    expect(() => port.release()).not.toThrow()
    expect(events).toEqual(['target:detach'])
  })

  // === 评审意见 3: getSnapshot 的完整状态与代际校验 ===
  test('Given 已释放、代际过期或已销毁的 port When 调用 getSnapshot Then 校验并抛出对应错误', () => {
    const target1 = new MockCdpTarget(101)
    router.registerTarget('tab-1', target1)
    const port = router.acquire('tab-1', 'agent')

    // 正常获取
    expect(port.getSnapshot().title).toBe('测试页面')

    // 1. 已 release 的 port
    port.release()
    expect(() => port.getSnapshot()).toThrow('CDP lease 已释放')

    // 2. 代际过期的 port (replaceTarget 后)
    const targetA = new MockCdpTarget(102)
    const targetB = new MockCdpTarget(103)
    router.registerTarget('tab-2', targetA)
    const stalePort = router.acquire('tab-2', 'agent')
    router.replaceTarget('tab-2', targetB)
    expect(() => stalePort.getSnapshot()).toThrow('CDP lease 已失效')

    // 3. target 已销毁
    const targetC = new MockCdpTarget(104)
    router.registerTarget('tab-3', targetC)
    const activePort = router.acquire('tab-3', 'agent')
    targetC.emitDestroyed()
    expect(() => activePort.getSnapshot()).toThrow('网页页签已销毁')

    // 4. router dispose
    const targetD = new MockCdpTarget(105)
    router.registerTarget('tab-4', targetD)
    const activePort2 = router.acquire('tab-4', 'workflow')
    router.dispose()
    expect(() => activePort2.getSnapshot()).toThrow('CDP Router 已释放')
  })

  // === 评审意见 4: replace/unregister/destroy/dispose 时分发生命周期事件并清理释放 port ===
  test('Given target 替换或 router dispose When 存在活动 port Then 分发 onDetached 并清理释放 port', () => {
    const target1 = new MockCdpTarget(101)
    const target2 = new MockCdpTarget(202)
    router.registerTarget('tab-1', target1)
    const port = router.acquire('tab-1', 'agent')

    const detachReasons: string[] = []
    port.onDetached((reason) => detachReasons.push(reason))

    // 替换 target: 必须触发 onDetached('网页目标已替换') 并将 port 标记为已失效/释放
    router.replaceTarget('tab-1', target2)
    expect(detachReasons).toEqual(['网页目标已替换'])
    expect(() => port.getSnapshot()).toThrow('CDP lease 已失效')

    // router dispose: 必须触发 onDetached('CDP Router 已释放') 并释放 port
    const port2 = router.acquire('tab-1', 'agent')
    const disposeDetachReasons: string[] = []
    port2.onDetached((reason) => disposeDetachReasons.push(reason))

    router.dispose()
    expect(disposeDetachReasons).toEqual(['CDP Router 已释放'])
    expect(() => port2.getSnapshot()).toThrow('CDP Router 已释放')
  })

  test('Given unregisterTarget 或 target destroy When 存在活动 port Then 分发 onDestroyed 并清理释放 port', () => {
    const target1 = new MockCdpTarget(101)
    router.registerTarget('tab-1', target1)
    const port = router.acquire('tab-1', 'recording')

    let destroyedFired = false
    port.onDestroyed(() => {
      destroyedFired = true
    })

    router.unregisterTarget('tab-1')
    expect(destroyedFired).toBe(true)
    expect(() => port.getSnapshot()).toThrow('网页页签已注销')
  })

  // === 修复轮次 2 缺陷 1: 旧 target 延迟事件竞争防护 ===
  test('Given 旧 target 延迟回调 When replaceTarget 之后被直接调用 Then 忽略旧回调且新 port 保持活跃/不接收旧事件', () => {
    const firstTarget = new MockCdpTarget(101)
    const secondTarget = new MockCdpTarget(202)

    let capturedOldMsgListener: ((method: string, params: Record<string, unknown>) => void) | undefined
    let capturedOldDetachListener: ((reason: string) => void) | undefined
    let capturedOldDestroyListener: (() => void) | undefined

    const origMsg = firstTarget.onMessage.bind(firstTarget)
    firstTarget.onMessage = (listener) => {
      capturedOldMsgListener = listener
      return origMsg(listener)
    }
    const origDetach = firstTarget.onDetach.bind(firstTarget)
    firstTarget.onDetach = (listener) => {
      capturedOldDetachListener = listener
      return origDetach(listener)
    }
    const origDestroy = firstTarget.onDestroyed.bind(firstTarget)
    firstTarget.onDestroyed = (listener) => {
      capturedOldDestroyListener = listener
      return origDestroy(listener)
    }

    router.registerTarget('tab-1', firstTarget)
    router.acquire('tab-1', 'agent')

    // 替换为 secondTarget 并建立新 lease
    router.replaceTarget('tab-1', secondTarget)
    const newPort = router.acquire('tab-1', 'agent')
    expect(secondTarget.isAttached()).toBe(true)

    const newMessages: string[] = []
    const newDetaches: string[] = []
    let newDestroyed = false
    newPort.onMessage((method) => newMessages.push(method))
    newPort.onDetached((reason) => newDetaches.push(reason))
    newPort.onDestroyed(() => {
      newDestroyed = true
    })

    // 直接触发旧 target 捕获的回调
    capturedOldMsgListener?.('Page.javascriptDialogOpening', {})
    capturedOldDetachListener?.('old detach reason')
    capturedOldDestroyListener?.()

    // 验证新 port 完全不受旧 target 延迟回调污染
    expect(newMessages).toEqual([])
    expect(newDetaches).toEqual([])
    expect(newDestroyed).toBe(false)
    expect(secondTarget.isAttached()).toBe(true)
    expect(router.hasLease('tab-1')).toBe(true)
  })

  // === 修复轮次 2 缺陷 2: Pending command 归属权与精准取消 ===
  test('Given 同一页签存在多个 owner When 释放 Agent lease Then 仅 reject Agent 的 pending 命令且 Recording 可正常 resolve', async () => {
    const target = new MockCdpTarget(101)
    router.registerTarget('tab-1', target)
    const agentPort = router.acquire('tab-1', 'agent')
    const recordingPort = router.acquire('tab-1', 'recording')

    const agentPending = agentPort.send('Page.enable')
    const recordingPending = recordingPort.send('Runtime.enable')

    // 释放 Agent lease
    agentPort.release()

    // Agent pending 必须立即被 reject
    await expect(agentPending).rejects.toThrow('CDP lease 已释放')

    // Target 仍然保持 attached，Recording pending 可正常 resolve
    expect(target.isAttached()).toBe(true)
    target.resolveNextCommand({ agent: 'ignored' })
    target.resolveNextCommand({ status: 'recording-ok' })

    await expect(recordingPending).resolves.toEqual({ status: 'recording-ok' })

    // 释放最后一个 lease 时，其 pending 指令在 detach 之前被 reject
    const lastPending = recordingPort.send('Page.getFrameTree')
    recordingPort.release()
    await expect(lastPending).rejects.toThrow('CDP lease 已释放')
    expect(target.detachCalls).toBe(1)
  })

  // === 修复轮次 2 缺陷 3: 监听器异常隔离 ===
  test('Given 监听器中存在抛出异常的 listener When 分发 onDetached 或 onDestroyed Then 隔离异常且后续监听器正常执行', () => {
    const target1 = new MockCdpTarget(101)
    router.registerTarget('tab-1', target1)
    const port1 = router.acquire('tab-1', 'workflow')

    let secondDetachRan = false
    port1.onDetached(() => {
      throw new Error('第一个 onDetached 抛错')
    })
    port1.onDetached(() => {
      secondDetachRan = true
    })

    target1.emitDetach('test-detach')
    expect(secondDetachRan).toBe(true)

    const target2 = new MockCdpTarget(102)
    router.registerTarget('tab-2', target2)
    const port2 = router.acquire('tab-2', 'workflow')

    let secondDestroyRan = false
    port2.onDestroyed(() => {
      throw new Error('第一个 onDestroyed 抛错')
    })
    port2.onDestroyed(() => {
      secondDestroyRan = true
    })

    target2.emitDestroyed()
    expect(secondDestroyRan).toBe(true)
    expect(() => port2.getSnapshot()).toThrow('网页页签已销毁')
    expect(target2.listenerCount()).toBe(0)
  })

  // === 修复轮次 3 问题 1: terminal lifecycle callback 重入安全性 ===
  test('Given 终态通知 (replace/unregister/destroyed/dispose) When listener 内调用 send/getSnapshot/release Then 立即按终态失败且不进入底层 target 且 release 幂等', async () => {
    const terminalCases: Array<{
      action: (r: CdpSessionRouter, p: BrowserPagePort, t: MockCdpTarget) => void
      expectedError: string
      registerCallback: (p: BrowserPagePort, cb: () => void) => void
    }> = [
      {
        action: (r) => r.replaceTarget('tab-1', new MockCdpTarget(202)),
        expectedError: 'CDP lease 已失效',
        registerCallback: (p, cb) => p.onDetached(cb),
      },
      {
        action: (r) => r.unregisterTarget('tab-1'),
        expectedError: '网页页签已注销',
        registerCallback: (p, cb) => p.onDestroyed(cb),
      },
      {
        action: (_, __, t) => t.emitDestroyed(),
        expectedError: '网页页签已销毁',
        registerCallback: (p, cb) => p.onDestroyed(cb),
      },
      {
        action: (r) => r.dispose(),
        expectedError: 'CDP Router 已释放',
        registerCallback: (p, cb) => p.onDetached(cb),
      },
    ]

    for (const item of terminalCases) {
      const target = new MockCdpTarget(101)
      const testRouter = createCdpSessionRouter()
      testRouter.registerTarget('tab-1', target)
      const port = testRouter.acquire('tab-1', 'agent')

      let sendPending: Promise<unknown> | undefined
      let snapshotError: Error | undefined
      let releaseCalled = false

      item.registerCallback(port, () => {
        sendPending = port.send('Page.enable')
        try {
          port.getSnapshot()
        } catch (err) {
          snapshotError = err as Error
        }
        port.release()
        releaseCalled = true
      })

      item.action(testRouter, port, target)

      expect(releaseCalled).toBe(true)
      expect(snapshotError?.message).toBe(item.expectedError)
      await expect(sendPending!).rejects.toThrow(item.expectedError)
      // 底层 target 绝对不收到 sendCommandCalls
      expect(target.sendCommandCalls.length).toBe(0)
      // release() 幂等且不改变终态错误
      expect(() => port.getSnapshot()).toThrow(item.expectedError)
    }
  })

  // === 修复轮次 4 缺陷 1: replace/unregister false listener 内 send/getSnapshot 立即按过渡态失败 ===
  test('Given replaceTarget 的 false listener 触发 When 对旧 port 调用 send/getSnapshot Then 立即按“正在替换”失败且底层不收到命令', async () => {
    const target1 = new MockCdpTarget(101)
    const target2 = new MockCdpTarget(202)
    router.registerTarget('tab-1', target1)
    const port = router.acquire('tab-1', 'agent')

    let snapshotError: Error | undefined
    let sendPromise: Promise<unknown> | undefined

    router.onLeaseStateChange('tab-1', (active) => {
      if (!active) {
        try {
          port.getSnapshot()
        } catch (err) {
          snapshotError = err as Error
        }
        sendPromise = port.send('Page.enable')
      }
    })

    router.replaceTarget('tab-1', target2)

    expect(snapshotError?.message).toBe('网页页签正在替换中')
    await expect(sendPromise!).rejects.toThrow('网页页签正在替换中')
    expect(target1.sendCommandCalls.length).toBe(0)
  })

  test('Given unregisterTarget 的 false listener 触发 When 对旧 port 调用 send/getSnapshot Then 立即按“正在注销”失败且底层不收到命令', async () => {
    const target1 = new MockCdpTarget(101)
    router.registerTarget('tab-1', target1)
    const port = router.acquire('tab-1', 'agent')

    let snapshotError: Error | undefined
    let sendPromise: Promise<unknown> | undefined

    router.onLeaseStateChange('tab-1', (active) => {
      if (!active) {
        try {
          port.getSnapshot()
        } catch (err) {
          snapshotError = err as Error
        }
        sendPromise = port.send('Page.enable')
      }
    })

    router.unregisterTarget('tab-1')

    expect(snapshotError?.message).toBe('网页页签正在注销')
    await expect(sendPromise!).rejects.toThrow('网页页签正在注销')
    expect(target1.sendCommandCalls.length).toBe(0)
  })

  // === 修复轮次 4 缺陷 2: replace false 通知期间触发旧 target 晚到 callback 必须被过滤 ===
  test('Given replaceTarget 的 false 通知期间旧 target 晚到 callback 触发 Then isCurrent 过滤旧事件且不污染新 target', () => {
    const firstTarget = new MockCdpTarget(101)
    const secondTarget = new MockCdpTarget(202)

    let oldMsgCb: ((method: string, params: Record<string, unknown>) => void) | undefined
    let oldDetachCb: ((reason: string) => void) | undefined
    let oldDestroyCb: (() => void) | undefined

    firstTarget.onMessage = (cb) => {
      oldMsgCb = cb
      return () => {}
    }
    firstTarget.onDetach = (cb) => {
      oldDetachCb = cb
      return () => {}
    }
    firstTarget.onDestroyed = (cb) => {
      oldDestroyCb = cb
      return () => {}
    }

    router.registerTarget('tab-1', firstTarget)
    router.acquire('tab-1', 'agent')

    router.onLeaseStateChange('tab-1', (active) => {
      if (!active) {
        // 在 replaceTarget 的 false 通知期间触发旧 target 回调
        oldMsgCb?.('Page.javascriptDialogOpening', {})
        oldDetachCb?.('late detach')
        oldDestroyCb?.()
      }
    })

    router.replaceTarget('tab-1', secondTarget)
    const newPort = router.acquire('tab-1', 'agent')

    const newMessages: string[] = []
    const newDetaches: string[] = []
    let newDestroyed = false
    newPort.onMessage((m) => newMessages.push(m))
    newPort.onDetached((r) => newDetaches.push(r))
    newPort.onDestroyed(() => {
      newDestroyed = true
    })

    expect(newMessages).toEqual([])
    expect(newDetaches).toEqual([])
    expect(newDestroyed).toBe(false)
    expect(secondTarget.isAttached()).toBe(true)
    expect(router.hasLease('tab-1')).toBe(true)
  })

  // === 修复轮次 4 缺陷 3: releasePort 在 notify false 中触发 replace/unregister/dispose 时旧 release 不 detach 新 target ===
  test('Given releasePort 触发 false 通知时 listener 同步执行 replaceTarget 并获取新 lease Then 旧 release 不 detach 新 target', () => {
    const firstTarget = new MockCdpTarget(101)
    const secondTarget = new MockCdpTarget(202)
    router.registerTarget('tab-1', firstTarget)
    const port1 = router.acquire('tab-1', 'agent')

    let secondPort: BrowserPagePort | undefined
    router.onLeaseStateChange('tab-1', (active) => {
      if (!active && !secondPort) {
        // 在 port1 release 触发的 false 通知中同步执行 replaceTarget
        router.replaceTarget('tab-1', secondTarget)
        secondPort = router.acquire('tab-1', 'recording')
      }
    })

    port1.release()

    // 验证新 target2 保持 attached，没有被 port1 的 release 错误 detach
    expect(secondPort).toBeDefined()
    expect(secondTarget.isAttached()).toBe(true)
    expect(secondTarget.detachCalls).toBe(0)
    expect(router.hasLease('tab-1')).toBe(true)
    expect(router.getLeaseCount('tab-1')).toBe(1)

    secondPort?.release()
    expect(secondTarget.detachCalls).toBe(1)
    expect(router.hasLease('tab-1')).toBe(false)
  })

  // === 修复轮次 4 缺陷 4: 分别覆盖 replace、unregister、dispose 的重入 acquire 明确错误 ===
  test('Given replaceTarget 过渡期 When listener 尝试重入 acquire Then 抛出“网页页签正在替换中”', () => {
    const target1 = new MockCdpTarget(101)
    const target2 = new MockCdpTarget(202)
    router.registerTarget('tab-1', target1)
    router.acquire('tab-1', 'agent')

    let caughtError: Error | undefined
    router.onLeaseStateChange('tab-1', (active) => {
      if (!active) {
        try {
          router.acquire('tab-1', 'recording')
        } catch (err) {
          caughtError = err as Error
        }
      }
    })

    router.replaceTarget('tab-1', target2)
    expect(caughtError?.message).toBe('网页页签正在替换中')
  })

  test('Given unregisterTarget 过渡期 When listener 尝试重入 acquire Then 抛出“网页页签正在注销”', () => {
    const target1 = new MockCdpTarget(101)
    router.registerTarget('tab-1', target1)
    router.acquire('tab-1', 'agent')

    let caughtError: Error | undefined
    router.onLeaseStateChange('tab-1', (active) => {
      if (!active) {
        try {
          router.acquire('tab-1', 'recording')
        } catch (err) {
          caughtError = err as Error
        }
      }
    })

    router.unregisterTarget('tab-1')
    expect(caughtError?.message).toBe('网页页签正在注销')
  })

  test('Given router.dispose 过渡期 When listener 尝试重入 acquire Then 抛出“CDP Router 已释放”', () => {
    const target1 = new MockCdpTarget(101)
    router.registerTarget('tab-1', target1)
    router.acquire('tab-1', 'agent')

    let caughtError: Error | undefined
    router.onLeaseStateChange('tab-1', (active) => {
      if (!active) {
        try {
          router.acquire('tab-1', 'recording')
        } catch (err) {
          caughtError = err as Error
        }
      }
    })

    router.dispose()
    expect(caughtError?.message).toBe('CDP Router 已释放')
  })

  // === 修复轮次 3 问题 2: leaseStateChange(false) 同步重入安全性 ===
  test('Given 释放最后一个 lease 时触发 onLeaseStateChange(false) When listener 同步 acquire 新 lease Then 新 port 可用、target 保持 attached 且不被误 detach', () => {
    const target = new MockCdpTarget(101)
    router.registerTarget('tab-1', target)
    const agentPort = router.acquire('tab-1', 'agent')

    let reacquiredPort: BrowserPagePort | undefined
    const leaseEvents: boolean[] = []

    router.onLeaseStateChange('tab-1', (active) => {
      leaseEvents.push(active)
      if (!active && !reacquiredPort) {
        // 在 false 回调中同步重新获取 lease
        reacquiredPort = router.acquire('tab-1', 'recording')
      }
    })

    // 释放原 lease，触发 false 回调
    agentPort.release()

    // 验证重入成功：新 port 存在且有效
    expect(reacquiredPort).toBeDefined()
    expect(reacquiredPort?.tabId).toBe('tab-1')
    expect(router.hasLease('tab-1')).toBe(true)
    expect(router.getLeaseCount('tab-1')).toBe(1)
    // target 保持 attached，没有被外层 release 错误执行 detach
    expect(target.isAttached()).toBe(true)
    expect(target.detachCalls).toBe(0)

    // 释放新获取的 lease 时，正常执行 detach
    reacquiredPort?.release()
    expect(target.detachCalls).toBe(1)
    expect(router.hasLease('tab-1')).toBe(false)
  })

  // === 修复轮次 3 问题 3: attach 部分成功后抛错的回滚 ===
  test('Given target.attach 将 attached 置为 true 后抛出异常 When acquire 失败 Then best-effort 执行 detach 且不残留 lease', () => {
    const target = new MockCdpTarget(101)
    target.attach = () => {
      target.attachCalls++
      ;(target as any).attached = true
      throw new Error('底层 attach 崩溃')
    }

    router.registerTarget('tab-1', target)

    expect(() => router.acquire('tab-1', 'agent')).toThrow('底层 attach 崩溃')
    expect(target.isAttached()).toBe(false)
    expect(target.detachCalls).toBe(1)
    expect(router.hasLease('tab-1')).toBe(false)
    expect(router.getLeaseCount('tab-1')).toBe(0)
  })

  test('Given target.attach 抛错且回滚 detach 也抛错 When acquire 失败 Then 优先抛出原始 attach 错误且不残留 lease', () => {
    const target = new MockCdpTarget(101)
    target.attach = () => {
      target.attachCalls++
      ;(target as any).attached = true
      throw new Error('原始 attach 错误')
    }
    target.detach = () => {
      target.detachCalls++
      throw new Error('detach 回滚错误')
    }

    router.registerTarget('tab-1', target)

    expect(() => router.acquire('tab-1', 'agent')).toThrow('原始 attach 错误')
    expect(router.hasLease('tab-1')).toBe(false)
    expect(router.getLeaseCount('tab-1')).toBe(0)
  })

  // === 修复轮次 4 Item A: isCurrent 回归防护 ===
  test('Given replaceTarget 过渡窗口中触发旧 detach callback When 执行 Then 旧回调被 isCurrent 忽略且 generation/epoch 仅 +1，新 target 正常工作', () => {
    const firstTarget = new MockCdpTarget(101)
    const secondTarget = new MockCdpTarget(202)

    let capturedOldDetachListener: ((reason: string) => void) | undefined
    const origDetach = firstTarget.onDetach.bind(firstTarget)
    firstTarget.onDetach = (listener) => {
      capturedOldDetachListener = listener
      return origDetach(listener)
    }

    router.registerTarget('tab-1', firstTarget)
    const oldPort = router.acquire('tab-1', 'agent')

    // 在 false listener（replaceTarget 过渡窗口）中触发捕获的旧 detach 回调
    let invokedOldDetachDuringReplace = false
    router.onLeaseStateChange('tab-1', (active) => {
      if (!active && !invokedOldDetachDuringReplace) {
        invokedOldDetachDuringReplace = true
        // 尝试重入旧 detach
        capturedOldDetachListener?.('旧 target 延迟断开')
      }
    })

    router.replaceTarget('tab-1', secondTarget)

    expect(invokedOldDetachDuringReplace).toBe(true)

    // replaceTarget 应该使得代际与 epoch 从 1 递增为 2（而不是因为旧 detach 额外递增到 3）
    const newPort = router.acquire('tab-1', 'agent')
    expect(newPort.generation).toBe(2)
    expect(newPort.documentEpoch).toBe(2)
    expect(newPort.getSnapshot().title).toBe('测试页面')
  })

  test('Given unexpected detach 处理过程中触发嵌套 detach callback When 执行 Then 嵌套调用被 isCurrent 忽略，generation/epoch 仅递增 1 次', () => {
    const target = new MockCdpTarget(101)
    let capturedDetachListener: ((reason: string) => void) | undefined
    const origDetach = target.onDetach.bind(target)
    target.onDetach = (listener) => {
      capturedDetachListener = listener
      return origDetach(listener)
    }

    router.registerTarget('tab-1', target)
    const port = router.acquire('tab-1', 'agent')

    let nestedDetachInvoked = false
    router.onLeaseStateChange('tab-1', (active) => {
      if (!active && !nestedDetachInvoked) {
        nestedDetachInvoked = true
        // 在 detaching 状态期间再次调用 detach callback
        capturedDetachListener?.('嵌套断开通知')
      }
    })

    // 触发 unexpected detach
    target.emitDetach('底层意外断开')

    expect(nestedDetachInvoked).toBe(true)

    // detach 完成后重新 acquire，generation 应为 2（只递增 1 次，非 3）
    const newPort = router.acquire('tab-1', 'agent')
    expect(newPort.generation).toBe(2)
    expect(newPort.documentEpoch).toBe(2)
    expect(newPort.getSnapshot().title).toBe('测试页面')
  })

  // === 修复: unexpected detach detaching 期间 target 同步 destroyed ===
  test('Given unexpected detach 处理过程中 target 同步触发 destroyed When 执行 Then 旧 port terminal、entry 状态置为 destroyed 且 target listeners 清零', () => {
    const target = new MockCdpTarget(101)
    const leaseStateChanges: boolean[] = []

    router.registerTarget('tab-1', target)
    router.onLeaseStateChange('tab-1', (active) => {
      leaseStateChanges.push(active)
    })

    const port = router.acquire('tab-1', 'agent')
    expect(leaseStateChanges).toEqual([true])

    // 在 onDetached 回调中同步触发 target.emitDestroyed
    port.onDetached(() => {
      target.emitDestroyed()
    })

    // 触发 unexpected detach
    target.emitDetach('意外断开')

    // 验证旧 port 进入终态
    expect(() => port.getSnapshot()).toThrow('CDP lease 已失效')

    // 验证 leaseStateChange(false) 仅分发 1 次，不重复分发
    expect(leaseStateChanges).toEqual([true, false])
    expect(router.hasLease('tab-1')).toBe(false)
    expect(router.getLeaseCount('tab-1')).toBe(0)

    // 验证 target 事件监听器被完全清理（清零）
    expect(target.listenerCount()).toBe(0)

    // 验证 entry 变为 destroyed 状态，拒绝后续 acquire
    expect(() => router.acquire('tab-1', 'agent')).toThrow('网页页签已销毁')
  })
})
