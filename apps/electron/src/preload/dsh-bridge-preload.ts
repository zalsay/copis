/**
 * DSH 原生 WebContentsView 桥接 Preload 脚本。
 *
 * 运行在 DSH WebContentsView 的隔离环境中：
 * 1. 暴露 window.copisBridge API 供 DSH 侧边栏直接调用；
 * 2. 代理 window.message 事件，向前兼容现有 postMessage 逻辑；
 * 3. 将主进程广播的事件（如取消高亮、全局命令）回传给网页。
 */

import { contextBridge, ipcRenderer } from 'electron'
import { DSH_CORDIS_IPC_CHANNELS, type DshClientEvent } from '@copis/shared'
import { SETTINGS_IPC_CHANNELS } from '../types'

let currentThemeIsDark: boolean | null = null
let isApplyingTheme = false

/**
 * 将浅色/深色主题应用到 DSH 网页 DOM
 */
function applyDshTheme(isDark: boolean): void {
  currentThemeIsDark = isDark
  if (typeof document === 'undefined') return

  const apply = () => {
    isApplyingTheme = true
    try {
      if (document.documentElement) {
        document.documentElement.style.colorScheme = isDark ? 'dark' : 'light'
      }
      if (document.body) {
        if (isDark) {
          if (!document.body.hasAttribute('data-ds-dark-theme')) {
            document.body.setAttribute('data-ds-dark-theme', '')
          }
        } else {
          if (document.body.hasAttribute('data-ds-dark-theme')) {
            document.body.removeAttribute('data-ds-dark-theme')
          }
        }
      }
    } finally {
      isApplyingTheme = false
    }
  }

  if (document.body) {
    apply()
  } else {
    document.addEventListener('DOMContentLoaded', apply, { once: true })
  }
}

/**
 * 守卫 DSH body 的主题属性，防止 DSH 内部脚本误覆盖 Copis 当前设定的主题
 */
function setupThemeGuard(): void {
  if (typeof document === 'undefined') return

  const attachObserver = () => {
    if (!document.body) return
    const observer = new MutationObserver(() => {
      if (isApplyingTheme || currentThemeIsDark === null) return
      const hasAttr = document.body.hasAttribute('data-ds-dark-theme')
      if (currentThemeIsDark && !hasAttr) {
        isApplyingTheme = true
        document.body.setAttribute('data-ds-dark-theme', '')
        isApplyingTheme = false
      } else if (!currentThemeIsDark && hasAttr) {
        isApplyingTheme = true
        document.body.removeAttribute('data-ds-dark-theme')
        isApplyingTheme = false
      }
    })
    observer.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] })
  }

  if (document.body) {
    attachObserver()
  } else {
    document.addEventListener('DOMContentLoaded', attachObserver, { once: true })
  }
}

function computeIsDark(themeMode?: string, themeStyle?: string, systemIsDark = false): boolean {
  if (themeMode === 'special' && themeStyle && themeStyle !== 'default') {
    return themeStyle.endsWith('-dark')
  }
  if (themeMode === 'system') {
    return systemIsDark
  }
  if (themeMode === 'dark') {
    return true
  }
  if (themeMode === 'light') {
    return false
  }
  return systemIsDark
}

async function initThemeSync(): Promise<void> {
  try {
    const [settings, systemIsDark] = await Promise.all([
      ipcRenderer.invoke(SETTINGS_IPC_CHANNELS.GET),
      ipcRenderer.invoke(SETTINGS_IPC_CHANNELS.GET_SYSTEM_THEME),
    ])
    const isDark = computeIsDark(settings?.themeMode, settings?.themeStyle, systemIsDark)
    applyDshTheme(isDark)
  } catch {
    if (typeof window !== 'undefined' && window.matchMedia) {
      applyDshTheme(window.matchMedia('(prefers-color-scheme: dark)').matches)
    }
  }
}

const copisBridge = {
  navigate: (view: string, tab?: string) => {
    ipcRenderer.send(DSH_CORDIS_IPC_CHANNELS.CLIENT_EVENT, { type: 'COPIS_NAVIGATE', view, tab })
  },
  switchMode: (mode: string) => {
    ipcRenderer.send(DSH_CORDIS_IPC_CHANNELS.CLIENT_EVENT, { type: 'COPIS_SWITCH_MODE', mode })
  },
  openSearch: () => {
    ipcRenderer.send(DSH_CORDIS_IPC_CHANNELS.CLIENT_EVENT, { type: 'COPIS_OPEN_SEARCH' })
  },
  openSettings: () => {
    ipcRenderer.send(DSH_CORDIS_IPC_CHANNELS.CLIENT_EVENT, { type: 'COPIS_OPEN_SETTINGS' })
  },
  openFeedback: () => {
    ipcRenderer.send(DSH_CORDIS_IPC_CHANNELS.CLIENT_EVENT, { type: 'COPIS_OPEN_FEEDBACK' })
  },
  reportSidebarInfo: (info: { width: number; wide?: boolean; collapsed?: boolean }) => {
    ipcRenderer.send(DSH_CORDIS_IPC_CHANNELS.CLIENT_EVENT, { type: 'COPIS_DSH_SIDEBAR_INFO', ...info })
  },
  readFile: (filePath: string, cwd?: string) => {
    return ipcRenderer.invoke(DSH_CORDIS_IPC_CHANNELS.READ_FILE, filePath, cwd)
  },
  showItemInFolder: (filePath: string, cwd?: string) => {
    return ipcRenderer.invoke(DSH_CORDIS_IPC_CHANNELS.SHOW_ITEM_IN_FOLDER, filePath, cwd)
  },
  listDirectory: (dirPath?: string, cwd?: string) => {
    return ipcRenderer.invoke(DSH_CORDIS_IPC_CHANNELS.LIST_DIRECTORY, dirPath, cwd)
  },
}

