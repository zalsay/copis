import { ipcMain, dialog, BrowserWindow } from 'electron'
import { basename, join, sep } from 'node:path'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { ATTACHMENT_IPC_CHANNELS, AGENT_IPC_CHANNELS } from '@copis/shared'
import type { FileDialogResult, FileOrFolderDialogResult, AgentSaveFilesInput, AgentSaveWorkspaceFilesInput, AgentSavedFile } from '@copis/shared'
import { readAttachmentAsBase64, openFileDialog, openFileOrFolderDialog } from '../lib/attachment-service'
import { saveFilesToAgentSession, saveFilesToWorkspaceFiles } from '../lib/agent-service'
import { getWorkspaceFilesDir } from '../lib/config-paths'
import { getAgentWorkspaceBySlug, getAgentWorkspaceSourceRoot } from '../lib/agent-workspace-manager'
import { getBundledResourcesDir } from '../lib/bundled-resources'

export function registerAttachmentsIpcHandlers(): void {
  // ===== 附件管理相关 =====

  // 读取附件（返回 base64）
  ipcMain.handle(
    ATTACHMENT_IPC_CHANNELS.READ_ATTACHMENT,
    async (_, localPath: string): Promise<string> => {
      return readAttachmentAsBase64(localPath)
    }
  )

  // 另存图片到用户选择的位置（原生 Save As 对话框）
  ipcMain.handle(
    ATTACHMENT_IPC_CHANNELS.SAVE_IMAGE_AS,
    async (event, localPath: string, defaultFilename: string): Promise<boolean> => {
      const { dialog, BrowserWindow } = await import('electron')
      const { writeFileSync } = await import('node:fs')
      const { extname: pathExtname } = await import('node:path')

      const win = BrowserWindow.fromWebContents(event.sender)
      const ext = pathExtname(defaultFilename).replace('.', '').toLowerCase()
      const filterMap: Record<string, string> = { jpg: 'JPEG', jpeg: 'JPEG', png: 'PNG', gif: 'GIF', webp: 'WebP', bmp: 'BMP' }
      const filterName = filterMap[ext] ?? 'Image'

      const result = await dialog.showSaveDialog(win ?? BrowserWindow.getFocusedWindow()!, {
        defaultPath: defaultFilename,
        filters: [
          { name: `${filterName} 图片`, extensions: [ext || 'png'] },
          { name: '所有文件', extensions: ['*'] },
        ],
      })

      if (result.canceled || !result.filePath) return false

      const base64 = readAttachmentAsBase64(localPath)
      writeFileSync(result.filePath, Buffer.from(base64, 'base64'))
      return true
    }
  )

  // 保存应用内置资源文件到用户选择的位置（原生 Save As 对话框）
  ipcMain.handle(
    ATTACHMENT_IPC_CHANNELS.SAVE_RESOURCE_FILE_AS,
    async (event, resourceRelativePath: string, defaultFilename: string): Promise<boolean> => {
      const { dialog, BrowserWindow } = await import('electron')
      const { writeFileSync, readFileSync, existsSync } = await import('node:fs')
      const { join, normalize, sep, extname: pathExtname } = await import('node:path')

      // 解析到应用内置 resources 目录（dev 用 __dirname/resources，prod 用 process.resourcesPath）
      const resourcesDir = normalize(getBundledResourcesDir())
      const fullPath = normalize(join(resourcesDir, resourceRelativePath))

      // 安全校验：防止路径穿越（追加 sep 防止 resources-evil 绕过）
      if (!fullPath.startsWith(resourcesDir + sep)) {
        throw new Error('Path traversal not allowed')
      }
      if (!existsSync(fullPath)) {
        throw new Error(`Resource not found: ${resourceRelativePath}`)
      }

      const win = BrowserWindow.fromWebContents(event.sender)
      const ext = pathExtname(defaultFilename).replace('.', '').toLowerCase()
      const filterMap: Record<string, string> = { jpg: 'JPEG', jpeg: 'JPEG', png: 'PNG', gif: 'GIF', webp: 'WebP' }
      const filterName = filterMap[ext] ?? 'Image'

      const result = await dialog.showSaveDialog(win ?? BrowserWindow.getFocusedWindow()!, {
        defaultPath: defaultFilename,
        filters: [
          { name: `${filterName} 图片`, extensions: [ext || 'png'] },
          { name: '所有文件', extensions: ['*'] },
        ],
      })

      if (result.canceled || !result.filePath) return false

      writeFileSync(result.filePath, readFileSync(fullPath))
      return true
    }
  )

  // 保存 Memory 导出内容；内容已经由 Rust Memory 服务序列化，主进程只负责本地文件对话框。
  ipcMain.handle(
    'memory:save-export',
    async (event, input: import('@copis/shared').MemoryExportFileInput): Promise<boolean> => {
      if (!input || typeof input !== 'object') throw new Error('Memory 导出参数不正确')
      const candidate = input as unknown as { fileName?: unknown; mimeType?: unknown; content?: unknown }
      if (
        typeof candidate.fileName !== 'string'
        || !/^copis-memory-[A-Za-z0-9_-]+\.(json|md)$/.test(candidate.fileName)
        || typeof candidate.content !== 'string'
        || candidate.content.length > 64 * 1024 * 1024
        || (candidate.mimeType !== 'application/json' && candidate.mimeType !== 'text/markdown')
      ) {
        throw new Error('Memory 导出内容不正确')
      }

      const extension = candidate.fileName.endsWith('.json') ? 'json' : 'md'
      const expectedMimeType = extension === 'json' ? 'application/json' : 'text/markdown'
      if (candidate.mimeType !== expectedMimeType) throw new Error('Memory 导出格式不匹配')

      const targetWindow = BrowserWindow.fromWebContents(event.sender)
      const saveOptions = {
        title: '导出 Memory',
        defaultPath: candidate.fileName,
        filters: [
          { name: extension === 'json' ? 'JSON 文件' : 'Markdown 文件', extensions: [extension] },
          { name: '所有文件', extensions: ['*'] },
        ],
      }
      const result = targetWindow
        ? await dialog.showSaveDialog(targetWindow, saveOptions)
        : await dialog.showSaveDialog(saveOptions)
      if (result.canceled || !result.filePath) return false

      writeFileSync(result.filePath, candidate.content, 'utf-8')
      return true
    },
  )

  // 打开文件选择对话框
  ipcMain.handle(
    ATTACHMENT_IPC_CHANNELS.OPEN_FILE_DIALOG,
    async (): Promise<FileDialogResult> => {
      return openFileDialog()
    }
  )
}

