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

/** 当前用于预览与截图的 MediaStream（仅存在于内存，生命周期受控） */
export const chromeDesktopMediaStreamAtom = atom<MediaStream | null>(null)

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
export const cleanupChromeDesktopStreamAtom = atom(null, (get, set) => {
  const stream = get(chromeDesktopMediaStreamAtom)
  if (stream) {
    stream.getTracks().forEach((track) => {
      try {
        track.stop()
      } catch (err) {
        console.warn('[ChromeDesktop] 停止视频采集 track 失败:', err)
      }
    })
    set(chromeDesktopMediaStreamAtom, null)
  }
})

/** 停止控制 */
export const stopChromeDesktopControlAtom = atom(
  null,
  async (get, set, sessionId?: string) => {
    set(chromeDesktopIsStartingAtom, false)
    set(cleanupChromeDesktopStreamAtom)
    if (!window.electronAPI?.chromeDesktop) return
    try {
      await window.electronAPI.chromeDesktop.stopControl(sessionId)
    } catch (err) {
      console.error('[ChromeDesktop] 停止控制失败:', err)
    }
  },
)
