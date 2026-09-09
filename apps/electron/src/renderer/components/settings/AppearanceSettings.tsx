/**
 * AppearanceSettings - 外观设置页
 *
 * 主题模式切换（浅色/深色/跟随系统）以及
 * Agent 模式与创造模式的主题色自定义功能。
 * 通过 Jotai atom 管理状态，持久化到 ~/.copis/settings.json 与 localStorage。
 */

import * as React from 'react'
import { useAtom, useAtomValue } from 'jotai'
import { RotateCcw } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  SettingsSection,
  SettingsCard,
  SettingsRow,
  SettingsSegmentedControl,
  LABEL_CLASS,
  DESCRIPTION_CLASS,
} from './primitives'
import {
  themeModeAtom,
  systemIsDarkAtom,
  resolvedThemeAtom,
  agentThemeColorAtom,
  creationThemeColorAtom,
  agentThemeColorLightAtom,
  agentThemeColorDarkAtom,
  creationThemeColorLightAtom,
  creationThemeColorDarkAtom,
  updateThemeMode,
  updateThemeStyle,
  applyThemeToDOM,
  updateAgentThemeColor,
  updateCreationThemeColor,
} from '@/atoms/theme'
import {
  markdownFontSizeAtom,
  updateMarkdownFontSize,
} from '@/atoms/markdown-font-size'
import { previewModePreferenceAtom, type PreviewModePreference } from '@/atoms/preview-atoms'
import {
  DEFAULT_AGENT_THEME_COLOR,
  DEFAULT_AGENT_THEME_COLOR_LIGHT,
  DEFAULT_AGENT_THEME_COLOR_DARK,
  DEFAULT_CREATION_THEME_COLOR_LIGHT,
  DEFAULT_CREATION_THEME_COLOR_DARK,
  AGENT_THEME_COLOR_PRESETS,
  CREATION_THEME_COLOR_PRESETS,
  type ThemeMode,
  type MarkdownFontSize,
  type ThemeColorPreset,
} from '../../../types'

/** 主题选项 */
const THEME_OPTIONS = [
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
  { value: 'system', label: '跟随系统' },
]

/** Markdown 字号选项 */
const MARKDOWN_FONT_SIZE_OPTIONS = [
  { value: 'small', label: '小' },
  { value: 'medium', label: '中' },
  { value: 'large', label: '大' },
]

/** 预览默认展开方式 */
const PREVIEW_MODE_OPTIONS: { value: PreviewModePreference; label: string }[] = [
  { value: 'tab', label: '标签页' },
  { value: 'split', label: '侧边分屏' },
]

/** 根据平台返回缩放快捷键提示 */
const isMac = navigator.userAgent.includes('Mac')
const ZOOM_HINT = isMac
  ? '使用 ⌘+ 放大、⌘- 缩小、⌘0 恢复默认大小'
  : '使用 Ctrl++ 放大、Ctrl+- 缩小、Ctrl+0 恢复默认大小'

/**
 * 校验并规范化 3/6 位 Hex 颜色值
 */
function normalizeHex(hex: string): string | null {
  let clean = hex.trim()
  if (!clean.startsWith('#')) {
    clean = '#' + clean
  }
  if (/^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/.test(clean)) {
    if (clean.length === 4) {
      return (
        '#' +
        clean[1] + clean[1] +
        clean[2] + clean[2] +
        clean[3] + clean[3]
      ).toLowerCase()
    }
    return clean.toLowerCase()
  }
  return null
}

interface ThemeColorPickerBlockProps {
  title: string
  description?: string
  badgeLabel?: string
  currentColor?: string
  defaultColor: string
  presets: ThemeColorPreset[]
  onChange: (color?: string) => void
}

/** 移除预设名称中的 (默认) 后缀，保持选项简洁 */
function cleanPresetName(name: string): string {
  return name.replace(/（默认）|\(默认\)/g, '').trim()
}

/**
 * 单个模式的主题色配置区块
 * 对齐外观设置统一的 SettingsSegmentedControl 风格与 SettingsCard 行内边距
 */
