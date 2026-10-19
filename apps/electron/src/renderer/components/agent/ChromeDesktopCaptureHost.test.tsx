import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { parseHTML } from 'linkedom'
import * as React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Provider, createStore } from 'jotai'
import type { ChromeDesktopSessionState } from '@copis/shared'
import {
  chromeDesktopMediaStreamAtom, chromeDesktopMediaStreamControlAtom, chromeDesktopSessionStateAtom,
} from '@/atoms/chrome-desktop-atoms'
import { activeTabIdAtom, tabsAtom } from '@/atoms/tab-atoms'
import { openChromeDesktopPreviewTabAtom } from '@/atoms/chrome-desktop-preview-tabs'
import { ChromeDesktopCaptureHost } from './ChromeDesktopCaptureHost'

const act = (React as typeof React & { act: typeof import('react-dom/test-utils').act }).act
const initialState: ChromeDesktopSessionState = {
  controlId: 'ctrl-1', sessionId: 'session-1', state: 'active', mode: 'observe', targetWindow: null, shortcut: '', createdAt: 0,
}
const globals = { window: globalThis.window, document: globalThis.document, navigator: globalThis.navigator }
let root: Root | null = null
let stateChanged: (state: ChromeDesktopSessionState) => void
let store: ReturnType<typeof createStore>
let api: ReturnType<typeof createApi>

function createApi() {
  return {
    getState: mock(async (): Promise<ChromeDesktopSessionState | null> => initialState),
    stopControl: mock(async (_input: unknown) => {}),
    onStateChanged: mock((cb: typeof stateChanged) => { stateChanged = cb; return mock(() => {}) }),
    onRequestFrame: mock((_cb: unknown) => mock(() => {})),
    sendFrameResponse: mock((_response: unknown) => {}),
    sendStreamError: mock((_error: unknown) => {}),
  }
}

beforeEach(() => {
  const { window } = parseHTML('<html><body><div id="root"></div></body></html>')
  Object.assign(globalThis, { window, document: window.document, navigator: window.navigator, IS_REACT_ACT_ENVIRONMENT: true })
  ;(window.HTMLElement.prototype as any).play = async () => {}
  api = createApi()
  window.electronAPI = { chromeDesktop: api } as any
  store = createStore()
  store.set(chromeDesktopSessionStateAtom, initialState)
})

afterEach(async () => {
  await act(async () => { root?.unmount() })
  root = null
  await new Promise(resolve => setTimeout(resolve, 5))
  Object.assign(globalThis, globals)
})

async function renderHost() {
  root = createRoot(document.getElementById('root')!)
  await act(async () => { root?.render(<Provider store={store}><ChromeDesktopCaptureHost /></Provider>) })
}

function installPreview(controlId = 'ctrl-1') {
  let ended!: () => void
  const stop = mock(() => {})
  const removeEventListener = mock((_event: string, _callback: () => void) => {})
  const track = { stop, addEventListener: (_event: string, callback: () => void) => { ended = callback }, removeEventListener }
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] } as unknown as MediaStream
  store.set(chromeDesktopMediaStreamAtom, stream)
  store.set(chromeDesktopMediaStreamControlAtom, controlId)
  return { stream, stop, removeEventListener, end: () => ended() }
}

