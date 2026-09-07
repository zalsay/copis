/**
 * 跨进程/跨视图主题同步服务
 *
 * 维护应用设置中主题模式（light/dark/system/special）与 Electron nativeTheme.themeSource 映射，
 * 并提供统一的 isDark 计算与 WebContentsView 主题状态推导。
 */

import { nativeTheme } from 'electron'
import type { ThemeMode, ThemeStyle } from '../../types'

/**
 * 根据应用设置与系统状态计算当前是否应呈现为深色模式
 */
export function resolveIsDark(
  themeMode: ThemeMode,
  themeStyle?: ThemeStyle,
  systemIsDark: boolean = nativeTheme.shouldUseDarkColors
): boolean {
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

/**
 * 同步 Copis 主题设置至 Electron 原生 nativeTheme.themeSource
 *
 * 设置 nativeTheme.themeSource 会影响整个 Electron 运行时：
 * - 动态切换 Chromium 内核的 prefers-color-scheme 媒体查询；
 * - 确保所有 WebContents 和 WebContentsView 能够实时感知浅色/深色模式。
 */
export function syncNativeThemeSource(themeMode: ThemeMode, themeStyle?: ThemeStyle): void {
  if (themeMode === 'light') {
    nativeTheme.themeSource = 'light'
  } else if (themeMode === 'dark') {
    nativeTheme.themeSource = 'dark'
  } else if (themeMode === 'special' && themeStyle && themeStyle !== 'default') {
    nativeTheme.themeSource = themeStyle.endsWith('-light') ? 'light' : 'dark'
  } else {
    nativeTheme.themeSource = 'system'
  }
}
