import { expect, mock, test } from 'bun:test'
import { CHATROOM_IPC_CHANNELS } from '@copis/shared'
const handlers = new Map<string, (...args: any[]) => any>()
const handle = mock((channel: string, fn: (...args: any[]) => any) => { handlers.set(channel, fn) })
const mainContents = { isDestroyed: () => false, send: mock(() => {}) }
mock.module('electron', () => ({ ipcMain: { handle }, BrowserWindow: class {} }))
mock.module('../index', () => ({ getMainWindow: () => ({ isDestroyed: () => false, webContents: mainContents }) }))
const coordinator = {
  listLocalRooms: () => [{ roomId: 'room-1', updatedAt: 1, hostUserId: 'hidden', deviceId: 'hidden', agents: [{ roomAgentId: 'a', displayName: 'A', sourceWorkspaceId: 'w', sessionId: 'secret-session', channelId: 'c', contextMessageCount: 50, memorySharingEnabled: false, skillSharingEnabled: false }], invocations: [], lastProcessedSeq: 0, createdAt: 1 }],
  provisionAgent: mock(async (input: any) => ({ ...input, roomAgentId: 'a', sessionId: 'secret-session', contextMessageCount: 50, memorySharingEnabled: false, skillSharingEnabled: false })),
  updateAgent: mock(async () => ({ roomAgentId: 'a', displayName: 'A', sourceWorkspaceId: 'w', sessionId: 'secret-session', channelId: 'c', contextMessageCount: 50, memorySharingEnabled: false, skillSharingEnabled: false })),
  removeAgent: mock(async () => {}), syncAgentSkills: mock(async () => ({ roomAgentId: 'a', displayName: 'A', sourceWorkspaceId: 'w', sessionId: 'secret-session', channelId: 'c', contextMessageCount: 50, memorySharingEnabled: false, skillSharingEnabled: false })), respondToPermission: mock(async () => {}),
  permissionListeners: [] as Array<(value: any) => void>, configListeners: [] as Array<(value: any) => void>,
  onPermissionRequested: (listener: (value: any) => void) => { coordinator.permissionListeners.push(listener); return () => { coordinator.permissionListeners = coordinator.permissionListeners.filter((item) => item !== listener) } }, onLocalConfigChanged: (listener: (value: any) => void) => { coordinator.configListeners.push(listener); return () => { coordinator.configListeners = coordinator.configListeners.filter((item) => item !== listener) } }, handleInvocation: async () => 'accepted' as const, handleGatewayDisconnected: async () => {}, stopAll: async () => ({ stoppedSessionIds: [], releasedRoomAgentIds: [] }), dispose: async () => {},
}
const module = await import('../ipc/chatrooms.ipc')
const coordinatorModule = await import('../lib/chatroom-agent-coordinator')
module.registerChatRoomIpcHandlers({ getCoordinator: () => coordinator as any, getMainWindow: () => ({ isDestroyed: () => false, webContents: mainContents } as any) })
coordinatorModule.registerChatRoomAgentCoordinator(coordinator as any)
test('Given 主窗口 When each management handler executes Then DTO reaches coordinator and views are redacted', async () => {
  const sender = { sender: mainContents }
  const list = await handlers.get(CHATROOM_IPC_CHANNELS.LIST_LOCAL_ROOMS)!(sender)
  expect(JSON.stringify(list)).not.toContain('hostUserId'); expect(JSON.stringify(list)).not.toContain('sessionId')
  const result = await handlers.get(CHATROOM_IPC_CHANNELS.PROVISION_AGENT)!({ sender: mainContents }, { roomId: 'room-1', sourceWorkspaceId: 'w', displayName: 'A', channelId: 'c' })
  expect(result.sessionId).toBeUndefined(); expect(result.roomAgentId).toBe('a')
  await handlers.get(CHATROOM_IPC_CHANNELS.UPDATE_AGENT)!(sender, { roomId: 'room-1', roomAgentId: 'a', displayName: 'A2' })
  await handlers.get(CHATROOM_IPC_CHANNELS.REMOVE_AGENT)!(sender, { roomId: 'room-1', roomAgentId: 'a' })
  await handlers.get(CHATROOM_IPC_CHANNELS.SYNC_AGENT_SKILLS)!(sender, { roomId: 'room-1', roomAgentId: 'a' })
  await handlers.get(CHATROOM_IPC_CHANNELS.RESPOND_PERMISSION)!(sender, { requestId: 'request-1', behavior: 'allow' })
  expect(coordinator.provisionAgent).toHaveBeenCalled(); expect(coordinator.updateAgent).toHaveBeenCalled(); expect(coordinator.removeAgent).toHaveBeenCalled(); expect(coordinator.syncAgentSkills).toHaveBeenCalled(); expect(coordinator.respondToPermission).toHaveBeenCalled()
})

