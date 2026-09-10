import { ipcMain } from 'electron'
import {
  WEB_IPC_CHANNELS,
  type CreateWebBookmarkGroupInput,
  type OpenWebBookmarksWindowInput,
  type RenameWebBookmarkGroupInput,
  type ResizeWebBookmarksWindowInput,
  type SaveWebBookmarkInput,
} from '@copis/shared'
import {
  closeWebBookmarksWindow,
  openWebBookmarksWindow,
  resizeWebBookmarksWindow,
} from '../lib/web-tab-manager'
import {
  createWebBookmarkGroup,
  getWebBookmarks,
  removeWebBookmark,
  removeWebBookmarkGroup,
  renameWebBookmarkGroup,
  saveWebBookmark,
} from '../lib/web-bookmark-service'

export function registerWebBookmarksWindowIpcHandlers(): void {
  ipcMain.handle(WEB_IPC_CHANNELS.BOOKMARKS_WINDOW_OPEN, (_event, input: OpenWebBookmarksWindowInput) => {
    if (!input || typeof input !== 'object' || !input.bounds || typeof input.bounds !== 'object') {
      throw new Error('收藏夹窗口参数不正确')
    }
    openWebBookmarksWindow(input)
  })
  ipcMain.handle(WEB_IPC_CHANNELS.BOOKMARKS_WINDOW_CLOSE, () => closeWebBookmarksWindow())
  ipcMain.handle(WEB_IPC_CHANNELS.BOOKMARKS_WINDOW_RESIZE, (_event, input: ResizeWebBookmarksWindowInput) => {
    if (!input || typeof input !== 'object') throw new Error('收藏夹窗口尺寸参数不正确')
    resizeWebBookmarksWindow(input)
  })
}

export function registerWebBookmarksStoreIpcHandlers(): void {
  ipcMain.handle(WEB_IPC_CHANNELS.BOOKMARKS_LIST, () => getWebBookmarks())
  ipcMain.handle(WEB_IPC_CHANNELS.BOOKMARKS_SAVE, (_event, input: SaveWebBookmarkInput) => {
    if (!input || typeof input !== 'object' || typeof input.title !== 'string' || typeof input.url !== 'string') {
      throw new Error('网页收藏参数不正确')
    }
    if (input.groupId !== undefined && input.groupId !== null && typeof input.groupId !== 'string') {
      throw new Error('网页收藏分组参数不正确')
    }
    if (input.faviconUrl !== undefined && input.faviconUrl !== null && typeof input.faviconUrl !== 'string') {
      throw new Error('网页收藏图标参数不正确')
    }
    return saveWebBookmark(input)
  })
  ipcMain.handle(WEB_IPC_CHANNELS.BOOKMARKS_REMOVE, (_event, bookmarkId: string) => {
    if (typeof bookmarkId !== 'string' || !bookmarkId.trim()) {
      throw new Error('网页收藏 ID 不正确')
    }
    return removeWebBookmark(bookmarkId)
  })
  ipcMain.handle(WEB_IPC_CHANNELS.BOOKMARK_GROUP_CREATE, (_event, input: CreateWebBookmarkGroupInput) => {
    if (!input || typeof input !== 'object' || typeof input.name !== 'string') {
      throw new Error('网页收藏分组参数不正确')
    }
    return createWebBookmarkGroup(input)
  })
  ipcMain.handle(WEB_IPC_CHANNELS.BOOKMARK_GROUP_RENAME, (_event, input: RenameWebBookmarkGroupInput) => {
    if (!input || typeof input !== 'object' || typeof input.groupId !== 'string' || typeof input.name !== 'string') {
      throw new Error('网页收藏分组参数不正确')
    }
    return renameWebBookmarkGroup(input)
  })
  ipcMain.handle(WEB_IPC_CHANNELS.BOOKMARK_GROUP_REMOVE, (_event, groupId: string) => {
    if (typeof groupId !== 'string' || !groupId.trim()) {
      throw new Error('网页收藏分组 ID 不正确')
    }
    return removeWebBookmarkGroup(groupId)
  })
}

export function registerWebBookmarksIpcHandlers(): void {
  registerWebBookmarksWindowIpcHandlers()
  registerWebBookmarksStoreIpcHandlers()
}
