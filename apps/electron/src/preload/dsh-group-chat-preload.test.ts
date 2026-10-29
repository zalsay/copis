import { expect, mock, test } from 'bun:test'
import { DSH_GROUP_CHAT_IPC_CHANNELS } from '@copis/shared'

const exposed: { value?: Record<string, unknown> } = {}
const listeners = new Map<string, (...args: unknown[]) => void>()
const removeListener = mock((_channel: string, _listener: unknown) => {})
const ipcRenderer = {
  invoke: mock(async () => undefined),
  on: mock((channel: string, listener: (...args: unknown[]) => void) => {
    listeners.set(channel, listener)
  }),
  removeListener,
}

mock.module('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (_name: string, api: Record<string, unknown>) => {
      exposed.value = api
    },
  },
  ipcRenderer,
  ipcMain: { handle: () => {}, on: () => {} },
  BrowserWindow: { getAllWindows: () => [] },
  webUtils: { getPathForFile: () => '' },
}))
mock.module('../renderer/lib/agent-http-stream', () => ({ agentHttpStreamClient: { setBaseUrl: () => {} } }))
mock.module('../renderer/lib/http-api-web-token', () => ({ setHttpApiWebToken: () => {} }))

await import('./index')

test('Given preload 初始化 When 暴露 dshGroupChat Then 具备完整的类型安全 API 方法', () => {
  const dshGroupChat = exposed.value?.dshGroupChat as Record<string, unknown>
  expect(dshGroupChat).toBeDefined()
  const expectedMethods = [
    'listCreationWorkspaces',
    'listGroups',
    'getGroup',
    'createGroup',
    'updateGroup',
    'deleteGroup',
    'addAgent',
    'removeAgent',
    'updateAgentResponsibility',
    'updateAgentModel',
    'getAvailableModels',
    'getMessages',
    'postMessage',
    'markRead',
    'getTasks',
    'createTask',
    'updateTask',
    'decomposeTasks',
    'archiveTask',
    'getInvocation',
    'onEventStream',
  ]

  for (const method of expectedMethods) {
    expect(typeof dshGroupChat[method]).toBe('function')
  }
})

test('Given dshGroupChat 调用方法 When invoked Then 触发正确的 IPC 通道', async () => {
  const dshGroupChat = exposed.value?.dshGroupChat as any

  await dshGroupChat.listCreationWorkspaces()
  expect(ipcRenderer.invoke).toHaveBeenCalledWith(DSH_GROUP_CHAT_IPC_CHANNELS.LIST_CREATION_WORKSPACES)

  await dshGroupChat.createGroup({ name: '测试群' })
  expect(ipcRenderer.invoke).toHaveBeenCalledWith(DSH_GROUP_CHAT_IPC_CHANNELS.CREATE_GROUP, { name: '测试群' })

  await dshGroupChat.postMessage({ groupId: 'grp_1', text: 'Hello' })
  expect(ipcRenderer.invoke).toHaveBeenCalledWith(DSH_GROUP_CHAT_IPC_CHANNELS.POST_MESSAGE, { groupId: 'grp_1', text: 'Hello' })

  await dshGroupChat.getTasks('grp_1')
  expect(ipcRenderer.invoke).toHaveBeenCalledWith(DSH_GROUP_CHAT_IPC_CHANNELS.GET_TASKS, 'grp_1')

  const callback = mock(() => {})
  const unsubscribe = dshGroupChat.onEventStream(callback)
  const wrapper = listeners.get(DSH_GROUP_CHAT_IPC_CHANNELS.EVENT_STREAM)
  unsubscribe()
  expect(removeListener).toHaveBeenCalledWith(DSH_GROUP_CHAT_IPC_CHANNELS.EVENT_STREAM, wrapper)
})