test('Given coordinator push callbacks When emitting permission/config Then each payload is redacted and delivered once', () => {
  const send = mock(() => {})
  mainContents.send = send
  const permission = { requestId: 'p', toolName: 'Bash', summary: 'run', roomId: 'r', roomAgentId: 'a', invocationId: 'i', traceId: 't', originalSender: { type: 'user', id: 'u', displayName: 'u' }, invocationChain: [], createdAt: 1, expiresAt: 2 }
  coordinator.permissionListeners.forEach((listener) => listener(permission))
  coordinator.configListeners.forEach((listener) => listener({ roomId: 'r', agents: [], updatedAt: 1 }))
  expect(send).toHaveBeenCalledWith(CHATROOM_IPC_CHANNELS.PERMISSION_REQUESTED, permission)
  expect(send).toHaveBeenCalledWith(CHATROOM_IPC_CHANNELS.LOCAL_CONFIG_CHANGED, { roomId: 'r', agents: [], updatedAt: 1 })
  expect(JSON.stringify(send.mock.calls)).not.toContain('toolInput')
})
test('Given runtime permission request contains internal fields When pushed Then renderer receives only the strict public DTO', () => {
  const send = mock(() => {})
  mainContents.send = send
  const request = {
    requestId: 'p-safe', toolName: 'Bash', summary: 'run', roomId: 'r', roomAgentId: 'a', invocationId: 'i', traceId: 't',
    originalSender: { type: 'user', id: 'u', displayName: 'u', internalToken: 'secret' }, invocationChain: [{ agentId: 'a', invocationId: 'parent', path: '/private' }], createdAt: 1, expiresAt: 2,
    toolInput: { command: 'cat /private' }, internalToken: 'secret', path: '/private', [Symbol('secret')]: 'secret',
  }
  coordinator.permissionListeners.forEach((listener) => listener(request))
  expect(send).toHaveBeenCalledWith(CHATROOM_IPC_CHANNELS.PERMISSION_REQUESTED, {
    requestId: 'p-safe', toolName: 'Bash', summary: 'run', roomId: 'r', roomAgentId: 'a', invocationId: 'i', traceId: 't',
    originalSender: { type: 'user', id: 'u', displayName: 'u' }, invocationChain: [{ agentId: 'a', invocationId: 'parent' }], createdAt: 1, expiresAt: 2,
  })
})
test('Given runtime permission request has a malicious prototype or extra fields When pushed Then it is rejected without IPC send', () => {
  const send = mock(() => {})
  mainContents.send = send
  const malicious = Object.create({ roomId: 'r' })
  Object.assign(malicious, { requestId: 'p-proto', toolName: 'Bash', summary: 'run', roomId: 'r', roomAgentId: 'a', invocationId: 'i', traceId: 't', originalSender: { type: 'user', id: 'u', displayName: 'u' }, invocationChain: [], createdAt: 1, expiresAt: 2 })
  coordinator.permissionListeners.forEach((listener) => listener(malicious))
  expect(send).not.toHaveBeenCalledWith(CHATROOM_IPC_CHANNELS.PERMISSION_REQUESTED, expect.anything())
})
test('Given coordinator is replaced or unregistered When old coordinator emits Then IPC detaches old subscriptions', () => {
  const registry = coordinatorModule
  const makeCoordinator = () => ({
    ...coordinator,
    permissionListeners: [] as Array<(value: any) => void>,
    configListeners: [] as Array<(value: any) => void>,
    onPermissionRequested(listener: (value: any) => void) { this.permissionListeners.push(listener); return () => { this.permissionListeners = this.permissionListeners.filter((item) => item !== listener) } },
    onLocalConfigChanged(listener: (value: any) => void) { this.configListeners.push(listener); return () => { this.configListeners = this.configListeners.filter((item) => item !== listener) } },
  })
  const first = makeCoordinator(); const second = makeCoordinator()
  const firstRelease = registry.registerChatRoomAgentCoordinator(first as any)
  const firstListeners = [...first.permissionListeners]
  const secondRelease = registry.registerChatRoomAgentCoordinator(second as any)
  const send = mock(() => {})
  mainContents.send = send
  firstListeners.forEach((listener) => listener({ requestId: 'old', toolName: 'Bash', summary: 'old', roomId: 'r', roomAgentId: 'a', invocationId: 'i', traceId: 't', originalSender: { type: 'user', id: 'u', displayName: 'u' }, invocationChain: [], createdAt: 1, expiresAt: 2 }))
  expect(send).not.toHaveBeenCalled()
  second.permissionListeners.forEach((listener) => listener({ requestId: 'new', toolName: 'Bash', summary: 'new', roomId: 'r', roomAgentId: 'a', invocationId: 'i', traceId: 't', originalSender: { type: 'user', id: 'u', displayName: 'u' }, invocationChain: [], createdAt: 1, expiresAt: 2 }))
  expect(send).toHaveBeenCalledTimes(1)
  firstRelease(); secondRelease()
})
test('Given non-main sender or strict DTO When mutate Then reject', async () => {
  await expect(handlers.get(CHATROOM_IPC_CHANNELS.PROVISION_AGENT)!({ sender: {} }, { roomId: 'room-1', sourceWorkspaceId: 'w', displayName: 'A', channelId: 'c' })).rejects.toThrow('不允许的请求来源')
  await expect(handlers.get(CHATROOM_IPC_CHANNELS.RESPOND_PERMISSION)!({ sender: mainContents }, { requestId: 'x', behavior: 'allow', [Symbol('x')]: 1 })).rejects.toThrow('权限响应参数不正确')
})
