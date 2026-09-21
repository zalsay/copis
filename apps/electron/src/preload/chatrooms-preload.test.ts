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
  expect(Object.keys(chatrooms).sort()).toEqual(['listLocalRooms', 'provisionAgent', 'updateAgent', 'removeAgent', 'syncAgentSkills', 'respondPermission', 'onPermissionRequested', 'onLocalConfigChanged'].sort())
  expect(JSON.stringify(chatrooms)).not.toContain('trustedRuntimeContext')
  expect(JSON.stringify(chatrooms)).not.toContain('internalToken')
})
test('Given push listener When unsubscribed Then removeListener receives same wrapper', () => {
  const callback = mock(() => {})
  const unsubscribe = (exposed.value?.chatrooms as any).onPermissionRequested(callback)
  const wrapper = listeners.get(CHATROOM_IPC_CHANNELS.PERMISSION_REQUESTED)
  unsubscribe()
  expect(removeListener).toHaveBeenCalledWith(CHATROOM_IPC_CHANNELS.PERMISSION_REQUESTED, wrapper)
})