function ThemeColorPickerBlock({
  title,
  description,
  currentColor,
  defaultColor,
  presets,
  onChange,
}: ThemeColorPickerBlockProps): React.ReactElement {
  const activeColor = currentColor || defaultColor
  const [inputVal, setInputVal] = React.useState(activeColor)
  const isCustomized = Boolean(currentColor && currentColor.toLowerCase() !== defaultColor.toLowerCase())

  // 判断当前选中的颜色是否属于某个预设
  const matchedPreset = presets.find(
    (p) => p.color.toLowerCase() === activeColor.toLowerCase()
  )
  const isCustomSelected = !matchedPreset

  // 当外部颜色变更且非当前编辑状态时同步输入框
  React.useEffect(() => {
    setInputVal(activeColor)
  }, [activeColor])

  const handlePresetSelect = (color: string) => {
    setInputVal(color)
    onChange(color)
  }

  const handleInputBlur = () => {
    const valid = normalizeHex(inputVal)
    if (valid) {
      setInputVal(valid)
      onChange(valid)
    } else {
      // 恢复为当前有效颜色
      setInputVal(activeColor)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.currentTarget.blur()
    }
  }

  const handleNativeColorChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value
    setInputVal(val)
    onChange(val)
  }

  const handleReset = () => {
    setInputVal(defaultColor)
    onChange(undefined)
  }

  return (
    <div className="px-4 py-3 space-y-2">
      {/* 头部：对齐 SettingsSegmentedControl 的 label 与 description 规范 */}
      <div className="flex items-center justify-between">
        <div>
          <div className={LABEL_CLASS}>{title}</div>
          {description && (
            <div className={cn(DESCRIPTION_CLASS, 'mt-0.5')}>{description}</div>
          )}
        </div>

        {/* 恢复默认按钮：轻量对齐右上角 */}
        {isCustomized && (
          <button
            type="button"
            onClick={handleReset}
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors ml-3 flex-shrink-0"
            title="恢复为默认主题色"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>恢复默认</span>
          </button>
        )}
      </div>

      {/* 选择区域：对齐外观设置分段选择器的 bg-muted 圆角卡槽规范 */}
      <div className="flex flex-wrap items-center gap-2 pt-0.5">
        <div className="inline-flex flex-wrap items-center rounded-lg bg-muted p-1 gap-0.5">
          {presets.map((preset) => {
            const isSelected = activeColor.toLowerCase() === preset.color.toLowerCase()
            return (
              <button
                key={preset.id}
                type="button"
                onClick={() => handlePresetSelect(preset.color)}
                className={cn(
                  'flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-colors',
                  isSelected
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                )}
                title={`${preset.name} (${preset.color})`}
              >
                <span
                  className="w-3.5 h-3.5 rounded-full flex-shrink-0 border border-black/10 dark:border-white/10"
                  style={{ backgroundColor: preset.color }}
                />
                <span>{cleanPresetName(preset.name)}</span>
              </button>
            )
          })}

          {/* 自定义颜色分段胶囊 */}
          <label
            className={cn(
              'flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium cursor-pointer transition-colors relative',
              isCustomSelected
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            )}
            title="点击打开取色器自定义颜色"
          >
            <span
              className="w-3.5 h-3.5 rounded-full flex-shrink-0 border border-black/10 dark:border-white/10"
              style={{ backgroundColor: activeColor }}
            />
            <span>自定义</span>
            <input
              type="color"
              value={normalizeHex(activeColor) || defaultColor}
              onChange={handleNativeColorChange}
              className="sr-only"
            />
          </label>
        </div>

        {/* 16 进制颜色编码输入框，高度与 SegmentedControl 按钮（32px）保持一致 */}
        <input
          type="text"
          value={inputVal}
          onChange={(e) => setInputVal(e.target.value)}
          onBlur={handleInputBlur}
          onKeyDown={handleKeyDown}
          maxLength={7}
          placeholder="#000000"
          className="h-8 w-20 px-2 font-mono text-xs uppercase bg-muted/60 border border-input/60 rounded-md text-foreground text-center focus:outline-none focus:ring-1 focus:ring-ring transition-colors"
          title="输入 Hex 颜色编码"
        />
      </div>
    </div>
  )
}

const COLOR_TARGET_OPTIONS = [
  { value: 'light', label: '浅色模式配色' },
  { value: 'dark', label: '深色模式配色' },
]

