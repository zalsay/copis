import { describe, expect, it, beforeEach } from 'bun:test'
import {
  ChromeDesktopService,
  type ChromeDesktopServiceDependencies,
} from './chrome-desktop-service'
import type {
  ChromeDesktopAllowedKey,
  ChromeDesktopBounds,
  ChromeDesktopWindowInfo,
} from '@copis/shared'
import type { IChromeDesktopHelperClient } from './chrome-desktop-helper-client'

class MockHelperClient implements IChromeDesktopHelperClient {
  public focusLost = false
  public geometryChanged = false
  public currentBounds: ChromeDesktopBounds = { x: 100, y: 100, width: 800, height: 600 }
  public clicked: { x: number; y: number; count: number }[] = []
  public typedTexts: string[] = []
  public pressedKeys: string[] = []
  public scrolledDeltaY: number[] = []
  public cancelled = false

  isAvailable(): boolean {
    return true
  }
  async start(): Promise<void> {}
  stop(): void {}
  async checkPermissions() {
    return { accessibility: true, screenRecording: true, helperPath: '/mock/helper' }
  }
  async listWindows(): Promise<ChromeDesktopWindowInfo[]> {
    return [
      { windowId: 101, pid: 2001, title: 'Google Chrome', bounds: { ...this.currentBounds } },
    ]
  }
  async activateWindow(windowId: number, pid: number) {
    return { ok: true, bounds: { ...this.currentBounds } }
  }
  async checkTarget(windowId: number, pid: number) {
    if (this.focusLost) {
      return { ok: false, error: 'CHROME_FOCUS_LOST' }
    }
    if (this.geometryChanged) {
      return { ok: true, bounds: { x: 200, y: 200, width: 900, height: 700 } }
    }
    return { ok: true, bounds: { ...this.currentBounds } }
  }
  async click(windowId: number, pid: number, screenX: number, screenY: number, clickCount = 1) {
    this.clicked.push({ x: screenX, y: screenY, count: clickCount })
    return { ok: true }
  }
  async scroll(windowId: number, pid: number, screenX: number, screenY: number, deltaY: number) {
    this.scrolledDeltaY.push(deltaY)
    return { ok: true }
  }
  async type(windowId: number, pid: number, text: string) {
    this.typedTexts.push(text)
    return { ok: true }
  }
  async press(windowId: number, pid: number, key: ChromeDesktopAllowedKey) {
    this.pressedKeys.push(key)
    return { ok: true }
  }
  async cancel() {
    this.cancelled = true
  }
}

