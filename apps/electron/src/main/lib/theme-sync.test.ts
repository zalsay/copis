import { describe, expect, it, mock } from 'bun:test'

const nativeThemeMock = {
  themeSource: 'system',
  shouldUseDarkColors: false,
}

mock.module('electron', () => ({
  nativeTheme: nativeThemeMock,
}))

const { resolveIsDark, syncNativeThemeSource } = await import('./theme-sync')

describe('theme-sync 主题同步模块', () => {
  it('Given themeMode 为 light When resolveIsDark Then 返回 false', () => {
    expect(resolveIsDark('light')).toBe(false)
  })

  it('Given themeMode 为 dark When resolveIsDark Then 返回 true', () => {
    expect(resolveIsDark('dark')).toBe(true)
  })

  it('Given themeMode 为 system When 系统为深色 Then 返回 true', () => {
    expect(resolveIsDark('system', undefined, true)).toBe(true)
  })

  it('Given themeMode 为 system When 系统为浅色 Then 返回 false', () => {
    expect(resolveIsDark('system', undefined, false)).toBe(false)
  })

  it('Given themeMode 为 special 且风格为 ocean-light When resolveIsDark Then 返回 false', () => {
    expect(resolveIsDark('special', 'ocean-light')).toBe(false)
  })

  it('Given themeMode 为 special 且风格为 ocean-dark When resolveIsDark Then 返回 true', () => {
    expect(resolveIsDark('special', 'ocean-dark')).toBe(true)
  })

  it('Given themeMode 为 light When syncNativeThemeSource Then themeSource 被设置为 light', () => {
    syncNativeThemeSource('light')
    expect(nativeThemeMock.themeSource).toBe('light')
  })

  it('Given themeMode 为 dark When syncNativeThemeSource Then themeSource 被设置为 dark', () => {
    syncNativeThemeSource('dark')
    expect(nativeThemeMock.themeSource).toBe('dark')
  })

  it('Given themeMode 为 system When syncNativeThemeSource Then themeSource 被设置为 system', () => {
    syncNativeThemeSource('system')
    expect(nativeThemeMock.themeSource).toBe('system')
  })
})
