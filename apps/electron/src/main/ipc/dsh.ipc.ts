import { ipcMain, BrowserWindow } from 'electron'
import { DSH_CORDIS_IPC_CHANNELS, type DshReadFileResult } from '@copis/shared'
import type { DshViewBounds, DshClientEvent } from '@copis/shared'
import { getDshCordisStatus, reloadDshCordisPlugins, setDshStatusChangeBroadcaster, startDshCordisServer, stopDshCordisServer } from '../lib/dsh-cordis-service'
import { ensureDshView, updateDshViewBounds, dispatchToDshClient } from '../lib/dsh-view-manager'

export function registerDshIpcHandlers(): void {
  ipcMain.handle(
    DSH_CORDIS_IPC_CHANNELS.GET_STATUS,
    () => {
      return getDshCordisStatus()
    }
  )

  ipcMain.handle(
    DSH_CORDIS_IPC_CHANNELS.START,
    async () => {
      return startDshCordisServer()
    }
  )

  ipcMain.handle(
    DSH_CORDIS_IPC_CHANNELS.STOP,
    () => {
      return stopDshCordisServer()
    }
  )

  ipcMain.handle(
    DSH_CORDIS_IPC_CHANNELS.RELOAD,
    async () => {
      return reloadDshCordisPlugins()
    }
  )

  ipcMain.handle(
    DSH_CORDIS_IPC_CHANNELS.UPDATE_VIEW_BOUNDS,
    (_event, bounds: DshViewBounds, url?: string) => {
      if (url) {
        ensureDshView(url)
      }
      updateDshViewBounds(bounds)
      return true
    }
  )

  ipcMain.handle(
    DSH_CORDIS_IPC_CHANNELS.DISPATCH_EVENT_TO_CLIENT,
    (_event, payload: unknown) => {
      dispatchToDshClient(payload)
      return true
    }
  )

  ipcMain.handle(
    DSH_CORDIS_IPC_CHANNELS.READ_FILE,
    async (_event, filePath: string, cwd?: string): Promise<DshReadFileResult> => {
      const { readDshFile } = await import('../lib/dsh-file-service')
      return readDshFile(filePath, cwd)
    }
  )

  ipcMain.handle(
    DSH_CORDIS_IPC_CHANNELS.SHOW_ITEM_IN_FOLDER,
    async (_event, filePath: string, cwd?: string): Promise<boolean> => {
      const { showDshItemInFolder } = await import('../lib/dsh-file-service')
      return showDshItemInFolder(filePath, cwd)
    }
  )

  ipcMain.handle(
    DSH_CORDIS_IPC_CHANNELS.LIST_DIRECTORY,
    async (_event, dirPath?: string, cwd?: string): Promise<import('@copis/shared').DshFileEntry[]> => {
      const { listDshDirectory } = await import('../lib/dsh-file-service')
      return listDshDirectory(dirPath, cwd)
    }
  )

  ipcMain.on(
    DSH_CORDIS_IPC_CHANNELS.CLIENT_EVENT,
    (_event, clientEvent: DshClientEvent) => {
      const windows = BrowserWindow.getAllWindows()
      for (const win of windows) {
        if (!win.isDestroyed() && win.webContents) {
          win.webContents.send(DSH_CORDIS_IPC_CHANNELS.CLIENT_EVENT, clientEvent)
        }
      }
    }
  )

  setDshStatusChangeBroadcaster((status) => {
    const windows = BrowserWindow.getAllWindows()
    for (const win of windows) {
      if (!win.isDestroyed() && win.webContents) {
        win.webContents.send(DSH_CORDIS_IPC_CHANNELS.ON_STATUS_CHANGE, status)
      }
    }
  })
}
