import { afterEach, describe, expect, test } from 'bun:test'
import { ChromeDesktopService } from './chrome-desktop-service'
import type { ChromeDesktopBounds, ChromeDesktopToolName, ChromeDesktopToolResponse, ChromeDesktopWindowInfo } from '@copis/shared'
import type { ChromeDesktopBackend, ChromeDesktopComponentAction, ChromeDesktopComponentFrame } from './chrome-desktop-component-client'

const bounds: ChromeDesktopBounds = { x: -300, y: 20, width: 800, height: 600 }
const target: ChromeDesktopWindowInfo = { windowId: 42, pid: 123, title: 'Example', bounds }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
class Backend implements ChromeDesktopBackend {
  inputs: { frameId: string; action: ChromeDesktopComponentAction }[] = []
  cancels = 0
  frameSequence = 0
  capture = async (): Promise<ChromeDesktopComponentFrame> => ({ frameId: `native-${++this.frameSequence}`, width: 1600, height: 1200, capturedAt: 1, bounds, data: '/9j/AA==' })
  connection = async () => target
  inputGate: Promise<void> | null = null
  inputError: Error | null = null
  async checkPermissions() { return { accessibility: true, screenRecording: true, helperPath: '/managed/helper', componentVersion: '0.1.0' } }
  async listWindows() { return [target] }
  async connectWindow() { return this.connection() }
  async observe() { return this.capture() }
  async input(frameId: string, action: ChromeDesktopComponentAction) { this.inputs.push({ frameId, action }); if (this.inputGate) await this.inputGate; if (this.inputError) throw this.inputError }
  async disconnect() {}
  async cancel() { this.cancels++ }
  stop() {}
}
const services: ChromeDesktopService[] = []
afterEach(() => { for (const service of services.splice(0)) service.releaseCurrentControl() })
function fixture() {
  const backend = new Backend()
  let emergency: (() => void) | undefined
  const service = new ChromeDesktopService({
    componentClient: backend,
    registerGlobalShortcut: (_key, callback) => { emergency = callback; return true },
    unregisterGlobalShortcut: () => {}, setBackgroundThrottling: () => {},
  })
  services.push(service)
  const call = (toolName: ChromeDesktopToolName, toolCallId: string, toolInput: Record<string, unknown> = {}, sessionId = 'A', capabilityToken = 'token-A') => service.handleToolRequest({ sessionId, capabilityToken, toolName, toolCallId, toolInput })
  async function start() {
    const response = await call('ChromeDesktopStart', 'start')
    if (response.kind !== 'json') throw new Error('Start 必须返回 JSON')
    const controlId = response.value.controlId as string
    expect(await service.confirmStart({ sessionId: 'A', controlId, windowId: 42, pid: 123 })).toEqual({ ok: true })
    return controlId
  }
  async function observe(controlId: string, id = 'observe'): Promise<Extract<ChromeDesktopToolResponse, { kind: 'image' }>> {
    const response = await call('ChromeDesktopObserve', id, { controlId })
    if (response.kind !== 'image') throw new Error('Observe 必须返回原生图片')
    return response
  }
  return { backend, service, call, start, observe, emergency: () => emergency?.() }
}

