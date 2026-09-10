import { ipcMain } from 'electron'
import { existsSync, rmSync } from 'node:fs'
import { STORAGE_IPC_CHANNELS } from '../../types'
import { calculateStorageStats, cleanupStorage, cleanupTempFiles } from '../lib/storage-service'
import type { CleanupOptions } from '../lib/storage-service'

export function registerStorageIpcHandlers(): void {
  // ===== 存储管理 =====

  ipcMain.handle(STORAGE_IPC_CHANNELS.GET_STATS, async () => {
    return calculateStorageStats()
  })

  ipcMain.handle(STORAGE_IPC_CHANNELS.CLEANUP, async (_, options: CleanupOptions) => {
    return cleanupStorage(options)
  })

  ipcMain.handle(STORAGE_IPC_CHANNELS.CLEANUP_TEMP, async () => {
    return cleanupTempFiles()
  })

  // 迁移取消时清理临时解压目录
  ipcMain.handle('migration:cancelImport', async (_, tempDir: string) => {
    if (tempDir && existsSync(tempDir) && tempDir.includes('copis-import-')) {
      rmSync(tempDir, { recursive: true, force: true })
      console.log(`[迁移] 已清理临时目录: ${tempDir}`)
    }
  })
}
