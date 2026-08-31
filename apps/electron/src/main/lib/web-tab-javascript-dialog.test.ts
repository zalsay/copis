import { afterEach, describe, expect, mock, test } from 'bun:test'
import type { JavascriptDialogOpeningInput, JavascriptDialogResult } from './web-tab-javascript-dialog'

const showMessageBox = mock(async (_hostWindow: unknown, _options: Record<string, unknown>) => ({ response: 0 }))

mock.module('electron', () => ({
  app: { isPackaged: false },
  BrowserWindow: class {},
  dialog: { showMessageBox },
}))

type Listener = (...args: unknown[]) => void

class FakeDebugger {
  attached = false
  destroyed = false
  pageEnabled = false
  enforcePageDomain = false
  currentDialog: { type: string; message: string } | undefined
  readonly handledDialogs: Array<{ message: string; accept: boolean }> = []
  readonly sendCommand = mock(async (method: string, params?: Record<string, unknown>) => {
    if (method === 'Page.enable') {
      this.pageEnabled = true
      return undefined
    }
    if (method === 'Page.handleJavaScriptDialog') this.handleCurrentDialog(params)
    return undefined
  })
  private listeners = new Map<string, Listener[]>()

  on(event: string, listener: Listener): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener])
    return this
  }

  removeListener(event: string, listener: Listener): this {
    this.listeners.set(event, (this.listeners.get(event) ?? []).filter((item) => item !== listener))
    return this
  }

  isAttached(): boolean { return this.attached }

  attach(): void { this.attached = true }

  handleCurrentDialog(params?: Record<string, unknown>): void {
    if (!this.currentDialog) throw new Error('没有 current dialog')
    this.handledDialogs.push({ message: this.currentDialog.message, accept: params?.accept === true })
    this.currentDialog = undefined
  }

  emit(event: string, ...args: unknown[]): void {
    if (event === 'message' && args[1] === 'Page.javascriptDialogOpening' && args[2] && typeof args[2] === 'object') {
      if (this.enforcePageDomain && !this.pageEnabled) return
      const params = args[2] as Record<string, unknown>
      this.currentDialog = { type: String(params.type), message: String(params.message) }
    }
    if (event === 'message' && args[1] === 'Page.javascriptDialogClosed') this.currentDialog = undefined
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args)
  }

  destroy(): void {
    this.destroyed = true
    this.emit('detach', {}, 'target_closed')
  }
}

const flushPromises = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
  await Promise.resolve()
}

function createBridgeHarness(options: { enforcePageDomain?: boolean } = {}) {
  const debuggerInstance = new FakeDebugger()
  debuggerInstance.enforcePageDomain = options.enforcePageDomain === true
  const present = mock<(input: JavascriptDialogOpeningInput, signal?: AbortSignal) => Promise<JavascriptDialogResult>>(async () => ({ accept: true }))
  const bridge = createWebTabJavascriptDialogBridge({
    debugger: debuggerInstance,
    attach: () => debuggerInstance.attach(),
    isDestroyed: () => debuggerInstance.destroyed,
    presenter: { present },
  })
  return { debuggerInstance, present, bridge }
}

const { createWebTabJavascriptDialogBridge } = await import('./web-tab-javascript-dialog')

