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
import { handleCopisFileRequest } from './local-file-protocol'

let hostWindow: BrowserWindow | null = null
let dshView: WebContentsView | null = null
let currentUrl: string | null = null
let fileProtocolRegistered = false
let focusOnNextShow = false
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
  // DSH 使用独立持久化 Session，不能只在默认 Session 注册媒体协议。
  if (!fileProtocolRegistered) {
    contents.session.protocol.handle('copis-file', handleCopisFileRequest)
    fileProtocolRegistered = true
  }

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

  contents.on('console-message', (_event, level, message, line, sourceId) => {
    console.log(`[DSH Web Console lvl=${level}] ${message} (${sourceId}:${line})`)
  })

  const syncCurrentTheme = () => {
    try {
      const settings = getSettings()
      const isDark = resolveIsDark(settings.themeMode, settings.themeStyle, nativeTheme.shouldUseDarkColors)
      const effectiveAgentColor = isDark
        ? (settings.agentThemeColorDark || settings.agentThemeColor || undefined)
        : (settings.agentThemeColorLight || settings.agentThemeColor || undefined)
      const effectiveCreationColor = isDark
        ? (settings.creationThemeColorDark || settings.creationThemeColor || undefined)
        : (settings.creationThemeColorLight || settings.creationThemeColor || undefined)
      syncThemeToDshView(isDark, effectiveAgentColor, effectiveCreationColor)
      syncHiddenSidebarMenuItemsToDshView(settings.hiddenSidebarMenuItems)
    } catch (err) {
      console.warn('[DSH View Manager] 同步主题与菜单失败:', err)
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

/** 新增媒体 IPC 只信任当前托管视图，不能由普通网页或已销毁的旧视图申请。 */
export function isDshViewSender(id: number): boolean {
  return !!dshView && !dshView.webContents.isDestroyed() && dshView.webContents.id === id
}

function applyDshViewBounds(): void {
  if (!dshView || dshView.webContents.isDestroyed() || !isHostAvailable()) return

  const { x, y, width, height, visible } = lastBounds
  if (!visible || width <= 0 || height <= 0 || ![x, y, width, height].every(Number.isFinite)) {
    dshView.setVisible(false)
    return
  }

  // 渲染进程上报的是 CSS 像素；原生子视图使用 DIP，不能直接沿用缩放前的坐标。
  const host = hostWindow!
  const zoom = host.webContents.getZoomFactor()
  const content = host.getContentBounds()
  const left = Math.max(0, Math.round(x * zoom))
  const top = Math.max(0, Math.round(y * zoom))
  const right = Math.min(content.width, Math.round((x + width) * zoom))
  const bottom = Math.min(content.height, Math.round((y + height) * zoom))
  if (right <= left || bottom <= top) {
    dshView.setVisible(false)
    return
  }

  dshView.setBounds({ x: left, y: top, width: right - left, height: bottom - top })
  dshView.setVisible(true)
  if (focusOnNextShow) {
    focusOnNextShow = false
    dshView.webContents.focus()
  }
}

/** 更新 DSH 视图在主窗口中的矩形坐标与可见性 */
export function updateDshViewBounds(bounds: DshViewBounds): void {
  lastBounds = { ...bounds }
  applyDshViewBounds()
}

/** 向 DSH 网页派发事件（如清除侧栏选中高亮等） */
export function dispatchToDshClient(payload: unknown, trustedUrl?: string): boolean {
  if (dshView && !dshView.webContents.isDestroyed()) {
    // 私有目录只发给已加载的受管 DSH 主 frame，未就绪由插件握手后重发。
    if (trustedUrl !== undefined) {
      const frame = dshView.webContents.mainFrame
      try {
        if (new URL(frame.url).origin !== new URL(trustedUrl).origin) return false
        frame.send(DSH_CORDIS_IPC_CHANNELS.DISPATCH_EVENT_TO_CLIENT, payload)
        return true
      } catch { return false }
    }
    dshView.webContents.send(DSH_CORDIS_IPC_CHANNELS.DISPATCH_EVENT_TO_CLIENT, payload)
    if (payload && typeof payload === 'object' && 'type' in payload && payload.type === 'COPIS_DSH_OPEN_SESSION') {
      if (lastBounds.visible && lastBounds.width > 0 && lastBounds.height > 0) dshView.webContents.focus()
      else focusOnNextShow = true
    }
    return true
  }
  return false
}

/** 向 DSH 视图实时同步主题状态（浅色/深色）及自定义模式主题色 */
export function syncThemeToDshView(isDark: boolean, agentThemeColor?: string, creationThemeColor?: string): void {
  dispatchToDshClient({
    type: 'COPIS_THEME_CHANGED',
    isDark,
    agentThemeColor,
    creationThemeColor,
  })

  if (dshView && !dshView.webContents.isDestroyed()) {
    const js = `
      try {
        if (document.documentElement) {
          document.documentElement.style.colorScheme = '${isDark ? 'dark' : 'light'}';
          ${creationThemeColor ? `document.documentElement.style.setProperty('--creation-ui-primary', '${creationThemeColor}', 'important');` : ''}
        }
        if (document.body) {
          ${isDark ? "document.body.setAttribute('data-ds-dark-theme', '');" : "document.body.removeAttribute('data-ds-dark-theme');"}
          ${creationThemeColor ? `document.body.style.setProperty('--creation-ui-primary', '${creationThemeColor}', 'important');` : ''}
        }
      } catch (e) {}
    `
    dshView.webContents.executeJavaScript(js).catch(() => {})
  }
}

/** 向 DSH 视图实时同步隐藏菜单项设置 */
export function syncHiddenSidebarMenuItemsToDshView(hiddenItems?: string[]): void {
  dispatchToDshClient({
    type: 'COPIS_HIDDEN_SIDEBAR_MENU_ITEMS_CHANGED',
    hiddenSidebarMenuItems: Array.isArray(hiddenItems) ? hiddenItems : [],
  })
}

/** 获取当前原生 DSH View 实例 */
export function getDshView(): WebContentsView | null {
  return dshView
}

/** 销毁 DSH View */
export function destroyDshView(): void {
  focusOnNextShow = false
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
