import { describe, expect, spyOn, test } from 'bun:test'
import { ChromeDesktopService } from './chrome-desktop-service'
import type { IChromeDesktopHelperClient } from './chrome-desktop-helper-client'
import type { ChromeDesktopToolName } from '@copis/shared'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function fixture() {
  const bounds = { x: 0, y: 0, width: 1000, height: 600 }
  const target = { windowId: 101, pid: 2001, title: '测试窗口', bounds }
  let clicks = 0
  let cancellations = 0
  const helper: IChromeDesktopHelperClient = {
    isAvailable: () => true,
    start: async () => {}, stop: () => {},
    checkPermissions: async () => ({ accessibility: true, screenRecording: true, helperPath: '/test/helper' }),
    listWindows: async () => [target],
    activateWindow: async () => ({ ok: true, bounds }),
    getWindowBounds: async () => ({ ok: true, bounds }),
    checkTarget: async () => ({ ok: true, bounds }),
    click: async () => { clicks++; return { ok: true } },
    scroll: async () => ({ ok: true }), type: async () => ({ ok: true }), press: async () => ({ ok: true }),
    cancel: async () => { cancellations++ },
  }
  const service = new ChromeDesktopService({
    helperClient: helper,
    getScreenAccessStatus: () => true,
    captureFrame: async () => ({ width: 1000, height: 600, capturedAt: Date.now(), data: '/9j/AA==' }),
    registerGlobalShortcut: () => true, unregisterGlobalShortcut: () => {}, setBackgroundThrottling: () => {},
  })
  const call = (toolName: ChromeDesktopToolName, toolCallId: string, toolInput: Record<string, unknown> = {}, sessionId = 'A', capabilityToken = 'token-A') =>
    service.handleToolRequest({ sessionId, capabilityToken, toolName, toolCallId, toolInput })
  const begin = async (sessionId = 'A', token = 'token-A') => {
    const result = await call('ChromeDesktopStart', `start-${sessionId}`, {}, sessionId, token)
    if (result.kind !== 'json') throw new Error('开始回执无效')
    const controlId = result.value.controlId as string
    return { controlId, confirm: () => service.confirmStart({ sessionId, controlId, windowId: 101, pid: 2001 }) }
  }
  const observe = async (controlId: string, id = 'observe-A') => {
    const result = await call('ChromeDesktopObserve', id, { controlId })
    if (result.kind !== 'image') throw new Error('观察回执无效')
    return result.frame.frameId
  }
  return { service, helper, call, begin, observe, bounds, get clicks() { return clicks }, get cancellations() { return cancellations } }
}

