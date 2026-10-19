import { afterEach, describe, expect, test } from 'bun:test'
import { chromeFixture } from './chrome-desktop-test-fixture'
const fixtures: ReturnType<typeof chromeFixture>[] = []
function fixture() { const value = chromeFixture(); fixtures.push(value); return value }
afterEach(() => { for (const f of fixtures.splice(0)) f.service.releaseCurrentControl() })

describe('Chrome 桌面工具组件服务 BDD', () => {
  test('Given A正在等待用户选择 When B发起Start Then 返回忙碌且不更换控制', async () => {
    const f = fixture(); const a = await f.begin()
    expect(await f.call('ChromeDesktopStart', 'B', {}, 'B', 'token-B')).toMatchObject({ kind: 'json', value: { error: 'CHROME_BUSY' } })
    expect(f.service.getSessionState()?.controlId).toBe(a.controlId)
  })
  test('Given 相同Start轮询 When 已选择并连接窗口 Then 复用同一个control和连接', async () => {
    const f = fixture(); const a = await f.begin(); await a.confirm()
    expect(await f.call('ChromeDesktopStart', 'next-turn')).toMatchObject({ kind: 'json', value: { status: 'active', controlId: a.controlId } })
    expect(f.component.connectCalls).toBe(1)
    expect(f.component.inputCalls).toHaveLength(0)
  })
  test('Given 开始预览绑定 When confirm Then 使用同PID窗口且保持observe模式', async () => {
    const f = fixture(); const { controlId, confirm } = await f.begin()
    expect(f.service.prepareCapture({ sessionId: 'A', controlId, windowId: 101, pid: 2001 })).toEqual({ ok: true })
    expect(f.service.getPendingCaptureTarget()).toEqual({ controlId, windowId: 101, pid: 2001 })
    expect(await confirm()).toEqual({ ok: true })
    expect(f.service.getSessionState()).toMatchObject({ mode: 'observe', state: 'active' })
    expect(f.service.getPendingCaptureTarget()).toEqual({ controlId, windowId: 101, pid: 2001 })
    expect(f.throttling).toBe(false)
  })
  test('Given 输入动作 When 调用组件 Then 保留图片坐标，不在Electron重复映射或激活', async () => {
    const f = fixture(); const { controlId, confirm } = await f.begin(); await confirm()
    const image = await f.observe(controlId)
    await f.call('ChromeDesktopClick', 'click', { controlId, frameId: image.frame.frameId, x: 800, y: 600, clickCount: 2 })
    expect(f.component.inputCalls).toEqual([{ frameId: image.frame.frameId, action: { action: 'click', x: 800, y: 600, clickCount: 2 } }])
    expect(f.service.getSessionState()?.mode).toBe('control')
  })
  test('Given 全局停止快捷键被占用 When confirm Then 不连接组件', async () => {
    const f = fixture(); f.setRegister(false); const { confirm } = await f.begin()
    expect(await confirm()).toMatchObject({ ok: false, error: 'CHROME_STOP_SHORTCUT_UNAVAILABLE' })
    expect(f.component.connectCalls).toBe(0)
  })
  test('Given 同一工具回执缓存 When 入参相同重试 Then 不再输入，参数碰撞明确拒绝', async () => {
    const f = fixture(); const { controlId, confirm } = await f.begin(); await confirm(); const image = await f.observe(controlId)
    const input = { controlId, frameId: image.frame.frameId, text: '中文' }
    await f.call('ChromeDesktopType', 'type', input)
    await f.call('ChromeDesktopType', 'type', input)
    expect(f.component.inputCalls).toHaveLength(1)
    await expect(f.call('ChromeDesktopType', 'type', { ...input, text: '其他' })).rejects.toThrow('CHROME_TOOL_CALL_COLLISION')
  })
  test('Given 原生图片已缓存 When 同一Observe重试 Then 返回完整图片而不重复采集', async () => {
    const f = fixture(); const { controlId, confirm } = await f.begin(); await confirm()
    const first = await f.observe(controlId); const retry = await f.observe(controlId)
    expect(retry).toEqual(first); expect(f.component.observeCalls).toBe(1)
    await f.call('ChromeDesktopPress', 'enter', { controlId, frameId: first.frame.frameId, key: 'Enter' })
    await expect(f.observe(controlId)).rejects.toThrow('CHROME_ACTION_UNCERTAIN')
  })
  test('Given 已连接 When 操作其他窗口标识或重复confirm Then 不替换连接', async () => {
    const f = fixture(); const { controlId, confirm } = await f.begin(); await confirm()
    expect(await confirm()).toMatchObject({ ok: false, error: 'CHROME_BUSY' })
    expect(f.service.prepareCapture({ sessionId: 'A', controlId, windowId: 999, pid: 123 })).toMatchObject({ ok: false })
    expect(f.component.connectCalls).toBe(1)
  })
  test('Given 组件返回错误窗口 When confirm Then 不进入active且立即清理', async () => {
    const f = fixture(); f.component.onConnect = async () => ({ ...f.component.target, pid: 999 })
    const { confirm } = await f.begin()
    expect(await confirm()).toMatchObject({ ok: false, error: 'CHROME_WINDOW_UNAVAILABLE' })
    expect(f.service.getSessionState()?.state).toBe('error'); expect(f.component.cancels).toBeGreaterThan(0)
  })
  test.skipIf(process.platform !== 'darwin')('Given 系统权限来自组件 When 检查状态 Then 返回组件版本和真实权限', async () => {
    const f = fixture(); f.component.permissions.screenRecording = false
    expect(await f.service.checkSystemStatus()).toMatchObject({ supported: true, screenRecordingGranted: false, accessibilityGranted: true, componentVersion: '0.1.0' })
  })
  test.skipIf(process.platform !== 'darwin')('Given 组件未安装且下载失败 When 检查状态 Then 返回明确失败而不是支持成功', async () => {
    const f = fixture(); f.component.checkPermissions = async () => { throw new Error('CHROME_HELPER_FAILED: 请在功能模块设置重试安装') }
    const status = await f.service.checkSystemStatus()
    expect(status.supported).toBe(false); expect(status.error).toContain('功能模块')
  })
  test('Given 旧turn迟到清理 When 新control已建立 Then 不取消当前连接', async () => {
    const f = fixture(); const old = await f.begin(); await old.confirm(); f.service.releaseCurrentControl()
    const current = await f.begin('A', 'token-new', 'new'); await current.confirm()
    const before = f.component.cancels
    f.service.releaseSessionControl('A', 'token-A', old.controlId)
    expect(f.component.cancels).toBe(before)
    expect(f.service.getSessionState()?.controlId).toBe(current.controlId)
  })
  test('Given B提交A的Stop或错误token When 请求到达 Then 保留A连接', async () => {
    const f = fixture(); const { controlId, confirm } = await f.begin(); await confirm()
    await f.call('ChromeDesktopStop', 'B-stop', { controlId }, 'B', 'token-A')
    await f.call('ChromeDesktopStop', 'wrong-token', { controlId }, 'A', 'token-other')
    expect(f.service.getSessionState()?.state).toBe('active'); expect(f.component.cancels).toBe(0)
  })
  test('Given 用户显式停止 When 重复Stop Then 幂等返回且不影响新连接', async () => {
    const f = fixture(); const old = await f.begin(); await old.confirm()
    await f.call('ChromeDesktopStop', 'stop', { controlId: old.controlId })
    expect(f.service.getSessionState()).toBeNull()
    const current = await f.begin('A', 'token-A', 'again'); await current.confirm()
    await f.call('ChromeDesktopStop', 'old-stop', { controlId: old.controlId })
    expect(f.service.getSessionState()?.controlId).toBe(current.controlId)
  })
})
