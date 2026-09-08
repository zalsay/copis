/**
 * 应用设置服务
 *
 * 管理应用设置（主题模式等）的读写。
 * 存储在 ~/.copis/settings.json
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { getSettingsPath } from './config-paths'
import { DEFAULT_AGENT_RUNTIME, DEFAULT_APP_MODE, DEFAULT_INTERFACE_VARIANT, DEFAULT_MEMORY_POLICY, DEFAULT_THEME_MODE } from '../../types'
import type { AppMode, AppSettings } from '../../types'
import { normalizeMemoryPolicy } from '@copis/shared'

interface ElectronAppModule {
  app?: {
    isPackaged?: boolean
  }
}

function isBrowserWorkflowDevelopmentMode(): boolean {
  if (process.env.COPIS_DEV === '1') return true
  try {
    return (require('electron') as ElectronAppModule).app?.isPackaged === false
  } catch {
    return false
  }
}

function resolveBrowserWorkflowEnabled(value: boolean | undefined): boolean {
  return isBrowserWorkflowDevelopmentMode() || value !== false
}

/**
 * 获取应用设置
 *
 * 如果文件不存在，返回默认设置。
 */
export function getSettings(): AppSettings {
  const filePath = getSettingsPath()

  if (!existsSync(filePath)) {
    return {
      appMode: DEFAULT_APP_MODE,
      themeMode: DEFAULT_THEME_MODE,
      interfaceVariant: DEFAULT_INTERFACE_VARIANT,
      onboardingCompleted: false,
      browserWorkflowEnabled: true,
      environmentCheckSkipped: false,
      notificationsEnabled: true,
      longTextPasteAsAttachmentEnabled: false,
      richTextRenderingEnabled: false,
      feishuSessionMirror: { mode: 'off' },
      visionRelay: { enabled: false },
      builtinMcpDisabledIds: [],
      pinnedDevProjects: {},
      hiddenSidebarMenuItems: [],
      agentRuntime: DEFAULT_AGENT_RUNTIME,
      defaultMemoryPolicy: DEFAULT_MEMORY_POLICY,
      windowsShellPreference: 'auto',
      agentThinking: { type: 'adaptive' },
      gitAttributionEnabled: true,
    }
  }

  try {
    const raw = readFileSync(filePath, 'utf-8')
    const data = JSON.parse(raw) as Partial<AppSettings> & {
      experimentalAgentRuntimeSwitchEnabled?: boolean
      agentRuntime?: unknown
    }
    // Pi runtime 已默认可用；读取时清理旧版本遗留的实验开关。
    const { experimentalAgentRuntimeSwitchEnabled: _legacyRuntimeSwitch, ...settings } = data
    return {
      ...settings,
      appMode: data.appMode === 'creation' ? 'creation' : DEFAULT_APP_MODE,
      themeMode: data.themeMode || DEFAULT_THEME_MODE,
      interfaceVariant: data.interfaceVariant || DEFAULT_INTERFACE_VARIANT,
      onboardingCompleted: data.onboardingCompleted ?? false,
      browserWorkflowEnabled: resolveBrowserWorkflowEnabled(data.browserWorkflowEnabled),
      environmentCheckSkipped: data.environmentCheckSkipped ?? false,
      notificationsEnabled: data.notificationsEnabled ?? true,
      longTextPasteAsAttachmentEnabled: data.longTextPasteAsAttachmentEnabled ?? false,
      richTextRenderingEnabled: data.richTextRenderingEnabled ?? false,
      feishuSessionMirror: data.feishuSessionMirror ?? { mode: 'off' },
      visionRelay: data.visionRelay ?? { enabled: false },
      builtinMcpDisabledIds: settings.builtinMcpDisabledIds ?? [],
      pinnedDevProjects: Array.isArray(settings.pinnedDevProjects) ? {} : settings.pinnedDevProjects ?? {},
      hiddenSidebarMenuItems: Array.isArray(settings.hiddenSidebarMenuItems) ? settings.hiddenSidebarMenuItems : [],
      agentRuntime: data.agentRuntime === 'pi' ? 'pi' : DEFAULT_AGENT_RUNTIME,
      defaultMemoryPolicy: normalizeMemoryPolicy(data.defaultMemoryPolicy),
      windowsShellPreference: settings.windowsShellPreference ?? 'auto',
      agentThinking: settings.agentThinking ?? { type: 'adaptive' },
      gitAttributionEnabled: settings.gitAttributionEnabled ?? true,
    }
  } catch (error) {
    console.error('[设置] 读取失败:', error)
    return {
      appMode: DEFAULT_APP_MODE,
      themeMode: DEFAULT_THEME_MODE,
      interfaceVariant: DEFAULT_INTERFACE_VARIANT,
      onboardingCompleted: false,
      browserWorkflowEnabled: true,
      environmentCheckSkipped: false,
      notificationsEnabled: true,
      longTextPasteAsAttachmentEnabled: false,
      richTextRenderingEnabled: false,
      feishuSessionMirror: { mode: 'off' },
      visionRelay: { enabled: false },
      builtinMcpDisabledIds: [],
      pinnedDevProjects: {},
      hiddenSidebarMenuItems: [],
      agentRuntime: DEFAULT_AGENT_RUNTIME,
      defaultMemoryPolicy: DEFAULT_MEMORY_POLICY,
      windowsShellPreference: 'auto',
      agentThinking: { type: 'adaptive' },
      gitAttributionEnabled: true,
    }
  }
}

/**
 * 更新应用设置
 *
 * 合并更新字段并写入文件。
 */
export function updateSettings(updates: Partial<AppSettings>): AppSettings {
  const current = getSettings()
  const normalizedUpdates = { ...updates }
  if (normalizedUpdates.appMode !== undefined) {
    normalizedUpdates.appMode = normalizedUpdates.appMode === 'creation' ? 'creation' : 'agent'
  }
  const themeColorKeys: (keyof AppSettings)[] = [
    'agentThemeColor',
    'creationThemeColor',
    'agentThemeColorLight',
    'agentThemeColorDark',
    'creationThemeColorLight',
    'creationThemeColorDark',
  ]
  for (const key of themeColorKeys) {
    if (normalizedUpdates[key] === '' || normalizedUpdates[key] === null) {
      normalizedUpdates[key] = undefined as any
    }
  }
  const updated: AppSettings = {
    ...current,
    ...normalizedUpdates,
  }
  const filePath = getSettingsPath()

  try {
    writeFileSync(filePath, JSON.stringify(updated, null, 2), 'utf-8')
    console.log('[设置] 已更新 keys:', Object.keys(updates).join(', '))
  } catch (error) {
    console.error('[设置] 写入失败:', error)
    throw new Error('写入应用设置失败')
  }

  return updated
}
