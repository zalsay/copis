import { afterEach, describe, expect, mock, test } from 'bun:test'
import type { JavascriptDialogOpeningInput, JavascriptDialogResult } from './web-tab-javascript-dialog'

mock.module('electron', () => ({
  app: { isPackaged: false },
  BrowserWindow: class {},
  dialog: { showMessageBox: mock(async () => ({ response: 0 })) },
}))

type Listener = (...args: unknown[]) => void

class FakeDebugger {
  attached = false
  destroyed = false
  readonly sendCommand = mock(async (_method: string, _params?: Record<string, unknown>) => undefined)
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

  emit(event: string, ...args: unknown[]): void {
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

function createBridgeHarness() {
  const debuggerInstance = new FakeDebugger()
  const present = mock<(input: JavascriptDialogOpeningInput) => Promise<JavascriptDialogResult>>(async () => ({ accept: true }))
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

  test('Given 无浏览器处理器的 alert When CDP 事件到达 Then 展示 presenter 并确认 dialog', async () => {
    const { debuggerInstance, present, bridge } = createBridgeHarness()
    bridges.push(bridge)
    await bridge.start()

    debuggerInstance.emit('message', {}, 'Page.javascriptDialogOpening', {
      type: 'alert', message: '已保存', hasBrowserHandler: false,
    })
    await flushPromises()

    expect(present).toHaveBeenCalledWith(expect.objectContaining({ type: 'alert', message: '已保存' }))
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
    }))
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

  test('Given 第一个对话框未完成 When 第二个到达 Then 在同一 WebContents 顺序展示', async () => {
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
    debuggerInstance.emit('message', {}, 'Page.javascriptDialogOpening', {
      type: 'alert', message: '第二项', hasBrowserHandler: false,
    })
    await flushPromises()
    expect(present).toHaveBeenCalledTimes(1)
    releaseFirst?.({ accept: false })
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
