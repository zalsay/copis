/**
 * 主题状态原子
 *
 * 管理应用主题模式（浅色/深色/跟随系统/特殊风格）和特殊风格。
 * - themeModeAtom: 用户选择的主题模式，持久化到 ~/.copis/settings.json
 * - themeStyleAtom: 特殊风格主题
 * - systemIsDarkAtom: 系统当前是否为深色模式
 * - resolvedThemeAtom: 派生的最终主题（light | dark）
 *
 * 使用 localStorage 作为缓存，避免页面加载时闪烁。
 */

import { atom } from 'jotai'
import { DEFAULT_INTERFACE_VARIANT, THEME_STYLES, type InterfaceVariant, type ThemeMode, type ThemeStyle } from '../../types'

/** localStorage 缓存键 */
const THEME_CACHE_KEY = 'copis-theme-mode'
const THEME_STYLE_CACHE_KEY = 'copis-theme-style'
const INTERFACE_VARIANT_CACHE_KEY = 'copis-interface-variant'
const AGENT_THEME_COLOR_CACHE_KEY = 'copis-agent-theme-color'
const CREATION_THEME_COLOR_CACHE_KEY = 'copis-creation-theme-color'
const AGENT_THEME_COLOR_LIGHT_CACHE_KEY = 'copis-agent-theme-color-light'
const AGENT_THEME_COLOR_DARK_CACHE_KEY = 'copis-agent-theme-color-dark'
const CREATION_THEME_COLOR_LIGHT_CACHE_KEY = 'copis-creation-theme-color-light'
const CREATION_THEME_COLOR_DARK_CACHE_KEY = 'copis-creation-theme-color-dark'

/**
 * 从 localStorage 读取缓存的主题模式
 */
function getCachedThemeMode(): ThemeMode {
  try {
    const cached = localStorage.getItem(THEME_CACHE_KEY)
    if (cached === 'light' || cached === 'dark' || cached === 'system' || cached === 'special') {
      return cached
    }
  } catch {
    // localStorage 不可用时忽略
  }
  return 'dark'
}

/**
 * 从 localStorage 读取缓存的特殊风格
 */
function getCachedThemeStyle(): ThemeStyle {
  try {
    const cached = localStorage.getItem(THEME_STYLE_CACHE_KEY)
    if ((THEME_STYLES as readonly string[]).includes(cached ?? '')) {
      return cached as ThemeStyle
    }
  } catch {
    // localStorage 不可用时忽略
  }
  return 'default'
}

/**
 * 从 localStorage 读取缓存的界面风格
 */
function getCachedInterfaceVariant(): InterfaceVariant {
  try {
    const cached = localStorage.getItem(INTERFACE_VARIANT_CACHE_KEY)
    if (cached === 'classic' || cached === 'modern') {
      return cached
    }
  } catch {
    // localStorage 不可用时忽略
  }
  return DEFAULT_INTERFACE_VARIANT
}

/**
 * 从 localStorage 读取缓存的颜色值（带备用 key 回退）
 */
function getCachedColor(key: string, fallbackKey?: string): string | undefined {
  try {
    const cached = localStorage.getItem(key)
    if (cached && /^#[0-9a-fA-F]{6}$/.test(cached)) {
      return cached
    }
    if (fallbackKey) {
      const fallback = localStorage.getItem(fallbackKey)
      if (fallback && /^#[0-9a-fA-F]{6}$/.test(fallback)) {
        return fallback
      }
    }
  } catch {
    // localStorage 不可用时忽略
  }
  return undefined
}

/**
 * 从 localStorage 读取缓存的 Agent 模式主题色
 */
function getCachedAgentThemeColor(): string | undefined {
  return getCachedColor(AGENT_THEME_COLOR_CACHE_KEY)
}

function getCachedAgentThemeColorLight(): string | undefined {
  return getCachedColor(AGENT_THEME_COLOR_LIGHT_CACHE_KEY, AGENT_THEME_COLOR_CACHE_KEY)
}

