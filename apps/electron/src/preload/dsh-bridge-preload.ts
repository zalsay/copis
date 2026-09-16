/**
 * DSH 原生 WebContentsView 桥接 Preload 脚本。
 *
 * 运行在 DSH WebContentsView 的隔离环境中：
 * 1. 暴露 window.copisBridge API 供 DSH 侧边栏直接调用；
 * 2. 代理 window.message 事件，向前兼容现有 postMessage 逻辑；
 * 3. 将主进程广播的事件（如取消高亮、全局命令）回传给网页。
 */

import { contextBridge, ipcRenderer } from 'electron'
import { DSH_CORDIS_IPC_CHANNELS, AGENT_IPC_CHANNELS, type DshClientEvent } from '@copis/shared'
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
    if (Array.isArray(settings?.hiddenSidebarMenuItems)) {
      applyHiddenSidebarMenuItems(settings.hiddenSidebarMenuItems)
    }
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
    if (typeof info?.width === 'number' && info.width >= 200 && info.width <= 360) {
      ipcRenderer.send(DSH_CORDIS_IPC_CHANNELS.CLIENT_EVENT, {
        type: 'COPIS_DSH_SIDEBAR_INFO',
        ...info,
        width: Math.max(264, Math.min(360, Math.round(info.width))),
      })
    }
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
  hideMenuItem: (menuId: string) => {
    void hideDshMenuItem(menuId)
  },
  getHiddenMenuItems: () => {
    return Array.from(currentHiddenMenuIds)
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
      hiddenSidebarMenuItems?: string[]
      subview?: string | null
      view?: string
    }
    if (p.type === 'COPIS_THEME_CHANGED') {
      applyDshTheme(Boolean(p.isDark))
      const nextAgentColor = p.agentThemeColor !== undefined ? (p.agentThemeColor || undefined) : currentCustomAgentColor
      const nextCreationColor = p.creationThemeColor !== undefined ? (p.creationThemeColor || undefined) : currentCustomCreationColor
      applyCustomThemeColors(nextAgentColor, nextCreationColor)
    }
    if (p.type === 'COPIS_HIDDEN_SIDEBAR_MENU_ITEMS_CHANGED') {
      applyHiddenSidebarMenuItems(Array.isArray(p.hiddenSidebarMenuItems) ? p.hiddenSidebarMenuItems : [])
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
    .copis-header-action-btn {
      border-radius: 7px !important;
      font-size: 13px !important;
    }
    .copis-header-btn-agent {
      border-radius: 7px !important;
      font-size: 13px !important;
    }
    .copis-header-btn-workspace {
      width: 30px !important;
      height: 30px !important;
      padding: 0 !important;
      border-radius: 7px !important;
      display: inline-flex !important;
      align-items: center !important;
      justify-content: center !important;
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

    /* 会话与项目行选中激活态：使用 creation-ui-primary 体系 */
    .YDXeBa_sessionRow.YDXeBa_selected,
    .YDXeBa_searchResultRow.YDXeBa_selected,
    .YDXeBa_projectRow.active,
    [class*="sessionRow"][class*="selected"],
    [class*="searchResultRow"][class*="selected"],
    [class*="projectRow"][class*="active"] {
      background: var(--creation-ui-primary-background) !important;
      color: var(--creation-ui-primary) !important;
      font-weight: 600 !important;
    }
    [class*="sessionRow"][class*="selected"] svg,
    [class*="searchResultRow"][class*="selected"] svg,
    [class*="projectRow"][class*="active"] svg {
      color: var(--creation-ui-primary) !important;
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

    /* 创造模式 DSH 侧边栏菜单项与隐藏胶囊按钮契约 */
    .copis-menu-section > button {
      position: relative !important;
    }

    /* 隐藏菜单项：宽侧边栏与窄侧边栏均生效 */
    .copis-menu-section button[data-copis-hidden="true"],
    .copis-rail-menu-section button[data-copis-hidden="true"] {
      display: none !important;
    }

    /* DSH 侧边栏菜单项隐藏胶囊按钮：无背景色，仅边框，悬停保持透明背景 */
    .copis-dsh-menu-hide-btn {
      position: static !important;
      right: auto;
      top: auto;
      transform: none;
      flex: none;
      margin-left: auto;
      height: 20px;
      padding: 0 7px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border: 1px solid var(--dsw-alias-border-l2, rgba(120, 120, 128, 0.4));
      border-radius: 9999px;
      background: transparent !important;
      color: var(--dsw-alias-label-secondary, #8f8f99);
      font-size: 11px;
      font-weight: 500;
      line-height: 1;
      cursor: pointer;
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.15s ease;
      z-index: 2;
      user-select: none;
      box-sizing: border-box;
    }

    .copis-menu-section button:hover .copis-dsh-menu-hide-btn,
    .copis-menu-section button:focus-within .copis-dsh-menu-hide-btn {
      opacity: 1;
      pointer-events: auto;
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

    body.copis-subview-active .hHd-Xa_root,
    body.copis-subview-active [class*="_root"],
    body.copis-subview-active [class*="SidebarRoot"],
    body.copis-subview-active aside {
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

    body.copis-subview-active [class*="newSessionLabel"]::after,
    body.copis-subview-active [class*="_newSessionLabel"]::after {
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

    /* 当子视图激活时，彻底隐藏浮动工具栏（工作区、Agent模式），避免挤占/遮挡侧栏顶部 */
    body.copis-subview-active .copis-hero-utilities-overlay {
      display: none !important;
    }

    body.copis-subview-active [class*="_regionArea"],
    body.copis-subview-active [class*="regionArea"] {
      display: flex !important;
      flex-direction: column !important;
      margin-left: 0 !important;
      margin-right: 0 !important;
      padding-left: 0 !important;
    }

    body.copis-subview-active .copis-menu-section {
      display: grid !important;
    }

    body.copis-subview-active [class*="_footArea"],
    body.copis-subview-active [class*="footArea"] {
      align-items: stretch !important;
    }

    /* 彻底屏蔽 DSH 原生设置弹窗与遮罩层，统一由 Copis 全屏设置面板接管 */
    [class*="VOzbGW_panel"],
    [class*="VOzbGW_overlay"],
    [class*="VOzbGW_mask"],
    [class*="settingsArea"] [role="dialog"],
    [class*="SettingsArea"] [role="dialog"],
    [class*="SettingsPanel"],
    [class*="settingsPanel"] {
      display: none !important;
      visibility: hidden !important;
      pointer-events: none !important;
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

const DSH_MENU_LABEL_TO_ID: Record<string, string> = {
  '搜索': 'search',
  '日程表': 'schedule',
  '定时任务': 'automations',
  '记忆': 'memory',
  '知识库': 'knowledge',
  '专家团队': 'expert-team',
  '技能市场': 'agent-skills',
  '我的投资': 'fund-stock',
}

let currentHiddenMenuIds: Set<string> = new Set()

/**
 * 应用隐藏侧边栏菜单项配置到 DSH 侧边栏
 */
function applyHiddenSidebarMenuItems(hiddenItems: string[]): void {
  currentHiddenMenuIds = new Set(hiddenItems)
  syncDshSidebarMenuDoms()
}

/**
 * 隐藏 DSH 侧边栏指定菜单项并持久化到设置
 */
async function hideDshMenuItem(menuId: string): Promise<void> {
  currentHiddenMenuIds.add(menuId)
  syncDshSidebarMenuDoms()
  try {
    const settings = await ipcRenderer.invoke(SETTINGS_IPC_CHANNELS.GET)
    const existing: string[] = Array.isArray(settings?.hiddenSidebarMenuItems)
      ? settings.hiddenSidebarMenuItems
      : []
    if (!existing.includes(menuId)) {
      const nextHidden = [...existing, menuId]
      await ipcRenderer.invoke(SETTINGS_IPC_CHANNELS.UPDATE, {
        hiddenSidebarMenuItems: nextHidden,
      })
    }
  } catch (err) {
    console.error('[DSH 侧边栏] 隐藏菜单项失败:', err)
  }
}

/**
 * 遍历 DSH 侧边栏菜单按钮，挂载 data-copis-menu-id、显隐状态以及悬停「隐藏」胶囊按钮
 */
function syncDshSidebarMenuDoms(): void {
  if (typeof document === 'undefined') return

  // 1. 宽侧边栏菜单项 (.copis-menu-section button)
  const wideButtons = document.querySelectorAll<HTMLButtonElement>('.copis-menu-section button')
  wideButtons.forEach((btn) => {
    if (btn.classList.contains('copis-dsh-menu-hide-btn')) return

    const labelSpan = btn.querySelector('span')
    const labelText = labelSpan?.textContent?.trim() || ''
    const menuId = DSH_MENU_LABEL_TO_ID[labelText]
    if (!menuId) return

    btn.setAttribute('data-copis-menu-id', menuId)
    const isHidden = currentHiddenMenuIds.has(menuId)
    btn.setAttribute('data-copis-hidden', isHidden ? 'true' : 'false')

    let hideBtn = btn.querySelector<HTMLButtonElement>(':scope > .copis-dsh-menu-hide-btn')
    if (!hideBtn) {
      hideBtn = document.createElement('button')
      hideBtn.type = 'button'
      hideBtn.className = 'copis-dsh-menu-hide-btn'
      hideBtn.textContent = '隐藏'
      hideBtn.setAttribute('aria-label', `隐藏${labelText}`)
      hideBtn.setAttribute('title', '隐藏此菜单')
      hideBtn.addEventListener('click', (e) => {
        e.stopPropagation()
        e.preventDefault()
        void hideDshMenuItem(menuId)
      })
      btn.appendChild(hideBtn)
    }
  })

  // 2. 窄侧边栏菜单项 (.copis-rail-menu-section button)
  const railButtons = document.querySelectorAll<HTMLButtonElement>('.copis-rail-menu-section button')
  railButtons.forEach((btn) => {
    const ariaLabel = btn.getAttribute('aria-label')?.trim() || ''
    const menuId = DSH_MENU_LABEL_TO_ID[ariaLabel]
    if (!menuId) return

    btn.setAttribute('data-copis-menu-id', menuId)
    const isHidden = currentHiddenMenuIds.has(menuId)
    btn.setAttribute('data-copis-hidden', isHidden ? 'true' : 'false')
  })

  // 3. 侧边栏底部隐藏意见反馈按钮（宽侧边栏与窄侧边栏，统一在设置菜单中呈现）
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

  // 4. 同步顶部「新建会话 / 返回会话」按钮属性
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
 * 启动 DSH 侧边栏 DOM 观察器，确保在动态渲染/切换视图时菜单显隐与隐藏按钮始终就绪
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

function isDshSettingsTarget(target: HTMLElement | null): boolean {
  if (!target) return false
  const btn = target.closest('button')
  if (!btn) return false
  if (btn.closest('[class*="settingsArea"], [class*="SettingsArea"]')) return true
  if (btn.closest('[class*="triggerRow"], [class*="TriggerRow"]') && btn.getAttribute('aria-haspopup') === 'dialog') return true
  if (btn.matches('button[class*="trigger"][aria-haspopup="dialog"], button[class*="Trigger"][aria-haspopup="dialog"]')) return true
  const aria = (btn.getAttribute('aria-label') || btn.getAttribute('title') || '').toLowerCase()
  if (aria.includes('设置') || aria.includes('setting')) return true
  const text = (btn.textContent || '').trim().toLowerCase()
  if (text.includes('设置') || text.includes('setting')) {
    if (btn.closest('[class*="footArea"], [class*="FootArea"], [class*="SidebarRoot"], [class*="_root"], aside')) {
      return true
    }
  }
  return false
}

function setupSettingsClickInterceptor(): void {
  if (typeof document === 'undefined') return

  const onSettingsClick = (event: MouseEvent) => {
    if (event.button !== 0) return
    const target = event.target as HTMLElement | null
    if (isDshSettingsTarget(target)) {
      event.preventDefault()
      event.stopPropagation()
      event.stopImmediatePropagation()
      applySubviewActiveState(true)
      copisBridge.openSettings()
      window.postMessage({ type: 'COPIS_OPEN_SETTINGS' }, '*')
      window.dispatchEvent(new CustomEvent('COPIS_OPEN_SETTINGS'))
    }
  }

  document.addEventListener('click', onSettingsClick, true)
}

if (typeof document !== 'undefined') {
  setupSessionClickInterceptor()
  setupSettingsClickInterceptor()
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