try {
  contextBridge.exposeInMainWorld('copisBridge', copisBridge)
} catch {
  // 如果 contextIsolation 为 false
  ;(window as unknown as { copisBridge: typeof copisBridge }).copisBridge = copisBridge
}

// 兼容 postMessage 消息监听并转交 IPC
window.addEventListener('message', (event) => {
  if (!event.data || typeof event.data !== 'object') return
  const data = event.data as DshClientEvent
  if (
    data.type === 'COPIS_NAVIGATE' ||
    data.type === 'COPIS_SWITCH_MODE' ||
    data.type === 'COPIS_OPEN_SEARCH' ||
    data.type === 'COPIS_OPEN_SETTINGS' ||
    data.type === 'COPIS_OPEN_FEEDBACK' ||
    data.type === 'COPIS_DSH_SIDEBAR_INFO'
  ) {
    ipcRenderer.send(DSH_CORDIS_IPC_CHANNELS.CLIENT_EVENT, data)
  }
})

// 监听主进程派发到此 WebContentsView 的事件，通过 postMessage 转发给当前网页
ipcRenderer.on(DSH_CORDIS_IPC_CHANNELS.DISPATCH_EVENT_TO_CLIENT, (_event, payload) => {
  if (payload && typeof payload === 'object' && (payload as { type?: string }).type === 'COPIS_THEME_CHANGED') {
    const { isDark } = payload as { isDark: boolean }
    applyDshTheme(Boolean(isDark))
  }
  window.postMessage(payload, '*')
})

/**
 * 注入 Copis 创造模式主题强调色 (#6C00CC)
 *
 * 替换 DSH 原有 DeepSeek 品牌蓝变量，并在浅色/深色主题下提供高对比度的紫色系强调色。
 */
function injectCopisThemeAccent(): void {
  const STYLE_ID = 'copis-theme-accent-style'
  if (document.getElementById(STYLE_ID)) return

  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
    :root, body {
      --ui-primary: #f09a43 !important;
      --creation-ui-primary: #6C00CC !important;
      --creation-ui-primary-foreground: #ffffff !important;
      --creation-ui-primary-background: rgba(108, 0, 204, 0.15) !important;
      --dsh-brand: #6C00CC !important;
      --dsw-static-deepseek-500: #6C00CC !important;
      --dsw-static-deepseek-450: #7d1ad9 !important;
      --dsw-static-deepseek-400: #8e2de2 !important;
      --dsw-static-deepseek-600: #5500a3 !important;
      --dsw-static-deepseek-100: #f3e8ff !important;
      --dsw-static-deepseek-200: #e9d5ff !important;
      --dsw-static-deepseek-300: #d8b4fe !important;
      --dsw-static-deepseek-50: #faf5ff !important;
      --dsw-alias-brand-primary-new-colorprimary-new-color: #6C00CC !important;
      --dsw-alias-state-business-primary: #6C00CC !important;
      --dsw-alias-state-business-tertiary: #f3e8ff !important;
      --dsw-alias-label-primary-bluish: #6C00CC !important;
    }
    body[data-ds-dark-theme] {
      --ui-primary: #f09a43 !important;
      --creation-ui-primary: #a855f7 !important;
      --creation-ui-primary-foreground: #ffffff !important;
      --creation-ui-primary-background: rgba(168, 85, 247, 0.18) !important;
      --dsh-brand: #a855f7 !important;
      --dsw-static-deepseek-500: #a855f7 !important;
      --dsw-static-deepseek-450: #a855f7 !important;
      --dsw-static-deepseek-400: #9333ea !important;
      --dsw-static-deepseek-100: #3b0764 !important;
      --dsw-static-deepseek-200: #4c1d95 !important;
      --dsw-static-deepseek-300: #581c87 !important;
      --dsw-static-deepseek-50: #23083e !important;
      --dsw-static-deepseek-800: #2e1065 !important;
      --dsw-static-deepseek-900: #1e0938 !important;
      --dsw-alias-brand-primary-new-colorprimary-new-color: #a855f7 !important;
      --dsw-alias-state-business-primary: #a855f7 !important;
      --dsw-alias-state-business-tertiary: #2e1065 !important;
      --dsw-alias-label-primary-bluish: #c084fc !important;
    }
  `
  const target = document.head || document.documentElement
  if (target) {
    target.appendChild(style)
  }
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectCopisThemeAccent)
  } else {
    injectCopisThemeAccent()
  }
}

// 启动主题观察守卫与首次同步
setupThemeGuard()
void initThemeSync()

if (typeof window !== 'undefined' && window.matchMedia) {
  try {
    const mql = window.matchMedia('(prefers-color-scheme: dark)')
    mql.addEventListener('change', (e) => {
      // 仅在当前未强行由 settings 指定时才作为媒体查询兜底
      if (currentThemeIsDark === null) {
        applyDshTheme(e.matches)
      }
    })
  } catch {}
}

