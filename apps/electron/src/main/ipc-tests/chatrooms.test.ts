import { expect, mock, test } from 'bun:test'
import { CHATROOM_IPC_CHANNELS } from '@copis/shared'
const handlers = new Map<string, (...args: any[]) => any>()
const handle = mock((channel: string, fn: (...args: any[]) => any) => { handlers.set(channel, fn) })
const mainContents = {}
mock.module('electron', () => ({ ipcMain: { handle }, BrowserWindow: class {} }))
mock.module('../index', () => ({ getMainWindow: () => ({ isDestroyed: () => false, webContents: mainContents }) }))
const coordinator = {
  listLocalRooms: () => [{ roomId: 'room-1', updatedAt: 1, hostUserId: 'hidden', deviceId: 'hidden', agents: [{ roomAgentId: 'a', displayName: 'A', sourceWorkspaceId: 'w', sessionId: 'secret-session', channelId: 'c', contextMessageCount: 50, memorySharingEnabled: false, skillSharingEnabled: false }], invocations: [], lastProcessedSeq: 0, createdAt: 1 }],
  provisionAgent: mock(async (input: any) => ({ ...input, roomAgentId: 'a', sessionId: 'secret-session', contextMessageCount: 50, memorySharingEnabled: false, skillSharingEnabled: false })),
  updateAgent: mock(async () => ({ roomAgentId: 'a', displayName: 'A', sourceWorkspaceId: 'w', sessionId: 'secret-session', channelId: 'c', contextMessageCount: 50, memorySharingEnabled: false, skillSharingEnabled: false })),
  removeAgent: mock(async () => {}), syncAgentSkills: mock(async () => ({ roomAgentId: 'a', displayName: 'A', sourceWorkspaceId: 'w', sessionId: 'secret-session', channelId: 'c', contextMessageCount: 50, memorySharingEnabled: false, skillSharingEnabled: false })), respondToPermission: mock(async () => {}),
  onPermissionRequested: () => () => {}, onLocalConfigChanged: () => () => {}, handleInvocation: async () => 'accepted' as const, handleGatewayDisconnected: async () => {}, stopAll: async () => ({ stoppedSessionIds: [], releasedRoomAgentIds: [] }), dispose: async () => {},
}
const module = await import('../ipc/chatrooms.ipc')
module.registerChatRoomIpcHandlers({ getCoordinator: () => coordinator as any, getMainWindow: () => ({ isDestroyed: () => false, webContents: mainContents } as any) })
test('Given 主窗口 provision When handler executes Then returns redacted view', async () => {
  const result = await handlers.get(CHATROOM_IPC_CHANNELS.PROVISION_AGENT)!({ sender: mainContents }, { roomId: 'room-1', sourceWorkspaceId: 'w', displayName: 'A', channelId: 'c' })
  expect(result.sessionId).toBeUndefined(); expect(result.roomAgentId).toBe('a')
})
test('Given non-main sender or strict DTO When mutate Then reject', async () => {
  await expect(handlers.get(CHATROOM_IPC_CHANNELS.PROVISION_AGENT)!({ sender: {} }, { roomId: 'room-1', sourceWorkspaceId: 'w', displayName: 'A', channelId: 'c' })).rejects.toThrow('不允许的请求来源')
  await expect(handlers.get(CHATROOM_IPC_CHANNELS.RESPOND_PERMISSION)!({ sender: mainContents }, { requestId: 'x', behavior: 'allow', [Symbol('x')]: 1 })).rejects.toThrow('权限响应参数不正确')
})
