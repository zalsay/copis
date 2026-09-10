import { ipcMain, nativeTheme, BrowserWindow, app } from 'electron'
import { existsSync } from 'node:fs'
import { IPC_CHANNELS } from '@copis/shared'
import { USER_PROFILE_IPC_CHANNELS, SETTINGS_IPC_CHANNELS, APP_ICON_IPC_CHANNELS, DOCK_BADGE_IPC_CHANNELS } from '../../types'
import type { UserProfile, AppSettings } from '../../types'
import { syncCopisModelConfigToDsh } from '../lib/dsh-cordis-service'
import { syncThemeToDshView, syncHiddenSidebarMenuItemsToDshView } from '../lib/dsh-view-manager'
import { syncNativeThemeSource, resolveIsDark } from '../lib/theme-sync'
import { shouldSyncDshCopisDefaults } from '../lib/dsh-model-config'
import { getTutorialContent } from '../lib/tutorial-service'
import { getUserProfile, updateUserProfile } from '../lib/user-profile-service'
import { getSettings, updateSettings } from '../lib/settings-service'
import { setDockBadgeCount } from '../lib/dock-badge-service'
import { getWorkingModelCatalogAccess } from '../lib/working-model-catalog-access'
import { syncFeishuSyncSleepBlocker } from '../lib/feishu-sleep-blocker'
import { filterWorkingModelCatalogUpdate, redactWorkingModelCatalog } from '../lib/working-model-catalog'
import { resolveAppIconPath } from '../lib/app-icon-path'

export function registerTutorialIpcHandlers(): void {
  // 获取教程内容
  ipcMain.handle(
    IPC_CHANNELS.GET_TUTORIAL_CONTENT,
    async (): Promise<string | null> => {
      return getTutorialContent()
    }
  )
}

