import { expect, mock, test } from 'bun:test'
import { CHATROOM_IPC_CHANNELS, type ChatRoomTransferState } from '@copis/shared'

const handlers = new Map<string, (...args: any[]) => any>()
const handle = mock((channel: string, handler: (...args: any[]) => any) => {
  handlers.set(channel, handler)
})
const mainContents = { isDestroyed: () => false, send: mock(() => {}) }
const mainWindow = { isDestroyed: () => false, webContents: mainContents }
const progressListeners = new Set<(state: ChatRoomTransferState) => void>()
const cosService = {
  selectAndUpload: mock(async () => ({ transferId: 'upload-1', originalName: '报告.pdf', phase: 'ready' as const, attachmentId: 'att-1' })),
  download: mock(async (input: any) => ({ transferId: input.transferId, attachmentId: input.attachmentId, phase: 'ready' as const })),
  cancel: mock(async () => {}),
  onProgress: mock((listener: (state: ChatRoomTransferState) => void) => {
    progressListeners.add(listener)
    return () => progressListeners.delete(listener)
  }),
}

mock.module('electron', () => ({ ipcMain: { handle }, BrowserWindow: class {} }))
mock.module('../index', () => ({ getMainWindow: () => mainWindow }))

const coordinator = {
  listLocalRooms: () => [],
  onPermissionRequested: () => () => {},
  onLocalConfigChanged: () => () => {},
}
const module = await import('./chatrooms.ipc')
module.registerChatRoomIpcHandlers({
  getCoordinator: () => coordinator as any,
  getMainWindow: () => mainWindow as any,
  getCosService: () => cosService as any,
  resolveAgentInboxPath: (roomId, roomAgentId, attachmentId) => `/trusted/${roomId}/${roomAgentId}/${attachmentId}`,
})

const sender = { sender: mainContents }

test('Given 主窗口 When 上传请求只含传输标识 Then 只委托 Main 服务且结果不返回路径或授权字段', async () => {
  const result = await handlers.get(CHATROOM_IPC_CHANNELS.SELECT_AND_UPLOAD)!(sender, { transferId: 'upload-1', roomId: 'room-1' })
  expect(cosService.selectAndUpload).toHaveBeenCalledWith({ transferId: 'upload-1', roomId: 'room-1' })
  expect(result).toEqual({ transferId: 'upload-1', originalName: '报告.pdf', phase: 'ready', attachmentId: 'att-1' })
  expect(JSON.stringify(result)).not.toMatch(/filePath|objectKey|tmpSecret|sts|token/i)
})

test('Given 下载到指定 Agent When request includes roomAgentId Then Main service receives the exact bound target', async () => {
  await handlers.get(CHATROOM_IPC_CHANNELS.START_DOWNLOAD)!(sender, {
    transferId: 'download-1', roomId: 'room-1', attachmentId: 'att-1', target: 'agent_inbox', roomAgentId: 'agent-2',
  })
  expect(cosService.download).toHaveBeenCalledWith({
    transferId: 'download-1', roomId: 'room-1', attachmentId: 'att-1', target: 'agent_inbox', roomAgentId: 'agent-2',
  })
})

test('Given user target When request supplies roomAgentId or unknown fields Then Main rejects before service', async () => {
  await expect(handlers.get(CHATROOM_IPC_CHANNELS.START_DOWNLOAD)!(sender, {
    transferId: 'download-2', roomId: 'room-1', attachmentId: 'att-1', target: 'user', roomAgentId: 'agent-2',
  })).rejects.toThrow('参数不正确')
  await expect(handlers.get(CHATROOM_IPC_CHANNELS.START_DOWNLOAD)!(sender, {
    transferId: 'download-3', roomId: 'room-1', attachmentId: 'att-1', target: 'agent_inbox', roomAgentId: 'agent-2', path: '/escape',
  })).rejects.toThrow('参数不正确')
  expect(cosService.download).toHaveBeenCalledTimes(1)
})

test('Given 非主窗口或空标识 When invoke transfer IPC Then request is rejected', async () => {
  await expect(handlers.get(CHATROOM_IPC_CHANNELS.SELECT_AND_UPLOAD)!({ sender: {} }, { transferId: 'upload-1', roomId: 'room-1' })).rejects.toThrow('不允许的请求来源')
  await expect(handlers.get(CHATROOM_IPC_CHANNELS.SELECT_AND_UPLOAD)!(sender, { transferId: '', roomId: 'room-1' })).rejects.toThrow('参数不正确')
  await expect(handlers.get(CHATROOM_IPC_CHANNELS.CANCEL_TRANSFER)!(sender, '')).rejects.toThrow('参数不正确')
})

test('Given COS service progress When IPC forwards Then only the strict transfer state reaches main window and unsubscribe detaches', () => {
  const listener = progressListeners.values().next().value as ((state: ChatRoomTransferState) => void) | undefined
  expect(listener).toBeFunction()
  const state = {
    transferId: 'upload-1', roomId: 'room-1', phase: 'uploading', progress: 0.5,
    originalName: '报告.pdf', filePath: '/private/file', objectKey: 'private/key', tmpSecretKey: 'secret',
  }
  listener?.(state as any)
  expect(mainContents.send).toHaveBeenCalledWith(CHATROOM_IPC_CHANNELS.TRANSFER_PROGRESS, {
    transferId: 'upload-1', roomId: 'room-1', phase: 'uploading', progress: 0.5, originalName: '报告.pdf',
  })
})