export function registerAgentAttachmentsIpcHandlers(): void {
  // ===== Agent 附件 =====

  // 保存文件到 Agent session 工作目录
  ipcMain.handle(
    AGENT_IPC_CHANNELS.SAVE_FILES_TO_SESSION,
    async (_, input: AgentSaveFilesInput): Promise<AgentSavedFile[]> => {
      return saveFilesToAgentSession(input)
    }
  )

  // 保存文件到工作区文件目录
  ipcMain.handle(
    AGENT_IPC_CHANNELS.SAVE_FILES_TO_WORKSPACE,
    async (_, input: AgentSaveWorkspaceFilesInput): Promise<AgentSavedFile[]> => {
      return saveFilesToWorkspaceFiles(input)
    }
  )

  // 获取工作区文件目录路径
  ipcMain.handle(
    AGENT_IPC_CHANNELS.GET_WORKSPACE_FILES_PATH,
    async (_, workspaceSlug: string): Promise<string> => {
      const workspace = getAgentWorkspaceBySlug(workspaceSlug)
      return workspace
        ? getAgentWorkspaceSourceRoot(workspace)
        : getWorkspaceFilesDir(workspaceSlug)
    }
  )

  // 打开文件夹选择对话框
  ipcMain.handle(
    AGENT_IPC_CHANNELS.OPEN_FOLDER_DIALOG,
    async (): Promise<{ path: string; name: string } | null> => {
      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
      if (!win) return null

      const result = await dialog.showOpenDialog(win, {
        properties: ['openDirectory'],
        title: '选择文件夹',
      })

      if (result.canceled || result.filePaths.length === 0) return null

      const folderPath = result.filePaths[0]!
      const name = basename(folderPath) || 'folder'
      return { path: folderPath, name }
    }
  )

  // 打开支持文件与文件夹混合选择的 Composer 对话框
  ipcMain.handle(
    AGENT_IPC_CHANNELS.OPEN_FILE_OR_FOLDER_DIALOG,
    async (): Promise<FileOrFolderDialogResult> => {
      return openFileOrFolderDialog()
    }
  )
}
