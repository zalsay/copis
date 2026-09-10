import { ipcMain, shell, clipboard } from 'electron'
import { resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { IPC_CHANNELS } from '@copis/shared'
import type { FileAccessOptions } from '@copis/shared'
import { normalizeFileAccessOptions, isPathAllowed } from '../lib/ipc-file-access'
import { KNOWN_EDITORS, getDefaultAppInfoForFile } from '../lib/system-app-info'

export function registerSystemFilesIpcHandlers(): void {
  // 在系统默认浏览器中打开外部链接
  ipcMain.handle(
    IPC_CHANNELS.OPEN_EXTERNAL,
    async (_, url: string): Promise<void> => {
      if (!url || typeof url !== 'string') {
        console.warn('[IPC] shell:open-external 收到无效的 URL')
        return
      }
      // 仅允许 http/https 协议，防止安全风险
      if (!url.startsWith('http://') && !url.startsWith('https://')) {
        console.warn('[IPC] shell:open-external 仅支持 http/https 协议:', url)
        return
      }
      await shell.openExternal(url)
    }
  )

  // 在系统剪贴板中写入纯文本
  ipcMain.handle(
    IPC_CHANNELS.WRITE_CLIPBOARD_TEXT,
    async (_, text: string): Promise<void> => {
      if (typeof text !== 'string') {
        throw new TypeError('剪贴板文本必须是字符串')
      }
      clipboard.writeText(text)
    }
  )

  // 用系统默认应用打开任意文件（appName 需在 KNOWN_EDITORS 白名单内）
  ipcMain.handle(
    IPC_CHANNELS.SYSTEM_OPEN_FILE,
    async (_, filePath: string, appName?: string, access?: FileAccessOptions | string[]): Promise<void> => {
      const { resolve } = await import('node:path')
      const absPath = resolve(filePath)
      const options = normalizeFileAccessOptions(access)
      if (!isPathAllowed(absPath, options)) {
        console.warn('[IPC] shell:system-open-file 拒绝越界路径:', absPath)
        return
      }
      if (process.platform === 'darwin') {
        const { spawnSync } = await import('node:child_process')
        if (appName) {
          if (!KNOWN_EDITORS.includes(appName)) {
            console.warn('[IPC] shell:system-open-file 拒绝未知应用:', appName)
            return
          }
          spawnSync('open', ['-a', appName, absPath], { timeout: 5000 })
        } else {
          spawnSync('open', [absPath], { timeout: 5000 })
        }
      } else {
        await shell.openPath(absPath)
      }
    }
  )

  // 扫描系统中的编辑器应用（仅 macOS）
  ipcMain.handle(
    IPC_CHANNELS.SCAN_EDITORS,
    async (): Promise<import('@copis/shared').EditorApp[]> => {
      if (process.platform !== 'darwin') return []
      const { existsSync } = await import('node:fs')
      const { homedir } = await import('node:os')
      const home = homedir()

      const editors = KNOWN_EDITORS.map((name) => {
        const searchPaths = name === 'Xcode' || name === 'TextEdit'
          ? [`/Applications/${name}.app`]
          : [`/Applications/${name}.app`, `${home}/Applications/${name}.app`]
        return { name, paths: searchPaths }
      })

      return editors
        .filter((e) => e.paths.some((p) => existsSync(p)))
        .map((e) => ({ name: e.name, path: e.paths.find((p) => existsSync(p))! }))
    }
  )

  // 查询某个文件在本机的默认打开应用信息（带图标）
  ipcMain.handle(
    IPC_CHANNELS.GET_DEFAULT_APP_FOR_FILE,
    async (_, filePath: string, access?: FileAccessOptions | string[]): Promise<import('@copis/shared').DefaultAppInfo | null> => {
      if (!filePath || typeof filePath !== 'string') return null
      try {
        const options = normalizeFileAccessOptions(access)
        if (options && !isPathAllowed(filePath, options)) {
          console.warn('[IPC] shell:get-default-app-for-file 拒绝越界路径:', filePath)
          return null
        }
        console.log('[IPC] get-default-app-for-file 收到请求:', filePath)
        const result = await getDefaultAppInfoForFile(filePath, options)
        console.log('[IPC] get-default-app-for-file 返回:', result ? `name=${result.name} appPath=${result.appPath} iconLen=${result.iconDataUrl?.length}` : 'null')
        return result
      } catch (err) {
        console.warn('[IPC] shell:get-default-app-for-file 失败:', err)
        return null
      }
    }
  )
}
