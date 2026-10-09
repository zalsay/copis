import { expect, mock, test } from 'bun:test'
import { CHATROOM_IPC_CHANNELS, type ChatRoomLocalRoomConfig } from '@copis/shared'
const handlers = new Map<string, (...args: any[]) => any>()
const handle = mock((channel: string, fn: (...args: any[]) => any) => { handlers.set(channel, fn) })
const mainContents = { isDestroyed: () => false, send: mock(() => {}) }
mock.module('electron', () => ({ ipcMain: { handle }, BrowserWindow: class {} }))
mock.module('../index', () => ({ getMainWindow: () => ({ isDestroyed: () => false, webContents: mainContents }) }))
const localRoomConfig: ChatRoomLocalRoomConfig = { roomId: 'room-1', updatedAt: 1, hostUserId: 'user-1', deviceId: 'device-1', agents: [{ roomAgentId: 'a', displayName: 'A', sourceWorkspaceId: 'w', sessionId: 'secret-session', channelId: 'c', contextMessageCount: 50, memorySharingEnabled: false, skillSharingEnabled: false }], invocations: [], lastProcessedSeq: 0, createdAt: 1 }
const localReadiness = new Map<string, any>()
let readinessGeneration = 'identity-generation-1'
const coordinator = {
  listLocalRooms: () => [localRoomConfig],
  listCurrentIdentityLocalRooms: async () => [localRoomConfig],
  getLocalReadinessGeneration: () => readinessGeneration,
  isLocalReadinessGenerationCurrent: (generation: string) => generation === readinessGeneration,
  getAgentRuntimeReadiness: (roomId: string, agentId: string) => localReadiness.get(`${roomId}:${agentId}`),
  provisionAgent: mock(async (input: any) => ({ ...input, roomAgentId: 'a', sessionId: 'secret-session', contextMessageCount: 50, memorySharingEnabled: false, skillSharingEnabled: false })),
  updateAgent: mock(async () => ({ roomAgentId: 'a', displayName: 'A', sourceWorkspaceId: 'w', sessionId: 'secret-session', channelId: 'c', contextMessageCount: 50, memorySharingEnabled: false, skillSharingEnabled: false })),
  removeAgent: mock(async () => {}), syncAgentSkills: mock(async () => ({ roomAgentId: 'a', displayName: 'A', sourceWorkspaceId: 'w', sessionId: 'secret-session', channelId: 'c', contextMessageCount: 50, memorySharingEnabled: false, skillSharingEnabled: false })), respondToPermission: mock(async () => {}),
  permissionListeners: [] as Array<(value: any) => void>, configListeners: [] as Array<(value: any) => void>, readinessListeners: [] as Array<(value: any) => void>,
  onPermissionRequested: (listener: (value: any) => void) => { coordinator.permissionListeners.push(listener); return () => { coordinator.permissionListeners = coordinator.permissionListeners.filter((item) => item !== listener) } }, onLocalConfigChanged: (listener: (value: any) => void) => { coordinator.configListeners.push(listener); return () => { coordinator.configListeners = coordinator.configListeners.filter((item) => item !== listener) } }, onAgentRuntimeReadinessChanged: (listener: (value: any) => void) => { coordinator.readinessListeners.push(listener); return () => { coordinator.readinessListeners = coordinator.readinessListeners.filter((item) => item !== listener) } }, handleInvocation: async () => 'accepted' as const, handleGatewayDisconnected: async () => {}, stopAll: async () => ({ stoppedSessionIds: [], releasedRoomAgentIds: [] }), dispose: async () => {},
}
const coordinatorModule = await import('../lib/chatroom-agent-coordinator')
const module = await import('../ipc/chatrooms.ipc')
module.registerChatRoomIpcHandlers({ getMainWindow: () => ({ isDestroyed: () => false, webContents: mainContents } as any) })
let releaseCoordinator = coordinatorModule.registerChatRoomAgentCoordinator(coordinator as any)
function registerCoordinator(value: any): () => void {
  const release = coordinatorModule.registerChatRoomAgentCoordinator(value)
  releaseCoordinator = release
  return release
}
test('Given 主窗口 When each management handler executes Then DTO reaches coordinator and views are redacted', async () => {
  const sender = { sender: mainContents }
  const list = await handlers.get(CHATROOM_IPC_CHANNELS.LIST_LOCAL_ROOMS)!(sender)
  expect(JSON.stringify(list)).not.toContain('hostUserId'); expect(JSON.stringify(list)).not.toContain('sessionId')
  expect(list[0].agents[0].localAvailability).toBeUndefined()
  const result = await handlers.get(CHATROOM_IPC_CHANNELS.PROVISION_AGENT)!({ sender: mainContents }, { roomId: 'room-1', sourceWorkspaceId: 'w', displayName: 'A', channelId: 'c' })
  expect(result.sessionId).toBeUndefined(); expect(result.roomAgentId).toBe('a')
  await handlers.get(CHATROOM_IPC_CHANNELS.UPDATE_AGENT)!(sender, { roomId: 'room-1', roomAgentId: 'a', displayName: 'A2' })
  await handlers.get(CHATROOM_IPC_CHANNELS.REMOVE_AGENT)!(sender, { roomId: 'room-1', roomAgentId: 'a' })
  await handlers.get(CHATROOM_IPC_CHANNELS.SYNC_AGENT_SKILLS)!(sender, { roomId: 'room-1', roomAgentId: 'a' })
  await handlers.get(CHATROOM_IPC_CHANNELS.RESPOND_PERMISSION)!(sender, { requestId: 'request-1', behavior: 'allow' })
  expect(coordinator.provisionAgent).toHaveBeenCalled(); expect(coordinator.updateAgent).toHaveBeenCalled(); expect(coordinator.removeAgent).toHaveBeenCalled(); expect(coordinator.syncAgentSkills).toHaveBeenCalled(); expect(coordinator.respondToPermission).toHaveBeenCalled()
})