export function registerSettingsIpcHandlers(): void {
  // ===== 用户档案相关 =====

  // 获取用户档案
  ipcMain.handle(
    USER_PROFILE_IPC_CHANNELS.GET,
    async (): Promise<UserProfile> => {
      return getUserProfile()
    }
  )

  // 更新用户档案
  ipcMain.handle(
    USER_PROFILE_IPC_CHANNELS.UPDATE,
    async (_, updates: Partial<UserProfile>): Promise<UserProfile> => {
      return updateUserProfile(updates)
    }
  )

  // ===== 应用设置相关 =====

  // 获取应用设置
  ipcMain.handle(
    SETTINGS_IPC_CHANNELS.GET,
    async (): Promise<AppSettings> => {
      const access = getWorkingModelCatalogAccess()
      return redactWorkingModelCatalog(getSettings(), access.isVip, access.ownerId)
    }
  )

  // 更新应用设置
  ipcMain.handle(
    SETTINGS_IPC_CHANNELS.UPDATE,
    async (event, updates: Partial<AppSettings>): Promise<AppSettings> => {
      const access = getWorkingModelCatalogAccess()
      const safeUpdates = filterWorkingModelCatalogUpdate(
        updates,
        access.isVip,
        access.ownerId,
      )
      const result = await updateSettings(safeUpdates)

      if (safeUpdates.feishuSessionMirror !== undefined) {
        syncFeishuSyncSleepBlocker(result)
      }
      if (shouldSyncDshCopisDefaults(safeUpdates)) {
        void syncCopisModelConfigToDsh({
          channelId: result.agentChannelId,
          modelId: result.agentModelId,
        }).catch((err) => {
          console.warn('[DSH Cordis Web] 联动同步模型配置失败:', err)
        })
      }
      // 主题相关设置变化时，同步 Electron 原生内核与 DSH 视图，并广播给所有窗口（跨窗口同步，如 Quick Task 面板）
      if (
        safeUpdates.themeMode !== undefined ||
        safeUpdates.themeStyle !== undefined ||
        safeUpdates.interfaceVariant !== undefined ||
        safeUpdates.agentThemeColor !== undefined ||
        safeUpdates.creationThemeColor !== undefined ||
        safeUpdates.agentThemeColorLight !== undefined ||
        safeUpdates.agentThemeColorDark !== undefined ||
        safeUpdates.creationThemeColorLight !== undefined ||
        safeUpdates.creationThemeColorDark !== undefined
      ) {
        syncNativeThemeSource(result.themeMode, result.themeStyle)
        const isDark = resolveIsDark(result.themeMode, result.themeStyle, nativeTheme.shouldUseDarkColors)
        const effectiveAgentColor = isDark
          ? (result.agentThemeColorDark || result.agentThemeColor)
          : (result.agentThemeColorLight || result.agentThemeColor)
        const effectiveCreationColor = isDark
          ? (result.creationThemeColorDark || result.creationThemeColor)
          : (result.creationThemeColorLight || result.creationThemeColor)

        syncThemeToDshView(isDark, effectiveAgentColor, effectiveCreationColor)

        const payload = {
          themeMode: result.themeMode,
          themeStyle: result.themeStyle,
          interfaceVariant: result.interfaceVariant,
          agentThemeColor: result.agentThemeColor,
          creationThemeColor: result.creationThemeColor,
          agentThemeColorLight: result.agentThemeColorLight,
          agentThemeColorDark: result.agentThemeColorDark,
          creationThemeColorLight: result.creationThemeColorLight,
          creationThemeColorDark: result.creationThemeColorDark,
        }
        BrowserWindow.getAllWindows().forEach((win) => {
          // 跳过发起者窗口，避免重复应用
          if (win.webContents.id !== event.sender.id) {
            win.webContents.send(SETTINGS_IPC_CHANNELS.ON_THEME_SETTINGS_CHANGED, payload)
          }
        })
      }

      // 隐藏菜单项配置变化时，同步 DSH 视图并广播给所有窗口
      if (safeUpdates.hiddenSidebarMenuItems !== undefined) {
        syncHiddenSidebarMenuItemsToDshView(result.hiddenSidebarMenuItems)
        BrowserWindow.getAllWindows().forEach((win) => {
          if (win.webContents.id !== event.sender.id) {
            win.webContents.send(
              SETTINGS_IPC_CHANNELS.ON_HIDDEN_SIDEBAR_MENU_ITEMS_CHANGED,
              result.hiddenSidebarMenuItems,
            )
          }
        })
      }

      return redactWorkingModelCatalog(result, access.isVip, access.ownerId)
    }
  )

  // 同步更新应用设置（用于 beforeunload 场景）
  ipcMain.on(
    SETTINGS_IPC_CHANNELS.UPDATE_SYNC,
    (event, updates: Partial<AppSettings>) => {
      try {
        const access = getWorkingModelCatalogAccess()
        const safeUpdates = filterWorkingModelCatalogUpdate(
          updates,
          access.isVip,
          access.ownerId,
        )
        const result = updateSettings(safeUpdates)
        if (safeUpdates.feishuSessionMirror !== undefined) {
          syncFeishuSyncSleepBlocker(result)
        }
        if (safeUpdates.hiddenSidebarMenuItems !== undefined) {
          syncHiddenSidebarMenuItemsToDshView(result.hiddenSidebarMenuItems)
          BrowserWindow.getAllWindows().forEach((win) => {
            if (win.webContents.id !== event.sender.id) {
              win.webContents.send(
                SETTINGS_IPC_CHANNELS.ON_HIDDEN_SIDEBAR_MENU_ITEMS_CHANGED,
                result.hiddenSidebarMenuItems,
              )
            }
          })
        }
        if (
          safeUpdates.themeMode !== undefined ||
          safeUpdates.themeStyle !== undefined ||
          safeUpdates.agentThemeColor !== undefined ||
          safeUpdates.creationThemeColor !== undefined ||
          safeUpdates.agentThemeColorLight !== undefined ||
          safeUpdates.agentThemeColorDark !== undefined ||
          safeUpdates.creationThemeColorLight !== undefined ||
          safeUpdates.creationThemeColorDark !== undefined
        ) {
          syncNativeThemeSource(result.themeMode, result.themeStyle)
          const isDark = resolveIsDark(result.themeMode, result.themeStyle, nativeTheme.shouldUseDarkColors)
          const effectiveAgentColor = isDark
            ? (result.agentThemeColorDark || result.agentThemeColor)
            : (result.agentThemeColorLight || result.agentThemeColor)
          const effectiveCreationColor = isDark
            ? (result.creationThemeColorDark || result.creationThemeColor)
            : (result.creationThemeColorLight || result.creationThemeColor)
          syncThemeToDshView(isDark, effectiveAgentColor, effectiveCreationColor)
        }
        if (shouldSyncDshCopisDefaults(safeUpdates)) {
          void syncCopisModelConfigToDsh({
            channelId: result.agentChannelId,
            modelId: result.agentModelId,
          }).catch((err) => {
            console.warn('[DSH Cordis Web] 联动同步模型配置失败:', err)
          })
        }
        event.returnValue = true
      } catch {
        event.returnValue = false
      }
    }
  )

  // 获取系统主题（是否深色模式）
  ipcMain.handle(
    SETTINGS_IPC_CHANNELS.GET_SYSTEM_THEME,
    async (): Promise<boolean> => {
      return nativeTheme.shouldUseDarkColors
    }
  )

  // 监听系统主题变化，推送给所有渲染进程窗口并联动 DSH 视图
  nativeTheme.on('updated', () => {
    const isDark = nativeTheme.shouldUseDarkColors
    console.log(`[设置] 系统主题变化: ${isDark ? '深色' : '浅色'}`)
    const currentSettings = getSettings()
    if (currentSettings.themeMode === 'system') {
      syncThemeToDshView(isDark)
    }
    BrowserWindow.getAllWindows().forEach((win) => {
      win.webContents.send(SETTINGS_IPC_CHANNELS.ON_SYSTEM_THEME_CHANGED, isDark)
    })
  })
}

export function registerAppAppearanceIpcHandlers(): void {
  // ===== 应用图标切换 =====

  ipcMain.handle(
    APP_ICON_IPC_CHANNELS.SET,
    async (_, variantId: string): Promise<boolean> => {
      try {
        // 解析图标文件路径
        const iconPath = resolveAppIconPath(variantId)
        if (!iconPath || !existsSync(iconPath)) {
          console.warn('[图标] 图标文件不存在:', iconPath)
          return false
        }

        // macOS: 设置 Dock 图标
        if (process.platform === 'darwin' && app.dock) {
          app.dock.setIcon(iconPath)
        }

        // 持久化到设置
        await updateSettings({ appIconVariant: variantId })
        console.log(`[图标] 已切换到: ${variantId}`)
        return true
      } catch (error) {
        console.error('[图标] 切换失败:', error)
        return false
      }
    }
  )

  // ===== Dock/Launcher 角标 =====

  ipcMain.handle(
    DOCK_BADGE_IPC_CHANNELS.SET_COUNT,
    async (_, count: number): Promise<boolean> => {
      return setDockBadgeCount(count)
    }
  )
}