describe('ChromeDesktopService BDD Scenarios', () => {
  let mockHelper: MockHelperClient
  let service: ChromeDesktopService
  let throttlingState: boolean | null = null
  let registeredShortcutCallback: (() => void) | null = null

  beforeEach(() => {
    mockHelper = new MockHelperClient()
    throttlingState = null
    registeredShortcutCallback = null

    service = new ChromeDesktopService({
      helperClient: mockHelper,
      registerGlobalShortcut: (_shortcut, cb) => {
        registeredShortcutCallback = cb
        return true
      },
      unregisterGlobalShortcut: () => {
        registeredShortcutCallback = null
      },
      setBackgroundThrottling: (enabled) => {
        throttlingState = enabled
      },
      captureFrame: async () => ({
        width: 1600,
        height: 1200,
        capturedAt: Date.now(),
        data: 'fake-base64-image-jpeg',
      }),
    })
  })

  it('Scenario: Global mutual exclusion (Session A busy blocks Session B)', async () => {
    // 会话 A 请求 Start
    const respA = await service.handleToolRequest({
      sessionId: 'session-A',
      capabilityToken: 'tok-a',
      toolCallId: 'call-1',
      toolName: 'ChromeDesktopStart',
      toolInput: {},
    })

    expect(respA.kind).toBe('json')
    if (respA.kind === 'json') {
      expect(respA.value.status).toBe('awaiting_user')
      expect(typeof respA.value.controlId).toBe('string')
    }

    // 会话 B 请求 Start -> CHROME_BUSY
    const respB = await service.handleToolRequest({
      sessionId: 'session-B',
      capabilityToken: 'tok-b',
      toolCallId: 'call-2',
      toolName: 'ChromeDesktopStart',
      toolInput: {},
    })

    expect(respB.kind).toBe('json')
    if (respB.kind === 'json') {
      expect(respB.value.error).toBe('CHROME_BUSY')
    }
  })

  it('Scenario: Full control lifecycle (Start -> User Confirm -> Observe -> Click -> Next action requires Observe)', async () => {
    // 1. Start
    const startResp = await service.handleToolRequest({
      sessionId: 'session-1',
      capabilityToken: 'tok-1',
      toolCallId: 'call-1',
      toolName: 'ChromeDesktopStart',
      toolInput: {},
    })
    const controlId = startResp.kind === 'json' ? (startResp.value.controlId as string) : ''
    expect(controlId).toBeTruthy()

    // 2. User confirms window selection in UI
    const confirmResult = await service.confirmStart({
      sessionId: 'session-1',
      controlId,
      windowId: 101,
      pid: 2001,
    })
    expect(confirmResult.ok).toBe(true)
    expect(throttlingState).toBe(false) // 后台节流已关闭
    expect(service.getSessionState()?.state).toBe('active')

    // 3. Worker poll returns active
    const pollResp = await service.handleToolRequest({
      sessionId: 'session-1',
      capabilityToken: 'tok-1',
      toolCallId: 'call-1',
      toolName: 'ChromeDesktopStart',
      toolInput: {},
    })
    expect(pollResp.kind === 'json' && pollResp.value.status).toBe('active')

    // 4. Agent calls Observe
    const observeResp = await service.handleToolRequest({
      sessionId: 'session-1',
      capabilityToken: 'tok-1',
      toolCallId: 'call-obs-1',
      toolName: 'ChromeDesktopObserve',
      toolInput: { controlId },
    })
    expect(observeResp.kind).toBe('image')
    if (observeResp.kind !== 'image') return

    expect(observeResp.frame.controlId).toBe(controlId)
    expect(observeResp.frame.width).toBe(1600)
    expect(observeResp.frame.height).toBe(1200)
    expect(observeResp.image.data).toBe('fake-base64-image-jpeg')
    const frameId = observeResp.frame.frameId

    // 5. Agent clicks at (800, 600) on 1600x1200 frame
    // Window bounds: { x: 100, y: 100, width: 800, height: 600 }
    // Expected screenX: 100 + (800/1600)*800 = 500
    // Expected screenY: 100 + (600/1200)*600 = 400
    const clickResp = await service.handleToolRequest({
      sessionId: 'session-1',
      capabilityToken: 'tok-1',
      toolCallId: 'call-click-1',
      toolName: 'ChromeDesktopClick',
      toolInput: { controlId, frameId, x: 800, y: 600, clickCount: 1 },
    })
    expect(clickResp.kind).toBe('json')
    expect(mockHelper.clicked.length).toBe(1)
    const firstClicked = mockHelper.clicked[0]
    expect(firstClicked?.x).toBe(500)
    expect(firstClicked?.y).toBe(400)

    // 6. Same frameId CANNOT be used again without a new Observe
    expect(
      service.handleToolRequest({
        sessionId: 'session-1',
        capabilityToken: 'tok-1',
        toolCallId: 'call-click-2',
        toolName: 'ChromeDesktopClick',
        toolInput: { controlId, frameId, x: 800, y: 600 },
      }),
    ).rejects.toThrow('CHROME_FRAME_STALE')
  })

  it('Scenario: Focus lost immediately stops input and enters paused', async () => {
    // 启动并激活
    const startResp = await service.handleToolRequest({
      sessionId: 'session-focus',
      capabilityToken: 'tok',
      toolCallId: 'call-1',
      toolName: 'ChromeDesktopStart',
      toolInput: {},
    })
    const controlId = startResp.kind === 'json' ? (startResp.value.controlId as string) : ''
    await service.confirmStart({ sessionId: 'session-focus', controlId, windowId: 101, pid: 2001 })

    // Observe
    const obs = await service.handleToolRequest({
      sessionId: 'session-focus',
      capabilityToken: 'tok',
      toolCallId: 'call-obs',
      toolName: 'ChromeDesktopObserve',
      toolInput: { controlId },
    })
    const frameId = obs.kind === 'image' ? obs.frame.frameId : ''

    // 模拟焦点丢失
    mockHelper.focusLost = true

    // 尝试点击 -> 失败并进入 paused
    await expect(
      service.handleToolRequest({
        sessionId: 'session-focus',
        capabilityToken: 'tok',
        toolCallId: 'call-click',
        toolName: 'ChromeDesktopClick',
        toolInput: { controlId, frameId, x: 100, y: 100 },
      }),
    ).rejects.toThrow('CHROME_FOCUS_LOST')

    expect(service.getSessionState()?.state).toBe('paused')
    expect(service.getSessionState()?.pauseReason).toBe('CHROME_FOCUS_LOST')
    expect(throttlingState).toBe(true) // 恢复节流
  })

  it('Scenario: Emergency stop shortcut cancels input and cleans up', async () => {
    const startResp = await service.handleToolRequest({
      sessionId: 'session-emg',
      capabilityToken: 'tok',
      toolCallId: 'call-1',
      toolName: 'ChromeDesktopStart',
      toolInput: {},
    })
    const controlId = startResp.kind === 'json' ? (startResp.value.controlId as string) : ''
    await service.confirmStart({ sessionId: 'session-emg', controlId, windowId: 101, pid: 2001 })

    expect(registeredShortcutCallback).not.toBeNull()

    // 触发全局快捷键
    registeredShortcutCallback?.()

    expect(mockHelper.cancelled).toBe(true)
    expect(service.getSessionState()?.state).toBe('paused')
    expect(service.getSessionState()?.pauseReason).toBe('CHROME_CANCELLED')
  })

  it('Scenario: Input validation guards against invalid parameters', async () => {
    const startResp = await service.handleToolRequest({
      sessionId: 'session-val',
      capabilityToken: 'tok',
      toolCallId: 'call-1',
      toolName: 'ChromeDesktopStart',
      toolInput: {},
    })
    const controlId = startResp.kind === 'json' ? (startResp.value.controlId as string) : ''
    await service.confirmStart({ sessionId: 'session-val', controlId, windowId: 101, pid: 2001 })

    const obs = await service.handleToolRequest({
      sessionId: 'session-val',
      capabilityToken: 'tok',
      toolCallId: 'call-obs',
      toolName: 'ChromeDesktopObserve',
      toolInput: { controlId },
    })
    const frameId = obs.kind === 'image' ? obs.frame.frameId : ''

    // 非法 deltaY
    await expect(
      service.handleToolRequest({
        sessionId: 'session-val',
        capabilityToken: 'tok',
        toolCallId: 'call-s1',
        toolName: 'ChromeDesktopScroll',
        toolInput: { controlId, frameId, x: 100, y: 100, deltaY: 2000 },
      }),
    ).rejects.toThrow('deltaY')

    // 非法控制字符
    await expect(
      service.handleToolRequest({
        sessionId: 'session-val',
        capabilityToken: 'tok',
        toolCallId: 'call-t1',
        toolName: 'ChromeDesktopType',
        toolInput: { controlId, frameId, text: 'Hello\u0000World' },
      }),
    ).rejects.toThrow('控制字符')

    // 非法 key
    await expect(
      service.handleToolRequest({
        sessionId: 'session-val',
        capabilityToken: 'tok',
        toolCallId: 'call-p1',
        toolName: 'ChromeDesktopPress',
        toolInput: { controlId, frameId, key: 'F13' },
      }),
    ).rejects.toThrow('不允许的按键')
  })

  it('Scenario: Stale run release protection (old capabilityToken cannot release new run)', async () => {
    // 启动新 run，token 为 'tok-new'
    const startResp = await service.handleToolRequest({
      sessionId: 'session-stale',
      capabilityToken: 'tok-new',
      toolCallId: 'call-1',
      toolName: 'ChromeDesktopStart',
      toolInput: {},
    })
    const controlId = startResp.kind === 'json' ? (startResp.value.controlId as string) : ''
    await service.confirmStart({ sessionId: 'session-stale', controlId, windowId: 101, pid: 2001 })

    expect(service.getSessionState()?.state).toBe('active')

    // 旧 run 迟到调用 releaseSessionControl，传入 'tok-old'
    service.releaseSessionControl('session-stale', 'tok-old')
    // 新 run 的活跃状态不受任何影响！
    expect(service.getSessionState()?.state).toBe('active')

    // 正确的 token 传入 -> 释放成功
    service.releaseSessionControl('session-stale', 'tok-new')
    expect(service.getSessionState()).toBeNull()
  })

  it('Scenario: actionHistory idempotency, parameter hash verification, and memory clearance', async () => {
    const startResp = await service.handleToolRequest({
      sessionId: 'session-cache',
      capabilityToken: 'tok',
      toolCallId: 'call-1',
      toolName: 'ChromeDesktopStart',
      toolInput: {},
    })
    const controlId = startResp.kind === 'json' ? (startResp.value.controlId as string) : ''
    await service.confirmStart({ sessionId: 'session-cache', controlId, windowId: 101, pid: 2001 })

    // Observe
    const obsResp = await service.handleToolRequest({
      sessionId: 'session-cache',
      capabilityToken: 'tok',
      toolCallId: 'call-obs',
      toolName: 'ChromeDesktopObserve',
      toolInput: { controlId },
    })
    const frameId = obsResp.kind === 'image' ? obsResp.frame.frameId : ''

    // 执行 Click 动作
    const clickInput = { controlId, frameId, x: 800, y: 600, clickCount: 1 }
    const firstClick = await service.handleToolRequest({
      sessionId: 'session-cache',
      capabilityToken: 'tok',
      toolCallId: 'call-click-1',
      toolName: 'ChromeDesktopClick',
      toolInput: clickInput,
    })
    expect(firstClick.kind).toBe('json')
    expect(mockHelper.clicked.length).toBe(1)

    // 重放相同 toolCallId 且相同入参 -> 直接命中幂等缓存，不会调用底层 helper（clicked.length 仍为 1）
    const secondClick = await service.handleToolRequest({
      sessionId: 'session-cache',
      capabilityToken: 'tok',
      toolCallId: 'call-click-1',
      toolName: 'ChromeDesktopClick',
      toolInput: clickInput,
    })
    expect(secondClick).toEqual(firstClick)
    expect(mockHelper.clicked.length).toBe(1)

    // 重放相同 toolCallId 但不同入参 -> 抛出 CHROME_TOOL_CALL_COLLISION 冲突拒绝
    await expect(
      service.handleToolRequest({
        sessionId: 'session-cache',
        capabilityToken: 'tok',
        toolCallId: 'call-click-1',
        toolName: 'ChromeDesktopClick',
        toolInput: { controlId, frameId, x: 500, y: 500, clickCount: 1 },
      }),
    ).rejects.toThrow('CHROME_TOOL_CALL_COLLISION')

    // 释放控制后，actionHistory 被全部清空
    service.releaseSessionControl('session-cache', 'tok')
    expect(service.getSessionState()).toBeNull()
  })

  it('Scenario: Screen access status reflects Electron permission status', async () => {
    let mockScreenGranted = false
    const customService = new ChromeDesktopService({
      helperClient: mockHelper,
      getScreenAccessStatus: () => mockScreenGranted,
    })

    if (process.platform === 'darwin') {
      const status1 = await customService.checkSystemStatus()
      expect(status1.screenRecordingGranted).toBe(false)
      expect(status1.accessibilityGranted).toBe(true)

      mockScreenGranted = true
      const status2 = await customService.checkSystemStatus()
      expect(status2.screenRecordingGranted).toBe(true)
      expect(status2.accessibilityGranted).toBe(true)
    }
  })

  it('Scenario: Observe idempotent retry returns full image data, not empty base64, and becomes CHROME_ACTION_UNCERTAIN after action', async () => {
    const startResp = await service.handleToolRequest({
      sessionId: 'session-obs-retry',
      capabilityToken: 'tok-obs',
      toolCallId: 'call-start',
      toolName: 'ChromeDesktopStart',
      toolInput: {},
    })
    const controlId = startResp.kind === 'json' ? (startResp.value.controlId as string) : ''
    await service.confirmStart({ sessionId: 'session-obs-retry', controlId, windowId: 101, pid: 2001 })

    // 第一次 Observe
    const obsResp1 = await service.handleToolRequest({
      sessionId: 'session-obs-retry',
      capabilityToken: 'tok-obs',
      toolCallId: 'call-obs-retry',
      toolName: 'ChromeDesktopObserve',
      toolInput: { controlId },
    })
    expect(obsResp1.kind).toBe('image')
    if (obsResp1.kind === 'image') {
      expect(obsResp1.image.data).toBe('fake-base64-image-jpeg')
      expect(obsResp1.image.data.length).toBeGreaterThan(0)
    }

    // 立即重试同一 toolCallId -> 返回相同的完整有效图片，绝不返回空 data: ''
    const obsResp2 = await service.handleToolRequest({
      sessionId: 'session-obs-retry',
      capabilityToken: 'tok-obs',
      toolCallId: 'call-obs-retry',
      toolName: 'ChromeDesktopObserve',
      toolInput: { controlId },
    })
    expect(obsResp2).toEqual(obsResp1)
    if (obsResp2.kind === 'image') {
      expect(obsResp2.image.data).toBe('fake-base64-image-jpeg')
    }

    // 重试相同 toolCallId 但篡改入参 -> CHROME_TOOL_CALL_COLLISION
    await expect(
      service.handleToolRequest({
        sessionId: 'session-obs-retry',
        capabilityToken: 'tok-obs',
        toolCallId: 'call-obs-retry',
        toolName: 'ChromeDesktopObserve',
        toolInput: { controlId: 'different-control-id' },
      }),
    ).rejects.toThrow('CHROME_TOOL_CALL_COLLISION')

    // 执行动作消耗当前帧
    const frameId = obsResp1.kind === 'image' ? obsResp1.frame.frameId : ''
    await service.handleToolRequest({
      sessionId: 'session-obs-retry',
      capabilityToken: 'tok-obs',
      toolCallId: 'call-click-after-obs',
      toolName: 'ChromeDesktopClick',
      toolInput: { controlId, frameId, x: 500, y: 500 },
    })

    // 动作执行后，再次请求之前的 Observe toolCallId -> 报错 CHROME_ACTION_UNCERTAIN，指示 Agent 重新 Observe
    await expect(
      service.handleToolRequest({
        sessionId: 'session-obs-retry',
        capabilityToken: 'tok-obs',
        toolCallId: 'call-obs-retry',
        toolName: 'ChromeDesktopObserve',
        toolInput: { controlId },
      }),
    ).rejects.toThrow('CHROME_ACTION_UNCERTAIN')

    service.releaseSessionControl('session-obs-retry', 'tok-obs')
  })

  it('Scenario: ChromeDesktopStart polling with mismatched capabilityToken returns CHROME_CAPABILITY_STALE', async () => {
    // 首次 Start，携带 token 'tok-gen1'
    const start1 = await service.handleToolRequest({
      sessionId: 'session-poll-stale',
      capabilityToken: 'tok-gen1',
      toolCallId: 'call-poll-start',
      toolName: 'ChromeDesktopStart',
      toolInput: {},
    })
    expect(start1.kind).toBe('json')
    if (start1.kind === 'json') {
      expect(start1.value.status).toBe('awaiting_user')
    }

    // 相同 session + 相同 toolCallId 轮询，携带匹配的 token -> 返回当前状态
    const pollOk = await service.handleToolRequest({
      sessionId: 'session-poll-stale',
      capabilityToken: 'tok-gen1',
      toolCallId: 'call-poll-start',
      toolName: 'ChromeDesktopStart',
      toolInput: {},
    })
    expect(pollOk.kind).toBe('json')
    if (pollOk.kind === 'json') {
      expect(pollOk.value.status).toBe('awaiting_user')
    }

    // 相同 session + 相同 toolCallId 轮询，但携带不匹配的过期 token 'tok-stale' -> 返回 CHROME_CAPABILITY_STALE
    const pollStale = await service.handleToolRequest({
      sessionId: 'session-poll-stale',
      capabilityToken: 'tok-stale',
      toolCallId: 'call-poll-start',
      toolName: 'ChromeDesktopStart',
      toolInput: {},
    })
    expect(pollStale.kind).toBe('json')
    if (pollStale.kind === 'json') {
      expect(pollStale.value.error).toBe('CHROME_CAPABILITY_STALE')
    }

    service.releaseSessionControl('session-poll-stale', 'tok-gen1')
  })
})
