import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import type { ChromeDesktopToolName } from '@copis/shared'
import { chromeFixture, deferred } from './chrome-desktop-test-fixture'
const fixtures: ReturnType<typeof chromeFixture>[] = []
function fixture() { const f = chromeFixture(); fixtures.push(f); return f }
afterEach(() => { for (const f of fixtures.splice(0)) f.service.releaseCurrentControl() })
const actions: Array<{ tool: ChromeDesktopToolName; input: Record<string, unknown> }> = [
  { tool: 'ChromeDesktopClick', input: { x: 10, y: 10 } },
  { tool: 'ChromeDesktopScroll', input: { x: 10, y: 10, deltaY: 100 } },
  { tool: 'ChromeDesktopType', input: { text: '测试输入' } },
  { tool: 'ChromeDesktopPress', input: { key: 'Cmd+L' } },
]
describe('Chrome 组件授权、取消与帧复用边界', () => {
  for (const age of [38_000, 108_000, 600_000]) for (const action of actions) {
    test(`Given 帧已过去${age}ms When ${action.tool}多次输入 Then 没有硬超时和一次消费限制`, async () => {
      const f = fixture(); const { controlId, confirm } = await f.begin(); await confirm(); const frame = await f.observe(controlId)
      const clock = spyOn(Date, 'now').mockReturnValue(Date.now() + age)
      try {
        for (let n = 0; n < 3; n++) await f.call(action.tool, `action-${n}`, { ...action.input, controlId, frameId: frame.frame.frameId })
        expect(f.component.inputCalls).toHaveLength(3); expect(f.component.cancels).toBe(0)
      } finally { clock.mockRestore() }
    })
  }
  for (const action of actions) test(`Given ${action.tool}仍在途 When 停止控制 Then 迟到回执不能恢复active`, async () => {
    const f = fixture(); const { controlId, confirm } = await f.begin(); await confirm(); const frame = await f.observe(controlId)
    const gate = deferred<void>(); f.component.onInput = () => gate.promise
    const pending = f.call(action.tool, 'action', { ...action.input, controlId, frameId: frame.frame.frameId }).catch((error: Error) => error.message)
    f.service.releaseCurrentControl(); gate.resolve()
    expect(await pending).toContain('CHROME_CAPABILITY_STALE'); expect(f.service.getSessionState()).toBeNull()
  })
  test('Given 异步连接已提交 When 用户停止 Then 迟到连接不能重新取得控制', async () => {
    const f = fixture(); const connection = deferred<typeof f.component.target>(); f.component.onConnect = () => connection.promise
    const { confirm } = await f.begin(); const pending = confirm()
    await Promise.resolve(); f.service.releaseCurrentControl(); connection.resolve(f.component.target)
    expect((await pending).ok).toBe(false); expect(f.service.getSessionState()).toBeNull()
  })
  test('Given 图片已缓存 When session/token/control任一不匹配 Then 读取和输入都拒绝', async () => {
    const f = fixture(); const { controlId, confirm } = await f.begin(); await confirm(); const frame = await f.observe(controlId)
    for (const [session, token, id] of [['B', 'token-A', controlId], ['A', 'bad-token', controlId], ['A', 'token-A', 'wrong-control']]) {
      await expect(f.call('ChromeDesktopObserve', 'observe', { controlId: id }, session, token)).rejects.toThrow('CHROME_CAPABILITY_STALE')
      await expect(f.call('ChromeDesktopPress', 'press', { controlId: id, frameId: frame.frame.frameId, key: 'Enter' }, session, token)).rejects.toThrow('CHROME_CAPABILITY_STALE')
    }
    expect(f.component.inputCalls).toHaveLength(0)
  })
  for (const input of [{ x: 1600, y: 10 }, { x: 10.5, y: 10 }, { x: NaN, y: 10 }, {}, { x: 10, y: -1 }, { x: 10, y: 10, clickCount: 3 }]) {
    test(`Given 非法坐标/次数${JSON.stringify(input)} When Click Then 不进入组件输入`, async () => {
      const f = fixture(); const { controlId, confirm } = await f.begin(); await confirm(); const image = await f.observe(controlId)
      await expect(f.call('ChromeDesktopClick', 'bad', { controlId, frameId: image.frame.frameId, ...input })).rejects.toThrow()
      expect(f.component.inputCalls).toHaveLength(0)
    })
  }
  for (const [tool, input] of [['ChromeDesktopScroll', { x: 10, y: 10, deltaY: 0 }], ['ChromeDesktopScroll', { x: 10, y: 10, deltaY: 2000 }], ['ChromeDesktopType', { text: 'Hello\u0000World' }], ['ChromeDesktopType', { text: '' }], ['ChromeDesktopPress', { key: 'Cmd+Q' }]] as const) {
    test(`Given 非法${tool}参数 When 请求 Then 不投递原生输入`, async () => {
      const f = fixture(); const { controlId, confirm } = await f.begin(); await confirm(); const image = await f.observe(controlId)
      await expect(f.call(tool, 'invalid', { controlId, frameId: image.frame.frameId, ...input })).rejects.toThrow()
      expect(f.component.inputCalls).toHaveLength(0)
    })
  }
  test('Given 原生采集失败 When Observe Then 旧帧不可继续输入', async () => {
    const f = fixture(); const { controlId, confirm } = await f.begin(); await confirm(); const image = await f.observe(controlId)
    f.component.onObserve = async () => { throw new Error('CHROME_CAPTURE_FAILED: 采集服务已退出') }
    await expect(f.observe(controlId, 'failed')).rejects.toThrow('CHROME_CAPTURE_FAILED')
    await expect(f.call('ChromeDesktopPress', 'old', { controlId, frameId: image.frame.frameId, key: 'Enter' })).rejects.toThrow()
    expect(f.component.inputCalls).toHaveLength(0)
  })
})