test('Given安全列表等待期间认证代次变化 When旧列表返回 Then不向Renderer返回旧快照', async () => {
  let finish!: (rooms: typeof localRoomConfig[]) => void
  coordinator.listCurrentIdentityLocalRooms = () => new Promise((resolve) => { finish = resolve })
  const request = handlers.get(CHATROOM_IPC_CHANNELS.LIST_LOCAL_ROOMS)!({ sender: mainContents })
  readinessGeneration = 'identity-generation-2'
  finish([localRoomConfig])
  expect(await request).toEqual([])
  coordinator.listCurrentIdentityLocalRooms = async () => [localRoomConfig]
})

test('Given安全列表等待期间coordinator注销 When旧列表返回 Then返回空列表而不是让hydration失败', async () => {
  let finish!: (rooms: ChatRoomLocalRoomConfig[]) => void
  coordinator.listCurrentIdentityLocalRooms = () => new Promise((resolve) => { finish = resolve })
  const request = handlers.get(CHATROOM_IPC_CHANNELS.LIST_LOCAL_ROOMS)!({ sender: mainContents })
  releaseCoordinator()
  finish([localRoomConfig])
  const result = await request.catch((error: unknown) => error)
  releaseCoordinator = coordinatorModule.registerChatRoomAgentCoordinator(coordinator as any)
  expect(result).toEqual([])
  coordinator.listCurrentIdentityLocalRooms = async () => [localRoomConfig]
})

test('Given已归档Agent仍残留旧online readiness When读取本地配置 Then归档视图不被旧状态复活', async () => {
  const archivedRoom: ChatRoomLocalRoomConfig = { ...localRoomConfig, agents: [{ ...localRoomConfig.agents[0]!, archivedAt: 2 }] }
  coordinator.listCurrentIdentityLocalRooms = async () => [archivedRoom]
  localReadiness.set('room-1:a', { roomId: 'room-1', roomAgentId: 'a', availability: 'online', updatedAt: 1 })
  const result = await handlers.get(CHATROOM_IPC_CHANNELS.LIST_LOCAL_ROOMS)!({ sender: mainContents })
  expect(result[0].agents[0].archived).toBe(true)
  expect(result[0].agents[0].localAvailability).toBeUndefined()
  coordinator.listCurrentIdentityLocalRooms = async () => [localRoomConfig]
})

