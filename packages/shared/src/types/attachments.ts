/** Agent、视觉助手和通用文件选择共用的附件类型。 */

export const MAX_ATTACHMENT_SIZE = 100 * 1024 * 1024

export interface FileAttachment {
  id: string
  filename: string
  mediaType: string
  localPath: string
  size: number
}

export interface AttachmentSaveInput {
  conversationId: string
  filename: string
  mediaType: string
  data: string
}

export interface AttachmentSaveResult {
  attachment: FileAttachment
}

export interface FileDialogFile {
  filename: string
  mediaType: string
  data: string
  size: number
}

export interface FileDialogLargeFile {
  filename: string
  mediaType: string
  size: number
  path: string
}

export interface FileDialogSkippedFile {
  filename: string
  mediaType?: string
  size?: number
  path?: string
  reason: 'unreadable'
  message?: string
}

export interface FileDialogDirectory {
  name: string
  path: string
}

export interface FileDialogResult {
  files: FileDialogFile[]
  largeFiles?: FileDialogLargeFile[]
  skippedFiles?: FileDialogSkippedFile[]
}

export interface FileOrFolderDialogResult extends FileDialogResult {
  directories: FileDialogDirectory[]
}

/** Agent、视觉助手和通用文件操作共用的 IPC 通道。 */
export const ATTACHMENT_IPC_CHANNELS = {
  /** 保存附件到本地。 */
  SAVE_ATTACHMENT: 'attachment:save',
  /** 读取附件并返回 base64。 */
  READ_ATTACHMENT: 'attachment:read',
  /** 另存图片到用户选择的位置。 */
  SAVE_IMAGE_AS: 'attachment:save-image-as',
  /** 保存应用内置资源文件到用户选择的位置。 */
  SAVE_RESOURCE_FILE_AS: 'attachment:save-resource-file-as',
  /** 删除附件。 */
  DELETE_ATTACHMENT: 'attachment:delete',
  /** 打开文件选择对话框。 */
  OPEN_FILE_DIALOG: 'attachment:open-file-dialog',
  /** 提取附件文档文本。 */
  EXTRACT_ATTACHMENT_TEXT: 'attachment:extract-text',
} as const

export type AttachmentIpcChannel = (typeof ATTACHMENT_IPC_CHANNELS)[keyof typeof ATTACHMENT_IPC_CHANNELS]