function getCachedAgentThemeColorDark(): string | undefined {
  return getCachedColor(AGENT_THEME_COLOR_DARK_CACHE_KEY, AGENT_THEME_COLOR_CACHE_KEY)
}

/**
 * 从 localStorage 读取缓存的创造模式主题色
 */
function getCachedCreationThemeColor(): string | undefined {
  return getCachedColor(CREATION_THEME_COLOR_CACHE_KEY)
}

function getCachedCreationThemeColorLight(): string | undefined {
  return getCachedColor(CREATION_THEME_COLOR_LIGHT_CACHE_KEY, CREATION_THEME_COLOR_CACHE_KEY)
}

function getCachedCreationThemeColorDark(): string | undefined {
  return getCachedColor(CREATION_THEME_COLOR_DARK_CACHE_KEY, CREATION_THEME_COLOR_CACHE_KEY)
}

/**
 * 缓存主题模式到 localStorage
 */
function cacheThemeMode(mode: ThemeMode): void {
  try {
    localStorage.setItem(THEME_CACHE_KEY, mode)
  } catch {
    // localStorage 不可用时忽略
  }
}

/**
 * 缓存特殊风格到 localStorage
 */
function cacheThemeStyle(style: ThemeStyle): void {
  try {
    localStorage.setItem(THEME_STYLE_CACHE_KEY, style)
  } catch {
    // localStorage 不可用时忽略
  }
}

/**
 * 缓存界面风格到 localStorage
 */
function cacheInterfaceVariant(variant: InterfaceVariant): void {
  try {
    localStorage.setItem(INTERFACE_VARIANT_CACHE_KEY, variant)
  } catch {
    // localStorage 不可用时忽略
  }
}

/**
 * 写入单项颜色缓存
 */
function setCachedColor(key: string, color?: string): void {
  try {
    if (color && /^#[0-9a-fA-F]{6}$/.test(color)) {
      localStorage.setItem(key, color)
    } else {
      localStorage.removeItem(key)
    }
  } catch {
    // localStorage 不可用时忽略
  }
}

/**
 * 缓存 Agent 模式主题色到 localStorage
 */
function cacheAgentThemeColor(color?: string): void {
  setCachedColor(AGENT_THEME_COLOR_CACHE_KEY, color)
}

export function cacheAgentThemeColorLight(color?: string): void {
  setCachedColor(AGENT_THEME_COLOR_LIGHT_CACHE_KEY, color)
}

export function cacheAgentThemeColorDark(color?: string): void {
  setCachedColor(AGENT_THEME_COLOR_DARK_CACHE_KEY, color)
}

/**
 * 缓存创造模式主题色到 localStorage
 */
function cacheCreationThemeColor(color?: string): void {
  setCachedColor(CREATION_THEME_COLOR_CACHE_KEY, color)
}

export function cacheCreationThemeColorLight(color?: string): void {
  setCachedColor(CREATION_THEME_COLOR_LIGHT_CACHE_KEY, color)
}

export function cacheCreationThemeColorDark(color?: string): void {
  setCachedColor(CREATION_THEME_COLOR_DARK_CACHE_KEY, color)
}

/** 用户选择的主题模式 */
export const themeModeAtom = atom<ThemeMode>(getCachedThemeMode())

/** 用户选择的特殊风格 */
export const themeStyleAtom = atom<ThemeStyle>(getCachedThemeStyle())

/** 用户选择的界面风格 */
export const interfaceVariantAtom = atom<InterfaceVariant>(getCachedInterfaceVariant())

/** Agent 模式浅色主题色 */
export const agentThemeColorLightAtom = atom<string | undefined>(getCachedAgentThemeColorLight())

/** Agent 模式深色主题色 */
export const agentThemeColorDarkAtom = atom<string | undefined>(getCachedAgentThemeColorDark())

