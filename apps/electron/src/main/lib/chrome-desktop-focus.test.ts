import { afterEach, describe, expect, test } from 'bun:test'
import { chromeFixture } from './chrome-desktop-test-fixture'
const fixtures: ReturnType<typeof chromeFixture>[] = []
function fixture() { const f = chromeFixture(); fixtures.push(f); return f }
afterEach(() => { for (const f of fixtures.splice(0)) f.service.releaseCurrentControl() })

describe('Chrome组件负责焦点恢复，Electron保留会话授权', () => {
  for (const code of ['CHROME_FOCUS_LOST', 'CHROME_GEOMETRY_CHANGED']) test(`Given 组件拒绝${code} When 再观察 Then 不重新授权或断开组件`, async () => {
    const f = fixture(); const { controlId, confirm } = await f.begin(); await confirm()
    const image = await f.observe(controlId)
    f.component.onInput = async () => { throw new Error(`${code}: 原生窗口检查失败`) }
    await expect(f.call('ChromeDesktopPress', 'failed', { controlId, frameId: image.frame.frameId, key: 'Enter' })).rejects.toThrow(code)
    expect(f.service.getSessionState()?.state).toBe('paused'); expect(f.component.cancels).toBe(0)
    f.component.onInput = async () => {}
    const next = await f.observe(controlId, 'recover')
    await f.call('ChromeDesktopPress', 'input', { controlId, frameId: next.frame.frameId, key: 'Enter' })
    expect(f.service.getSessionState()?.state).toBe('active'); expect(f.component.connectCalls).toBe(1)
  })
  test('Given 原生输入超时 When 工具结束 Then 明确结果未知并取消组件，不能返回成功', async () => {
    const f = fixture(); const { controlId, confirm } = await f.begin(); await confirm(); const image = await f.observe(controlId)
    f.component.onInput = async () => { throw new Error('CHROME_ACTION_UNCERTAIN: 原生调用超时') }
    await expect(f.call('ChromeDesktopClick', 'timeout', { controlId, frameId: image.frame.frameId, x: 10, y: 10 })).rejects.toThrow('CHROME_ACTION_UNCERTAIN')
    expect(f.component.cancels).toBe(1); expect(f.service.getSessionState()?.state).toBe('paused')
  })
})
