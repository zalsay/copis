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
    const target = document.head || document.documentElement
    if (target) target.appendChild(styleEl)
  }

  let css = ':root, body {\n'
  if (agentColor) {
    css += `  --ui-primary: ${agentColor} !important;\n`
    css += `  --ui-primary-background: ${hexToRgba(agentColor, 0.2)} !important;\n`
  }
  if (creationColor) {
    css += `  --creation-ui-primary: ${creationColor} !important;\n`
    css += `  --creation-ui-primary-background: ${hexToRgba(creationColor, 0.18)} !important;\n`
    css += `  --dsh-brand: ${creationColor} !important;\n`
    css += `  --dsw-static-deepseek-500: ${creationColor} !important;\n`
    css += `  --dsw-alias-brand-primary-new-colorprimary-new-color: ${creationColor} !important;\n`
    css += `  --dsw-alias-state-business-primary: ${creationColor} !important;\n`
    css += `  --dsw-specific-sidebar-nav-item-active: ${hexToRgba(creationColor, 0.18)} !important;\n`
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
    applyCustomThemeColors(settings?.agentThemeColor, settings?.creationThemeColor)
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

// 监听主进程派发到此 WebContentsView 的事件，通过 postMessage 转发给当前网页
ipcRenderer.on(DSH_CORDIS_IPC_CHANNELS.DISPATCH_EVENT_TO_CLIENT, (_event, payload) => {
  if (payload && typeof payload === 'object' && (payload as { type?: string }).type === 'COPIS_THEME_CHANGED') {
    const { isDark, agentThemeColor, creationThemeColor } = payload as {
      isDark: boolean
      agentThemeColor?: string
      creationThemeColor?: string
    }
    applyDshTheme(Boolean(isDark))
    applyCustomThemeColors(agentThemeColor, creationThemeColor)
  }
  if (payload && typeof payload === 'object' && (payload as { type?: string }).type === 'COPIS_HIDDEN_SIDEBAR_MENU_ITEMS_CHANGED') {
    const { hiddenSidebarMenuItems } = payload as { hiddenSidebarMenuItems?: string[] }
    applyHiddenSidebarMenuItems(Array.isArray(hiddenSidebarMenuItems) ? hiddenSidebarMenuItems : [])
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
    .copis-menu-section button {
      position: relative !important;
    }

    /* 隐藏菜单项：宽侧边栏与窄侧边栏均生效 */
    .copis-menu-section button[data-copis-hidden="true"],
    .copis-rail-menu-section button[data-copis-hidden="true"] {
      display: none !important;
    }

    /* DSH 侧边栏菜单项隐藏胶囊按钮：无背景色，仅边框，悬停保持透明背景 */
    .copis-dsh-menu-hide-btn {
      position: absolute;
      right: 6px;
      top: 50%;
      transform: translateY(-50%);
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

    if (isSessionItem || isNewSession || isRegionArea) {
      copisBridge.navigate('conversations')
      // 同时通过 postMessage 广播，确保侧边栏激活项高亮在网页端第一时间同步清除
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


