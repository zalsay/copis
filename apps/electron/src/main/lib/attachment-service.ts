/**
 * 附件存储服务（Electron IPC / UI 层）
 *
 * 负责文件附件的本地存储、读取和删除，并提供基于 Electron dialog 的文件选择弹窗。
 * 纯文件系统存储操作已委托给 attachment-storage.ts。
 */

import { dialog, BrowserWindow } from 'electron'
import type {
  FileDialogResult,
  FileDialogDirectory,
  FileOrFolderDialogResult,
} from '@copis/shared'
import {
  FILE_FILTERS,
  readDialogFiles,
} from './attachment-storage'

// 重新导出所有纯存储操作与常量，保持向后兼容
export * from './attachment-storage'

/**
 * 打开文件选择对话框
 *
 * 弹出 Electron 文件选择对话框，支持多选，
 * 读取选中的小文件并返回 base64 编码数据；超过内存导入上限的大文件仅返回路径。
 *
 * @returns 选中的文件列表
 */
export async function openFileDialog(): Promise<FileDialogResult> {
  // macOS 上必须传入父窗口，否则对话框可能出现在应用窗口后面
  const parentWindow = BrowserWindow.getFocusedWindow()
  const dialogOptions: Electron.OpenDialogOptions = {
    properties: ['openFile', 'multiSelections'],
    filters: FILE_FILTERS,
  }

  const result = parentWindow
    ? await dialog.showOpenDialog(parentWindow, dialogOptions)
    : await dialog.showOpenDialog(dialogOptions)

  if (result.canceled || result.filePaths.length === 0) {
    return { files: [] }
  }

  const fileResult = readDialogFiles(result.filePaths)
  console.log(`[附件服务] 文件对话框选择了 ${fileResult.files.length} 个内存附件，${fileResult.largeFiles?.length ?? 0} 个大文件引用，${fileResult.skippedFiles?.length ?? 0} 个跳过`)
  return fileResult
}

/**
 * 打开 Agent Composer 的混合选择对话框。
 * 文件按附件语义读取，文件夹只返回路径，交由会话目录授权流程处理。
 */
export async function openFileOrFolderDialog(): Promise<FileOrFolderDialogResult> {
  const parentWindow = BrowserWindow.getFocusedWindow()
  let dialogOptions: Electron.OpenDialogOptions

  if (process.platform === 'win32' || process.platform === 'linux') {
    const choiceOptions: Electron.MessageBoxOptions = {
      type: 'question',
      title: '附加文件或文件夹',
      message: '请选择要附加的内容类型',
      buttons: ['文件', '文件夹', '取消'],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    }
    const choice = parentWindow
      ? await dialog.showMessageBox(parentWindow, choiceOptions)
      : await dialog.showMessageBox(choiceOptions)
    if (choice.response === 2) return { files: [], directories: [] }

    dialogOptions = choice.response === 0
      ? { properties: ['openFile', 'multiSelections'], filters: FILE_FILTERS, title: '附加文件' }
      : { properties: ['openDirectory', 'multiSelections'], title: '附加文件夹' }
  } else {
    dialogOptions = {
      properties: ['openFile', 'openDirectory', 'multiSelections'],
      title: '附加文件或文件夹',
    }
  }

  const result = parentWindow
    ? await dialog.showOpenDialog(parentWindow, dialogOptions)
    : await dialog.showOpenDialog(dialogOptions)

  if (result.canceled || result.filePaths.length === 0) {
    return { files: [], directories: [] }
  }

  const directories: FileDialogDirectory[] = []
  const fileResult = readDialogFiles(result.filePaths, directories)
  console.log(`[附件服务] 混合对话框选择了 ${fileResult.files.length} 个内存附件，${fileResult.largeFiles?.length ?? 0} 个大文件引用，${directories.length} 个目录，${fileResult.skippedFiles?.length ?? 0} 个跳过`)
  return { ...fileResult, directories }
}