describe('ChromeDesktopCaptureHost 只维护预览与原生状态', () => {
  test('Given 原生负责 Observe When 全局宿主挂载 Then 不订阅 renderer 截帧或发送图片', async () => {
    installPreview()
    await renderHost()
    expect(api.onRequestFrame).not.toHaveBeenCalled()
    expect(api.sendFrameResponse).not.toHaveBeenCalled()
    expect(document.querySelector('canvas')).toBeNull()
  })

  test('Given 预览轨道结束 When 收到 ended Then 只清理流且原生连接保持 active', async () => {
    const preview = installPreview()
    await renderHost()
    await act(async () => { preview.end() })
    expect(store.get(chromeDesktopMediaStreamAtom)).toBeNull()
    expect(store.get(chromeDesktopMediaStreamControlAtom)).toBeNull()
    expect(preview.stop).toHaveBeenCalledTimes(1)
    expect(preview.removeEventListener).toHaveBeenCalled()
    expect(store.get(chromeDesktopSessionStateAtom)?.state).toBe('active')
    expect(api.sendStreamError).not.toHaveBeenCalled()
    expect(api.stopControl).not.toHaveBeenCalled()
  })

  test('Given 旧流的 ended 迟到 When 已换成另一个 control 的预览 Then 不清理新流且不上报连接失败', async () => {
    const oldPreview = installPreview()
    await renderHost()
    let newPreview!: ReturnType<typeof installPreview>
    await act(async () => {
      newPreview = installPreview('ctrl-2')
      oldPreview.end()
    })
    expect(store.get(chromeDesktopMediaStreamAtom)).toBe(newPreview.stream)
    expect(newPreview.stop).not.toHaveBeenCalled()
    expect(api.sendStreamError).not.toHaveBeenCalled()
  })

  test('Given 旧 Chrome 预览 Tab 正在展示 When 主进程广播同会话重新授权 Then 全局宿主切回 Agent 展示授权入口', async () => {
    store.set(tabsAtom, [{ id: 'session-1', type: 'agent', sessionId: 'session-1', title: 'Agent' }])
    store.set(openChromeDesktopPreviewTabAtom, { sessionId: 'session-1', controlId: 'ctrl-1', title: 'Chrome' })
    await renderHost()
    await act(async () => { stateChanged({ ...initialState, controlId: 'ctrl-2', state: 'awaiting_user' }) })
    expect(store.get(activeTabIdAtom)).toBe('session-1')
    expect(store.get(chromeDesktopSessionStateAtom)?.controlId).toBe('ctrl-2')
  })

  test('Given Chrome 焦点暂停 When 主进程广播可恢复状态 Then 保留预览；原生报告不可恢复失败才释放', async () => {
    const preview = installPreview()
    await renderHost()
    await act(async () => { stateChanged({ ...initialState, state: 'paused', pauseReason: 'CHROME_FOCUS_LOST' }) })
    expect(preview.stop).not.toHaveBeenCalled()
    await act(async () => { stateChanged({ ...initialState, state: 'paused', pauseReason: 'CHROME_CAPTURE_FAILED' }) })
    expect(preview.stop).toHaveBeenCalledTimes(1)
  })

  test('Given 正在使用预览 When 原生停止或切换 control Then 释放原来的流', async () => {
    const preview = installPreview()
    await renderHost()
    await act(async () => { stateChanged({ ...initialState, controlId: 'ctrl-2', state: 'awaiting_user' }) })
    expect(preview.stop).toHaveBeenCalledTimes(1)
    expect(store.get(chromeDesktopMediaStreamAtom)).toBeNull()
  })

  test('Given getState 快照迟到 When 已收到新状态广播 Then 保持较新的原生状态', async () => {
    let resolveState!: (state: ChromeDesktopSessionState) => void
    api.getState.mockImplementation(() => new Promise(resolve => { resolveState = resolve }))
    await renderHost()
    await act(async () => { stateChanged({ ...initialState, state: 'stopped' }); resolveState(initialState) })
    expect(store.get(chromeDesktopSessionStateAtom)?.state).toBe('stopped')
  })

  test('Given 应用宿主持有原生连接和预览 When 真正卸载 Then 停止连接并清理流', async () => {
    const preview = installPreview()
    await renderHost()
    await act(async () => { root?.unmount() })
    root = null
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(preview.stop).toHaveBeenCalledTimes(1)
    expect(api.stopControl).toHaveBeenCalledWith({ sessionId: 'session-1', controlId: 'ctrl-1' })
  })

  test('Given preload 已删除所有截帧接口 When 宿主挂载并收到状态 Then 仍同步原生控制状态', async () => {
    window.electronAPI = { chromeDesktop: {
      getState: api.getState, onStateChanged: api.onStateChanged, stopControl: api.stopControl,
    } } as any
    await renderHost()
    await act(async () => { stateChanged({ ...initialState, state: 'paused', pauseReason: 'CHROME_FOCUS_LOST' }) })
    expect(store.get(chromeDesktopSessionStateAtom)?.state).toBe('paused')
    expect(api.stopControl).not.toHaveBeenCalled()
  })

})
