import { BrowserWindow } from 'electron'
import { AUTOMATION_IPC_CHANNELS } from '@copis/shared'
import { runtimeAutomationApiClient } from './automation-api-client'

/**
 * Rust HTTP API 是定时任务调度与 Pi Worker 的唯一执行方。
 * Electron 仅在 Rust 持久化任务状态后通知已打开的界面刷新。
 */
export function broadcastChanged(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(AUTOMATION_IPC_CHANNELS.CHANGED)
  }
}

/** 保留旧调用点兼容；立即执行统一转发到 Rust API。 */
export async function runAutomationNow(id: string): Promise<void> {
  await runtimeAutomationApiClient.runNow(id)
}