test('Given coordinator config/readiness callbacks When emitting Then safe local view is redacted and delivered once', async () => {
  const send = mock(() => {})
  mainContents.send = send
  const permission = { requestId: 'p', toolName: 'Bash', summary: 'run', roomId: 'r', roomAgentId: 'a', invocationId: 'i', traceId: 't', originalSender: { type: 'user', id: 'u', displayName: 'u' }, invocationChain: [], createdAt: 1, expiresAt: 2 }
  localReadiness.set('room-1:a', { roomId: 'room-1', roomAgentId: 'a', availability: 'preparing', reason: '/private/reason', updatedAt: 2 })
  coordinator.permissionListeners.forEach((listener) => listener(permission))
  coordinator.configListeners.forEach((listener) => listener(localRoomConfig))
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(send).toHaveBeenCalledWith(CHATROOM_IPC_CHANNELS.PERMISSION_REQUESTED, permission)
  expect(send).toHaveBeenCalledWith(CHATROOM_IPC_CHANNELS.LOCAL_CONFIG_CHANGED, {
    roomId: 'room-1', agents: [{ roomAgentId: 'a', displayName: 'A', sourceWorkspaceId: 'w', channelId: 'c', contextMessageCount: 50, memorySharingEnabled: false, skillSharingEnabled: false, archived: false, localAvailability: 'preparing' }], updatedAt: 1,
  })
  expect(JSON.stringify(send.mock.calls)).not.toContain('toolInput')
  expect(JSON.stringify(send.mock.calls)).not.toContain('/private/reason')
  expect(JSON.stringify(send.mock.calls)).not.toContain('secret-session')
  send.mockClear()
  localReadiness.set('room-1:a', { roomId: 'room-1', roomAgentId: 'a', availability: 'configuration_error', reason: 'credential /private', updatedAt: 3 })
  coordinator.readinessListeners.forEach((listener) => listener({ roomId: 'room-1', roomAgentId: 'a', availability: 'configuration_error', reason: 'credential /private', updatedAt: 3 }))
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(send).toHaveBeenCalledWith(CHATROOM_IPC_CHANNELS.LOCAL_CONFIG_CHANGED, expect.objectContaining({
    roomId: 'room-1', agents: [expect.objectContaining({ localAvailability: 'configuration_error' })],
  }))
  expect(JSON.stringify(send.mock.calls)).not.toContain('credential /private')
})