/** 创造模式浅色主题色 */
export const creationThemeColorLightAtom = atom<string | undefined>(getCachedCreationThemeColorLight())

/** 创造模式深色主题色 */
export const creationThemeColorDarkAtom = atom<string | undefined>(getCachedCreationThemeColorDark())

/** Agent 模式当前生效主题色（响应式派生当前浅/深色下的生效值，并支持双向更新） */
export const agentThemeColorAtom = atom<string | undefined, [string | undefined], void>(
  (get) => {
    const isDark = get(resolvedThemeAtom) === 'dark'
    const custom = isDark ? get(agentThemeColorDarkAtom) : get(agentThemeColorLightAtom)
    return custom ?? getCachedAgentThemeColor()
  },
  (get, set, update) => {
    const isDark = get(resolvedThemeAtom) === 'dark'
    if (isDark) {
      set(agentThemeColorDarkAtom, update)
    } else {
      set(agentThemeColorLightAtom, update)
    }
  }
)

/** 创造模式当前生效主题色（响应式派生当前浅/深色下的生效值，并支持双向更新） */
export const creationThemeColorAtom = atom<string | undefined, [string | undefined], void>(
  (get) => {
    const isDark = get(resolvedThemeAtom) === 'dark'
    const custom = isDark ? get(creationThemeColorDarkAtom) : get(creationThemeColorLightAtom)
    return custom ?? getCachedCreationThemeColor()
  },
  (get, set, update) => {
    const isDark = get(resolvedThemeAtom) === 'dark'
    if (isDark) {
      set(creationThemeColorDarkAtom, update)
    } else {
      set(creationThemeColorLightAtom, update)
    }
  }
)

/** 系统当前是否为深色模式 */
export const systemIsDarkAtom = atom<boolean>(true)

/** 派生：最终解析的主题（light | dark） */
export const resolvedThemeAtom = atom<'light' | 'dark'>((get) => {
  const mode = get(themeModeAtom)
  if (mode === 'system') {
    return get(systemIsDarkAtom) ? 'dark' : 'light'
  }
  if (mode === 'special') {
    const style = get(themeStyleAtom)
    // 根据特殊风格决定是浅色还是深色基调
    return style.endsWith('-light') ? 'light' : 'dark'
  }
  return mode
})

/** 所有特殊风格 class（用于清理旧值）— 从 THEME_STYLES 单一源派生，排除 'default' */
const ALL_THEME_STYLE_CLASSES = THEME_STYLES
  .filter((style) => style !== 'default')
  .map((style) => `theme-${style}` as const)

/**
 * 应用主题到 DOM
 *
 * 在 <html> 元素上切换 dark 类名和特殊风格类名。
 *
 * 幂等实现：先计算目标 class 状态，与当前 DOM 对比，一致时直接 return，
 * 不触发任何 classList mutation。避免与 vibrancy 合成层叠加
 * 导致 Chromium 重建合成层造成的全屏闪烁。
 */
export function applyThemeToDOM(themeMode: ThemeMode, themeStyle: ThemeStyle = 'default', systemIsDark: boolean = true): void {
  const html = document.documentElement

  // 计算目标状态
  let targetStyleClass: string | null = null
  let targetIsDark: boolean

  if (themeMode === 'special' && themeStyle !== 'default') {
    targetStyleClass = `theme-${themeStyle}`
    targetIsDark = themeStyle.endsWith('-dark')
  } else if (themeMode === 'system') {
    targetIsDark = systemIsDark
  } else {
    targetIsDark = themeMode === 'dark'
  }

  // 读取当前状态
  const currentIsDark = html.classList.contains('dark')
  const currentStyleClass = ALL_THEME_STYLE_CLASSES.find((c) => html.classList.contains(c)) ?? null

  // 与目标一致 → 直接跳过，避免触发 CSS 重新级联
  if (currentIsDark === targetIsDark && currentStyleClass === targetStyleClass) {
    return
  }

  // [FLASH-DEBUG] 仅在真正发生 DOM 变更时打印
  console.log(
    `[FLASH-DEBUG] applyThemeToDOM apply: mode=${themeMode}, style=${themeStyle}, systemIsDark=${systemIsDark}, diff={dark: ${currentIsDark}→${targetIsDark}, style: ${currentStyleClass}→${targetStyleClass}}`
  )

  // 只修改确实需要变的 class
  if (currentStyleClass !== targetStyleClass) {
    if (currentStyleClass) {
      html.classList.remove(currentStyleClass)
    }
    if (targetStyleClass) {
      html.classList.add(targetStyleClass)
    }
  }
  if (currentIsDark !== targetIsDark) {
    html.classList.toggle('dark', targetIsDark)
  }
}

