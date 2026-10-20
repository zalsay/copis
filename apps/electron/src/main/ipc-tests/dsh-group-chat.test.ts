import { beforeEach, expect, mock, test } from 'bun:test'
import { DSH_GROUP_CHAT_IPC_CHANNELS } from '@copis/shared'
import { createIpcHarness } from './t2-harness'

const h = createIpcHarness()
const liveSend = mock((_channel: string, _payload: unknown) => {})

mock.module('electron', () => ({
  ipcMain: h.ipcMain,
  BrowserWindow: {
    getAllWindows: () => [
      { isDestroyed: () => false, webContents: { send: liveSend } },
      { isDestroyed: () => true, webContents: { send: mock(() => {}) } },
    ],
  },
}))

test('dsh-group-chat IPC handlers should register all DSH_GROUP_CHAT_IPC_CHANNELS correctly', async () => {
  const { registerDshGroupChatIpcHandlers } = await import('../ipc/dsh-group-chat.ipc')
  registerDshGroupChatIpcHandlers()

  const expectedChannels = [
    DSH_GROUP_CHAT_IPC_CHANNELS.LIST_CREATION_WORKSPACES,
    DSH_GROUP_CHAT_IPC_CHANNELS.LIST_GROUPS,
    DSH_GROUP_CHAT_IPC_CHANNELS.GET_GROUP,
    DSH_GROUP_CHAT_IPC_CHANNELS.CREATE_GROUP,
    DSH_GROUP_CHAT_IPC_CHANNELS.UPDATE_GROUP,
    DSH_GROUP_CHAT_IPC_CHANNELS.DELETE_GROUP,
    DSH_GROUP_CHAT_IPC_CHANNELS.ADD_AGENT,
    DSH_GROUP_CHAT_IPC_CHANNELS.REMOVE_AGENT,
    DSH_GROUP_CHAT_IPC_CHANNELS.UPDATE_AGENT_RESPONSIBILITY,
    DSH_GROUP_CHAT_IPC_CHANNELS.GET_MESSAGES,
    DSH_GROUP_CHAT_IPC_CHANNELS.POST_MESSAGE,
    DSH_GROUP_CHAT_IPC_CHANNELS.MARK_READ,
    DSH_GROUP_CHAT_IPC_CHANNELS.GET_TASKS,
    DSH_GROUP_CHAT_IPC_CHANNELS.CREATE_TASK,
    DSH_GROUP_CHAT_IPC_CHANNELS.UPDATE_TASK,
    DSH_GROUP_CHAT_IPC_CHANNELS.DECOMPOSE_TASKS,
    DSH_GROUP_CHAT_IPC_CHANNELS.ARCHIVE_TASK,
    DSH_GROUP_CHAT_IPC_CHANNELS.GET_INVOCATION,
    DSH_GROUP_CHAT_IPC_CHANNELS.STOP_INVOCATION,
  ]

  const registeredChannels = new Set(h.ipcMain.handle.mock.calls.map((call) => call[0]))

  for (const channel of expectedChannels) {
    expect(registeredChannels.has(channel)).toBeTrue()
  }

  // 模拟调用 CREATE_GROUP
  const createdGroup: any = await h.invoke(DSH_GROUP_CHAT_IPC_CHANNELS.CREATE_GROUP, {}, {
    name: 'IPC 测试组',
    description: '通过 IPC 创建的群组',
  })
  expect(createdGroup.id).toStartWith('grp_')
  expect(createdGroup.name).toBe('IPC 测试组')

  // 模拟调用 LIST_GROUPS
  const groups: any = await h.invoke(DSH_GROUP_CHAT_IPC_CHANNELS.LIST_GROUPS, {})
  expect(groups.length).toBeGreaterThan(0)
  expect(groups.some((g: any) => g.id === createdGroup.id)).toBeTrue()

  // 模拟调用 POST_MESSAGE
  const msg: any = await h.invoke(DSH_GROUP_CHAT_IPC_CHANNELS.POST_MESSAGE, {}, {
    groupId: createdGroup.id,
    text: '通过 IPC 发送的消息',
  })
  expect(msg.seq).toBe(1)
  expect(msg.text).toBe('通过 IPC 发送的消息')

  // 模拟调用 GET_TASKS（创建群后初始化版本自增为 2）
  const taskBoard: any = await h.invoke(DSH_GROUP_CHAT_IPC_CHANNELS.GET_TASKS, {}, createdGroup.id)
  expect(taskBoard.revision).toBe(2)

  // 模拟调用 LIST_CREATION_WORKSPACES
  const workspaces: any = await h.invoke(DSH_GROUP_CHAT_IPC_CHANNELS.LIST_CREATION_WORKSPACES, {})
  expect(Array.isArray(workspaces)).toBeTrue()
  expect(workspaces.length).toBeGreaterThan(0)
})