export function AppearanceSettings(): React.ReactElement {
  const [themeMode, setThemeMode] = useAtom(themeModeAtom)
  const systemIsDark = useAtomValue(systemIsDarkAtom)
  const resolvedTheme = useAtomValue(resolvedThemeAtom)
  const [markdownFontSize, setMarkdownFontSize] = useAtom(markdownFontSizeAtom)
  const [previewModePref, setPreviewModePref] = useAtom(previewModePreferenceAtom)

  // 浅色与深色模式下独立的主题色状态
  const [agentColorLight, setAgentColorLight] = useAtom(agentThemeColorLightAtom)
  const [agentColorDark, setAgentColorDark] = useAtom(agentThemeColorDarkAtom)
  const [creationColorLight, setCreationColorLight] = useAtom(creationThemeColorLightAtom)
  const [creationColorDark, setCreationColorDark] = useAtom(creationThemeColorDarkAtom)

  // 当前用户在主题色彩中选中的目标配置模式（浅色模式 / 深色模式），默认与当前应用实际生效主题对齐
  const [colorTargetMode, setColorTargetMode] = React.useState<'light' | 'dark'>(() => resolvedTheme)

  /** 切换主题模式 */
  const handleThemeChange = React.useCallback((value: string) => {
    const mode = value as ThemeMode
    setThemeMode(mode)
    updateThemeMode(mode)
    void updateThemeStyle('default')
    applyThemeToDOM(mode, 'default', systemIsDark)
  }, [setThemeMode, systemIsDark])

  /** 切换 Markdown 字号 */
  const handleMarkdownFontSizeChange = React.useCallback((value: string) => {
    const size = value as MarkdownFontSize
    setMarkdownFontSize(size)
    updateMarkdownFontSize(size)
  }, [setMarkdownFontSize])

  const isTargetDark = colorTargetMode === 'dark'

  /** 处理当前目标模式下的 Agent 模式主题色变更 */
  const handleAgentColorChange = React.useCallback((color?: string) => {
    if (isTargetDark) {
      setAgentColorDark(color)
    } else {
      setAgentColorLight(color)
    }
    updateAgentThemeColor(color, isTargetDark)
  }, [isTargetDark, setAgentColorDark, setAgentColorLight])

  /** 处理当前目标模式下的创造模式主题色变更 */
  const handleCreationColorChange = React.useCallback((color?: string) => {
    if (isTargetDark) {
      setCreationColorDark(color)
    } else {
      setCreationColorLight(color)
    }
    updateCreationThemeColor(color, isTargetDark)
  }, [isTargetDark, setCreationColorDark, setCreationColorLight])

  // 当前目标模式下的默认主题色
  const defaultAgentColor = isTargetDark
    ? DEFAULT_AGENT_THEME_COLOR_DARK
    : DEFAULT_AGENT_THEME_COLOR_LIGHT
  const defaultCreationColor = isTargetDark
    ? DEFAULT_CREATION_THEME_COLOR_DARK
    : DEFAULT_CREATION_THEME_COLOR_LIGHT

  return (
    <div className="space-y-6">
      {/* 基础外观设置 */}
      <SettingsSection
        title="外观设置"
        description="自定义应用的视觉风格与阅读体验"
      >
        <SettingsCard>
          {/* 主题模式 - 最上面 */}
          <SettingsSegmentedControl
            label="主题模式"
            description="选择应用的配色方案"
            value={themeMode}
            onValueChange={handleThemeChange}
            options={THEME_OPTIONS}
          />

          <SettingsRow
            label="界面缩放"
            description={ZOOM_HINT}
          />

          <SettingsSegmentedControl
            label="Markdown 字号"
            description="调整 AI 回复与 Markdown 编辑器的正文字号"
            value={markdownFontSize}
            onValueChange={handleMarkdownFontSizeChange}
            options={MARKDOWN_FONT_SIZE_OPTIONS}
          />

          <SettingsSegmentedControl
            label="Agent 预览展开方式"
            description="点击文件、工具结果「预览」按钮时的默认展开位置；拖拽预览 Tab 出标签栏可即时切换为侧边分屏"
            value={previewModePref}
            onValueChange={(v) => setPreviewModePref(v as PreviewModePreference)}
            options={PREVIEW_MODE_OPTIONS}
          />
        </SettingsCard>
      </SettingsSection>

      {/* 主题色自定义设置 */}
      <SettingsSection
        title="主题色彩"
        description="分别为浅色模式与深色模式自定义 Agent 模式与创造模式的主题强调色"
      >
        <SettingsCard>
          {/* 目标配色模式分段选择器 */}
          <SettingsSegmentedControl
            label="配色目标模式"
            description={`切换配置浅色或深色模式色彩（当前应用生效：${resolvedTheme === 'dark' ? '深色模式' : '浅色模式'}）`}
            value={colorTargetMode}
            onValueChange={(val) => setColorTargetMode(val as 'light' | 'dark')}
            options={COLOR_TARGET_OPTIONS}
          />

          {/* Agent 模式主题色 */}
          <ThemeColorPickerBlock
            title={`Agent 模式主题色（${isTargetDark ? '深色' : '浅色'}）`}
            description={`用于 ${isTargetDark ? '深色' : '浅色'}模式下 Agent 对话的主色调、激活按钮与高亮边框`}
            currentColor={isTargetDark ? agentColorDark : agentColorLight}
            defaultColor={defaultAgentColor}
            presets={AGENT_THEME_COLOR_PRESETS}
            onChange={handleAgentColorChange}
          />

          {/* 创造模式主题色 */}
          <ThemeColorPickerBlock
            title={`创造模式主题色（${isTargetDark ? '深色' : '浅色'}）`}
            description={`用于 ${isTargetDark ? '深色' : '浅色'}模式下创造模式的主题强调色与激活边框`}
            currentColor={isTargetDark ? creationColorDark : creationColorLight}
            defaultColor={defaultCreationColor}
            presets={CREATION_THEME_COLOR_PRESETS}
            onChange={handleCreationColorChange}
          />
        </SettingsCard>
      </SettingsSection>
    </div>
  )
}
