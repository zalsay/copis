import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_AGENT_THEME_COLOR,
  DEFAULT_AGENT_THEME_COLOR_LIGHT,
  DEFAULT_AGENT_THEME_COLOR_DARK,
  DEFAULT_CREATION_THEME_COLOR_LIGHT,
  DEFAULT_CREATION_THEME_COLOR_DARK,
  AGENT_THEME_COLOR_PRESETS,
  CREATION_THEME_COLOR_PRESETS,
} from '../../../types/settings'
import {
  hexToRgba,
  applyThemeColorsToDOM,
} from '../../atoms/theme'
import * as fs from 'node:fs'
import * as path from 'node:path'

describe('外观设置主题色自定义功能契约 (BDD)', () => {
  test('主题色预设与默认常量契约完整性（含浅色与深色独立默认）', () => {
    // 默认色契约
    expect(DEFAULT_AGENT_THEME_COLOR).toBe('#f09a43')
    expect(DEFAULT_AGENT_THEME_COLOR_LIGHT).toBe('#f09a43')
    expect(DEFAULT_AGENT_THEME_COLOR_DARK).toBe('#f09a43')
    expect(DEFAULT_CREATION_THEME_COLOR_LIGHT).toBe('#6C00CC')
    expect(DEFAULT_CREATION_THEME_COLOR_DARK).toBe('#a855f7')

    // 预设色盘包含 8 组精选色彩
    expect(AGENT_THEME_COLOR_PRESETS.length).toBe(8)
    expect(CREATION_THEME_COLOR_PRESETS.length).toBe(8)

    // Agent 预设首个为经典橙
    const firstAgentPreset = AGENT_THEME_COLOR_PRESETS[0]
    expect(firstAgentPreset).toBeDefined()
    expect(firstAgentPreset!.color.toLowerCase()).toBe('#f09a43')
    expect(firstAgentPreset!.name).toContain('默认')

    // 创造模式预设包含专属紫
    const firstCreationPreset = CREATION_THEME_COLOR_PRESETS[0]
    expect(firstCreationPreset).toBeDefined()
    expect(firstCreationPreset!.color.toLowerCase()).toBe('#6c00cc')

    // 验证所有预设均为合法 6 位 hex 且名称与 ID 不为空
    for (const preset of [...AGENT_THEME_COLOR_PRESETS, ...CREATION_THEME_COLOR_PRESETS]) {
      expect(/^#[0-9A-Fa-f]{6}$/.test(preset.color)).toBe(true)
      expect(preset.name.trim().length).toBeGreaterThan(0)
      expect(preset.id.trim().length).toBeGreaterThan(0)
    }
  })

  test('hexToRgba 颜色转换契约', () => {
    // 6 位 hex 转换
    expect(hexToRgba('#f09a43', 0.2)).toBe('rgba(240, 154, 67, 0.2)')
    expect(hexToRgba('#6C00CC', 0.15)).toBe('rgba(108, 0, 204, 0.15)')
    expect(hexToRgba('#000000', 1)).toBe('rgba(0, 0, 0, 1)')
    expect(hexToRgba('#ffffff', 0.5)).toBe('rgba(255, 255, 255, 0.5)')

    // 3 位 hex 扩展转换
    expect(hexToRgba('#f09', 0.1)).toBe('rgba(255, 0, 153, 0.1)')

    // 非法 hex 安全回退（保持原样返回）
    expect(hexToRgba('invalid', 0.1)).toBe('invalid')
  })

  test('applyThemeColorsToDOM 样式注入与浅深色模式对比度契约', () => {
    // 模拟全局 document.documentElement.style
    const styles: Record<string, string> = {}
    const originalDocument = (globalThis as any).document

    ;(globalThis as any).document = {
      documentElement: {
        style: {
          setProperty: (key: string, value: string) => {
            styles[key] = value
          },
          removeProperty: (key: string) => {
            delete styles[key]
          },
        },
      },
    }

    try {
      // 1. 应用自定义颜色（浅色模式 isDark=false）
      applyThemeColorsToDOM('#10b981', '#3b82f6', false)
      expect(styles['--ui-primary']).toBe('#10b981')
      expect(styles['--ui-primary-background']).toBe('rgba(16, 185, 129, 0.2)')
      expect(styles['--creation-ui-primary']).toBe('#3b82f6')
      expect(styles['--creation-ui-primary-background']).toBe('rgba(59, 130, 246, 0.15)')

      // 2. 应用深色模式自定义颜色（深色模式 isDark=true，创造模式背景透明度适配 0.18）
      applyThemeColorsToDOM('#f43f5e', '#a855f7', true)
      expect(styles['--ui-primary']).toBe('#f43f5e')
      expect(styles['--ui-primary-background']).toBe('rgba(244, 63, 94, 0.2)')
      expect(styles['--creation-ui-primary']).toBe('#a855f7')
      expect(styles['--creation-ui-primary-background']).toBe('rgba(168, 85, 247, 0.18)')

      // 3. 恢复默认（undefined），应清除对应内联属性
      applyThemeColorsToDOM(undefined, undefined, false)
      expect(styles['--ui-primary']).toBeUndefined()
      expect(styles['--ui-primary-background']).toBeUndefined()
      expect(styles['--creation-ui-primary']).toBeUndefined()
      expect(styles['--creation-ui-primary-background']).toBeUndefined()
    } finally {
      ;(globalThis as any).document = originalDocument
    }
  })

  test('AppearanceSettings 视图源码契约与浅深色模式独立配置统一 UI', () => {
    const filePath = path.resolve(__dirname, 'AppearanceSettings.tsx')
    const content = fs.readFileSync(filePath, 'utf-8')

    // 契约：必须包含两套模式的主题色设置区块
    expect(content).toContain('Agent 模式主题色')
    expect(content).toContain('创造模式主题色')
    expect(content).toContain('agentThemeColorAtom')
    expect(content).toContain('creationThemeColorAtom')
    expect(content).toContain('agentThemeColorLightAtom')
    expect(content).toContain('agentThemeColorDarkAtom')
    expect(content).toContain('creationThemeColorLightAtom')
    expect(content).toContain('creationThemeColorDarkAtom')
    expect(content).toContain('updateAgentThemeColor')
    expect(content).toContain('updateCreationThemeColor')
    expect(content).toContain('ThemeColorPickerBlock')
    expect(content).toContain('恢复默认')
    expect(content).toContain('normalizeHex')

    // 契约：必须包含配色目标模式分段切换器（浅色/深色独立配置）
    expect(content).toContain('配色目标模式')
    expect(content).toContain('COLOR_TARGET_OPTIONS')
    expect(content).toContain('浅色模式配色')
    expect(content).toContain('深色模式配色')

    // 契约：必须完全对齐 SettingsSegmentedControl 的排版与控件卡槽视觉规范
    expect(content).toContain('px-4 py-3 space-y-2')
    expect(content).toContain('bg-muted p-1')
    expect(content).toContain('cleanPresetName')

    // 契约：移除手写全宽分割线，由 SettingsCard 统一优雅处理
    expect(content).not.toContain('-mx-4 sm:-mx-6')
  })
})
