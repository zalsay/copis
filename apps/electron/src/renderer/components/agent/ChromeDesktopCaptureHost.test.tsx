import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { parseHTML } from 'linkedom'
import * as React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Provider, createStore } from 'jotai'
import {
  chromeDesktopMediaStreamAtom, chromeDesktopMediaStreamControlAtom, chromeDesktopSessionStateAtom,
} from '@/atoms/chrome-desktop-atoms'
import { activeTabIdAtom, tabsAtom } from '@/atoms/tab-atoms'
import { openChromeDesktopPreviewTabAtom } from '@/atoms/chrome-desktop-preview-tabs'
import { ChromeDesktopCaptureHost } from './ChromeDesktopCaptureHost'

const act = (React as typeof React & { act: typeof import('react-dom/test-utils').act }).act
let root: Root | null = null

describe('ChromeDesktopCaptureHost requestVideoFrameCallback 序列与静止检测', () => {
  let currentState: any = null
  let stateChangedCallback: ((state: any) => void) | null = null
  let frameRequestCallback: ((req: { controlId: string; requestId: string; geometryVersion: number }) => void) | null = null
  let sendFrameResponseCalls: any[] = []
  let sendStreamErrorCalls: any[] = []
  let rVfcCallbacks: Array<(now: number, meta: any) => void> = []

  beforeEach(() => {
    const parsed = parseHTML('<html><body><div id="root"></div></body></html>')
    currentState = { controlId: 'ctrl-1', sessionId: 'session-1', state: 'active', targetWindow: null, shortcut: '', createdAt: 0 }
    sendFrameResponseCalls = []
    sendStreamErrorCalls = []
    rVfcCallbacks = []
    frameRequestCallback = null
    stateChangedCallback = null

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
          getState: mock(async () => currentState),
          stopControl: mock(async (_input: any) => {}),
          onStateChanged: mock((cb: any) => { stateChangedCallback = cb; return () => { stateChangedCallback = null } }),
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
      stop: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
    }
    const mockStream = {
      getVideoTracks: () => [mockTrack],
      getTracks: () => [mockTrack],
    } as unknown as MediaStream

    store.set(chromeDesktopMediaStreamAtom, mockStream)
    store.set(chromeDesktopMediaStreamControlAtom, 'ctrl-1')
    store.set(chromeDesktopSessionStateAtom, currentState)

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

  test('requestVideoFrameCallback 不可用时明确失败，不将旧画面当作新帧', async () => {
    const store = createStore()
    const track = { addEventListener: () => {}, removeEventListener: () => {}, stop: () => {} }
    store.set(chromeDesktopMediaStreamAtom, { getVideoTracks: () => [track], getTracks: () => [track] } as unknown as MediaStream)
    store.set(chromeDesktopMediaStreamControlAtom, 'ctrl-1')
    store.set(chromeDesktopSessionStateAtom, currentState)
    root = createRoot(document.getElementById('root')!)
    await act(async () => root?.render(<Provider store={store}><ChromeDesktopCaptureHost /></Provider>))
    const video = document.querySelector('video') as any
    Object.defineProperty(video, 'readyState', { value: 4, configurable: true })
    Object.defineProperty(video, 'videoWidth', { value: 1280, configurable: true })
    Object.defineProperty(video, 'videoHeight', { value: 720, configurable: true })
    video.requestVideoFrameCallback = undefined

    await act(async () => frameRequestCallback!({ controlId: 'ctrl-1', requestId: 'req-no-rvfc', geometryVersion: 1 }))
    expect(sendFrameResponseCalls).toHaveLength(1)
    expect(sendFrameResponseCalls[0].error).toContain('不支持 requestVideoFrameCallback')
    expect(sendFrameResponseCalls[0].data).toBe('')
  })

  test('Given 旧 Chrome 预览 Tab 正在展示 When 主进程广播同会话重新授权 Then 全局宿主切回 Agent 展示授权入口', async () => {
    const store = createStore()
    store.set(tabsAtom, [{ id: 'session-1', type: 'agent', sessionId: 'session-1', title: 'Agent' }])
    store.set(openChromeDesktopPreviewTabAtom, { sessionId: 'session-1', controlId: 'ctrl-1', title: 'Chrome' })
    root = createRoot(document.getElementById('root')!)
    await act(async () => root?.render(<Provider store={store}><ChromeDesktopCaptureHost /></Provider>))
    expect(store.get(activeTabIdAtom)).toBe('__chrome-desktop-preview__:ctrl-1')
    await act(async () => stateChangedCallback!({ ...currentState, controlId: 'ctrl-2', state: 'awaiting_user' }))
    expect(store.get(activeTabIdAtom)).toBe('session-1')
    expect(store.get(chromeDesktopSessionStateAtom)?.controlId).toBe('ctrl-2')
  })

  test('Given Chrome 失去焦点 When 主进程广播可恢复暂停 Then 保留已授权采集流；真正采集失败才释放', async () => {
    const store = createStore()
    const stop = mock(() => {})
    const track = { addEventListener: () => {}, removeEventListener: () => {}, stop }
    const stream = { getVideoTracks: () => [track], getTracks: () => [track] } as unknown as MediaStream
    store.set(chromeDesktopMediaStreamAtom, stream)
    store.set(chromeDesktopMediaStreamControlAtom, 'ctrl-1')
    store.set(chromeDesktopSessionStateAtom, currentState)
    root = createRoot(document.getElementById('root')!)
    await act(async () => root?.render(<Provider store={store}><ChromeDesktopCaptureHost /></Provider>))

    await act(async () => stateChangedCallback!({ ...currentState, state: 'paused', pauseReason: 'CHROME_FOCUS_LOST' }))
    expect(stop).not.toHaveBeenCalled()

    await act(async () => stateChangedCallback!({ ...currentState, state: 'paused', pauseReason: 'CHROME_CAPTURE_FAILED' }))
    expect(stop).toHaveBeenCalledTimes(1)
  })

  test('track ended 上报绑定产生该 stream 的 controlId', async () => {
    const store = createStore()
    let ended: (() => void) | undefined
    const track = { addEventListener: (_: string, cb: () => void) => { ended = cb }, removeEventListener: () => {}, stop: () => {} }
    store.set(chromeDesktopMediaStreamAtom, { getVideoTracks: () => [track], getTracks: () => [track] } as unknown as MediaStream)
    store.set(chromeDesktopMediaStreamControlAtom, 'ctrl-1')
    store.set(chromeDesktopSessionStateAtom, currentState)
    root = createRoot(document.getElementById('root')!)
    await act(async () => root?.render(<Provider store={store}><ChromeDesktopCaptureHost /></Provider>))
    await act(async () => ended?.())
    expect(sendStreamErrorCalls[0]).toMatchObject({ controlId: 'ctrl-1', reason: 'CHROME_CAPTURE_FAILED' })
  })

})
