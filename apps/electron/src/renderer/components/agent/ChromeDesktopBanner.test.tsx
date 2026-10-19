import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { parseHTML } from 'linkedom'
import * as React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Provider, createStore } from 'jotai'
import type { ChromeDesktopSessionState, ChromeDesktopSystemStatus } from '@copis/shared'
import {
  chromeDesktopMediaStreamAtom,
  chromeDesktopMediaStreamControlAtom,
  chromeDesktopSessionStateAtom,
  stopChromeDesktopControlAtom,
} from '@/atoms/chrome-desktop-atoms'
import { activeTabIdAtom, tabsAtom } from '@/atoms/tab-atoms'
import { workingSettingsOpenAtom, workingSettingsSectionAtom } from '@/atoms/working-atoms'
import { ChromeDesktopBanner } from './ChromeDesktopBanner'

const act = (React as typeof React & { act: typeof import('react-dom/test-utils').act }).act
const targetWindow = { windowId: 42, pid: 123, title: '测试 Chrome', bounds: { x: 0, y: 0, width: 800, height: 600 } }
const control = { sessionId: 'session-1', controlId: 'ctrl-1' }
const initialState: ChromeDesktopSessionState = {
  ...control, state: 'awaiting_user', mode: 'observe', targetWindow, shortcut: '停止快捷键', createdAt: 0,
}
let root: Root | null = null
let store: ReturnType<typeof createStore>
let api: ReturnType<typeof createApi>
let getDisplayMedia: ReturnType<typeof mock>
let calls: string[]
const globals = { window: globalThis.window, document: globalThis.document, navigator: globalThis.navigator }

function createApi() {
  return {
    checkStatus: mock(async (): Promise<ChromeDesktopSystemStatus> => ({
      supported: true, screenRecordingGranted: true, accessibilityGranted: true,
      visionModelSupported: true, shortcut: initialState.shortcut, shortcutAvailable: true,
    })),
    listWindows: mock(async () => [targetWindow]),
    prepareCapture: mock(async (_input: unknown) => { calls.push('prepare'); await new Promise(resolve => setTimeout(resolve, 0)); return { ok: true } }),
    confirmStart: mock(async (_input: unknown): Promise<{ ok: boolean; message?: string }> => {
      calls.push('confirm')
      store.set(chromeDesktopSessionStateAtom, { ...initialState, state: 'active' })
      return { ok: true }
    }),
    stopControl: mock(async (_input: unknown) => {}),
  }
}

beforeEach(() => {
  const { window } = parseHTML('<html><body><div id="root"></div></body></html>')
  Object.assign(globalThis, { window, document: window.document, navigator: { mediaDevices: {} }, IS_REACT_ACT_ENVIRONMENT: true })
  ;(window.HTMLElement.prototype as any).play = async () => {}
  calls = []
  store = createStore()
  store.set(chromeDesktopSessionStateAtom, initialState)
  store.set(tabsAtom, [{ id: control.sessionId, type: 'agent', sessionId: control.sessionId, title: 'Agent' }])
  api = createApi()
  window.electronAPI = { chromeDesktop: api } as any
  getDisplayMedia = mock(async () => { calls.push('preview'); throw new DOMException('预览不可用', 'NotSupportedError') })
  Object.assign(navigator.mediaDevices, { getDisplayMedia })
})

afterEach(async () => {
  await act(async () => { root?.unmount() })
  root = null
  await new Promise(resolve => setTimeout(resolve, 5))
  Object.assign(globalThis, globals)
})

async function renderBanner() {
  root = createRoot(document.getElementById('root')!)
  await act(async () => { root?.render(<Provider store={store}><ChromeDesktopBanner sessionId={control.sessionId} /></Provider>) })
}

async function clickButton(text: string) {
  const button = [...document.querySelectorAll('button')].find(item => item.textContent?.includes(text))
  expect(button).toBeDefined()
  await act(async () => { button!.click() })
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)) })
}

function previewStream() {
  const stop = mock(() => {})
  const stream = { getTracks: () => [{ stop }] } as unknown as MediaStream
  return { stream, stop }
}

