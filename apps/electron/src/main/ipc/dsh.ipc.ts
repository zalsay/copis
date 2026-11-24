import { ipcMain, BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { DSH_CORDIS_IPC_CHANNELS, type DshReadFileResult } from '@copis/shared'
import type { DshViewBounds, DshClientEvent } from '@copis/shared'
import { getDshCordisStatus, reloadDshCordisPlugins, setDshStatusChangeBroadcaster, startDshCordisServer, stopDshCordisServerAndWait } from '../lib/dsh-cordis-service'
import { ensureDshView, updateDshViewBounds, dispatchToDshClient, isDshViewSender } from '../lib/dsh-view-manager'

const mediaOwners = new WeakSet<Electron.WebContents>()

function isDshMainFrame(event: Electron.IpcMainEvent | IpcMainInvokeEvent): boolean {
  const url = getDshCordisStatus().url
  try {
    if (isDshViewSender(event.sender.id) && event.senderFrame === event.sender.mainFrame && url
      && new URL(event.senderFrame.url).origin === new URL(url).origin) return true
  } catch { /* 无效或已释放的 frame 按拒绝处理。 */ }
  return false
}

function requireDshMediaSender(event: IpcMainInvokeEvent): void {
  if (!isDshMainFrame(event)) throw new Error('媒体预览仅允许当前创造模式主页面访问')
}

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
    async () => {
      return stopDshCordisServerAndWait()
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

  ipcMain.handle(DSH_CORDIS_IPC_CHANNELS.PREPARE_MEDIA_PREVIEW, async (event, path: string) => {
    requireDshMediaSender(event)
    const { prepareDshMediaPreview } = await import('../lib/dsh-media-service')
    const { revokeCopisFilesForOwner } = await import('../lib/local-file-protocol')
    if (!mediaOwners.has(event.sender)) {
      mediaOwners.add(event.sender)
      const ownerId = event.sender.id
      event.sender.once('destroyed', () => revokeCopisFilesForOwner(ownerId))
      event.sender.on('render-process-gone', () => revokeCopisFilesForOwner(ownerId))
      event.sender.on('did-start-navigation', (_event, _url, inPlace, isMainFrame) => {
        if (isMainFrame && !inPlace) revokeCopisFilesForOwner(ownerId)
      })
    }
    return prepareDshMediaPreview(path, event.sender.id)
  })

  ipcMain.handle(DSH_CORDIS_IPC_CHANNELS.RELEASE_MEDIA_PREVIEW, async (event, url: string) => {
    requireDshMediaSender(event)
    const { revokeCopisFileUrl } = await import('../lib/local-file-protocol')
    return revokeCopisFileUrl(url, event.sender.id)
  })

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

  ipcMain.handle(
    DSH_CORDIS_IPC_CHANNELS.GET_ACTIVE_WORKSPACE_PATH,
    async (_event, cwd?: string): Promise<string> => {
      const { getActiveDshWorkspacePath } = await import('../lib/dsh-file-service')
      return getActiveDshWorkspacePath(cwd)
    }
  )

  ipcMain.on(
    DSH_CORDIS_IPC_CHANNELS.CLIENT_EVENT,
    (event, clientEvent: DshClientEvent) => {
      if (clientEvent?.type === 'COPIS_DSH_SESSION_COMPLETED' || clientEvent?.type === 'COPIS_DSH_SESSION_VIEWED') {
        if (!isDshMainFrame(event) || typeof clientEvent.sessionId !== 'string' || !clientEvent.sessionId.trim() || clientEvent.sessionId.length > 256) return
        if (clientEvent.type === 'COPIS_DSH_SESSION_COMPLETED' && (
          !Number.isSafeInteger(clientEvent.completionSeq) || clientEvent.completionSeq < 0
          || typeof clientEvent.title !== 'string' || clientEvent.title.length > 4096
          || typeof clientEvent.viewed !== 'boolean' || typeof clientEvent.windowFocused !== 'boolean'
        )) return
      }
      const windows = BrowserWindow.getAllWindows()
      if (clientEvent?.type === 'COPIS_DSH_SESSION_COMPLETED') {
        // 原生网页页签同样属于前台应用，不能只看两个 Renderer 的 document.hasFocus()。
        clientEvent = { ...clientEvent, windowFocused: windows.some((win) => !win.isDestroyed() && win.isFocused()) }
      }
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
