import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { parseHTML } from 'linkedom'
import * as React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Provider, createStore } from 'jotai'
import { chromeDesktopMediaStreamAtom } from '@/atoms/chrome-desktop-atoms'
import { ChromeDesktopCaptureHost } from './ChromeDesktopCaptureHost'

const act = (React as typeof React & { act: typeof import('react-dom/test-utils').act }).act
let root: Root | null = null

describe('ChromeDesktopCaptureHost requestVideoFrameCallback 序列与静止检测', () => {
  let frameRequestCallback: ((req: { controlId: string; requestId: string; geometryVersion: number }) => void) | null = null
  let sendFrameResponseCalls: any[] = []
  let sendStreamErrorCalls: any[] = []
  let rVfcCallbacks: Array<(now: number, meta: any) => void> = []

  beforeEach(() => {
    const parsed = parseHTML('<html><body><div id="root"></div></body></html>')
    sendFrameResponseCalls = []
    sendStreamErrorCalls = []
    rVfcCallbacks = []
    frameRequestCallback = null

    // Mock HTMLCanvasElement.getContext and toDataURL
    parsed.window.HTMLCanvasElement.prototype.getContext = () => ({
      drawImage: () => {},
    }) as any
    parsed.window.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/jpeg;base64,mockJpegData'

    // Mock video element methods
    let handleSeq = 0
    const activeCallbacks = new Map<number, (now: number, meta: any) => void>()
    const mockPlay = async () => {}
    const mockRvfc = (cb: any) => {
      const handle = ++handleSeq
      activeCallbacks.set(handle, cb)
      rVfcCallbacks.push(cb)
      return handle
    }
    const mockCancelRvfc = (handle: number) => {
      const cb = activeCallbacks.get(handle)
      if (cb) {
        activeCallbacks.delete(handle)
        rVfcCallbacks = rVfcCallbacks.filter((c) => c !== cb)
      }
    }

    if (parsed.window.HTMLVideoElement) {
      parsed.window.HTMLVideoElement.prototype.play = mockPlay
      ;(parsed.window.HTMLVideoElement.prototype as any).requestVideoFrameCallback = mockRvfc
      ;(parsed.window.HTMLVideoElement.prototype as any).cancelVideoFrameCallback = mockCancelRvfc
    }
    if (parsed.window.HTMLMediaElement) {
      parsed.window.HTMLMediaElement.prototype.play = mockPlay
      ;(parsed.window.HTMLMediaElement.prototype as any).requestVideoFrameCallback = mockRvfc
      ;(parsed.window.HTMLMediaElement.prototype as any).cancelVideoFrameCallback = mockCancelRvfc
    }
    ;(parsed.window.HTMLElement.prototype as any).play = mockPlay
    ;(parsed.window.HTMLElement.prototype as any).requestVideoFrameCallback = mockRvfc
    ;(parsed.window.HTMLElement.prototype as any).cancelVideoFrameCallback = mockCancelRvfc

    Object.assign(globalThis, {
      window: parsed.window,
      document: parsed.window.document,
      navigator: parsed.window.navigator,
      HTMLVideoElement: parsed.window.HTMLVideoElement,
      HTMLCanvasElement: parsed.window.HTMLCanvasElement,
      IS_REACT_ACT_ENVIRONMENT: true,
    })

    Object.assign(parsed.window, {
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      electronAPI: {
        chromeDesktop: {
          getState: mock(async () => null),
          onStateChanged: mock(() => () => {}),
          onRequestFrame: mock((cb: any) => {
            frameRequestCallback = cb
            return () => {}
          }),
          sendFrameResponse: mock((res: any) => {
            sendFrameResponseCalls.push(res)
          }),
          sendStreamError: mock((err: any) => {
            sendStreamErrorCalls.push(err)
          }),
        },
      },
    })
  })

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root?.unmount()
      })
    }
    root = null
  })

  test('首次 Observe 获得新帧；静止时再次 Observe 返回 CHROME_FRAME_STALE；画面更新后再次 Observe 成功', async () => {
    const store = createStore()
    const mockTrack = {
      addEventListener: () => {},
      removeEventListener: () => {},
    }
    const mockStream = {
      getVideoTracks: () => [mockTrack],
    } as unknown as MediaStream

    store.set(chromeDesktopMediaStreamAtom, mockStream)

    root = createRoot(document.getElementById('root')!)
    await act(async () => {
      root?.render(
        <Provider store={store}>
          <ChromeDesktopCaptureHost />
        </Provider>,
      )
    })

    expect(frameRequestCallback).not.toBeNull()

    const videoElement = document.querySelector('video') as HTMLVideoElement
    expect(videoElement).not.toBeNull()
    Object.defineProperty(videoElement, 'readyState', { value: 4, configurable: true })
    Object.defineProperty(videoElement, 'videoWidth', { value: 1280, configurable: true })
    Object.defineProperty(videoElement, 'videoHeight', { value: 720, configurable: true })

    // 1. 发起第 1 次 Observe 请求
    await act(async () => {
      frameRequestCallback!({ controlId: 'ctrl-1', requestId: 'req-1', geometryVersion: 1 })
    })

    expect(rVfcCallbacks.length).toBe(1)
    // 触发 rVFC 呈现第 1 帧
    await act(async () => {
      const cb = rVfcCallbacks.shift()!
      cb(100, { presentedFrames: 1, mediaTime: 0.016 })
      await new Promise((r) => setTimeout(r, 10))
    })

    expect(sendFrameResponseCalls.length).toBe(1)
    expect(sendFrameResponseCalls[0].requestId).toBe('req-1')
    expect(sendFrameResponseCalls[0].error).toBeUndefined()
    expect(sendFrameResponseCalls[0].presentedFrames).toBe(1)
    expect(sendFrameResponseCalls[0].mediaTime).toBe(0.016)
    expect(typeof sendFrameResponseCalls[0].encodedAt).toBe('number')
    expect(sendFrameResponseCalls[0].data).toBe('mockJpegData')

    // 2. 发起第 2 次 Observe 请求（此时视频画面静止，无新源帧呈现）
    await act(async () => {
      frameRequestCallback!({ controlId: 'ctrl-1', requestId: 'req-2', geometryVersion: 2 })
    })

    expect(rVfcCallbacks.length).toBe(1)
    // 画面静止：即使 rVFC 触发，presentedFrames 仍为 1（<= 上一帧序号 1）
    await act(async () => {
      const cb = rVfcCallbacks.shift()!
      cb(200, { presentedFrames: 1, mediaTime: 0.016 })
      // 等待 360ms 触发 350ms 超时
      await new Promise((r) => setTimeout(r, 360))
    })

    expect(sendFrameResponseCalls.length).toBe(2)
    expect(sendFrameResponseCalls[1].requestId).toBe('req-2')
    // 必须返回明确的 CHROME_FRAME_STALE，绝不能用旧帧充数
    expect(sendFrameResponseCalls[1].error).toContain('CHROME_FRAME_STALE')
    expect(sendFrameResponseCalls[1].data).toBe('')

    // 3. 发起第 3 次 Observe 请求（画面发生更新，呈现第 2 帧）
    await act(async () => {
      frameRequestCallback!({ controlId: 'ctrl-1', requestId: 'req-3', geometryVersion: 3 })
    })

    expect(rVfcCallbacks.length).toBe(1)
    await act(async () => {
      const cb = rVfcCallbacks.shift()!
      cb(400, { presentedFrames: 2, mediaTime: 0.033 })
      await new Promise((r) => setTimeout(r, 10))
    })

    expect(sendFrameResponseCalls.length).toBe(3)
    expect(sendFrameResponseCalls[2].requestId).toBe('req-3')
    expect(sendFrameResponseCalls[2].error).toBeUndefined()
    expect(sendFrameResponseCalls[2].presentedFrames).toBe(2)
    expect(sendFrameResponseCalls[2].mediaTime).toBe(0.033)
  })
})