describe('Chrome 原生连接与尽力预览', () => {
  for (const errorName of ['NotSupportedError', 'NotAllowedError']) {
    test(`Given 已选 Chrome 窗口 When 用户确认且预览返回 ${errorName} Then 仍按顺序绑定并连接原生组件且可停止与重试`, async () => {
      getDisplayMedia.mockImplementation(async () => { calls.push('preview'); throw new DOMException('预览不可用', errorName) })
      await renderBanner()
      await clickButton('开始观察')
      expect(calls).toEqual(['prepare', 'preview', 'confirm'])
      expect(api.prepareCapture).toHaveBeenCalledWith({ ...control, windowId: 42, pid: 123 })
      expect(api.confirmStart).toHaveBeenCalledWith({ ...control, windowId: 42, pid: 123 })
      expect(api.stopControl).not.toHaveBeenCalled()
      expect(document.body.textContent).toContain('预览暂不可用')
      expect(document.body.textContent).toContain('可观察页面')
      await clickButton('停止控制')
      expect(api.stopControl).toHaveBeenCalledWith(control)
    })
  }

  test('Given 原生已连接但没有预览 When 重试预览成功 Then 复用连接与完整预览 Tab', async () => {
    store.set(chromeDesktopSessionStateAtom, { ...initialState, state: 'active' })
    const { stream } = previewStream()
    getDisplayMedia.mockImplementation(async () => stream)
    await renderBanner()
    await clickButton('重试预览')
    expect(store.get(chromeDesktopMediaStreamAtom)).toBe(stream)
    expect(store.get(chromeDesktopMediaStreamControlAtom)).toBe(control.controlId)
    expect(api.confirmStart).not.toHaveBeenCalled()
    expect(api.stopControl).not.toHaveBeenCalled()
    const preview = document.querySelector<HTMLButtonElement>('[aria-label="在顶部主 Tab 中打开完整 Chrome 预览"]')
    expect(preview).not.toBeNull()
    await act(async () => { preview!.click() })
    expect(store.get(activeTabIdAtom)).toBe('__chrome-desktop-preview__:ctrl-1')
  })

  test('Given 原生已连接 When 重试预览仍被拒绝 Then 保留原生连接与重试入口', async () => {
    store.set(chromeDesktopSessionStateAtom, { ...initialState, state: 'active' })
    await renderBanner()
    await clickButton('重试预览')
    expect(api.stopControl).not.toHaveBeenCalled()
    expect(store.get(chromeDesktopSessionStateAtom)?.state).toBe('active')
    expect(document.body.textContent).toContain('预览暂不可用')
    expect(document.body.textContent).toContain('重试预览')
  })

  test('Given 原生连接不等待预览 When 用户停止后预览才返回 Then 释放迟到流且不重新连接', async () => {
    let resolvePreview!: (stream: MediaStream) => void
    getDisplayMedia.mockImplementation(() => new Promise<MediaStream>(resolve => { resolvePreview = resolve }))
    await renderBanner()
    await clickButton('开始观察')
    await act(async () => { await store.set(stopChromeDesktopControlAtom, control) })
    const { stream, stop } = previewStream()
    await act(async () => { resolvePreview(stream) })
    expect(stop).toHaveBeenCalledTimes(1)
    expect(api.confirmStart).toHaveBeenCalledTimes(1)
    expect(store.get(chromeDesktopMediaStreamAtom)).toBeNull()
  })

  test('Given 预览成功 When 原生连接失败 Then 释放流并显示原生错误', async () => {
    const { stream, stop } = previewStream()
    getDisplayMedia.mockImplementation(async () => stream)
    api.confirmStart.mockImplementation(async () => ({ ok: false, message: '原生组件连接失败' }))
    await renderBanner()
    await clickButton('开始观察')
    expect(stop).toHaveBeenCalledTimes(1)
    expect(api.stopControl).toHaveBeenCalledWith(control)
    expect(document.body.textContent).toContain('原生组件连接失败')
  })

  test('Given getDisplayMedia 长时间 pending When 用户确认 Then 不等待预览即可建立原生连接并可停止', async () => {
    getDisplayMedia.mockImplementation(() => new Promise<MediaStream>(() => {}))
    await renderBanner()
    await clickButton('开始观察')
    expect(api.confirmStart).toHaveBeenCalledTimes(1)
    expect(store.get(chromeDesktopSessionStateAtom)?.state).toBe('active')
    expect(document.body.textContent).toContain('可观察页面')
    await clickButton('停止控制')
    expect(api.stopControl).toHaveBeenCalledWith(control)
  })

  test('Given 原生连接已建立且预览仍 pending When 切换 control 后旧预览返回 Then 释放旧流且不污染新连接', async () => {
    let resolvePreview!: (stream: MediaStream) => void
    getDisplayMedia.mockImplementation(() => new Promise<MediaStream>(resolve => { resolvePreview = resolve }))
    await renderBanner()
    await clickButton('开始观察')
    expect(api.confirmStart).toHaveBeenCalledTimes(1)
    await act(async () => { store.set(chromeDesktopSessionStateAtom, { ...initialState, controlId: 'ctrl-2', state: 'active' }) })
    const { stream, stop } = previewStream()
    await act(async () => { resolvePreview(stream) })
    expect(stop).toHaveBeenCalledTimes(1)
    expect(store.get(chromeDesktopMediaStreamAtom)).toBeNull()
    expect(store.get(chromeDesktopSessionStateAtom)?.controlId).toBe('ctrl-2')
    expect(api.stopControl.mock.calls.some(([input]) => (input as typeof control).controlId === 'ctrl-2')).toBe(false)
  })

  test('Given 原生连接已建立 When pending 的预览稍后被拒绝 Then 保持连接并可重试预览', async () => {
    let rejectPreview!: (error: Error) => void
    getDisplayMedia.mockImplementation(() => new Promise<MediaStream>((_resolve, reject) => { rejectPreview = reject }))
    await renderBanner()
    await clickButton('开始观察')
    expect(api.confirmStart).toHaveBeenCalledTimes(1)
    await act(async () => { rejectPreview(new DOMException('用户拒绝预览', 'NotAllowedError')) })
    expect(api.stopControl).not.toHaveBeenCalled()
    expect(store.get(chromeDesktopSessionStateAtom)?.state).toBe('active')
    expect(document.body.textContent).toContain('重试预览')
  })


  test('Given 组件已连接 When getDisplayMedia API 不存在 Then 仍保持原生连接且有重试入口', async () => {
    Object.assign(globalThis, { navigator: {} })
    await renderBanner()
    await clickButton('开始观察')
    expect(api.confirmStart).toHaveBeenCalledTimes(1)
    expect(api.stopControl).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('重试预览')
  })

  test('Given 原生拒绝连接且预览仍 pending When 流迟到 Then 释放流且不恢复已失败的控制', async () => {
    let resolvePreview!: (stream: MediaStream) => void
    getDisplayMedia.mockImplementation(() => new Promise<MediaStream>(resolve => { resolvePreview = resolve }))
    api.confirmStart.mockImplementation(async () => ({ ok: false, message: '组件不可用' }))
    await renderBanner()
    await clickButton('开始观察')
    expect(api.stopControl).toHaveBeenCalledWith(control)
    const { stream, stop } = previewStream()
    await act(async () => { resolvePreview(stream) })
    expect(stop).toHaveBeenCalledTimes(1)
    expect(store.get(chromeDesktopMediaStreamAtom)).toBeNull()
  })

  test('Given 重试预览仍 pending When 停止控制后返回流 Then 只释放迟到流且不重新确认连接', async () => {
    store.set(chromeDesktopSessionStateAtom, { ...initialState, state: 'active' })
    let resolvePreview!: (stream: MediaStream) => void
    getDisplayMedia.mockImplementation(() => new Promise<MediaStream>(resolve => { resolvePreview = resolve }))
    await renderBanner()
    await clickButton('重试预览')
    await clickButton('停止控制')
    const { stream, stop } = previewStream()
    await act(async () => { resolvePreview(stream) })
    expect(stop).toHaveBeenCalledTimes(1)
    expect(api.confirmStart).not.toHaveBeenCalled()
    expect(api.stopControl).toHaveBeenCalledTimes(1)
    expect(store.get(chromeDesktopMediaStreamAtom)).toBeNull()
  })

  test('Given 原生已连接且预览仍 pending When 原生广播停止后旧流返回 Then 不发布已经失效的预览', async () => {
    let resolvePreview!: (stream: MediaStream) => void
    getDisplayMedia.mockImplementation(() => new Promise<MediaStream>(resolve => { resolvePreview = resolve }))
    await renderBanner()
    await clickButton('开始观察')
    await act(async () => { store.set(chromeDesktopSessionStateAtom, { ...initialState, state: 'stopped' }) })
    const { stream, stop } = previewStream()
    await act(async () => { resolvePreview(stream) })
    expect(stop).toHaveBeenCalledTimes(1)
    expect(store.get(chromeDesktopMediaStreamAtom)).toBeNull()
  })


  test('Given 原生已连接且预览仍 pending When 原生报告不可恢复暂停后旧流返回 Then 不恢复预览资源', async () => {
    let resolvePreview!: (stream: MediaStream) => void
    getDisplayMedia.mockImplementation(() => new Promise<MediaStream>(resolve => { resolvePreview = resolve }))
    await renderBanner()
    await clickButton('开始观察')
    await act(async () => { store.set(chromeDesktopSessionStateAtom, { ...initialState, state: 'paused', pauseReason: 'CHROME_CAPTURE_FAILED' }) })
    const { stream, stop } = previewStream()
    await act(async () => { resolvePreview(stream) })
    expect(stop).toHaveBeenCalledTimes(1)
    expect(store.get(chromeDesktopMediaStreamAtom)).toBeNull()
  })

})