/**
 * 将 Hex 颜色转换为带有透明度的 RGBA 字符串
 */
export function hexToRgba(hex: string, alpha: number): string {
  const clean = hex.replace('#', '')
  const num = parseInt(clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean, 16)
  if (isNaN(num)) return hex
  const r = (num >> 16) & 255
  const g = (num >> 8) & 255
  const b = num & 255
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

/**
 * 应用自定义主题色到 DOM
 *
 * 如果未提供自定义颜色，移除 inline style property，回退到 globals.css 默认值。
 */
export function applyThemeColorsToDOM(
  agentColor?: string,
  creationColor?: string,
  isDark: boolean = true,
): void {
  const html = document.documentElement
  if (agentColor && /^#[0-9a-fA-F]{6}$/.test(agentColor)) {
    html.style.setProperty('--ui-primary', agentColor)
    html.style.setProperty('--ui-primary-background', hexToRgba(agentColor, 0.2))
  } else {
    html.style.removeProperty('--ui-primary')
    html.style.removeProperty('--ui-primary-background')
  }

  if (creationColor && /^#[0-9a-fA-F]{6}$/.test(creationColor)) {
    html.style.setProperty('--creation-ui-primary', creationColor)
    html.style.setProperty('--creation-ui-primary-background', hexToRgba(creationColor, isDark ? 0.18 : 0.15))
  } else {
    html.style.removeProperty('--creation-ui-primary')
    html.style.removeProperty('--creation-ui-primary-background')
  }
}

/**
 * 应用界面风格到 DOM
 */
export function applyInterfaceVariantToDOM(variant: InterfaceVariant = DEFAULT_INTERFACE_VARIANT): void {
  const html = document.documentElement
  const targetClass = variant === 'classic' ? 'ui-classic' : 'ui-modern'
  const currentClass = html.classList.contains('ui-classic')
    ? 'ui-classic'
    : html.classList.contains('ui-modern')
      ? 'ui-modern'
      : null

  if (currentClass === targetClass) {
    return
  }

  if (currentClass) {
    html.classList.remove(currentClass)
  }
  html.classList.add(targetClass)
}

/**
 * 初始化主题系统
 *
 * 从主进程加载设置，监听系统主题变化。
 * 返回清理函数。
 */
export async function initializeTheme(
  setThemeMode: (mode: ThemeMode) => void,
  setSystemIsDark: (isDark: boolean) => void,
  setThemeStyle?: (style: ThemeStyle) => void,
  setInterfaceVariant?: (variant: InterfaceVariant) => void,
  setAgentThemeColor?: (color?: string) => void,
  setCreationThemeColor?: (color?: string) => void,
  setAgentThemeColorLight?: (color?: string) => void,
  setAgentThemeColorDark?: (color?: string) => void,
  setCreationThemeColorLight?: (color?: string) => void,
  setCreationThemeColorDark?: (color?: string) => void,
): Promise<() => void> {
  // 从主进程加载持久化设置
  const settings = await window.electronAPI.getSettings()
  setThemeMode(settings.themeMode)
  cacheThemeMode(settings.themeMode)

  // 加载特殊风格
  if (setThemeStyle && settings.themeStyle) {
    setThemeStyle(settings.themeStyle)
    cacheThemeStyle(settings.themeStyle)
  }

  const interfaceVariant = settings.interfaceVariant || DEFAULT_INTERFACE_VARIANT
  if (setInterfaceVariant) {
    setInterfaceVariant(interfaceVariant)
  }
  cacheInterfaceVariant(interfaceVariant)

  // 加载自定义主题色（浅深色独立与旧单值兼容）
  const agentColorLight = settings.agentThemeColorLight ?? settings.agentThemeColor
  const agentColorDark = settings.agentThemeColorDark ?? settings.agentThemeColor
  if (setAgentThemeColorLight) setAgentThemeColorLight(agentColorLight)
  if (setAgentThemeColorDark) setAgentThemeColorDark(agentColorDark)
  cacheAgentThemeColorLight(agentColorLight)
  cacheAgentThemeColorDark(agentColorDark)
  cacheAgentThemeColor(settings.agentThemeColor)

  const creationColorLight = settings.creationThemeColorLight ?? settings.creationThemeColor
  const creationColorDark = settings.creationThemeColorDark ?? settings.creationThemeColor
  if (setCreationThemeColorLight) setCreationThemeColorLight(creationColorLight)
  if (setCreationThemeColorDark) setCreationThemeColorDark(creationColorDark)
  cacheCreationThemeColorLight(creationColorLight)
  cacheCreationThemeColorDark(creationColorDark)
  cacheCreationThemeColor(settings.creationThemeColor)

  // 获取系统主题
  const isDark = await window.electronAPI.getSystemTheme()
  setSystemIsDark(isDark)

  const initialAgentColor = isDark ? agentColorDark : agentColorLight
  const initialCreationColor = isDark ? creationColorDark : creationColorLight
  if (setAgentThemeColor) setAgentThemeColor(initialAgentColor)
  if (setCreationThemeColor) setCreationThemeColor(initialCreationColor)

  // 初始注入主题色变量到 DOM
  applyThemeColorsToDOM(initialAgentColor, initialCreationColor, isDark)

  // 监听系统主题变化
  const cleanupSystem = window.electronAPI.onSystemThemeChanged((newIsDark) => {
    setSystemIsDark(newIsDark)
    const effectiveAgent = newIsDark
      ? (getCachedAgentThemeColorDark() ?? getCachedAgentThemeColor())
      : (getCachedAgentThemeColorLight() ?? getCachedAgentThemeColor())
    const effectiveCreation = newIsDark
      ? (getCachedCreationThemeColorDark() ?? getCachedCreationThemeColor())
      : (getCachedCreationThemeColorLight() ?? getCachedCreationThemeColor())
    applyThemeColorsToDOM(effectiveAgent, effectiveCreation, newIsDark)
  })

  // 监听用户手动切换主题（跨窗口同步，如 Quick Task 面板）
  const cleanupThemeSettings = window.electronAPI.onThemeSettingsChanged((payload) => {
    const mode = payload.themeMode as ThemeMode
    const style = (payload.themeStyle || 'default') as ThemeStyle
    const variant = (payload.interfaceVariant || DEFAULT_INTERFACE_VARIANT) as InterfaceVariant
    const p = payload as {
      agentThemeColor?: string
      creationThemeColor?: string
      agentThemeColorLight?: string
      agentThemeColorDark?: string
      creationThemeColorLight?: string
      creationThemeColorDark?: string
    }

    setThemeMode(mode)
    cacheThemeMode(mode)
    if (setThemeStyle) {
      setThemeStyle(style)
      cacheThemeStyle(style)
    }
    if (setInterfaceVariant) {
      setInterfaceVariant(variant)
      cacheInterfaceVariant(variant)
    }

    if (p.agentThemeColorLight !== undefined) {
      if (setAgentThemeColorLight) setAgentThemeColorLight(p.agentThemeColorLight)
      cacheAgentThemeColorLight(p.agentThemeColorLight)
    }
    if (p.agentThemeColorDark !== undefined) {
      if (setAgentThemeColorDark) setAgentThemeColorDark(p.agentThemeColorDark)
      cacheAgentThemeColorDark(p.agentThemeColorDark)
    }
    if (p.creationThemeColorLight !== undefined) {
      if (setCreationThemeColorLight) setCreationThemeColorLight(p.creationThemeColorLight)
      cacheCreationThemeColorLight(p.creationThemeColorLight)
    }
    if (p.creationThemeColorDark !== undefined) {
      if (setCreationThemeColorDark) setCreationThemeColorDark(p.creationThemeColorDark)
      cacheCreationThemeColorDark(p.creationThemeColorDark)
    }

    const currentIsDark = isDark
    const effAgent = currentIsDark
      ? (p.agentThemeColorDark ?? p.agentThemeColor ?? getCachedAgentThemeColorDark())
      : (p.agentThemeColorLight ?? p.agentThemeColor ?? getCachedAgentThemeColorLight())
    const effCreation = currentIsDark
      ? (p.creationThemeColorDark ?? p.creationThemeColor ?? getCachedCreationThemeColorDark())
      : (p.creationThemeColorLight ?? p.creationThemeColor ?? getCachedCreationThemeColorLight())

    if (setAgentThemeColor) setAgentThemeColor(effAgent)
    if (setCreationThemeColor) setCreationThemeColor(effCreation)
    applyThemeColorsToDOM(effAgent, effCreation, currentIsDark)
  })

  return () => {
    cleanupSystem()
    cleanupThemeSettings()
  }
}

/**
 * 更新主题模式并持久化
 *
 * 同时更新 localStorage 缓存和主进程配置文件。
 */
export async function updateThemeMode(mode: ThemeMode): Promise<void> {
  cacheThemeMode(mode)
  await window.electronAPI.updateSettings({ themeMode: mode })
}

/**
 * 更新特殊风格并持久化
 */
export async function updateThemeStyle(style: ThemeStyle): Promise<void> {
  cacheThemeStyle(style)
  await window.electronAPI.updateSettings({ themeStyle: style })
}

/**
 * 更新界面风格并持久化
 */
export async function updateInterfaceVariant(variant: InterfaceVariant): Promise<void> {
  cacheInterfaceVariant(variant)
  await window.electronAPI.updateSettings({ interfaceVariant: variant })
}

/**
 * 更新 Agent 模式主题色并持久化
 * @param color 颜色值或 undefined（恢复默认）
 * @param isDark 是否更新深色模式配置（默认为当前解析的明暗模式）
 */
export async function updateAgentThemeColor(color?: string, isDark: boolean = false): Promise<void> {
  const normalized = color && /^#[0-9a-fA-F]{6}$/.test(color) ? color : undefined
  if (isDark) {
    cacheAgentThemeColorDark(normalized)
    await window.electronAPI.updateSettings({ agentThemeColorDark: normalized ?? '' })
  } else {
    cacheAgentThemeColorLight(normalized)
    await window.electronAPI.updateSettings({ agentThemeColorLight: normalized ?? '' })
  }
}

/**
 * 更新创造模式主题色并持久化
 * @param color 颜色值或 undefined（恢复默认）
 * @param isDark 是否更新深色模式配置（默认为当前解析的明暗模式）
 */
export async function updateCreationThemeColor(color?: string, isDark: boolean = false): Promise<void> {
  const normalized = color && /^#[0-9a-fA-F]{6}$/.test(color) ? color : undefined
  if (isDark) {
    cacheCreationThemeColorDark(normalized)
    await window.electronAPI.updateSettings({ creationThemeColorDark: normalized ?? '' })
  } else {
    cacheCreationThemeColorLight(normalized)
    await window.electronAPI.updateSettings({ creationThemeColorLight: normalized ?? '' })
  }
}
