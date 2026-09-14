import { BrowserWindow, ipcMain } from 'electron'
import {
  WEB_SYNC_IPC_CHANNELS,
  type SaveWebPageProfileInput,
  type WebSyncState,
} from '@copis/shared'
import { getWebSyncCoordinator } from '../lib/web-sync-coordinator'
import {
  getWebPageProfiles,
  getWebPageProfile,
  saveWebPageProfile,
  removeWebPageProfile,
} from '../lib/web-page-profile-service'

export function registerWebSyncIpcHandlers(): void {
  const coordinator = getWebSyncCoordinator()

  coordinator.addStateListener((state: WebSyncState) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send(WEB_SYNC_IPC_CHANNELS.STATE_CHANGED, state)
      }
    }
  })

  ipcMain.handle(WEB_SYNC_IPC_CHANNELS.SYNC_NOW, async () => {
    return coordinator.syncNow()
  })

  ipcMain.handle(WEB_SYNC_IPC_CHANNELS.GET_STATE, () => {
    return coordinator.getState()
  })

  ipcMain.handle(WEB_SYNC_IPC_CHANNELS.PROFILES_LIST, () => {
    return getWebPageProfiles()
  })

  ipcMain.handle(WEB_SYNC_IPC_CHANNELS.PROFILE_GET, (_event, url: string) => {
    if (typeof url !== 'string') throw new Error('页面地址不正确')
    return getWebPageProfile(url)
  })

  ipcMain.handle(WEB_SYNC_IPC_CHANNELS.PROFILE_SAVE, (_event, input: SaveWebPageProfileInput) => {
    if (!input || typeof input !== 'object' || typeof input.url !== 'string') {
      throw new Error('页面 Profile 参数不正确')
    }
    return saveWebPageProfile(input)
  })

  ipcMain.handle(WEB_SYNC_IPC_CHANNELS.PROFILE_REMOVE, (_event, profileId: string) => {
    if (typeof profileId !== 'string' || !profileId.trim()) {
      throw new Error('页面 Profile ID 不正确')
    }
    return removeWebPageProfile(profileId)
  })
}