describe('Chrome 组件状态与权限提示', () => {
  const unavailableStatus: ChromeDesktopSystemStatus = {
    supported: false, screenRecordingGranted: false, accessibilityGranted: false,
    visionModelSupported: true, shortcut: initialState.shortcut, shortcutAvailable: false,
    error: 'CHROME_HELPER_FAILED: 组件尚未发布或下载失败，请到功能模块设置安装或重试',
  }

  test('Given 组件未发布或下载失败 When 状态与窗口检查返回不可用 Then 展示真实错误及本地能力入口说明且不误报权限', async () => {
    api.checkStatus.mockImplementation(async () => unavailableStatus)
    api.listWindows.mockImplementation(async () => { throw new Error(unavailableStatus.error) })
    await renderBanner()
    const text = document.body.textContent ?? ''
    expect(text).toContain('Chrome 桌面自动化组件暂不可用')
    expect(text).toContain(unavailableStatus.error!)
    expect(text).toContain('设置 → 关于/更新 → 本地能力')
    expect(text).not.toContain('系统必要权限未就绪')
    expect(text).not.toContain('屏幕录制权限未授予')
    expect(text).not.toContain('辅助功能权限未授予')
    expect(text).not.toContain('未检测到运行中的 Google Chrome 窗口')
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(unavailableStatus.error!)
  })

  test('Given Chrome 组件不可用 When 点击关于/更新入口 Then 打开关于/更新设置并选中本地能力区块', async () => {
    api.checkStatus.mockImplementation(async () => unavailableStatus)
    api.listWindows.mockImplementation(async () => [])
    await renderBanner()

    expect(document.body.textContent).toContain('设置 → 关于/更新 → 本地能力')
    const link = [...document.querySelectorAll('button')].find(item => item.textContent?.includes('打开关于/更新'))
    expect(link).toBeDefined()
    await act(async () => { link!.click() })

    expect(store.get(workingSettingsSectionAtom)).toBe('about')
    expect(store.get(workingSettingsOpenAtom)).toBe(true)
  })

  test('Given 组件不受支持但未返回错误详情 When 显示横幅 Then 仍提示组件不可用与安装重试位置', async () => {
    api.checkStatus.mockImplementation(async () => ({ ...unavailableStatus, error: undefined }))
    await renderBanner()
    expect(document.body.textContent).toContain('Chrome 桌面自动化组件暂不可用')
    expect(document.body.textContent).toContain('设置 → 关于/更新 → 本地能力')
    expect(document.body.textContent).not.toContain('系统必要权限未就绪')
  })

  test('Given 组件支持且系统权限未授予 When 显示横幅 Then 才展示权限警示且明确录屏授权归属于组件', async () => {
    api.checkStatus.mockImplementation(async () => ({ ...unavailableStatus, supported: true, error: undefined }))
    await renderBanner()
    expect(document.body.textContent).toContain('系统必要权限未就绪')
    const screenRecordingHint = [...document.querySelectorAll('p')].find(item => item.textContent?.includes('屏幕录制权限未授予'))?.textContent ?? ''
    expect(screenRecordingHint).toContain('Chrome 桌面自动化组件')
    expect(screenRecordingHint).toContain('以 macOS 实际显示的名称为准')
    expect(document.body.textContent).not.toContain('Chrome 桌面自动化组件暂不可用')
  })

  test('Given 状态支持但返回错误详情 When 显示横幅 Then 仍展示状态错误且不虚构权限问题', async () => {
    api.checkStatus.mockImplementation(async () => ({
      ...unavailableStatus, supported: true, screenRecordingGranted: true, accessibilityGranted: true,
      error: '组件状态检查提示：请稍后重试',
    }))
    await renderBanner()
    expect(document.body.textContent).toContain('组件状态检查提示：请稍后重试')
    expect(document.body.textContent).not.toContain('系统必要权限未就绪')
  })

  test('Given 已在设置安装组件 When 点击刷新列表 Then 重新检查组件状态并恢复窗口选择', async () => {
    api.checkStatus.mockImplementation(async () => unavailableStatus)
    api.listWindows.mockImplementation(async () => [])
    await renderBanner()
    api.checkStatus.mockImplementation(async () => ({
      ...unavailableStatus, supported: true, error: undefined,
      screenRecordingGranted: true, accessibilityGranted: true,
    }))
    api.listWindows.mockImplementation(async () => [targetWindow])
    await clickButton('刷新列表')
    expect(api.checkStatus).toHaveBeenCalledTimes(2)
    expect(document.body.textContent).not.toContain('Chrome 桌面自动化组件暂不可用')
    expect(document.body.textContent).not.toContain(unavailableStatus.error!)
    const start = [...document.querySelectorAll('button')].find(item => item.textContent?.includes('开始观察'))
    expect(start?.hasAttribute('disabled')).toBe(false)
  })
})
