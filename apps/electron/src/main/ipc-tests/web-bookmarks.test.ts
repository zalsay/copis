import { expect, mock, test } from 'bun:test'
import { WEB_IPC_CHANNELS } from '@copis/shared'

const handle = mock(() => {})
const openWebBookmarksWindow = mock(() => undefined)
const saveWebBookmark = mock((input: unknown) => input)
const removeWebBookmarkGroup = mock((groupId: string) => groupId)

mock.module('electron', () => ({ ipcMain: { handle } }))
mock.module('../lib/web-tab-manager', () => ({
  closeWebBookmarksWindow: mock(() => undefined),
  openWebBookmarksWindow,
  resizeWebBookmarksWindow: mock(() => undefined),
}))
mock.module('../lib/web-bookmark-service', () => ({
  createWebBookmarkGroup: mock(() => undefined),
  getWebBookmarks: mock(() => []),
  removeWebBookmark: mock(() => undefined),
  removeWebBookmarkGroup,
  renameWebBookmarkGroup: mock(() => undefined),
  saveWebBookmark,
}))

type IpcHandler = (...args: unknown[]) => unknown

function registeredHandler(channel: string): IpcHandler {
  const registrations = handle.mock.calls as unknown as Array<[unknown, unknown]>
  const registration = registrations.find(([registeredChannel]) => registeredChannel === channel)
  expect(registration).toBeDefined()
  return registration?.[1] as IpcHandler
}

test('收藏夹窗口打开拒绝缺失 bounds 的输入', async () => {
  const { registerWebBookmarksIpcHandlers } = await import('../ipc/web-bookmarks.ipc')
  registerWebBookmarksIpcHandlers()

  expect(() => registeredHandler(WEB_IPC_CHANNELS.BOOKMARKS_WINDOW_OPEN)({}, {})).toThrow('收藏夹窗口参数不正确')
  const input = { bounds: { x: 1, y: 2, width: 3, height: 4 } }
  expect(await registeredHandler(WEB_IPC_CHANNELS.BOOKMARKS_WINDOW_OPEN)({}, input)).toBeUndefined()
  expect(openWebBookmarksWindow).toHaveBeenCalledWith(input)
})

test('保存收藏保留原有输入校验和服务参数', async () => {
  const { registerWebBookmarksIpcHandlers } = await import('../ipc/web-bookmarks.ipc')
  registerWebBookmarksIpcHandlers()

  expect(() => registeredHandler(WEB_IPC_CHANNELS.BOOKMARKS_SAVE)({}, { title: 'Copis' })).toThrow('网页收藏参数不正确')
  const input = { title: 'Copis', url: 'https://copis.example', groupId: 'group-1' }
  expect(await registeredHandler(WEB_IPC_CHANNELS.BOOKMARKS_SAVE)({}, input)).toEqual(input)
  expect(saveWebBookmark).toHaveBeenCalledWith(input)
})

test('移除收藏分组拒绝空 ID 并透传有效 ID', async () => {
  const { registerWebBookmarksIpcHandlers } = await import('../ipc/web-bookmarks.ipc')
  registerWebBookmarksIpcHandlers()

  expect(() => registeredHandler(WEB_IPC_CHANNELS.BOOKMARK_GROUP_REMOVE)({}, '  ')).toThrow('网页收藏分组 ID 不正确')
  expect(await registeredHandler(WEB_IPC_CHANNELS.BOOKMARK_GROUP_REMOVE)({}, 'group-1')).toBe('group-1')
  expect(removeWebBookmarkGroup).toHaveBeenCalledWith('group-1')
})
