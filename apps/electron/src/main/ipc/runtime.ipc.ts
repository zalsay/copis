import { ipcMain, BrowserWindow, app } from 'electron'
import { IPC_CHANNELS, ENVIRONMENT_IPC_CHANNELS, FUNCTIONAL_MODULE_IPC_CHANNELS, PROXY_IPC_CHANNELS } from '@copis/shared'
import type { AppInfo, RuntimeStatus, EnvironmentCheckResult, FunctionalModuleInstallInput, FunctionalModuleProgressPayload, FunctionalModuleStartupProgressPayload, FunctionalModuleStatus, ProxyConfig, SystemProxyDetectResult } from '@copis/shared'
import { getRuntimeStatus, reinitializeRuntime } from '../lib/runtime-init'
import { updateSettings } from '../lib/settings-service'
import { checkEnvironment } from '../lib/environment-checker'
import { checkFunctionalModule, getFunctionalModuleStatuses, installFunctionalModule } from '../lib/functional-module-manager'
import { ensureRequiredFunctionalModules } from '../lib/functional-module-startup'
import { getProxySettings, saveProxySettings } from '../lib/proxy-settings-service'
import { detectSystemProxy } from '../lib/system-proxy-detector'

export function registerRuntimeInfoIpcHandlers(): void {
  // ===== 主程序与运行时相关 =====

  // 获取主程序版本与运行环境信息
  ipcMain.handle(
    IPC_CHANNELS.GET_APP_INFO,
    async (): Promise<AppInfo> => ({
      version: app.getVersion(),
      packaged: app.isPackaged,
    })
  )

  // 获取运行时状态
  ipcMain.handle(
    IPC_CHANNELS.GET_RUNTIME_STATUS,
    async (): Promise<RuntimeStatus | null> => {
      return getRuntimeStatus()
    }
  )

  // 重新初始化运行时（用户安装完 Git/Node 后触发，Windows 场景常用）
  ipcMain.handle(
    IPC_CHANNELS.REINIT_RUNTIME,
    async (): Promise<RuntimeStatus> => {
      return reinitializeRuntime()
    }
  )
}

export function registerRuntimeServicesIpcHandlers(): void {
  // ===== 环境检测相关 =====

  // 执行环境检测
  ipcMain.handle(
    ENVIRONMENT_IPC_CHANNELS.CHECK,
    async (): Promise<EnvironmentCheckResult> => {
      const result = await checkEnvironment()
      // 自动保存检测结果到设置
      await updateSettings({
        lastEnvironmentCheck: result,
      })
      return result
    }
  )

  // ===== Copis 功能模块相关 =====

  ipcMain.handle(
    FUNCTIONAL_MODULE_IPC_CHANNELS.LIST,
    async (): Promise<FunctionalModuleStatus[]> => getFunctionalModuleStatuses(),
  )

  ipcMain.handle(
    FUNCTIONAL_MODULE_IPC_CHANNELS.CHECK,
    async (_event, name: string): Promise<FunctionalModuleStatus> => {
      if (typeof name !== 'string' || !name.trim()) throw new Error('功能模块名称不正确')
      return checkFunctionalModule(name)
    },
  )

  ipcMain.handle(
    FUNCTIONAL_MODULE_IPC_CHANNELS.INSTALL,
    async (event, input: FunctionalModuleInstallInput): Promise<FunctionalModuleStatus> => {
      if (!input || typeof input.name !== 'string' || !input.name.trim()) {
        throw new Error('功能模块安装参数不正确')
      }
      const window = BrowserWindow.fromWebContents(event.sender)
      return installFunctionalModule(input, {
        onProgress: (payload) => {
          if (window && !window.isDestroyed()) {
            window.webContents.send(FUNCTIONAL_MODULE_IPC_CHANNELS.PROGRESS, payload)
          }
        },
      })
    },
  )

  ipcMain.handle(
    FUNCTIONAL_MODULE_IPC_CHANNELS.ENSURE_REQUIRED,
    async (event): Promise<FunctionalModuleStatus[]> => {
      const window = BrowserWindow.fromWebContents(event.sender)
      const sendStartupProgress = (payload: FunctionalModuleStartupProgressPayload): void => {
        if (window && !window.isDestroyed()) {
          window.webContents.send(FUNCTIONAL_MODULE_IPC_CHANNELS.STARTUP_PROGRESS, payload)
        }
      }
      const sendModuleProgress = (payload: FunctionalModuleProgressPayload): void => {
        if (window && !window.isDestroyed()) {
          window.webContents.send(FUNCTIONAL_MODULE_IPC_CHANNELS.PROGRESS, payload)
        }
      }
      return ensureRequiredFunctionalModules({
        skipModuleUpdates: app.isPackaged !== true,
        allowBundledPlaywrightCore: app.isPackaged === true,
        onProgress: sendStartupProgress,
        onModuleProgress: sendModuleProgress,
      })
    },
  )

  // ===== 代理配置相关 =====

  // 获取代理配置
  ipcMain.handle(
    PROXY_IPC_CHANNELS.GET_SETTINGS,
    async (): Promise<ProxyConfig> => {
      return getProxySettings()
    }
  )

  // 更新代理配置
  ipcMain.handle(
    PROXY_IPC_CHANNELS.UPDATE_SETTINGS,
    async (_, config: ProxyConfig): Promise<void> => {
      await saveProxySettings(config)
    }
  )

  // 检测系统代理
  ipcMain.handle(
    PROXY_IPC_CHANNELS.DETECT_SYSTEM,
    async (): Promise<SystemProxyDetectResult> => {
      return detectSystemProxy()
    }
  )
}