describe('内置 Chrome 工具委派可更新组件', () => {
  test('Given 首次停止失败 When 同control再次Stop Then 重试实际取消，确认前不假报成功', async () => {
    const f = fixture(); const controlId = await f.start()
    let attempts = 0
    f.backend.cancel = async () => { attempts++; throw new Error('CHROME_HELPER_FAILED: 尚未停止') }
    for (let n = 0; n < 2; n++) await expect(f.call('ChromeDesktopStop', 'same-stop', { controlId })).rejects.toThrow('CHROME_HELPER_FAILED')
    expect(attempts).toBe(2)
    expect(f.service.getSessionState()).toMatchObject({ controlId, state: 'error' })
    f.backend.cancel = async () => { attempts++ }
    expect(await f.call('ChromeDesktopStop', 'same-stop', { controlId })).toMatchObject({ kind: 'json', value: { ok: true } })
    expect(attempts).toBe(3); expect(f.service.getSessionState()).toBeNull()
  })
  test('Given IPC停止未确认 When 原控制重试 Then 重试清理，另一control不能取消待清理记录', async () => {
    const f = fixture(); const controlId = await f.start()
    let attempts = 0
    f.backend.cancel = async () => { attempts++; throw new Error('CHROME_HELPER_FAILED: 尚未停止') }
    await expect(f.service.stopSessionControl('A', controlId)).rejects.toThrow()
    await f.service.stopSessionControl('B', controlId)
    await f.service.stopSessionControl('A', 'wrong')
    expect(attempts).toBe(1)
    await expect(f.service.stopSessionControl('A', controlId)).rejects.toThrow()
    expect(attempts).toBe(2)
    f.backend.cancel = async () => {}
    await f.service.stopSessionControl('A', controlId)
  })
  test('Given A停止尚未确认 When B或A新Start Then 不能开启新连接，清理成功后才可继续', async () => {
    const f = fixture(); const controlId = await f.start()
    f.backend.cancel = async () => { throw new Error('CHROME_HELPER_FAILED: 尚未停止') }
    await expect(f.call('ChromeDesktopStop', 'stop', { controlId })).rejects.toThrow()
    for (const [session, token] of [['A', 'token-A'], ['B', 'token-B']]) {
      expect(await f.call('ChromeDesktopStart', 'new', {}, session, token)).toMatchObject({ kind: 'json', value: { error: 'CHROME_BUSY' } })
    }
    f.backend.cancel = async () => {}
    await f.call('ChromeDesktopStop', 'retry', { controlId })
    expect(await f.call('ChromeDesktopStart', 'B', {}, 'B', 'token-B')).toMatchObject({ kind: 'json', value: { status: 'awaiting_user' } })
  })

  test('Given 组件未确认停止 When Stop工具返回 Then 明确失败而不是假成功', async () => {
    const f = fixture(); const controlId = await f.start()
    f.backend.cancel = async () => { throw new Error('CHROME_HELPER_FAILED: 组件尚未停止') }
    await expect(f.call('ChromeDesktopStop', 'stop-failed', { controlId })).rejects.toThrow('CHROME_HELPER_FAILED')
    f.backend.cancel = async () => {}
  })

  test('Given 已连接且预览失败 When 同目标请求重试预览 Then 不重新连接或修改授权窗口', async () => {
    const f = fixture(); const controlId = await f.start()
    expect(f.service.prepareCapture({ sessionId: 'A', controlId, windowId: 42, pid: 123 })).toEqual({ ok: true })
    expect(f.service.getPendingCaptureTarget()).toEqual({ controlId, windowId: 42, pid: 123 })
    expect(f.service.getSessionState()?.targetWindow?.bounds).toEqual(bounds)
    expect(f.service.prepareCapture({ sessionId: 'A', controlId, windowId: 99, pid: 123 })).toMatchObject({ ok: false })
  })
  test('Given 只查询过组件权限还没有control When 应用退出 Then 仍清理准备阶段后台进程', async () => {
    const f = fixture(); await f.service.checkSystemStatus()
    await f.service.shutdown()
    expect(f.backend.cancels).toBeGreaterThan(0)
  })

  test('Given 没有renderer采集器 When Observe Then 使用组件JPEG/native frameId，时间戳不使其失效', async () => {
    const f = fixture(); const controlId = await f.start(); const frame = await f.observe(controlId)
    expect(frame.frame.frameId).toBe('native-1')
    expect(frame.image.data).toBe('/9j/AA==')
    for (let n = 0; n < 3; n++) await f.call('ChromeDesktopClick', `click-${n}`, { controlId, frameId: frame.frame.frameId, x: 400, y: 300 })
    expect(f.backend.inputs).toHaveLength(3)
    expect(f.backend.inputs[0]).toEqual({ frameId: 'native-1', action: { action: 'click', x: 400, y: 300, clickCount: 1 } })
  })
  test('Given 有较新的截图 When 复用旧保留帧 Then 继续传递原帧ID且一帧允许多次输入', async () => {
    const f = fixture(); const controlId = await f.start(); const old = await f.observe(controlId)
    await f.observe(controlId, 'newer')
    await f.call('ChromeDesktopPress', 'press-old', { controlId, frameId: old.frame.frameId, key: 'Enter' })
    expect(f.backend.inputs[0]?.frameId).toBe('native-1')
  })
  test('Given 33张截图 When 使用最旧已淘汰帧 Then 不调用组件输入', async () => {
    const f = fixture(); const controlId = await f.start(); const old = await f.observe(controlId)
    for (let n = 0; n < 32; n++) await f.observe(controlId, `next-${n}`)
    await expect(f.call('ChromeDesktopPress', 'oldest', { controlId, frameId: old.frame.frameId, key: 'Enter' })).rejects.toThrow('CHROME_FRAME_STALE')
    expect(f.backend.inputs).toHaveLength(0)
  })
  test('Given 同会话下一轮 When Start Then 不重新选择或确认窗口', async () => {
    const f = fixture(); const controlId = await f.start()
    const response = await f.call('ChromeDesktopStart', 'next-turn')
    expect(response.kind === 'json' && response.value.controlId).toBe(controlId)
    expect(response.kind === 'json' && response.value.status).toBe('active')
  })
  test('Given 组件输入已在途 When 并发工具到达 Then 同步拒绝且紧急停止不等待输入', async () => {
    const f = fixture(); const controlId = await f.start(); const frame = await f.observe(controlId)
    const gate = deferred<void>(); f.backend.inputGate = gate.promise
    const first = f.call('ChromeDesktopPress', 'first', { controlId, frameId: frame.frame.frameId, key: 'Enter' })
    const outcome = first.catch((error: Error) => error.message)
    await expect(f.call('ChromeDesktopPress', 'second', { controlId, frameId: frame.frame.frameId, key: 'Enter' })).rejects.toThrow('CHROME_BUSY')
    f.emergency(); expect(f.backend.cancels).toBeGreaterThan(0)
    gate.resolve(); expect(await outcome).toContain('CHROME_CAPABILITY_STALE')
  })
  test('Given 组件连接尚在建立 When 用户停止 Then 迟到的connect不恢复旧control', async () => {
    const f = fixture(); const gate = deferred<ChromeDesktopWindowInfo>(); f.backend.connection = () => gate.promise
    const started = await f.call('ChromeDesktopStart', 'start')
    const controlId = started.kind === 'json' ? started.value.controlId as string : ''
    const pending = f.service.confirmStart({ sessionId: 'A', controlId, windowId: 42, pid: 123 })
    f.service.releaseCurrentControl(); gate.resolve(target)
    expect((await pending).ok).toBe(false)
    expect(f.service.getSessionState()).toBeNull()
  })
  test('Given 组件报告几何变化 When Observe新帧 Then 复用授权和连接，不cancel组件', async () => {
    const f = fixture(); const controlId = await f.start(); const frame = await f.observe(controlId)
    f.backend.inputError = new Error('CHROME_GEOMETRY_CHANGED: 请重新观察')
    await expect(f.call('ChromeDesktopPress', 'changed', { controlId, frameId: frame.frame.frameId, key: 'Enter' })).rejects.toThrow('CHROME_GEOMETRY_CHANGED')
    expect(f.service.getSessionState()?.state).toBe('paused'); expect(f.backend.cancels).toBe(0)
    f.backend.inputError = null; await f.observe(controlId, 'recover')
    expect(f.service.getSessionState()?.state).toBe('active')
  })
  test('Given 可恢复暂停属于A When B发起Start Then 不能接管A的长期授权', async () => {
    const f = fixture(); const controlId = await f.start(); const frame = await f.observe(controlId)
    f.backend.inputError = new Error('CHROME_FOCUS_LOST: 焦点无法确认')
    await expect(f.call('ChromeDesktopPress', 'lost', { controlId, frameId: frame.frame.frameId, key: 'Enter' })).rejects.toThrow()
    const response = await f.call('ChromeDesktopStart', 'B-start', {}, 'B', 'token-B')
    expect(response.kind === 'json' && response.value.error).toBe('CHROME_BUSY')
  })
  test('Given 已缓存Observe When 其他session或token重放 Then 图片缓存不能越权', async () => {
    const f = fixture(); const controlId = await f.start(); await f.observe(controlId)
    await expect(f.call('ChromeDesktopObserve', 'observe', { controlId }, 'B', 'token-B')).rejects.toThrow('CHROME_CAPABILITY_STALE')
    await expect(f.call('ChromeDesktopObserve', 'observe', { controlId }, 'A', 'new-token')).rejects.toThrow('CHROME_CAPABILITY_STALE')
  })
  test('Given 工具调用已成功 When 同toolCallId重复或碰撞 Then 不重复发送且拒绝不同输入', async () => {
    const f = fixture(); const controlId = await f.start(); const frame = await f.observe(controlId)
    const input = { controlId, frameId: frame.frame.frameId, text: '中文' }
    await f.call('ChromeDesktopType', 'type', input); await f.call('ChromeDesktopType', 'type', input)
    expect(f.backend.inputs).toHaveLength(1)
    await expect(f.call('ChromeDesktopType', 'type', { ...input, text: '不同' })).rejects.toThrow('CHROME_TOOL_CALL_COLLISION')
  })
})
