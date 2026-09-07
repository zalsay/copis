/**
 * DSH 原生 WebContentsView 视图管理器。
 *
 * 负责在 Electron 主窗口中以原生 Chromium WebContentsView 承载 DSH 创造模式 Web：
 * - 彻底替代 <iframe>，提供无沙箱割裂、原生事件和最高渲染性能；
 * - 生命周期由主进程单例持有，与 React 视图渲染解耦，避免意外重载和长连接断开；
 * - 响应渲染进程 bounds 矩形同步，在展示 Copis 原生功能时自适应裁切露出右侧区域。
 */

import { BrowserWindow, nativeTheme, shell, WebContentsView } from 'electron'
import { join } from 'node:path'
import { DSH_CORDIS_IPC_CHANNELS, type DshViewBounds, type DshClientEvent } from '@copis/shared'
import { getSettings } from './settings-service'
import { resolveIsDark } from './theme-sync'

let hostWindow: BrowserWindow | null = null
let dshView: WebContentsView | null = null
let currentUrl: string | null = null
let lastBounds: DshViewBounds = { x: 0, y: 0, width: 0, height: 0, visible: false }

function isHostAvailable(): boolean {
  return hostWindow !== null && !hostWindow.isDestroyed()
}

/** 设置承载原生 WebContentsView 的主窗口 */
export function setDshHostWindow(window: BrowserWindow): void {
  hostWindow = window
  if (dshView && isHostAvailable()) {
    try {
      hostWindow.contentView.addChildView(dshView)
      applyDshViewBounds()
    } catch (err) {
      console.warn('[DSH View Manager] 重新挂载 dshView 失败:', err)
    }
  }
}

/**
 * 确保 DSH 原生 WebContentsView 已创建并加载目标 URL
 */
export function ensureDshView(url: string): WebContentsView | null {
  if (!isHostAvailable()) return null

  if (dshView && !dshView.webContents.isDestroyed()) {
    if (currentUrl !== url) {
      currentUrl = url
      void dshView.webContents.loadURL(url)
    }
    return dshView
  }

  const preloadPath = join(__dirname, 'dsh-bridge-preload.cjs')

  dshView = new WebContentsView({
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      partition: 'persist:copis-dsh',
      spellcheck: false,
    },
  })

  const contents = dshView.webContents

  contents.setWindowOpenHandler(({ url: openUrl }) => {
    if (openUrl.startsWith('http:') || openUrl.startsWith('https:')) {
      void shell.openExternal(openUrl).catch((err) => {
        console.warn('[DSH View Manager] 打开外部网页失败:', err)
      })
    }
    return { action: 'deny' }
  })

  contents.on('render-process-gone', (_event, details) => {
    console.warn('[DSH View Manager] DSH 网页渲染进程崩溃/退出:', details.reason)
  })

  const syncCurrentTheme = () => {
    try {
      const settings = getSettings()
      const isDark = resolveIsDark(settings.themeMode, settings.themeStyle, nativeTheme.shouldUseDarkColors)
      syncThemeToDshView(isDark)
    } catch (err) {
      console.warn('[DSH View Manager] 同步主题失败:', err)
    }
  }

  contents.on('dom-ready', syncCurrentTheme)
  contents.on('did-finish-load', syncCurrentTheme)

  try {
    hostWindow!.contentView.addChildView(dshView)
  } catch (err) {
    console.warn('[DSH View Manager] 添加 dshView 到 contentView 失败:', err)
  }

  currentUrl = url
  void contents.loadURL(url)
  applyDshViewBounds()

  return dshView
}

function applyDshViewBounds(): void {
  if (!dshView || dshView.webContents.isDestroyed() || !isHostAvailable()) return

  const { x, y, width, height, visible } = lastBounds
  if (visible && width > 0 && height > 0) {
    dshView.setBounds({
      x: Math.round(x),
      y: Math.round(y),
      width: Math.round(width),
      height: Math.round(height),
    })
    dshView.setVisible(true)
  } else {
    dshView.setVisible(false)
  }
}

/** 更新 DSH 视图在主窗口中的矩形坐标与可见性 */
export function updateDshViewBounds(bounds: DshViewBounds): void {
  lastBounds = { ...bounds }
  applyDshViewBounds()
}

/** 向 DSH 网页派发事件（如清除侧栏选中高亮等） */
export function dispatchToDshClient(payload: unknown): void {
  if (dshView && !dshView.webContents.isDestroyed()) {
    dshView.webContents.send(DSH_CORDIS_IPC_CHANNELS.DISPATCH_EVENT_TO_CLIENT, payload)
  }
}

/** 向 DSH 视图实时同步主题状态（浅色/深色） */
export function syncThemeToDshView(isDark: boolean): void {
  dispatchToDshClient({
    type: 'COPIS_THEME_CHANGED',
    isDark,
  })

  if (dshView && !dshView.webContents.isDestroyed()) {
    const js = `
      try {
        if (document.documentElement) {
          document.documentElement.style.colorScheme = '${isDark ? 'dark' : 'light'}';
        }
        if (document.body) {
          ${isDark ? "document.body.setAttribute('data-ds-dark-theme', '');" : "document.body.removeAttribute('data-ds-dark-theme');"}
        }
      } catch (e) {}
    `
    dshView.webContents.executeJavaScript(js).catch(() => {})
  }
}

/** 获取当前原生 DSH View 实例 */
export function getDshView(): WebContentsView | null {
  return dshView
}

/** 销毁 DSH View */
export function destroyDshView(): void {
  if (!dshView) return
  try {
    if (isHostAvailable()) {
      hostWindow!.contentView.removeChildView(dshView)
    }
    if (!dshView.webContents.isDestroyed()) {
      dshView.webContents.close()
    }
  } catch (err) {
    console.warn('[DSH View Manager] 销毁 dshView 异常:', err)
  } finally {
    dshView = null
    currentUrl = null
  }
}
