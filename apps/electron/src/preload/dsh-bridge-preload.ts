/**
 * DSH 原生 WebContentsView 桥接 Preload 脚本。
 *
 * 运行在 DSH WebContentsView 的隔离环境中：
 * 1. 暴露 window.copisBridge API 供 DSH 侧边栏直接调用；
 * 2. 代理 window.message 事件，向前兼容现有 postMessage 逻辑；
 * 3. 将主进程广播的事件（如取消高亮、全局命令）回传给网页。
 */

import { contextBridge, ipcRenderer } from 'electron'
import { DSH_CORDIS_IPC_CHANNELS, AGENT_IPC_CHANNELS, DEFAULT_DSH_PINNED_MENU_IDS, isDshExpandedSidebarWidth, type DshClientEvent, type DshMediaPreviewResult } from '@copis/shared'
import { SETTINGS_IPC_CHANNELS } from '../types'

let currentThemeIsDark: boolean | null = null
let isApplyingTheme = false
let currentCustomAgentColor: string | undefined = undefined
let currentCustomCreationColor: string | undefined = undefined

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
      if (currentCustomAgentColor || currentCustomCreationColor) {
        applyCustomThemeColors(currentCustomAgentColor, currentCustomCreationColor)
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

function hexToRgba(hex: string, alpha: number): string {
  const clean = hex.replace('#', '')
  const num = parseInt(clean.length === 3 ? clean.split('').map(c => c + c).join('') : clean, 16)
  if (isNaN(num)) return hex
  const r = (num >> 16) & 255
  const g = (num >> 8) & 255
  const b = num & 255
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

function applyCustomThemeColors(agentColor?: string, creationColor?: string): void {
  currentCustomAgentColor = agentColor
  currentCustomCreationColor = creationColor
  if (typeof document === 'undefined') return
  const CUSTOM_STYLE_ID = 'copis-custom-theme-colors-style'
  let styleEl = document.getElementById(CUSTOM_STYLE_ID) as HTMLStyleElement | null
  if (!agentColor && !creationColor) {
    if (styleEl) styleEl.remove()
    return
  }

  if (!styleEl) {
    styleEl = document.createElement('style')
    styleEl.id = CUSTOM_STYLE_ID
  }
  const target = document.head || document.documentElement
  if (target) {
    target.appendChild(styleEl)
  }

  const isDark = currentThemeIsDark ?? false
  const alpha = isDark ? 0.18 : 0.15

  let css = ':root, :root body, body, body[data-ds-dark-theme], :root body[data-ds-dark-theme], html[data-ds-dark-theme], [data-ds-dark-theme] {\n'
  if (agentColor) {
    css += `  --ui-primary: ${agentColor} !important;\n`
    css += `  --ui-primary-background: ${hexToRgba(agentColor, 0.2)} !important;\n`
  }
  if (creationColor) {
    css += `  --creation-ui-primary: ${creationColor} !important;\n`
    css += `  --creation-ui-primary-background: ${hexToRgba(creationColor, alpha)} !important;\n`
    css += `  --dsh-brand: ${creationColor} !important;\n`
    css += `  --dsw-static-deepseek-500: ${creationColor} !important;\n`
    css += `  --dsw-static-deepseek-450: ${creationColor} !important;\n`
    css += `  --dsw-static-deepseek-400: ${creationColor} !important;\n`
    css += `  --dsw-alias-brand-primary-new-colorprimary-new-color: ${creationColor} !important;\n`
    css += `  --dsw-alias-state-business-primary: ${creationColor} !important;\n`
    css += `  --dsw-alias-label-primary-bluish: ${creationColor} !important;\n`
    css += `  --dsw-specific-sidebar-nav-item-active: ${hexToRgba(creationColor, alpha)} !important;\n`
    css += `  --dsw-specific-sidebar-nav-item-active-accent: ${creationColor} !important;\n`
  }
  css += '}\n'
  styleEl.textContent = css
}

async function initThemeSync(): Promise<void> {
  try {
    const [settings, systemIsDark] = await Promise.all([
      ipcRenderer.invoke(SETTINGS_IPC_CHANNELS.GET),
      ipcRenderer.invoke(SETTINGS_IPC_CHANNELS.GET_SYSTEM_THEME),
    ])
    const isDark = computeIsDark(settings?.themeMode, settings?.themeStyle, systemIsDark)
    applyDshTheme(isDark)
    const agentColor = isDark
      ? (settings?.agentThemeColorDark || settings?.agentThemeColor || undefined)
      : (settings?.agentThemeColorLight || settings?.agentThemeColor || undefined)
    const creationColor = isDark
      ? (settings?.creationThemeColorDark || settings?.creationThemeColor || undefined)
      : (settings?.creationThemeColorLight || settings?.creationThemeColor || undefined)
    applyCustomThemeColors(agentColor, creationColor)
  } catch {
    if (typeof window !== 'undefined' && window.matchMedia) {
      applyDshTheme(window.matchMedia('(prefers-color-scheme: dark)').matches)
    }
  }
}

const copisBridge = {
  reportSessionCompleted: (completion: Omit<Extract<DshClientEvent, { type: 'COPIS_DSH_SESSION_COMPLETED' }>, 'type'>) => {
    ipcRenderer.send(DSH_CORDIS_IPC_CHANNELS.CLIENT_EVENT, { ...completion, type: 'COPIS_DSH_SESSION_COMPLETED' })
  },
  reportSessionViewed: (sessionId: string) => {
    ipcRenderer.send(DSH_CORDIS_IPC_CHANNELS.CLIENT_EVENT, { type: 'COPIS_DSH_SESSION_VIEWED', sessionId })
  },
  navigate: (view: string, tab?: string) => {
    ipcRenderer.send(DSH_CORDIS_IPC_CHANNELS.CLIENT_EVENT, { type: 'COPIS_NAVIGATE', view, tab })
  },
  switchMode: (mode: string) => {
    ipcRenderer.send(DSH_CORDIS_IPC_CHANNELS.CLIENT_EVENT, { type: 'COPIS_SWITCH_MODE', mode })
  },
  openSearch: () => {
    window.dispatchEvent(new CustomEvent('COPIS_OPEN_SEARCH_MODAL'))
    ipcRenderer.send(DSH_CORDIS_IPC_CHANNELS.CLIENT_EVENT, { type: 'COPIS_OPEN_SEARCH' })
  },
  getAgentSessions: () => {
    return ipcRenderer.invoke(AGENT_IPC_CHANNELS.LIST_SESSIONS)
  },
  searchAgentSessionMessages: (query: string) => {
    return ipcRenderer.invoke(AGENT_IPC_CHANNELS.SEARCH_MESSAGES, query)
  },
  openSession: (sessionType: 'agent' | 'chat', sessionId: string, title?: string) => {
    ipcRenderer.send(DSH_CORDIS_IPC_CHANNELS.CLIENT_EVENT, {
      type: 'COPIS_OPEN_SESSION',
      sessionType,
      sessionId,
      title,
    })
  },
  openSettings: () => {
    ipcRenderer.send(DSH_CORDIS_IPC_CHANNELS.CLIENT_EVENT, { type: 'COPIS_OPEN_SETTINGS' })
  },
  openFeedback: () => {
    ipcRenderer.send(DSH_CORDIS_IPC_CHANNELS.CLIENT_EVENT, { type: 'COPIS_OPEN_FEEDBACK' })
  },
  reportSidebarInfo: (info: { width: number; wide?: boolean; collapsed?: boolean }) => {
    if (isDshExpandedSidebarWidth(info?.width)) {
      ipcRenderer.send(DSH_CORDIS_IPC_CHANNELS.CLIENT_EVENT, {
        type: 'COPIS_DSH_SIDEBAR_INFO',
        ...info,
        width: Math.round(info.width),
      })
    }
  },
  prepareMediaPreview: (path: string): Promise<DshMediaPreviewResult> =>
    ipcRenderer.invoke(DSH_CORDIS_IPC_CHANNELS.PREPARE_MEDIA_PREVIEW, path),
  releaseMediaPreview: (url: string): Promise<boolean> =>
    ipcRenderer.invoke(DSH_CORDIS_IPC_CHANNELS.RELEASE_MEDIA_PREVIEW, url),
  readFile: (filePath: string, cwd?: string) => {
    return ipcRenderer.invoke(DSH_CORDIS_IPC_CHANNELS.READ_FILE, filePath, cwd)
  },
  showItemInFolder: (filePath: string, cwd?: string) => {
    return ipcRenderer.invoke(DSH_CORDIS_IPC_CHANNELS.SHOW_ITEM_IN_FOLDER, filePath, cwd)
  },
  listDirectory: (dirPath?: string, cwd?: string) => {
    return ipcRenderer.invoke(DSH_CORDIS_IPC_CHANNELS.LIST_DIRECTORY, dirPath, cwd)
  },
  getActiveWorkspacePath: (cwd?: string) => {
    return ipcRenderer.invoke(DSH_CORDIS_IPC_CHANNELS.GET_ACTIVE_WORKSPACE_PATH, cwd)
  },
  getPinnedMenuItems: async (): Promise<string[]> => {
    const settings = await ipcRenderer.invoke(SETTINGS_IPC_CHANNELS.GET)
    if (Array.isArray(settings?.pinnedDshSidebarMenuItems)) return settings.pinnedDshSidebarMenuItems
    const previouslyHidden = Array.isArray(settings?.hiddenSidebarMenuItems) ? settings.hiddenSidebarMenuItems : []
    // 旧版被隐藏的默认项改为未固定，可从「展开显示」找回。
    return DEFAULT_DSH_PINNED_MENU_IDS.filter((id) => !previouslyHidden.includes(id))
  },
  setPinnedMenuItems: async (ids: string[]): Promise<void> => {
    if (!Array.isArray(ids) || ids.length > 32 || ids.some((id) => typeof id !== 'string' || !/^[a-z-]{1,32}$/.test(id))) {
      throw new TypeError('无效的固定菜单项')
    }
    await ipcRenderer.invoke(SETTINGS_IPC_CHANNELS.UPDATE, { pinnedDshSidebarMenuItems: [...new Set(ids)] })
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

function applySubviewActiveState(active: boolean): void {
  if (typeof document === 'undefined') return
  if (active) {
    document.body?.classList.add('copis-subview-active')
    document.documentElement?.classList.add('copis-subview-active')
  } else {
    document.body?.classList.remove('copis-subview-active')
    document.documentElement?.classList.remove('copis-subview-active')
  }

  const newSessionBtn = document.querySelector<HTMLButtonElement>(
    'button[class*="_newSession"], button[class*="newSession"]',
  )
  if (newSessionBtn) {
    if (active) {
      newSessionBtn.setAttribute('data-copis-return-button', 'true')
      newSessionBtn.setAttribute('title', '返回会话 (Esc)')
      newSessionBtn.setAttribute('aria-label', '返回会话 (Esc)')
    } else {
      newSessionBtn.removeAttribute('data-copis-return-button')
      newSessionBtn.setAttribute('title', '新建会话')
      newSessionBtn.setAttribute('aria-label', '新建会话')
    }
  }
}

// 监听主进程派发到此 WebContentsView 的事件，通过 postMessage 转发给当前网页
ipcRenderer.on(DSH_CORDIS_IPC_CHANNELS.DISPATCH_EVENT_TO_CLIENT, (_event, payload) => {
  if (payload && typeof payload === 'object') {
    const p = payload as {
      type?: string
      isDark?: boolean
      agentThemeColor?: string
      creationThemeColor?: string
      subview?: string | null
      view?: string
    }
    if (p.type === 'COPIS_THEME_CHANGED') {
      applyDshTheme(Boolean(p.isDark))
      const nextAgentColor = p.agentThemeColor !== undefined ? (p.agentThemeColor || undefined) : currentCustomAgentColor
      const nextCreationColor = p.creationThemeColor !== undefined ? (p.creationThemeColor || undefined) : currentCustomCreationColor
      applyCustomThemeColors(nextAgentColor, nextCreationColor)
    }
    if (p.type === 'COPIS_OPEN_SEARCH_MODAL') {
      window.dispatchEvent(new CustomEvent('COPIS_OPEN_SEARCH_MODAL'))
    }
    if (p.type === 'COPIS_SUBVIEW_CHANGE') {
      applySubviewActiveState(Boolean(p.subview))
    }
    if (p.type === 'COPIS_ACTIVE_VIEW_CHANGE') {
      if (p.view === 'conversations') {
        applySubviewActiveState(false)
      } else if (p.view) {
        applySubviewActiveState(true)
      }
    }
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
      --ui-primary-background: rgb(240 161 90 / 20%) !important;
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

      /* 创造模式浅色左侧菜单栏背景色：与 Agent 模式一致 (hsl(var(--muted)) -> hsl(0 0% 96.1%)) */
      --dsw-specific-sidebar-fill: hsl(0 0% 96.1%) !important;
      /* 创造模式菜单激活背景色与强调色：使用 creation-ui-primary 体系 */
      --dsw-specific-sidebar-nav-item-active: rgba(108, 0, 204, 0.15) !important;
      --dsw-specific-sidebar-nav-item-active-accent: #6C00CC !important;
    }
    body[data-ds-dark-theme] {
      --ui-primary: #f09a43 !important;
      --ui-primary-background: rgb(240 161 90 / 20%) !important;
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

      /* 创造模式深色左侧菜单栏背景色：与 Agent 模式一致 (hsl(var(--muted)) -> hsl(0 0% 17%)) */
      --dsw-specific-sidebar-fill: hsl(0 0% 17%) !important;
      /* 创造模式菜单激活背景色与强调色：使用 creation-ui-primary 体系 */
      --dsw-specific-sidebar-nav-item-active: rgba(168, 85, 247, 0.18) !important;
      --dsw-specific-sidebar-nav-item-active-accent: #a855f7 !important;
    }

    .copis-hero-logo-light {
      display: block;
    }
    .copis-hero-logo-dark {
      display: none;
    }
    body[data-ds-dark-theme] .copis-hero-logo-light {
      display: none;
    }
    body[data-ds-dark-theme] .copis-hero-logo-dark {
      display: block;
    }

    /* 侧边栏容器背景：对齐 Agent 模式 */
    .hHd-Xa_root,
    [class*="SidebarRoot_root"],
    [class*="sidebar"][class*="root"],
    aside[class*="root"],
    div[style*="--dsh-sidebar-inline-padding"] {
      background: var(--dsw-specific-sidebar-fill) !important;
    }

    /* 侧边栏菜单项尺寸与圆角对齐 Agent 模式 */
    .copis-menu-item {
      font-size: 14px !important;
      font-weight: 400 !important;
      line-height: 1.25 !important;
      border-radius: 7px !important;
      min-height: 31px !important;
      padding: 5px 8px !important;
      gap: 8px !important;
    }
    .copis-rail-menu-item {
      border-radius: 7px !important;
    }
    /* 隐藏顶部右上角原生的 session-log-download 及任何 Agent 模式切换按钮 */
    button[class*="sessionLogButton"],
    button[title*="返回 Agent 模式"]:not(.copis-return-agent-button),
    button[title*="返回Agent 模式"]:not(.copis-return-agent-button),
    button[aria-label*="返回 Agent 模式"]:not(.copis-return-agent-button),
    button[aria-label*="返回Agent 模式"]:not(.copis-return-agent-button),
    [data-slot-id="session-log-download"] {
      display: none !important;
    }
    /* 创造模式会话列表行圆角与字号对齐 Agent 模式 */
    .YDXeBa_sessionRow,
    [class*="sessionRow"] {
      border-radius: 7px !important;
      font-size: 14px !important;
    }
    button[class*="_newSession"],
    button[class*="newSession"] {
      border-radius: 7px !important;
      font-size: 14px !important;
    }

    /* Copis 左栏从新建会话开始，不展示 DSH 本地构建品牌 Header。 */
    [class*="_logoRow"],
    [class*="logoRow"],
    [class*="_localBuildBrand"],
    [class*="localBuildBrand"] {
      display: none !important;
    }

    /* 隐藏 DSH 原生侧栏中遗留的旧版静态菜单（无 data-copis-placement），只保留 copis-creation-web 插件动态挂载的导航菜单 */
    .copis-menu-section:not([data-copis-placement="before-workspaces"]),
    .copis-rail-menu-section:not([data-copis-placement="before-workspaces"]) {
      display: none !important;
    }

    /* 侧边栏菜单项激活态：使用 creation-ui-primary 体系 */
    .copis-menu-section button.active,
    .copis-menu-section button[data-active="true"],
    .copis-menu-section button[style*="f59e0b"],
    .copis-menu-section button[style*="245, 158, 11"],
    .copis-menu-section button[style*="rgba(245, 158, 11"],
    .copis-menu-section button[style*="var(--ui-primary)"],
    .copis-menu-section button[style*="var(--creation-ui-primary)"],
    .copis-rail-menu-section button.active,
    .copis-rail-menu-section button[data-active="true"],
    .copis-rail-menu-section button[style*="f59e0b"],
    .copis-rail-menu-section button[style*="245, 158, 11"],
    .copis-rail-menu-section button[style*="rgba(245, 158, 11"],
    .copis-rail-menu-section button[style*="var(--ui-primary)"],
    .copis-rail-menu-section button[style*="var(--creation-ui-primary)"] {
      background: var(--creation-ui-primary-background) !important;
      color: var(--creation-ui-primary) !important;
      border: none !important;
      border-color: transparent !important;
      font-weight: 600 !important;
    }
    .copis-menu-section button.active svg,
    .copis-menu-section button[data-active="true"] svg,
    .copis-menu-section button[style*="f59e0b"] svg,
    .copis-menu-section button[style*="245, 158, 11"] svg,
    .copis-menu-section button[style*="rgba(245, 158, 11"] svg,
    .copis-menu-section button[style*="var(--ui-primary)"] svg,
    .copis-menu-section button[style*="var(--creation-ui-primary)"] svg,
    .copis-rail-menu-section button.active svg,
    .copis-rail-menu-section button[data-active="true"] svg,
    .copis-rail-menu-section button[style*="f59e0b"] svg,
    .copis-rail-menu-section button[style*="245, 158, 11"] svg,
    .copis-rail-menu-section button[style*="rgba(245, 158, 11"] svg,
    .copis-rail-menu-section button[style*="var(--ui-primary)"] svg,
    .copis-rail-menu-section button[style*="var(--creation-ui-primary)"] svg {
      color: var(--creation-ui-primary) !important;
    }

    /* 会话与项目行选中激活态：使用 WorkBuddy 浅灰/曜石微高光体系，彻底消除紫色 */
    .copis-room-row:has(> .copis-menu-item[data-active="true"]),
    .YDXeBa_sessionRow.YDXeBa_selected,
    .YDXeBa_searchResultRow.YDXeBa_selected,
    .YDXeBa_projectRow.active,
    [class*="sessionRow"][class*="selected"],
    [class*="searchResultRow"][class*="selected"],
    [class*="projectRow"][class*="active"],
    [class*="sessionRow"][data-selected="true"],
    [class*="SessionRow"][data-selected="true"] {
      background: var(--dsw-alias-interactive-bg-hover, rgba(255, 255, 255, 0.1)) !important;
      color: var(--dsw-alias-label-primary, #ffffff) !important;
      font-weight: 500 !important;
    }
    .YDXeBa_sessionRow.YDXeBa_selected *,
    [class*="sessionRow"][class*="selected"] * {
      color: var(--dsw-alias-label-primary, #ffffff) !important;
    }
    .YDXeBa_sessionRow.YDXeBa_selected [class*="date"],
    .YDXeBa_sessionRow.YDXeBa_selected [class*="time"],
    [class*="sessionRow"][class*="selected"] [class*="date"],
    [class*="sessionRow"][class*="selected"] [class*="time"],
    [class*="sessionRow"][class*="selected"] span:last-child {
      color: #a1a1aa !important;
    }
    .copis-room-row > .copis-menu-item[data-active="true"] svg,
    [class*="sessionRow"][class*="selected"] svg,
    [class*="searchResultRow"][class*="selected"] svg,
    [class*="projectRow"][class*="active"] svg {
      color: var(--dsw-alias-label-secondary, #d4d4d8) !important;
    }
    .YDXeBa_projectRow svg,
    [class*="projectRow"] svg,
    [class*="workspaceRow"] svg {
      color: #a1a1aa !important;
    }

    /* 顶部 Tab 导航（对话 / 轨迹）：WorkBuddy 纯白文字与白色指示条 */
    .wSkVaW_tab,
    [class*="wSkVaW_tab"],
    [class*="_tab"][role="tab"] {
      color: #94a3b8 !important;
      font-weight: 500 !important;
    }
    .wSkVaW_tab:hover,
    [class*="wSkVaW_tab"]:hover,
    [class*="_tab"][role="tab"]:hover {
      color: #cbd5e1 !important;
    }
    .wSkVaW_tabActive,
    [class*="wSkVaW_tabActive"],
    [class*="_tabActive"],
    button[role="tab"][aria-selected="true"],
    [class*="tab"][class*="active"],
    [class*="tab"][data-active="true"] {
      color: #ffffff !important;
      font-weight: 600 !important;
    }
    .wSkVaW_tabActive:after,
    [class*="wSkVaW_tabActive"]:after,
    [class*="_tabActive"]:after,
    button[role="tab"][aria-selected="true"]:after,
    [class*="tab"][class*="active"]:after,
    [class*="tab"][data-active="true"]:after {
      background: #ffffff !important;
      height: 2px !important;
      border-radius: 1px !important;
    }

    /* 优雅紫色半透明毛玻璃 Composer 输入胶囊卡片（背景更深，紫色更淡内敛） */
    [class*="uV2eYG_card"],
    [class*="_card"][class*="composer"] {
      border-radius: 20px !important;
      background: color-mix(in srgb, var(--creation-ui-primary, #a855f7) 7%, rgba(16, 17, 24, 0.90)) !important;
      -webkit-backdrop-filter: blur(24px) !important;
      backdrop-filter: blur(24px) !important;
      border: 1px solid color-mix(in srgb, var(--creation-ui-primary, #a855f7) 12%, rgba(255, 255, 255, 0.08)) !important;
      box-shadow: 0 16px 40px -8px rgba(0, 0, 0, 0.6), 0 0 20px -4px color-mix(in srgb, var(--creation-ui-primary, #a855f7) 8%, transparent), inset 0 1px 0 rgba(255, 255, 255, 0.08) !important;
      margin-bottom: 16px !important;
      padding-top: 10px !important;
    }

    body:not([data-ds-dark-theme]) [class*="uV2eYG_card"],
    body:not([data-ds-dark-theme]) [class*="_card"][class*="composer"] {
      background: color-mix(in srgb, var(--creation-ui-primary, #6c00cc) 4%, rgba(255, 255, 255, 0.88)) !important;
      border: 1px solid color-mix(in srgb, var(--creation-ui-primary, #6c00cc) 10%, rgba(0, 0, 0, 0.08)) !important;
      box-shadow: 0 16px 36px -8px rgba(0, 0, 0, 0.08), inset 0 1px 0 rgba(255, 255, 255, 0.8) !important;
    }

    /* 页面视口与对话容器：彻底消除横向多余滚动条与 hover 闪烁 */
    html,
    body,
    [class*="_centerCol"],
    [class*="centerCol"],
    [class*="_frame"],
    [class*="frame"],
    [data-view="conversation"],
    main,
    [class*="uV2eYG_root"] {
      overflow-x: clip !important;
      max-width: 100% !important;
    }

    /* 强制屏蔽页面与卡片底部的横向多余滚动条 */
    html::-webkit-scrollbar:horizontal,
    body::-webkit-scrollbar:horizontal,
    [class*="_centerCol"]::-webkit-scrollbar:horizontal,
    [class*="centerCol"]::-webkit-scrollbar:horizontal,
    [class*="uV2eYG_root"]::-webkit-scrollbar:horizontal,
    [class*="uV2eYG_card"]::-webkit-scrollbar:horizontal,
    [class*="uV2eYG_row"]::-webkit-scrollbar:horizontal {
      display: none !important;
      height: 0 !important;
      width: 0 !important;
    }

    /* 上下文用量圆环（ContextMeter）与底部工具按钮悬浮 Tooltip 定位边界防溢出保护 */
    [class*="JObwrW_root"] {
      overflow: visible !important;
    }

    [class*="JObwrW_root"] [role="tooltip"],
    [class*="JObwrW_root"] [class*="tooltip"],
    [class*="JObwrW_root"] [class*="Tooltip"] {
      right: 0 !important;
      left: auto !important;
      max-width: 240px !important;
      white-space: nowrap !important;
      pointer-events: none !important;
    }

    /* 全局 Tooltip 浮层尺寸保护：避免绝对定位或动画帧撑大视口底部 */
    [role="tooltip"],
    [class*="tooltip"],
    [class*="Tooltip"] {
      max-width: calc(100vw - 32px) !important;
      word-break: break-word !important;
      pointer-events: none !important;
    }

    /* 创造模式会话列表项：背景色与条目留出左侧间距，形成优雅层级对齐 */
    .YDXeBa_sessionRow,
    [class*="sessionRow"] {
      margin-left: 16px !important;
      width: calc(100% - 16px) !important;
      box-sizing: border-box !important;
    }
    .YDXeBa_sessionRow .YDXeBa_slot:empty,
    [class*="sessionRow"] [class*="slot"]:empty {
      display: none !important;
      width: 0 !important;
      margin: 0 !important;
      padding: 0 !important;
    }

    /* 侧边栏底部隐藏意见反馈菜单项（统一移入设置菜单） */
    .hHd-Xa_footArea button[aria-label="意见反馈"],
    [class*="footArea"] button[aria-label="意见反馈"],
    [class*="FootArea"] button[aria-label="意见反馈"],
    .hHd-Xa_footArea button[data-copis-feedback="true"],
    [class*="footArea"] button[data-copis-feedback="true"],
    [class*="FootArea"] button[data-copis-feedback="true"] {
      display: none !important;
    }

    /* 隐藏 DSH 本地构建与 Logo 标识行，移除多余顶部留白与折叠切换按钮 */
    [class*="_logoRow"],
    [class*="logoRow"],
    .hHd-Xa_logoRow {
      display: none !important;
    }

    /* 当 Copis 子视图（规划/记忆/知识库/专家团队等）激活时：
       1. 彻底隐藏 DSH 原生中间对话区、欢迎屏、输入区与右侧详情栏；
       2. 强制 DSH 外层 Frame 与侧边栏独占整个 WebContentsView 视口 (100%)；
       3. 强制 DSH 侧边栏保持展开宽态 (Wide)，严禁误折叠为窄 Rail。 */
    body.copis-subview-active [class*="_centerCol"],
    body.copis-subview-active [class*="centerCol"],
    body.copis-subview-active [class*="_detailsCol"],
    body.copis-subview-active [class*="detailsCol"],
    body.copis-subview-active [class*="_handle"],
    body.copis-subview-active [class*="handle"],
    body.copis-subview-active [data-view="conversation"],
    body.copis-subview-active main {
      display: none !important;
      width: 0 !important;
      min-width: 0 !important;
      max-width: 0 !important;
      height: 0 !important;
      overflow: hidden !important;
      visibility: hidden !important;
      pointer-events: none !important;
    }

    body.copis-subview-active [class*="_frame"],
    body.copis-subview-active [class*="frame"] {
      display: flex !important;
      grid-template-columns: 100% !important;
      width: 100% !important;
      height: 100% !important;
    }

    body.copis-subview-active [class*="_sidebarCol"],
    body.copis-subview-active [class*="sidebarCol"] {
      display: flex !important;
      flex: 1 1 100% !important;
      width: 100% !important;
      max-width: 100% !important;
      height: 100% !important;
      border-right: none !important;
    }

    /* RC2 侧栏根节点为 div，覆盖原生抽屉保留的 48px 宽度差。 */
    body.copis-subview-active :is(.copis-creation-sidebar, .hHd-Xa_root, [class*="SidebarRoot_root"]) {
      box-sizing: border-box;
      width: 100% !important;
      padding: 6px var(--dsh-sidebar-inline-padding, 12px) !important;
    }

    /* 当子视图激活时，原「新会话」按钮无缝切换为「返回会话」按钮 */
    body.copis-subview-active button[class*="_newSession"],
    body.copis-subview-active button[class*="newSession"] {
      display: flex !important;
      align-items: center !important;
      width: 100% !important;
      height: 36px !important;
      margin: 0 0 12px !important;
      padding: 0 12px !important;
      gap: 8px !important;
      background: var(--creation-ui-primary-background, rgba(108, 0, 204, 0.12)) !important;
      color: var(--creation-ui-primary, #6c00cc) !important;
      border: 1px solid var(--creation-ui-primary-background, rgba(108, 0, 204, 0.25)) !important;
      border-radius: 7px !important;
      align-self: stretch !important;
      cursor: pointer !important;
      transition: background-color 150ms ease, border-color 150ms ease !important;
      box-sizing: border-box !important;
    }

    body.copis-subview-active button[class*="_newSession"]:hover,
    body.copis-subview-active button[class*="newSession"]:hover {
      background: var(--creation-ui-primary-background, rgba(108, 0, 204, 0.2)) !important;
      border-color: var(--creation-ui-primary, #6c00cc) !important;
    }

    /* 隐藏原「新建会话」图标 */
    body.copis-subview-active button[class*="_newSession"] svg,
    body.copis-subview-active button[class*="newSession"] svg {
      display: none !important;
    }

    /* 注入返回会话矢量箭头图标（仅作用于外层 button 前缀） */
    body.copis-subview-active button[class*="_newSession"]::before,
    body.copis-subview-active button[class*="newSession"]::before {
      content: "" !important;
      display: inline-block !important;
      width: 15px !important;
      height: 15px !important;
      flex: none !important;
      background-color: currentColor !important;
      -webkit-mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2.2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m12 19-7-7 7-7'/%3E%3Cpath d='M19 12H5'/%3E%3C/svg%3E") no-repeat center / contain !important;
      mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2.2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m12 19-7-7 7-7'/%3E%3Cpath d='M19 12H5'/%3E%3C/svg%3E") no-repeat center / contain !important;
    }

    /* 隐藏原「新会话」文字，替换为「返回会话」，确保内部 label 绝不带多余边框、背景或伪类箭头 */
    body.copis-subview-active [class*="newSessionLabel"],
    body.copis-subview-active [class*="_newSessionLabel"] {
      font-size: 0 !important;
      max-width: none !important;
      opacity: 1 !important;
      display: inline-flex !important;
      align-items: center !important;
      flex: 1 1 auto !important;
      min-width: 0 !important;
      overflow: hidden !important;
      border: none !important;
      background: transparent !important;
      padding: 0 !important;
      margin: 0 !important;
      height: auto !important;
      color: currentColor !important;
      box-shadow: none !important;
    }

    body.copis-subview-active [class*="newSessionLabel"]::before,
    body.copis-subview-active [class*="_newSessionLabel"]::before {
      content: none !important;
      display: none !important;
    }

    /* 只在文字节点生成标签，避免 RC2 的 LabelMask 再生成一次。 */
    body.copis-subview-active [class*="newSessionLabel"]:not([class*="newSessionLabelMask"])::after {
      content: "返回会话" !important;
      font-size: 14px !important;
      font-weight: 600 !important;
      line-height: 20px !important;
      color: currentColor !important;
      white-space: nowrap !important;
      border: none !important;
      background: transparent !important;
      padding: 0 !important;
      margin: 0 !important;
    }

    /* 在按钮最右侧展示精致的 Esc 快捷键胶囊（仅作用于外层 button 自身） */
    body.copis-subview-active button[class*="_newSession"]::after,
    body.copis-subview-active button[class*="newSession"]::after {
      content: "Esc" !important;
      margin-left: auto !important;
      font-size: 10px !important;
      font-weight: 500 !important;
      font-family: ui-monospace, monospace !important;
      line-height: 1 !important;
      padding: 2px 5px !important;
      border-radius: 4px !important;
      border: 1px solid currentColor !important;
      opacity: 0.7 !important;
      background: transparent !important;
      color: currentColor !important;
      flex: none !important;
    }

    body.copis-subview-active [class*="_regionArea"],
    body.copis-subview-active [class*="regionArea"] {
      display: flex !important;
      flex-direction: column !important;
      margin-left: -4px !important;
      margin-right: calc(-1 * var(--dsh-sidebar-inline-padding, 12px)) !important;
      padding-left: 4px !important;
    }

    /* 确保侧边栏工作区顶栏未展开搜索时，搜索按钮与操作按钮完整呈现，防止被 flex 压缩或裁剪 */
    [class*="sectionHeader"] {
      display: flex !important;
      align-items: center !important;
    }
    [class*="searchSlot"]:not([class*="searchSlotExpanded"]):not([class*="_searchSlotExpanded"]) {
      display: flex !important;
      min-width: 28px !important;
      max-width: 28px !important;
      flex: 0 0 28px !important;
      margin-left: auto !important;
      opacity: 1 !important;
      visibility: visible !important;
    }
    [class*="searchSlot"]:not([class*="searchSlotExpanded"]):not([class*="_searchSlotExpanded"]) [class*="search"] {
      display: flex !important;
      width: 28px !important;
      height: 28px !important;
    }
    [class*="searchSlot"]:not([class*="searchSlotExpanded"]):not([class*="_searchSlotExpanded"]) [class*="searchButton"] {
      display: inline-flex !important;
      width: 28px !important;
      height: 28px !important;
    }
    [class*="headerActions"]:not([class*="headerActionsHidden"]):not([class*="_headerActionsHidden"]) {
      display: flex !important;
      align-items: center !important;
      gap: 4px !important;
      min-width: 60px !important;
      max-width: none !important;
      flex: 0 0 auto !important;
      opacity: 1 !important;
      visibility: visible !important;
    }

    body.copis-subview-active .copis-menu-section {
      display: grid !important;
    }

    body.copis-subview-active [class*="_footArea"],
    body.copis-subview-active [class*="footArea"] {
      align-items: stretch !important;
    }
  `
  const target = document.head || document.documentElement
  if (target) {
    target.appendChild(style)
  }
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      injectCopisThemeAccent()
      void initThemeSync()
    })
  } else {
    injectCopisThemeAccent()
    void initThemeSync()
  }
}

/** 清理旧版菜单节点并同步原生侧栏按钮。 */
function syncDshSidebarMenuDoms(): void {
  if (typeof document === 'undefined') return

  // 清理原生侧栏中可能遗留的旧版硬编码菜单节点（无 data-copis-placement），避免与独立插件菜单重复
  const legacySections = document.querySelectorAll(
    '.copis-menu-section:not([data-copis-placement="before-workspaces"]), .copis-rail-menu-section:not([data-copis-placement="before-workspaces"])',
  )
  legacySections.forEach((el) => el.remove())

  // 侧边栏底部隐藏意见反馈按钮（宽侧边栏与窄侧边栏，统一在设置菜单中呈现）
  const footButtons = document.querySelectorAll<HTMLButtonElement>(
    '.hHd-Xa_footArea button, [class*="footArea"] button, [class*="FootArea"] button',
  )
  footButtons.forEach((btn) => {
    const label = btn.querySelector('span')?.textContent?.trim() || btn.getAttribute('aria-label')?.trim() || ''
    if (label === '意见反馈' || label.includes('反馈')) {
      btn.setAttribute('data-copis-feedback', 'true')
      btn.style.setProperty('display', 'none', 'important')
    }
  })

  // 同步顶部「新建会话 / 返回会话」按钮属性
  const topNewSessionBtn = document.querySelector<HTMLButtonElement>(
    'button[class*="_newSession"], button[class*="newSession"]',
  )
  if (topNewSessionBtn) {
    const isSubActive = Boolean(document.body?.classList.contains('copis-subview-active'))
    if (isSubActive) {
      topNewSessionBtn.setAttribute('data-copis-return-button', 'true')
      topNewSessionBtn.setAttribute('title', '返回会话 (Esc)')
      topNewSessionBtn.setAttribute('aria-label', '返回会话 (Esc)')
    } else {
      topNewSessionBtn.removeAttribute('data-copis-return-button')
      topNewSessionBtn.setAttribute('title', '新建会话')
      topNewSessionBtn.setAttribute('aria-label', '新建会话')
    }
  }
}

/**
 * 启动 DSH 侧边栏 DOM 观察器，同步原生按钮，不改动插件菜单
 */
function setupDshSidebarMenuObserver(): void {
  if (typeof document === 'undefined') return

  const attachObserver = () => {
    if (!document.body) return
    const observer = new MutationObserver(() => {
      syncDshSidebarMenuDoms()
    })
    observer.observe(document.body, { childList: true, subtree: true })
    syncDshSidebarMenuDoms()
  }

  if (document.body) {
    attachObserver()
  } else {
    document.addEventListener('DOMContentLoaded', attachObserver, { once: true })
  }
}

// 启动主题观察守卫与首次同步
setupThemeGuard()
void initThemeSync()
setupDshSidebarMenuObserver()

/**
 * 监听侧边栏中对会话项（sessionRow）、新建会话（newSession）、搜索结果（searchResultRow）的点击，
 * 一旦触发立即切回会话视图（通知 Copis 关闭右侧子功能面板并恢复 DSH 原生 Web 视口全屏）。
 */
function setupSessionClickInterceptor(): void {
  if (typeof document === 'undefined') return

  const onSessionClick = (event: MouseEvent) => {
    // 仅响应鼠标左键点击
    if (event.button !== 0) return

    const target = event.target as HTMLElement | null
    if (!target) return

    // 1. 严格排除 Copis 自身注入的菜单项、模式切换器以及底部操作区
    if (
      target.closest('[data-copis-placement="after-workspaces"]') ||
      target.closest('.copis-menu-section') ||
      target.closest('.copis-rail-menu-section') ||
      target.closest('.copis-mode-switcher') ||
      target.closest('[class*="footArea"]') ||
      target.closest('[class*="FootArea"]')
    ) {
      return
    }

    // 2. 排除工作区目录折叠展开行（点击项目文件夹仅折叠/展开，不切回会话）
    if (target.closest('[class*="projectRow"]') || target.closest('[class*="ProjectRow"]')) {
      return
    }

    // 3. 判断是否为会话项或新建会话按钮点击
    const isSessionItem = Boolean(
      target.closest('[class*="sessionRow"]') ||
      target.closest('[class*="SessionRow"]') ||
      target.closest('[class*="searchResultRow"]') ||
      target.closest('[class*="SearchResultRow"]')
    )

    const isNewSession = Boolean(
      target.closest('[class*="newSession"]') ||
      target.closest('[class*="NewSession"]') ||
      target.closest('button[aria-label*="会话"]') ||
      target.closest('button[aria-label*="session"]') ||
      target.closest('button[aria-label*="Session"]')
    )

    // 会话树区域内的点击（排除文件夹行后）
    const isRegionArea = Boolean(
      target.closest('[class*="regionArea"]') ||
      target.closest('[class*="RegionArea"]')
    )

    if (isNewSession) {
      if (document.body?.classList.contains('copis-subview-active')) {
        // 在子视图激活时，原「新建会话」按钮已切换为「返回会话」，点击时拦截 startSession，直接关闭子视图并平滑返回原会话
        event.preventDefault()
        event.stopPropagation()
        event.stopImmediatePropagation()
        applySubviewActiveState(false)
        copisBridge.navigate('conversations')
        window.postMessage({ type: 'COPIS_ACTIVE_VIEW_CHANGE', view: 'conversations' }, '*')
        window.postMessage({ type: 'COPIS_SUBVIEW_CHANGE', subview: null }, '*')
        return
      }
      applySubviewActiveState(false)
      copisBridge.navigate('conversations')
      window.postMessage({ type: 'COPIS_ACTIVE_VIEW_CHANGE', view: 'conversations' }, '*')
    } else if (isSessionItem || isRegionArea) {
      applySubviewActiveState(false)
      copisBridge.navigate('conversations')
      window.postMessage({ type: 'COPIS_ACTIVE_VIEW_CHANGE', view: 'conversations' }, '*')
    }
  }

  // 使用捕获阶段 (capture: true)，保证在任何子组件或第三方框架 stopPropagation 之前抢先感知用户点击意图
  document.addEventListener('click', onSessionClick, true)
}

if (typeof document !== 'undefined') {
  setupSessionClickInterceptor()
}

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

