/** Chrome 服务 BDD 使用的组件边界；不采集屏幕、不向系统投递输入。 */
import type { ChromeDesktopBounds, ChromeDesktopToolName, ChromeDesktopWindowInfo } from '@copis/shared'
import { ChromeDesktopService } from './chrome-desktop-service'
import type { ChromeDesktopBackend, ChromeDesktopComponentAction, ChromeDesktopComponentFrame } from './chrome-desktop-component-client'

export function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
export class TestChromeComponent implements ChromeDesktopBackend {
  bounds: ChromeDesktopBounds = { x: 100, y: 100, width: 800, height: 600 }
  target: ChromeDesktopWindowInfo = { windowId: 101, pid: 2001, title: '测试窗口', bounds: this.bounds }
  inputCalls: Array<{ frameId: string; action: ChromeDesktopComponentAction }> = []
  fileSelections: string[] = []
  cancels = 0
  connectCalls = 0
  observeCalls = 0
  permissions = { accessibility: true, screenRecording: true, helperPath: '/managed/helper', componentVersion: '0.1.0' }
  onConnect = async (): Promise<ChromeDesktopWindowInfo> => ({ ...this.target, bounds: { ...this.bounds } })
  onObserve = async (): Promise<ChromeDesktopComponentFrame> => ({ frameId: `native-frame-${this.observeCalls}`, width: 1600, height: 1200, capturedAt: Date.now(), bounds: { ...this.bounds }, data: '/9j/AA==' })
  onInput = async (_frameId: string, _action: ChromeDesktopComponentAction): Promise<void> => {}
  onSelectFile = async (_path: string): Promise<void> => {}
  async checkPermissions() { return this.permissions }
  async listWindows() { return [this.target] }
  async connectWindow(_windowId: number, _pid: number) { this.connectCalls++; return this.onConnect() }
  async observe() { this.observeCalls++; return this.onObserve() }
  async input(frameId: string, action: ChromeDesktopComponentAction) { this.inputCalls.push({ frameId, action }); await this.onInput(frameId, action) }
  async selectFile(path: string) { this.fileSelections.push(path); await this.onSelectFile(path) }
  async disconnect() {}
  async cancel() { this.cancels++ }
  stop() {}
}
export function chromeFixture() {
  const component = new TestChromeComponent()
  let emergency: (() => void) | undefined
  let registerSucceeds = true
  let throttling = true
  const service = new ChromeDesktopService({
    componentClient: component,
    registerGlobalShortcut: (_key, callback) => { emergency = callback; return registerSucceeds },
    unregisterGlobalShortcut: () => {},
    setBackgroundThrottling: enabled => { throttling = enabled },
  })
  const call = (toolName: ChromeDesktopToolName, toolCallId: string, toolInput: Record<string, unknown> = {}, sessionId = 'A', capabilityToken = 'token-A') => service.handleToolRequest({ sessionId, capabilityToken, toolName, toolCallId, toolInput })
  const begin = async (sessionId = 'A', token = 'token-A', toolCallId = `start-${sessionId}`) => {
    const result = await call('ChromeDesktopStart', toolCallId, {}, sessionId, token)
    if (result.kind !== 'json') throw new Error('开始回执无效')
    const controlId = result.value.controlId as string
    return { controlId, confirm: () => service.confirmStart({ sessionId, controlId, windowId: 101, pid: 2001 }) }
  }
  const observe = async (controlId: string, toolCallId = 'observe') => {
    const result = await call('ChromeDesktopObserve', toolCallId, { controlId })
    if (result.kind !== 'image') throw new Error('观察回执无效')
    return result
  }
  return { component, service, call, begin, observe, emergency: () => emergency?.(), setRegister: (allowed: boolean) => { registerSucceeds = allowed }, get throttling() { return throttling } }
}