describe('网页 JavaScript 对话框 CDP bridge', () => {
  const bridges: Array<{ dispose: () => void }> = []

  afterEach(() => {
    for (const bridge of bridges.splice(0)) bridge.dispose()
  })

  test('Given accept 命令失败且 current dialog 仍存在 When bridge 恢复 Then 重新启用 Page 并只发送拒绝处理', async () => {
    const { debuggerInstance, present, bridge } = createBridgeHarness({ enforcePageDomain: true })
    let rejectAccept = true
    debuggerInstance.sendCommand.mockImplementation(async (method, params) => {
      if (method === 'Page.enable') {
        debuggerInstance.pageEnabled = true
        return undefined
      }
      if (method === 'Page.handleJavaScriptDialog' && params?.accept === true && rejectAccept) {
        rejectAccept = false
        debuggerInstance.attached = false
        throw new Error('accept 暂时失败')
      }
      if (method === 'Page.handleJavaScriptDialog') debuggerInstance.handleCurrentDialog(params)
      return undefined
    })
    present.mockResolvedValue({ accept: true })
    bridges.push(bridge)
    await bridge.start()

    debuggerInstance.emit('message', {}, 'Page.javascriptDialogOpening', {
      type: 'alert', message: '需要恢复', hasBrowserHandler: false,
    })
    await flushPromises()

    expect(debuggerInstance.sendCommand.mock.calls.map(([method, params]) => [method, params])).toEqual([
      ['Page.enable', undefined],
      ['Page.handleJavaScriptDialog', { accept: true }],
      ['Page.enable', undefined],
      ['Page.handleJavaScriptDialog', { accept: false }],
    ])
    expect(debuggerInstance.handledDialogs).toEqual([{ message: '需要恢复', accept: false }])
    expect(debuggerInstance.currentDialog).toBeUndefined()
  })

  test('Given start 初次 Page.enable 失败 When 有界重试随后成功 Then 后续 dialog 仍可展示并处理', async () => {
    const { debuggerInstance, present, bridge } = createBridgeHarness({ enforcePageDomain: true })
    let enableAttempts = 0
    debuggerInstance.sendCommand.mockImplementation(async (method, params) => {
      if (method === 'Page.enable') {
        enableAttempts += 1
        if (enableAttempts === 1) throw new Error('Page 暂时不可用')
        debuggerInstance.pageEnabled = true
        return undefined
      }
      if (method === 'Page.handleJavaScriptDialog') debuggerInstance.handleCurrentDialog(params)
      return undefined
    })
    bridges.push(bridge)
    await bridge.start()

    debuggerInstance.emit('message', {}, 'Page.javascriptDialogOpening', {
      type: 'confirm', message: '重试后可用', hasBrowserHandler: false,
    })
    await flushPromises()

    expect(enableAttempts).toBe(2)
    expect(present).toHaveBeenCalledTimes(1)
    expect(debuggerInstance.handledDialogs).toEqual([{ message: '重试后可用', accept: true }])
  })

  test('Given start Page.enable 有界重试耗尽 When 后续 dialog 到达 Then 不发送处理命令且不保留恢复候选', async () => {
    const { debuggerInstance, bridge } = createBridgeHarness({ enforcePageDomain: true })
    let enableAttempts = 0
    debuggerInstance.sendCommand.mockImplementation(async (method) => {
      if (method === 'Page.enable') {
        enableAttempts += 1
        throw new Error('Page 持续不可用')
      }
      throw new Error('不应发送 dialog 命令')
    })
    bridges.push(bridge)
    await bridge.start()

    debuggerInstance.emit('message', {}, 'Page.javascriptDialogOpening', {
      type: 'alert', message: '不可达', hasBrowserHandler: false,
    })
    await flushPromises()

    expect(enableAttempts).toBe(3)
    expect(debuggerInstance.currentDialog).toBeUndefined()
    expect(debuggerInstance.handledDialogs).toEqual([])
    expect(debuggerInstance.sendCommand.mock.calls.some(([method]) => method === 'Page.handleJavaScriptDialog')).toBe(false)
  })

  test('Given 无浏览器处理器的 alert When CDP 事件到达 Then 展示 presenter 并确认 dialog', async () => {
    const { debuggerInstance, present, bridge } = createBridgeHarness()
    bridges.push(bridge)
    await bridge.start()

    debuggerInstance.emit('message', {}, 'Page.javascriptDialogOpening', {
      type: 'alert', message: '已保存', hasBrowserHandler: false,
    })
    await flushPromises()

    expect(present).toHaveBeenCalledWith(expect.objectContaining({ type: 'alert', message: '已保存' }), expect.any(AbortSignal))
    expect(debuggerInstance.sendCommand).toHaveBeenCalledWith('Page.handleJavaScriptDialog', { accept: true })
  })

  test('Given confirm 与 beforeunload When 用户取消 Then CDP 发送 accept=false', async () => {
    const { debuggerInstance, present, bridge } = createBridgeHarness()
    present.mockResolvedValue({ accept: false })
    bridges.push(bridge)
    await bridge.start()

    debuggerInstance.emit('message', {}, 'Page.javascriptDialogOpening', {
      type: 'confirm', message: '确定删除？', hasBrowserHandler: false,
    })
    await flushPromises()
    debuggerInstance.emit('message', {}, 'Page.javascriptDialogOpening', {
      type: 'beforeunload', message: '确定离开？', hasBrowserHandler: false,
    })
    await flushPromises()

    expect(present).toHaveBeenCalledTimes(2)
    expect(debuggerInstance.sendCommand).toHaveBeenNthCalledWith(2, 'Page.handleJavaScriptDialog', { accept: false })
    expect(debuggerInstance.sendCommand).toHaveBeenNthCalledWith(3, 'Page.handleJavaScriptDialog', { accept: false })
  })

  test('Given prompt When 用户确认文本 Then CDP 发送 accept=true 和 promptText', async () => {
    const { debuggerInstance, present, bridge } = createBridgeHarness()
    present.mockResolvedValue({ accept: true, promptText: 'Copis' })
    bridges.push(bridge)
    await bridge.start()

    debuggerInstance.emit('message', {}, 'Page.javascriptDialogOpening', {
      type: 'prompt', message: '请输入名称', defaultPrompt: '默认值', hasBrowserHandler: false,
    })
    await flushPromises()

    expect(present).toHaveBeenCalledWith(expect.objectContaining({
      type: 'prompt', message: '请输入名称', defaultPrompt: '默认值',
    }), expect.any(AbortSignal))
    expect(debuggerInstance.sendCommand).toHaveBeenCalledWith('Page.handleJavaScriptDialog', {
      accept: true,
      promptText: 'Copis',
    })
  })

  test('Given hasBrowserHandler=true When 收到事件 Then 不重复展示或提前处理', async () => {
    const { debuggerInstance, present, bridge } = createBridgeHarness()
    bridges.push(bridge)
    await bridge.start()

    debuggerInstance.emit('message', {}, 'Page.javascriptDialogOpening', {
      type: 'alert', message: '浏览器已处理', hasBrowserHandler: true,
    })
    await flushPromises()

    expect(present).not.toHaveBeenCalled()
    expect(debuggerInstance.sendCommand).not.toHaveBeenCalledWith('Page.handleJavaScriptDialog', expect.anything())
  })

  test('Given 第一个对话框完成并关闭 When 第二个到达 Then 在同一 WebContents 顺序展示', async () => {
    const { debuggerInstance, present, bridge } = createBridgeHarness()
    let releaseFirst: ((result: { accept: boolean }) => void) | undefined
    present
      .mockImplementationOnce(() => new Promise((resolve) => { releaseFirst = resolve }))
      .mockResolvedValueOnce({ accept: true })
    bridges.push(bridge)
    await bridge.start()

    debuggerInstance.emit('message', {}, 'Page.javascriptDialogOpening', {
      type: 'confirm', message: '第一项', hasBrowserHandler: false,
    })
    await flushPromises()
    expect(present).toHaveBeenCalledTimes(1)
    releaseFirst?.({ accept: false })
    await flushPromises()

    debuggerInstance.emit('message', {}, 'Page.javascriptDialogOpening', {
      type: 'alert', message: '第二项', hasBrowserHandler: false,
    })
    await flushPromises()

    expect(present).toHaveBeenCalledTimes(2)
    const calls = present.mock.calls as Array<[JavascriptDialogOpeningInput]>
    expect(calls[0]?.[0]).toMatchObject({ message: '第一项' })
    expect(calls[1]?.[0]).toMatchObject({ message: '第二项' })
  })

  test('Given CDP detach 或 view 销毁 When 对话框未完成 Then 取消且不命令已销毁 debugger', async () => {
    const { debuggerInstance, present, bridge } = createBridgeHarness()
    present.mockImplementation(() => new Promise(() => undefined))
    bridges.push(bridge)
    await bridge.start()

    debuggerInstance.emit('message', {}, 'Page.javascriptDialogOpening', {
      type: 'confirm', message: '等待操作', hasBrowserHandler: false,
    })
    await flushPromises()
    debuggerInstance.destroy()
    await flushPromises()

    expect(debuggerInstance.sendCommand).not.toHaveBeenCalledWith('Page.handleJavaScriptDialog', expect.anything())
    bridge.dispose()
    expect(debuggerInstance.sendCommand).not.toHaveBeenCalledWith('Page.handleJavaScriptDialog', expect.anything())
  })

  test('Given 可恢复的 CDP detach When 对话框正在打开 Then 重连启用 Page 后拒绝 Chromium 对话框', async () => {
    const { debuggerInstance, present, bridge } = createBridgeHarness()
    present.mockImplementation(() => new Promise(() => undefined))
    bridges.push(bridge)
    await bridge.start()

    debuggerInstance.emit('message', {}, 'Page.javascriptDialogOpening', {
      type: 'confirm', message: '等待操作', hasBrowserHandler: false,
    })
    await flushPromises()
    debuggerInstance.attached = false
    debuggerInstance.emit('detach', {}, '意外断开')
    await flushPromises()

    expect(debuggerInstance.sendCommand).toHaveBeenNthCalledWith(2, 'Page.enable')
    expect(debuggerInstance.sendCommand).toHaveBeenCalledTimes(3)
    expect(debuggerInstance.sendCommand).toHaveBeenLastCalledWith('Page.handleJavaScriptDialog', { accept: false })
  })

  test('Given 结果命令已发出但本地 finally 尚未完成 When CDP detach Then 不发送过期拒绝', async () => {
    const { debuggerInstance, present, bridge } = createBridgeHarness()
    let detached = false
    debuggerInstance.sendCommand.mockImplementation(async (method, params) => {
      if (!detached && method === 'Page.handleJavaScriptDialog' && params?.accept === true) {
        detached = true
        debuggerInstance.attached = false
        debuggerInstance.emit('detach', {}, '结果已发出')
      }
    })
    bridges.push(bridge)
    await bridge.start()

    debuggerInstance.emit('message', {}, 'Page.javascriptDialogOpening', {
      type: 'alert', message: '已发送结果', hasBrowserHandler: false,
    })
    await flushPromises()

    expect(present).toHaveBeenCalledTimes(1)
    expect(debuggerInstance.sendCommand).not.toHaveBeenCalledWith('Page.handleJavaScriptDialog', { accept: false })
  })

  test('Given detach 快速重复且重连期间出现新 dialog When reconnect Then 不得把旧拒绝作用于新的 current dialog', async () => {
    const { debuggerInstance, present, bridge } = createBridgeHarness()
    present.mockImplementation(() => new Promise(() => undefined))
    bridges.push(bridge)
    await bridge.start()

    debuggerInstance.emit('message', {}, 'Page.javascriptDialogOpening', {
      type: 'confirm', message: '旧 dialog', hasBrowserHandler: false,
    })
    await flushPromises()

    let pageEnableCalls = 0
    let releaseReconnect: (() => void) | undefined
    debuggerInstance.sendCommand.mockImplementation((method, params) => {
      if (method !== 'Page.enable') {
        if (method === 'Page.handleJavaScriptDialog') debuggerInstance.handleCurrentDialog(params)
        return Promise.resolve(undefined)
      }
      pageEnableCalls += 1
      if (pageEnableCalls === 1) {
        return new Promise<undefined>((resolve) => { releaseReconnect = () => resolve(undefined) })
      }
      return Promise.resolve(undefined)
    })
    debuggerInstance.attached = false
    debuggerInstance.emit('detach', {}, '第一次断开')
    await flushPromises()
    debuggerInstance.emit('detach', {}, '第二次断开')
    present.mockResolvedValue({ accept: true })
    releaseReconnect?.()
    debuggerInstance.emit('message', {}, 'Page.javascriptDialogOpening', {
      type: 'alert', message: '新 dialog', hasBrowserHandler: false,
    })
    await flushPromises()

    expect(pageEnableCalls).toBe(1)
    expect(debuggerInstance.sendCommand.mock.calls.filter(([, params]) => params?.accept === false)).toHaveLength(0)
    expect(debuggerInstance.sendCommand).toHaveBeenCalledWith('Page.handleJavaScriptDialog', { accept: true })
    expect(debuggerInstance.handledDialogs).toEqual([{ message: '新 dialog', accept: true }])
  })

  test('Given 旧 dialog detach 后重连中出现新 dialog When reconnect completes Then 旧候选失效且新 dialog 使用自身 presenter 结果', async () => {
    const { debuggerInstance, present, bridge } = createBridgeHarness()
    present
      .mockImplementationOnce(() => new Promise(() => undefined))
      .mockResolvedValueOnce({ accept: true })
    bridges.push(bridge)
    await bridge.start()

    debuggerInstance.emit('message', {}, 'Page.javascriptDialogOpening', {
      type: 'confirm', message: '旧 dialog', hasBrowserHandler: false,
    })
    await flushPromises()

    let releaseReconnect: (() => void) | undefined
    debuggerInstance.sendCommand.mockImplementation((method, params) => {
      if (method !== 'Page.enable') {
        if (method === 'Page.handleJavaScriptDialog') debuggerInstance.handleCurrentDialog(params)
        return Promise.resolve(undefined)
      }
      return new Promise<undefined>((resolve) => { releaseReconnect = () => resolve(undefined) })
    })
    debuggerInstance.attached = false
    debuggerInstance.emit('detach', {}, '旧 dialog 断开')
    await flushPromises()

    debuggerInstance.emit('message', {}, 'Page.javascriptDialogOpening', {
      type: 'alert', message: '新 dialog', hasBrowserHandler: false,
    })
    releaseReconnect?.()
    await flushPromises()

    expect(debuggerInstance.sendCommand).not.toHaveBeenCalledWith('Page.handleJavaScriptDialog', { accept: false })
    expect(debuggerInstance.sendCommand).toHaveBeenCalledWith('Page.handleJavaScriptDialog', { accept: true })
    expect(debuggerInstance.sendCommand.mock.calls.filter(([, params]) => params?.accept === false)).toHaveLength(0)
    expect(debuggerInstance.sendCommand.mock.calls.filter(([, params]) => params?.accept === true)).toHaveLength(1)
    expect(debuggerInstance.handledDialogs).toEqual([{ message: '新 dialog', accept: true }])
    expect(present).toHaveBeenNthCalledWith(2, expect.objectContaining({ message: '新 dialog' }), expect.any(AbortSignal))
  })

  test('Given detach 后恢复候选存在 When 新的浏览器处理器 Opening 到达 Then 不得拒绝新的 current dialog', async () => {
    const { debuggerInstance, present, bridge } = createBridgeHarness()
    present.mockImplementation(() => new Promise(() => undefined))
    bridges.push(bridge)
    await bridge.start()

    debuggerInstance.emit('message', {}, 'Page.javascriptDialogOpening', {
      type: 'confirm', message: '旧 dialog', hasBrowserHandler: false,
    })
    await flushPromises()

    let releaseEnable: (() => void) | undefined
    debuggerInstance.sendCommand.mockImplementation((method, params) => {
      if (method === 'Page.enable') return new Promise<undefined>((resolve) => { releaseEnable = () => resolve(undefined) })
      if (method === 'Page.handleJavaScriptDialog') {
        debuggerInstance.handleCurrentDialog(params)
      }
      return Promise.resolve(undefined)
    })
    debuggerInstance.attached = false
    debuggerInstance.emit('detach', {}, '旧 dialog 断开')
    await flushPromises()

    debuggerInstance.emit('message', {}, 'Page.javascriptDialogOpening', {
      type: 'alert', message: '浏览器处理中的新 dialog', hasBrowserHandler: true,
    })
    releaseEnable?.()
    await flushPromises()

    expect(debuggerInstance.currentDialog?.message).toBe('浏览器处理中的新 dialog')
    expect(debuggerInstance.sendCommand.mock.calls.filter(([, params]) => params?.accept === false)).toHaveLength(0)
  })

  test('Given detach 后恢复候选存在 When javascriptDialogClosed 到达 Then 清除候选且不发送恢复拒绝', async () => {
    const { debuggerInstance, present, bridge } = createBridgeHarness()
    present.mockImplementation(() => new Promise(() => undefined))
    bridges.push(bridge)
    await bridge.start()

    debuggerInstance.emit('message', {}, 'Page.javascriptDialogOpening', {
      type: 'confirm', message: '旧 dialog', hasBrowserHandler: false,
    })
    await flushPromises()

    let releaseEnable: (() => void) | undefined
    debuggerInstance.sendCommand.mockImplementation((method, params) => {
      if (method === 'Page.enable') return new Promise<undefined>((resolve) => { releaseEnable = () => resolve(undefined) })
      if (method === 'Page.handleJavaScriptDialog') {
        debuggerInstance.handleCurrentDialog(params)
      }
      return Promise.resolve(undefined)
    })
    debuggerInstance.attached = false
    debuggerInstance.emit('detach', {}, '旧 dialog 断开')
    await flushPromises()
    debuggerInstance.emit('message', {}, 'Page.javascriptDialogClosed', {})
    releaseEnable?.()
    await flushPromises()

    expect(debuggerInstance.currentDialog).toBeUndefined()
    expect(debuggerInstance.sendCommand.mock.calls.filter(([, params]) => params?.accept === false)).toHaveLength(0)
  })

  test('Given 旧恢复拒绝命令仍在执行 When 新对话框再次 detach Then 旧链完成后继续恢复最新候选', async () => {
    const { debuggerInstance, present, bridge } = createBridgeHarness()
    present.mockImplementation(() => new Promise(() => undefined))
    bridges.push(bridge)
    await bridge.start()

    debuggerInstance.emit('message', {}, 'Page.javascriptDialogOpening', {
      type: 'confirm', message: '旧 dialog', hasBrowserHandler: false,
    })
    await flushPromises()

    let recoveryDismissals = 0
    let releaseFirstDismissal: (() => void) | undefined
    debuggerInstance.sendCommand.mockImplementation((method, params) => {
      if (method === 'Page.enable') return Promise.resolve(undefined)
      if (method === 'Page.handleJavaScriptDialog' && params?.accept === false) {
        recoveryDismissals += 1
        debuggerInstance.handleCurrentDialog(params)
        if (recoveryDismissals === 1) {
          return new Promise<undefined>((resolve) => { releaseFirstDismissal = () => resolve(undefined) })
        }
      }
      return Promise.resolve(undefined)
    })

    debuggerInstance.attached = false
    debuggerInstance.emit('detach', {}, '旧 dialog 断开')
    await flushPromises()
    expect(recoveryDismissals).toBe(1)
    expect(debuggerInstance.handledDialogs).toEqual([{ message: '旧 dialog', accept: false }])

    debuggerInstance.emit('message', {}, 'Page.javascriptDialogOpening', {
      type: 'alert', message: '新 dialog', hasBrowserHandler: false,
    })
    await flushPromises()
    debuggerInstance.attached = false
    debuggerInstance.emit('detach', {}, '新 dialog 断开')
    await flushPromises()

    expect(recoveryDismissals).toBe(1)
    releaseFirstDismissal?.()
    await flushPromises()

    expect(recoveryDismissals).toBe(2)
    expect(debuggerInstance.handledDialogs).toEqual([
      { message: '旧 dialog', accept: false },
      { message: '新 dialog', accept: false },
    ])
  })

  test('Given Page.enable 连续失败 When detach recovery 重试耗尽 Then 有界结束并清理候选', async () => {
    const { debuggerInstance, present, bridge } = createBridgeHarness()
    present.mockImplementation(() => new Promise(() => undefined))
    bridges.push(bridge)
    await bridge.start()

    debuggerInstance.emit('message', {}, 'Page.javascriptDialogOpening', {
      type: 'confirm', message: '等待恢复', hasBrowserHandler: false,
    })
    await flushPromises()
    debuggerInstance.sendCommand.mockImplementation(async (method) => {
      if (method === 'Page.enable') throw new Error('暂时不可用')
      return undefined
    })
    debuggerInstance.attached = false
    debuggerInstance.emit('detach', {}, '重连失败')
    await flushPromises()
    await new Promise((resolve) => setTimeout(resolve, 30))

    const enableCalls = debuggerInstance.sendCommand.mock.calls.filter(([method]) => method === 'Page.enable')
    expect(enableCalls.length).toBeGreaterThan(1)
    expect(enableCalls.length).toBeLessThanOrEqual(4)

    debuggerInstance.attached = false
    debuggerInstance.emit('detach', {}, '候选应已清理')
    await flushPromises()
    expect(debuggerInstance.sendCommand.mock.calls.filter(([, params]) => params?.accept === false)).toHaveLength(0)
  })

  test('Given 旧候选的 Page.enable 三次失败 When 新候选等待后续恢复 Then 只拒绝新 current dialog', async () => {
    const { debuggerInstance, present, bridge } = createBridgeHarness()
    present.mockImplementation(() => new Promise(() => undefined))
    bridges.push(bridge)
    await bridge.start()

    debuggerInstance.emit('message', {}, 'Page.javascriptDialogOpening', {
      type: 'confirm', message: '已耗尽候选', hasBrowserHandler: false,
    })
    await flushPromises()

    let recoveryEnableCalls = 0
    let releaseThirdFailure: (() => void) | undefined
    debuggerInstance.sendCommand.mockImplementation(async (method, params) => {
      if (method === 'Page.enable') {
        recoveryEnableCalls += 1
        if (recoveryEnableCalls <= 2) throw new Error('暂时不可用')
        if (recoveryEnableCalls === 3) {
          await new Promise<void>((_, reject) => {
            releaseThirdFailure = () => reject(new Error('暂时不可用'))
          })
        }
      }
      if (method === 'Page.handleJavaScriptDialog') debuggerInstance.handleCurrentDialog(params)
      return undefined
    })
    debuggerInstance.attached = false
    debuggerInstance.emit('detach', {}, '旧候选恢复中')
    await flushPromises()

    expect(recoveryEnableCalls).toBe(3)
    debuggerInstance.emit('message', {}, 'Page.javascriptDialogOpening', {
      type: 'alert', message: '新候选', hasBrowserHandler: false,
    })
    await flushPromises()
    debuggerInstance.attached = false
    debuggerInstance.emit('detach', {}, '新候选等待恢复')
    await flushPromises()
    releaseThirdFailure?.()
    await flushPromises()
    await new Promise((resolve) => setTimeout(resolve, 0))
    await flushPromises()

    debuggerInstance.attached = false
    debuggerInstance.emit('detach', {}, '后续恢复')
    await flushPromises()
    await new Promise((resolve) => setTimeout(resolve, 0))
    await flushPromises()

    expect(recoveryEnableCalls).toBeGreaterThanOrEqual(4)
    expect(debuggerInstance.currentDialog).toBeUndefined()
    expect(debuggerInstance.handledDialogs).toEqual([{ message: '新候选', accept: false }])
    expect(debuggerInstance.handledDialogs).not.toContainEqual({ message: '已耗尽候选', accept: false })
  })

  test('Given 原生 alert When presenter 收到 signal Then message box 使用同一 signal 并在 abort 时取消', async () => {
    const hostWindow = { isDestroyed: () => false, webContents: { isDestroyed: () => false } }
    let rejectMessageBox: ((error: Error) => void) | undefined
    showMessageBox.mockImplementationOnce(async (_window, options) => {
      const signal = options.signal as AbortSignal
      expect(signal).toBeInstanceOf(AbortSignal)
      return new Promise((_, reject) => {
        rejectMessageBox = reject
        signal.addEventListener('abort', () => reject(new Error('message box aborted')), { once: true })
      })
    })
    const { createDefaultJavascriptDialogPresenter } = await import('./web-tab-javascript-dialog')
    const presenter = createDefaultJavascriptDialogPresenter(hostWindow as never)
    const controller = new AbortController()
    const resultPromise = presenter.present({ type: 'alert', message: '可取消' }, controller.signal)
    controller.abort()
    rejectMessageBox?.(new Error('message box aborted'))
    await expect(resultPromise).resolves.toEqual({ accept: false })
    expect(showMessageBox).toHaveBeenCalledWith(hostWindow, expect.objectContaining({ signal: controller.signal }))
  })

  test('Given 旧 dialog detach 后重连中出现的新 dialog 又被第二次 detach 取消 When 恢复完成并再次断开 Then 不重复拒绝已取消项且后续新 dialog 只使用自身结果', async () => {
    const { debuggerInstance, present, bridge } = createBridgeHarness()
    present
      .mockImplementationOnce(() => new Promise(() => undefined))
      .mockImplementationOnce(() => new Promise(() => undefined))
      .mockResolvedValueOnce({ accept: true })
    bridges.push(bridge)
    await bridge.start()

    debuggerInstance.emit('message', {}, 'Page.javascriptDialogOpening', {
      type: 'confirm', message: '旧 dialog', hasBrowserHandler: false,
    })
    await flushPromises()

    let releaseReconnect: (() => void) | undefined
    let pageEnableCalls = 1
    debuggerInstance.sendCommand.mockImplementation((method) => {
      if (method !== 'Page.enable') return Promise.resolve(undefined)
      pageEnableCalls += 1
      if (pageEnableCalls === 2) {
        return new Promise<undefined>((resolve) => { releaseReconnect = () => resolve(undefined) })
      }
      return Promise.resolve(undefined)
    })
    debuggerInstance.attached = false
    debuggerInstance.emit('detach', {}, '旧 dialog 断开')
    await flushPromises()

    debuggerInstance.emit('message', {}, 'Page.javascriptDialogOpening', {
      type: 'alert', message: '重连中的新 dialog', hasBrowserHandler: false,
    })
    await flushPromises()
    expect(present).toHaveBeenCalledTimes(2)

    debuggerInstance.emit('detach', {}, '新 dialog 断开')
    releaseReconnect?.()
    await flushPromises()

    expect(debuggerInstance.sendCommand.mock.calls.filter(([, params]) => params?.accept === false)).toHaveLength(1)

    debuggerInstance.attached = false
    debuggerInstance.emit('detach', {}, '恢复后再次断开')
    await flushPromises()

    expect(debuggerInstance.sendCommand.mock.calls.filter(([, params]) => params?.accept === false)).toHaveLength(1)

    debuggerInstance.emit('message', {}, 'Page.javascriptDialogOpening', {
      type: 'alert', message: '恢复后的新 dialog', hasBrowserHandler: false,
    })
    await flushPromises()

    expect(present).toHaveBeenNthCalledWith(3, expect.objectContaining({ message: '恢复后的新 dialog' }), expect.any(AbortSignal))
    expect(debuggerInstance.sendCommand).toHaveBeenCalledWith('Page.handleJavaScriptDialog', { accept: true })
    expect(debuggerInstance.sendCommand.mock.calls.filter(([, params]) => params?.accept === false)).toHaveLength(1)
  })

  test('Given bridge dispose When prompt presenter 未完成 Then 通过窄 signal 取消 presenter', async () => {
    const { debuggerInstance, present, bridge } = createBridgeHarness()
    let presenterSignal: AbortSignal | undefined
    present.mockImplementation((_input, signal) => {
      presenterSignal = signal
      return new Promise(() => undefined)
    })
    await bridge.start()
    debuggerInstance.emit('message', {}, 'Page.javascriptDialogOpening', {
      type: 'prompt', message: '输入', hasBrowserHandler: false,
    })
    await flushPromises()

    bridge.dispose()
    expect(presenterSignal?.aborted).toBe(true)
  })

  test('Given CDP 意外 detach When debugger 重新可用 Then 重新 attach 并启用 Page 域', async () => {
    const { debuggerInstance, bridge } = createBridgeHarness()
    bridges.push(bridge)
    await bridge.start()
    debuggerInstance.attached = false

    debuggerInstance.emit('detach', {}, '意外断开')
    await flushPromises()

    expect(debuggerInstance.attached).toBe(true)
    expect(debuggerInstance.sendCommand).toHaveBeenCalledTimes(2)
    expect(debuggerInstance.sendCommand).toHaveBeenLastCalledWith('Page.enable')
  })
})
