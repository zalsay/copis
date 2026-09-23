import { expect, mock, test } from 'bun:test'
import { CHATROOM_IPC_CHANNELS } from '@copis/shared'
const exposed: { value?: Record<string, unknown> } = {}
const listeners = new Map<string, (...args: unknown[]) => void>()
const removeListener = mock((_channel: string, _listener: unknown) => {})
const ipcRenderer = { invoke: mock(async () => undefined), on: mock((channel: string, listener: (...args: unknown[]) => void) => { listeners.set(channel, listener) }), removeListener }
mock.module('electron', () => ({ contextBridge: { exposeInMainWorld: (_name: string, api: Record<string, unknown>) => { exposed.value = api } }, ipcRenderer, webUtils: { getPathForFile: () => '' } }))
mock.module('../renderer/lib/agent-http-stream', () => ({ agentHttpStreamClient: { setBaseUrl: () => {} } }))
mock.module('../renderer/lib/http-api-web-token', () => ({ setHttpApiWebToken: () => {} }))
await import('./index')
test('Given preload 初始化 When 暴露 chatrooms Then exact API keys and no sensitive fields', () => {
  const chatrooms = exposed.value?.chatrooms as Record<string, unknown>
  expect(Object.keys(chatrooms).sort()).toEqual(['listLocalRooms', 'provisionAgent', 'updateAgent', 'removeAgent', 'syncAgentSkills', 'respondPermission', 'onPermissionRequested', 'onLocalConfigChanged', 'startUpload', 'startDownload', 'cancelTransfer', 'onTransferProgress'].sort())
  expect(JSON.stringify(chatrooms)).not.toContain('trustedRuntimeContext')
  expect(JSON.stringify(chatrooms)).not.toContain('internalToken')
})

test('Given preload transfer methods When called Then they invoke only the fixed IPC channels and progress listener can be removed', async () => {
  const chatrooms = exposed.value?.chatrooms as any
  await chatrooms.startUpload({ transferId: 't-1', roomId: 'r-1' })
  await chatrooms.startDownload({ transferId: 't-2', roomId: 'r-1', attachmentId: 'a-1', target: 'agent_inbox', roomAgentId: 'agent-1' })
  await chatrooms.cancelTransfer('t-1')
  expect(ipcRenderer.invoke).toHaveBeenCalledWith(CHATROOM_IPC_CHANNELS.SELECT_AND_UPLOAD, { transferId: 't-1', roomId: 'r-1' })
  expect(ipcRenderer.invoke).toHaveBeenCalledWith(CHATROOM_IPC_CHANNELS.START_DOWNLOAD, { transferId: 't-2', roomId: 'r-1', attachmentId: 'a-1', target: 'agent_inbox', roomAgentId: 'agent-1' })
  expect(ipcRenderer.invoke).toHaveBeenCalledWith(CHATROOM_IPC_CHANNELS.CANCEL_TRANSFER, 't-1')
  const callback = mock(() => {})
  const unsubscribe = chatrooms.onTransferProgress(callback)
  const wrapper = listeners.get(CHATROOM_IPC_CHANNELS.TRANSFER_PROGRESS)
  unsubscribe()
  expect(removeListener).toHaveBeenCalledWith(CHATROOM_IPC_CHANNELS.TRANSFER_PROGRESS, wrapper)
})
test('Given push listener When unsubscribed Then removeListener receives same wrapper', () => {
  const callback = mock(() => {})
  const unsubscribe = (exposed.value?.chatrooms as any).onPermissionRequested(callback)
  const wrapper = listeners.get(CHATROOM_IPC_CHANNELS.PERMISSION_REQUESTED)
  unsubscribe()
  expect(removeListener).toHaveBeenCalledWith(CHATROOM_IPC_CHANNELS.PERMISSION_REQUESTED, wrapper)
})