test('Given same-generation reads for one room finish out of order When config/readiness pushes settle Then only its newest view is emitted while another room remains independent', async () => {
  const send = mock(() => {})
  mainContents.send = send
  const pendingReads: Array<(rooms: ChatRoomLocalRoomConfig[]) => void> = []
  coordinator.listCurrentIdentityLocalRooms = () => new Promise((resolve) => { pendingReads.push(resolve) })
  const eventListeners = [...coordinator.configListeners]
  eventListeners.forEach((listener) => listener({ ...localRoomConfig, roomId: 'room-one' }))
  eventListeners.forEach((listener) => listener({ ...localRoomConfig, roomId: 'room-one' }))
  eventListeners.forEach((listener) => listener({ ...localRoomConfig, roomId: 'room-two' }))
  expect(pendingReads).toHaveLength(3)

  const olderRoomOne = { ...localRoomConfig, roomId: 'room-one', updatedAt: 1, agents: [{ ...localRoomConfig.agents[0]!, displayName: 'older' }] }
  const newerRoomOne = { ...localRoomConfig, roomId: 'room-one', updatedAt: 1, agents: [{ ...localRoomConfig.agents[0]!, displayName: 'newer' }] }
  const independentRoomTwo = { ...localRoomConfig, roomId: 'room-two', updatedAt: 1, agents: [{ ...localRoomConfig.agents[0]!, displayName: 'independent' }] }
  pendingReads[1]!([newerRoomOne])
  pendingReads[2]!([independentRoomTwo])
  await new Promise((resolve) => setTimeout(resolve, 0))
  pendingReads[0]!([olderRoomOne])
  await new Promise((resolve) => setTimeout(resolve, 0))

  expect(send).toHaveBeenCalledWith(CHATROOM_IPC_CHANNELS.LOCAL_CONFIG_CHANGED, expect.objectContaining({
    roomId: 'room-one', agents: [expect.objectContaining({ displayName: 'newer' })],
  }))
  expect(send).toHaveBeenCalledWith(CHATROOM_IPC_CHANNELS.LOCAL_CONFIG_CHANGED, expect.objectContaining({
    roomId: 'room-two', agents: [expect.objectContaining({ displayName: 'independent' })],
  }))
  expect(JSON.stringify(send.mock.calls)).not.toContain('older')
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
test('Given coordinator is replaced or unregistered When old coordinator emits Then IPC detaches old subscriptions and drops its pending push', async () => {
  const makeCoordinator = () => ({
    ...coordinator,
    permissionListeners: [] as Array<(value: any) => void>,
    configListeners: [] as Array<(value: any) => void>,
    readinessListeners: [] as Array<(value: any) => void>,
    onPermissionRequested(listener: (value: any) => void) { this.permissionListeners.push(listener); return () => { this.permissionListeners = this.permissionListeners.filter((item) => item !== listener) } },
    onLocalConfigChanged(listener: (value: any) => void) { this.configListeners.push(listener); return () => { this.configListeners = this.configListeners.filter((item) => item !== listener) } },
    onAgentRuntimeReadinessChanged(listener: (value: any) => void) { this.readinessListeners.push(listener); return () => { this.readinessListeners = this.readinessListeners.filter((item) => item !== listener) } },
  })
  const first = makeCoordinator(); const second = makeCoordinator()
  const firstRelease = registerCoordinator(first)
  const firstListeners = [...first.permissionListeners]
  const firstReadinessListeners = [...first.readinessListeners]
  let finishOldRooms!: (rooms: typeof localRoomConfig[]) => void
  first.listCurrentIdentityLocalRooms = () => new Promise((resolve) => { finishOldRooms = resolve })
  first.configListeners.forEach((listener) => listener(localRoomConfig))
  const secondRelease = registerCoordinator(second)
  const send = mock(() => {})
  mainContents.send = send
  finishOldRooms([localRoomConfig])
  await new Promise((resolve) => setTimeout(resolve, 0))
  firstListeners.forEach((listener) => listener({ requestId: 'old', toolName: 'Bash', summary: 'old', roomId: 'r', roomAgentId: 'a', invocationId: 'i', traceId: 't', originalSender: { type: 'user', id: 'u', displayName: 'u' }, invocationChain: [], createdAt: 1, expiresAt: 2 }))
  firstReadinessListeners.forEach((listener) => listener({ roomId: 'room-1', roomAgentId: 'a', availability: 'online' }))
  expect(send).not.toHaveBeenCalled()
  second.permissionListeners.forEach((listener) => listener({ requestId: 'new', toolName: 'Bash', summary: 'new', roomId: 'r', roomAgentId: 'a', invocationId: 'i', traceId: 't', originalSender: { type: 'user', id: 'u', displayName: 'u' }, invocationChain: [], createdAt: 1, expiresAt: 2 }))
  expect(send).toHaveBeenCalledTimes(1)
  firstRelease(); secondRelease(); releaseCoordinator = coordinatorModule.registerChatRoomAgentCoordinator(coordinator as any)
})
test('Given non-main sender or strict DTO When mutate Then reject', async () => {
  await expect(handlers.get(CHATROOM_IPC_CHANNELS.PROVISION_AGENT)!({ sender: {} }, { roomId: 'room-1', sourceWorkspaceId: 'w', displayName: 'A', channelId: 'c' })).rejects.toThrow('不允许的请求来源')
  await expect(handlers.get(CHATROOM_IPC_CHANNELS.RESPOND_PERMISSION)!({ sender: mainContents }, { requestId: 'x', behavior: 'allow', [Symbol('x')]: 1 })).rejects.toThrow('权限响应参数不正确')
})
