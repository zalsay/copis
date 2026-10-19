/**
 * Chrome Desktop 桌面视觉自动化 Jotai 状态管理
 *
 * 管理本机 Chrome 窗口控制状态、MediaStream 引用、窗口选择列表与系统权限状态。
 * 遵循本地优先原则，所有运行时状态均保存在内存 Atom 中，不使用 localStorage 或本地数据库。
 */

import { atom } from 'jotai'
import type {
  ChromeDesktopSessionState,
  ChromeDesktopWindowInfo,
  ChromeDesktopSystemStatus,
  ChromeDesktopErrorCode,
} from '@copis/shared'

/** 当前活动的 Chrome 控制会话状态（来自主进程广播） */
export const chromeDesktopSessionStateAtom = atom<ChromeDesktopSessionState | null>(null)

/** 当前仅用于实时预览的 MediaStream（仅存在于内存，生命周期受控） */
export const chromeDesktopMediaStreamAtom = atom<MediaStream | null>(null)
/** MediaStream 所属 control，防止迟到授权/清理跨控制覆盖。 */
export const chromeDesktopMediaStreamControlAtom = atom<string | null>(null)
/** 每次授权尝试及显式停止都递增，用于隔离 await 中的旧请求。 */
export const chromeDesktopCaptureAttemptAtom = atom(0)
const chromeDesktopCaptureAttemptControlAtom = atom<string | null>(null)

/** 建立一代新的用户授权尝试。 */
export const reserveChromeDesktopCaptureAtom = atom(null, (get, set, controlId: string) => {
  if (get(chromeDesktopIsStartingAtom) && get(chromeDesktopCaptureAttemptControlAtom) === controlId) return null
  const attempt = get(chromeDesktopCaptureAttemptAtom) + 1
  set(chromeDesktopCaptureAttemptAtom, attempt)
  set(chromeDesktopCaptureAttemptControlAtom, controlId)
  set(chromeDesktopIsStartingAtom, true)
  return attempt
})

/** 仅提交仍有效的授权结果；失效回包立即释放自身流。 */
export const commitChromeDesktopCaptureAtom = atom(
  null,
  (get, set, input: { attempt: number; controlId: string; stream: MediaStream }) => {
    if (get(chromeDesktopCaptureAttemptAtom) !== input.attempt || get(chromeDesktopCaptureAttemptControlAtom) !== input.controlId) {
      input.stream.getTracks().forEach((track) => track.stop())
      return false
    }
    set(chromeDesktopMediaStreamAtom, input.stream)
    set(chromeDesktopMediaStreamControlAtom, input.controlId)
    return true
  },
)

/** 可选的本机 Chrome 窗口列表 */
export const chromeDesktopAvailableWindowsAtom = atom<ChromeDesktopWindowInfo[]>([])

/** 用户当前选中的 Chrome 窗口 ID */
export const chromeDesktopSelectedWindowIdAtom = atom<number | null>(null)

/** 系统权限与能力状态 */
export const chromeDesktopSystemStatusAtom = atom<ChromeDesktopSystemStatus | null>(null)

/** 是否正在启动/授权中（防止用户重复点击） */
export const chromeDesktopIsStartingAtom = atom<boolean>(false)

/** 授权横幅展示的错误信息 */
export const chromeDesktopErrorAtom = atom<string | null>(null)

/** 刷新系统状态 */
export const fetchChromeDesktopStatusAtom = atom(null, async (_get, set) => {
  if (!window.electronAPI?.chromeDesktop) return null
  try {
    const status = await window.electronAPI.chromeDesktop.checkStatus()
    set(chromeDesktopSystemStatusAtom, status)
    return status
  } catch (err: any) {
    console.error('[ChromeDesktop] 检查系统状态失败:', err)
    return null
  }
})

/** 刷新可用 Chrome 窗口列表 */
export const fetchChromeDesktopWindowsAtom = atom(null, async (get, set) => {
  if (!window.electronAPI?.chromeDesktop) return []
  try {
    const windows = await window.electronAPI.chromeDesktop.listWindows()
    set(chromeDesktopAvailableWindowsAtom, windows)

    // 若当前未选择或选择的窗口已不存在，默认选择首个可用窗口
    const currentSelected = get(chromeDesktopSelectedWindowIdAtom)
    const firstWindow = windows[0]
    if (firstWindow) {
      if (!currentSelected || !windows.some((w) => w.windowId === currentSelected)) {
        set(chromeDesktopSelectedWindowIdAtom, firstWindow.windowId)
      }
    } else {
      set(chromeDesktopSelectedWindowIdAtom, null)
    }

    return windows
  } catch (err: any) {
    console.error('[ChromeDesktop] 获取 Chrome 窗口列表失败:', err)
    set(chromeDesktopAvailableWindowsAtom, [])
    return []
  }
})

/** 清理并停止 MediaStream 轨道 */
export const cleanupChromeDesktopStreamAtom = atom(null, (get, set, expected?: MediaStream | string) => {
  const stream = get(chromeDesktopMediaStreamAtom)
  const matchesExpected = !expected || (typeof expected === 'string'
    ? get(chromeDesktopMediaStreamControlAtom) === expected
    : expected === stream)
  if (stream && matchesExpected) {
    stream.getTracks().forEach((track) => {
      try {
        track.stop()
      } catch (err) {
        console.warn('[ChromeDesktop] 停止视频采集 track 失败:', err)
      }
    })
    set(chromeDesktopMediaStreamAtom, null)
    set(chromeDesktopMediaStreamControlAtom, null)
  }
})

/** 停止控制 */
export const stopChromeDesktopControlAtom = atom(
  null,
  async (get, set, control?: { sessionId: string; controlId: string }) => {
    const streamControlId = get(chromeDesktopMediaStreamControlAtom)
    if (!control || get(chromeDesktopCaptureAttemptControlAtom) === control.controlId) {
      set(chromeDesktopCaptureAttemptAtom, get(chromeDesktopCaptureAttemptAtom) + 1)
      set(chromeDesktopCaptureAttemptControlAtom, null)
      set(chromeDesktopIsStartingAtom, false)
    }
    if (!control || streamControlId === control.controlId) set(cleanupChromeDesktopStreamAtom)
    if (!window.electronAPI?.chromeDesktop || !control) return
    try {
      await window.electronAPI.chromeDesktop.stopControl(control)
    } catch (err) {
      console.error('[ChromeDesktop] 停止控制失败:', err)
    }
  },
)
