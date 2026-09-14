/**
 * Codex App Server IPC 处理模块
 *
 * 负责注册 Codex App Server 的启停与状态查询 IPC 通道，
 * 并向所有渲染窗口广播状态变更。
 */

import { BrowserWindow, ipcMain } from 'electron'
import { CODEX_IPC_CHANNELS } from '../../types'
import {
  detectCodexCli,
  getCodexAppServerStatus,
  setCodexStatusChangeBroadcaster,
  startCodexAppServer,
  stopCodexAppServer,
} from '../lib/codex-app-server-service'
import { updateSettings } from '../lib/settings-service'

export function registerCodexIpcHandlers(): void {
  // 注册状态变更广播钩子
  setCodexStatusChangeBroadcaster((status) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send(CODEX_IPC_CHANNELS.ON_STATUS_CHANGED, status)
      }
    }
  })

  // 检测 codex-cli 本地安装与 app-server 可用性
  ipcMain.handle(CODEX_IPC_CHANNELS.CHECK_CLI, async () => {
    return detectCodexCli()
  })

  // 获取 Codex App Server 状态
  ipcMain.handle(CODEX_IPC_CHANNELS.GET_STATUS, () => {
    return getCodexAppServerStatus()
  })

  // 启动 Codex App Server 并开启专业模式
  ipcMain.handle(CODEX_IPC_CHANNELS.START_APP_SERVER, async () => {
    try {
      const status = await startCodexAppServer()
      updateSettings({ professionalMode: true })
      return status
    } catch (error) {
      console.error('[IPC] 启动 Codex App Server 失败:', error)
      throw error
    }
  })

  // 停止 Codex App Server 并关闭专业模式
  ipcMain.handle(CODEX_IPC_CHANNELS.STOP_APP_SERVER, async () => {
    try {
      await stopCodexAppServer()
      updateSettings({ professionalMode: false })
    } catch (error) {
      console.error('[IPC] 停止 Codex App Server 失败:', error)
      throw error
    }
  })
}