describe('Chrome desktop 取消与可信边界', () => {
  const actions: Array<{
    tool: ChromeDesktopToolName
    method: 'click' | 'scroll' | 'type' | 'press'
    input: Record<string, unknown>
  }> = [
    { tool: 'ChromeDesktopClick', method: 'click', input: { x: 10, y: 10 } },
    { tool: 'ChromeDesktopScroll', method: 'scroll', input: { x: 10, y: 10, deltaY: 100 } },
    { tool: 'ChromeDesktopType', method: 'type', input: { text: '测试输入' } },
    { tool: 'ChromeDesktopPress', method: 'press', input: { key: 'Cmd+L' } },
  ]

  for (const ageMs of [38_000, 108_000, 600_000]) {
    for (const { tool, method, input } of actions) {
      test(`Given 观察后模型耗时 ${ageMs / 1000} 秒 When ${tool} 复用同一帧 Then 不受时间或使用次数限制`, async () => {
        const f = fixture()
        const { controlId, confirm } = await f.begin()
        await confirm()
        const frameId = await f.observe(controlId)
        const inputSpy = spyOn(f.helper, method)
        const cancellationsBefore = f.cancellations
        const clock = spyOn(Date, 'now').mockReturnValue(Date.now() + ageMs)
        try {
          const response = await f.call(tool, 'delayed-input', { ...input, controlId, frameId })
          expect(response).toMatchObject({ kind: 'json', value: { ok: true } })
          expect(inputSpy).toHaveBeenCalledTimes(1)
          expect(f.cancellations).toBe(cancellationsBefore)
          expect(f.service.getSessionState()?.state).toBe('active')

          const reused = await f.call(tool, 'reused-frame-input', { ...input, controlId, frameId })
          expect(reused).toMatchObject({ kind: 'json', value: { ok: true } })
          expect(inputSpy).toHaveBeenCalledTimes(2)

          const freshFrameId = await f.observe(controlId, 'observe-fresh')
          const next = await f.call(tool, 'fresh-input', { ...input, controlId, frameId: freshFrameId })
          expect(next).toMatchObject({ kind: 'json', value: { ok: true } })
          expect(inputSpy).toHaveBeenCalledTimes(3)
        } finally {
          clock.mockRestore()
          inputSpy.mockRestore()
          f.service.releaseCurrentControl()
        }
      })
    }
  }

  test('Given 同一观察帧 When 连续发送快捷键、文本、点击和滚动 Then 无需在每次操作间重新 Observe', async () => {
    const f = fixture()
    const { controlId, confirm } = await f.begin()
    await confirm()
    const frameId = await f.observe(controlId)
    const pressed = spyOn(f.helper, 'press')
    const typed = spyOn(f.helper, 'type')
    const scrolled = spyOn(f.helper, 'scroll')
    try {
      const sequence: Array<{ tool: ChromeDesktopToolName; input: Record<string, unknown> }> = [
        { tool: 'ChromeDesktopPress', input: { key: 'Cmd+L' } },
        { tool: 'ChromeDesktopType', input: { text: 'https://example.com' } },
        { tool: 'ChromeDesktopPress', input: { key: 'Enter' } },
        { tool: 'ChromeDesktopClick', input: { x: 10, y: 10 } },
        { tool: 'ChromeDesktopClick', input: { x: 20, y: 20 } },
        { tool: 'ChromeDesktopScroll', input: { x: 20, y: 20, deltaY: 100 } },
      ]
      for (const [index, { tool, input }] of sequence.entries()) {
        const response = await f.call(tool, `sequence-${index}`, { ...input, controlId, frameId })
        expect(response).toMatchObject({ kind: 'json', value: { ok: true } })
      }
      expect(pressed).toHaveBeenCalledTimes(2)
      expect(typed).toHaveBeenCalledTimes(1)
      expect(scrolled).toHaveBeenCalledTimes(1)
      expect(f.clicks).toBe(2)
    } finally {
      pressed.mockRestore()
      typed.mockRestore()
      scrolled.mockRestore()
      f.service.releaseCurrentControl()
    }
  })

  test('Given 新 Observe 已替换旧帧 When 旧 frameId 用于输入 Then 即使没有时间期限也不得复用旧帧', async () => {
    const f = fixture()
    const { controlId, confirm } = await f.begin()
    await confirm()
    try {
      const oldFrameId = await f.observe(controlId, 'observe-old')
      const latestFrameId = await f.observe(controlId, 'observe-latest')
      await expect(f.call('ChromeDesktopClick', 'old-frame-click', { controlId, frameId: oldFrameId, x: 10, y: 10 }))
        .rejects.toThrow('CHROME_FRAME_STALE')
      expect(f.clicks).toBe(0)
      const response = await f.call('ChromeDesktopClick', 'latest-frame-click', { controlId, frameId: latestFrameId, x: 10, y: 10 })
      expect(response).toMatchObject({ kind: 'json', value: { ok: true } })
      expect(f.clicks).toBe(1)
    } finally {
      f.service.releaseCurrentControl()
    }
  })

  for (const captureFailure of ['expired', 'static']) {
    test(`Given ${captureFailure} 观察帧 When Observe 拒绝该帧 Then 保留连接但不允许复用旧输入帧`, async () => {
      const f = fixture()
      const { controlId, confirm } = await f.begin()
      await confirm()
      const oldFrameId = await f.observe(controlId)
      f.service.setFrameCapturer(async () => {
        if (captureFailure === 'static') throw new Error('CHROME_FRAME_STALE: 视频源暂未呈现新帧')
        return { width: 1000, height: 600, capturedAt: Date.now() - 3000, data: '/9j/AA==' }
      })
      try {
        await expect(f.observe(controlId, 'observe-stale')).rejects.toThrow('CHROME_FRAME_STALE')
        expect(f.service.getSessionState()?.state).toBe('active')
        await expect(f.call('ChromeDesktopClick', 'old-click', { controlId, frameId: oldFrameId, x: 10, y: 10 }))
          .rejects.toThrow('CHROME_FRAME_STALE')
        expect(f.clicks).toBe(0)

        f.service.setFrameCapturer(async () => ({ width: 1000, height: 600, capturedAt: Date.now(), data: '/9j/AA==' }))
        expect(await f.observe(controlId, 'observe-retry')).not.toBe(oldFrameId)
      } finally {
        f.service.releaseCurrentControl()
      }
    })
  }

  test('Given A 已缓存图片 When B 重用 toolCallId Then 拒绝跨会话读取', async () => {
    const f = fixture()
    const { controlId, confirm } = await f.begin()
    await confirm(); await f.observe(controlId)
    await expect(f.call('ChromeDesktopObserve', 'observe-A', { controlId }, 'B', 'token-B')).rejects.toThrow('CHROME_CAPABILITY_STALE')
    f.service.releaseCurrentControl()
  })

  test('Given 缓存属于旧 token When 同会话新 token 重试 Then 缓存不能绕过能力校验', async () => {
    const f = fixture()
    const { controlId, confirm } = await f.begin()
    await confirm(); await f.observe(controlId)
    await expect(f.call('ChromeDesktopObserve', 'observe-A', { controlId }, 'A', 'token-new')).rejects.toThrow('CHROME_CAPABILITY_STALE')
    f.service.releaseCurrentControl()
  })

  test('Given 激活仍在等待 When 用户停止 Then 迟到激活不得恢复 active', async () => {
    const f = fixture()
    const activation = deferred<{ ok: boolean; bounds: typeof f.bounds }>()
    f.helper.activateWindow = () => activation.promise
    const { controlId, confirm } = await f.begin()
    const pending = confirm()
    f.service.releaseSessionControl('A', 'token-A', controlId)
    activation.resolve({ ok: true, bounds: f.bounds })
    expect((await pending).ok).toBe(false)
    expect(f.service.getSessionState()?.state).not.toBe('active')
  })

  test('Given 动作正在核对目标 When 控制取消 Then 迟到检查不得投递点击', async () => {
    const f = fixture()
    const { controlId, confirm } = await f.begin(); await confirm()
    const frameId = await f.observe(controlId)
    const checked = deferred<{ ok: boolean; bounds: typeof f.bounds }>()
    f.helper.checkTarget = () => checked.promise
    const action = f.call('ChromeDesktopClick', 'click-A', { controlId, frameId, x: 10, y: 10 })
    const outcome = action.then(() => 'input-sent', (error: Error) => error.message)
    f.service.releaseCurrentControl()
    checked.resolve({ ok: true, bounds: f.bounds })
    expect(await outcome).toContain('CHROME_CAPABILITY_STALE')
    expect(f.clicks).toBe(0)
  })

  test('Given 首次点击尚在检查 When 同帧第二次点击到达 Then 在 await 前占用串行锁', async () => {
    const f = fixture()
    const { controlId, confirm } = await f.begin(); await confirm()
    const frameId = await f.observe(controlId)
    const checked = deferred<{ ok: boolean; bounds: typeof f.bounds }>()
    f.helper.checkTarget = () => checked.promise
    const first = f.call('ChromeDesktopClick', 'click-1', { controlId, frameId, x: 10, y: 10 })
    const second = f.call('ChromeDesktopClick', 'click-2', { controlId, frameId, x: 10, y: 10 })
    const secondOutcome = second.then(() => 'input-sent', (error: Error) => error.message)
    checked.resolve({ ok: true, bounds: f.bounds })
    await first
    expect(await secondOutcome).toContain('CHROME_BUSY')
    expect(f.clicks).toBe(1)
    f.service.releaseCurrentControl()
  })

  test('Given 视频取帧失败 When Observe 返回错误 Then 暂停并撤销旧帧输入', async () => {
    const f = fixture()
    const { controlId, confirm } = await f.begin(); await confirm()
    const frameId = await f.observe(controlId)
    f.service.setFrameCapturer(async () => { throw new Error('CHROME_CAPTURE_FAILED: 流失效') })
    await expect(f.call('ChromeDesktopObserve', 'observe-failed', { controlId })).rejects.toThrow('CHROME_CAPTURE_FAILED')
    expect(f.service.getSessionState()?.state).toBe('paused')
    await expect(f.call('ChromeDesktopClick', 'old-frame', { controlId, frameId, x: 10, y: 10 })).rejects.toThrow()
    expect(f.clicks).toBe(0)
    f.service.releaseCurrentControl()
  })

  test('Given A 拥有控制 When B 提供 A 的 controlId 请求 Stop Then 不影响 A', async () => {
    const f = fixture()
    const { controlId, confirm } = await f.begin(); await confirm()
    // 即使内部调用给出相同 token，也必须核对 session。
    await f.call('ChromeDesktopStop', 'stop-B', { controlId }, 'B', 'token-A')
    expect(f.service.getSessionState()?.state).toBe('active')
    f.service.releaseCurrentControl()
  })

  for (const coordinates of [{ x: 1000, y: 10 }, { x: 10.5, y: 10 }, { x: NaN, y: 10 }, {}]) {
    test(`Given 非法图片坐标 ${JSON.stringify(coordinates)} When Click Then 不投递`, async () => {
      const f = fixture()
      const { controlId, confirm } = await f.begin(); await confirm()
      const frameId = await f.observe(controlId)
      await expect(f.call('ChromeDesktopClick', 'invalid', { controlId, frameId, ...coordinates })).rejects.toThrow()
      expect(f.clicks).toBe(0)
      f.service.releaseCurrentControl()
    })
  }
})
