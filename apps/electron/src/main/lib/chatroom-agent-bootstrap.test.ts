import { afterAll, beforeEach, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { COPIS_WORKING_FAST_MODEL_ID, type ChatRoomAgentLocalConfig } from '@copis/shared'
import type { ChatRoomAgentCoordinatorRegistration } from './chatroom-agent-coordinator'

const fixtureRoot = mkdtempSync(join(tmpdir(), 'copis-chatroom-bootstrap-'))
const actualConfigPaths = await import('./config-paths')
mock.module('./config-paths', () => ({
  ...actualConfigPaths,
  getConfigDir: () => fixtureRoot,
  getChatRoomsRootPath: () => join(fixtureRoot, 'chatrooms'),
  getChannelsPath: () => join(fixtureRoot, 'channels.json'),
  getAgentWorkspacesIndexPath: () => join(fixtureRoot, 'agent-workspaces.json'),
  getChatRoomAgentProjectPath: (roomId: string, agentId: string) => join(fixtureRoot, 'rooms', roomId, agentId, 'project'),
  getChatRoomAgentSessionDir: (roomId: string, agentId: string) => join(fixtureRoot, 'rooms', roomId, agentId, 'sessions'),
  getChatRoomAgentSessionMetaPath: (roomId: string, agentId: string) => join(fixtureRoot, 'rooms', roomId, agentId, 'sessions', 'meta.json'),
  getChatRoomAgentSessionMessagesPath: (roomId: string, agentId: string) => join(fixtureRoot, 'rooms', roomId, agentId, 'sessions', 'messages.jsonl'),
  getWorkspaceFilesDir: (slug: string) => join(fixtureRoot, 'workspace-files', slug),
}))

const rustCalls: Array<{ method: string; input: unknown }> = []
const managementCalls: Array<{ method: string; roomId: string; roomAgentId: string; operation?: unknown }> = []
let roomFixtures: any[] = []
let rejectStrictList = false
let cachedUserId = 'user-production'
let bootstrapDeviceId = 'device-production'
const storeIdentities: unknown[] = []
const resumeListeners = new Set<() => void>()
const roomRosterCalls: Array<{ roomId: string; signal?: AbortSignal }> = []
let gatewayStatusReads = 0
let gatewayStatus: any = { ready: false, epoch: 0, capabilityState: 'preparing', mode: 'legacy', socketGeneration: 0, snapshotReady: false, selectedCapabilities: [] }
let piWorkerAvailability: { available: true; kind: 'executable' } | { available: false; reason: 'pi_worker_entry_missing' | 'pi_worker_runtime_missing' } = { available: true, kind: 'executable' }
let reportContext!: (invocationId: string) => unknown
mock.module('electron', () => ({
  app: { isPackaged: false, getPath: () => fixtureRoot },
  powerMonitor: {
    on: (event: string, listener: () => void) => { if (event === 'resume') resumeListeners.add(listener) },
    off: (event: string, listener: () => void) => { if (event === 'resume') resumeListeners.delete(listener) },
  },
  safeStorage: { isEncryptionAvailable: () => true, decryptString: () => 'fixture-key' },
  BrowserWindow: class {}, WebContentsView: class {}, clipboard: {}, dialog: {}, nativeImage: { createFromPath: () => ({}) },
  nativeTheme: {}, powerSaveBlocker: {}, screen: {}, shell: { openExternal: async () => {} },
}))
mock.module('./chatroom-workspace-store', () => ({ ChatRoomWorkspaceStore: class { constructor(options?: unknown) { storeIdentities.push(options) } list() { if (rejectStrictList) throw new Error('invalid_room_config'); return roomFixtures } listRestorableRooms() { return roomFixtures } read(roomId: string) { return roomFixtures.find((room) => room.roomId === roomId) } } }))
mock.module('./http-api-server', () => ({ HTTP_API_HOST: '127.0.0.1', HTTP_API_PORT: 51740, getHttpApiInternalToken: () => 'test-internal-token', getPiWorkerRuntimeAvailability: () => piWorkerAvailability }))
mock.module('./chatroom-management-client', () => ({ ChatRoomManagementClient: class {
  getRoomHostUserId = async () => cachedUserId
  getRoomAgentRoster = async (roomId: string, options?: { signal?: AbortSignal }) => {
    roomRosterCalls.push({ roomId, signal: options?.signal })
    return { roomId, hostUserId: cachedUserId, agents: [{ roomAgentId: 'server-agent', displayName: 'Server Agent' }] }
  }
  getRoomRealtimeStatus = async () => {
    gatewayStatusReads++
    return { ...gatewayStatus, epoch: gatewayStatus.epoch }
  }
  readyAgent = async (roomId: string, roomAgentId: string) => { managementCalls.push({ method: 'ready', roomId, roomAgentId }); return { outcome: 'confirmed', mode: 'agent-ready-v1', source: 'private-ack', requestId: 'ready-1', roomId, roomAgentId, command: 'agent.ready', generation: 7 } }
  unreadyAgent = async (roomId: string, roomAgentId: string) => { managementCalls.push({ method: 'unready', roomId, roomAgentId }); return { outcome: 'confirmed', mode: 'agent-ready-v1', source: 'private-ack', requestId: 'unready-1', roomId, roomAgentId, command: 'agent.unready', generation: 7 } }
  registerAgent = async () => 'server-agent'
  lookupManagementOperation = async () => ({ mode: 'legacy' as const })
  unregisterAgent = async (roomId: string, roomAgentId: string, operation?: unknown) => { managementCalls.push({ method: 'unregister', roomId, roomAgentId, operation }) }
  probeAgentManagementVersion = async () => true
  updateAgentSharing = async (input: any) => ({ version: 1, operationId: input.operationId, roomId: input.roomId,
    roomAgentId: input.roomAgentId, ownerUserId: 1, action: 'update-sharing', status: 'updated', displayName: input.roomAgentId,
    memoryShared: input.memoryShared, skillsShared: input.skillsShared })
  renewAgentLease = async (roomId: string, roomAgentId: string) => { managementCalls.push({ method: 'renew', roomId, roomAgentId }) }
} }))
mock.module('./chatroom-rust-client', () => ({ HttpChatRoomRustApiClient: class {
  constructor(options: { getInvocationContext: (invocationId: string) => unknown }) { reportContext = options.getInvocationContext }
  reportAccepted = async (input: unknown) => { rustCalls.push({ method: 'accepted', input }) }
  reportRunning = async (input: unknown) => { rustCalls.push({ method: 'running', input }) }
  reportDelta = async (input: unknown) => { rustCalls.push({ method: 'delta', input }) }
  reportCompleted = async (input: unknown) => { rustCalls.push({ method: 'completed', input }) }
  reportFailed = async (input: unknown) => { rustCalls.push({ method: 'failed', input }) }
  queryInvocationStatus = async (input: unknown) => { rustCalls.push({ method: 'status', input }); return { outcome: 'Unknown' } }
  releaseAgentLeases = async (input: unknown) => { rustCalls.push({ method: 'release', input }) }
} }))
mock.module('./client-device-id', () => ({ getOrCreateClientDeviceId: () => bootstrapDeviceId }))
mock.module('./working-api-service', () => ({ getWorkingApiClient: () => ({ baseUrl: 'https://backend.example.test', getCachedUser: () => cachedUserId ? { id: cachedUserId } : undefined }) }))
mock.module('./channel-manager', () => ({ listConfiguredChannels: () => [{ id: 'channel-secret' }], getChannelById: () => undefined, decryptApiKey: () => 'configured-secret' }))
mock.module('./agent-service', () => ({ runAgentHeadless: async () => {}, stopAgent: async () => {}, agentEventBus: { on: () => () => {} } }))
mock.module('./chatroom-hidden-session-store', () => ({ createChatRoomHiddenSessionStore: () => ({}) }))
mock.module('./agent-session-manager', () => ({ registerAgentSessionStorageOverride: () => () => {} }))
mock.module('./chatroom-skill-snapshot', () => ({ syncChatRoomAgentSkillSnapshot: () => ({ snapshotPath: '/tmp/skills', digest: 'a'.repeat(64), skillSlugs: [], syncedAt: Date.now() }), computeChatRoomSkillSnapshotDigest: () => 'a'.repeat(64) }))

const bootstrap = await import('./chatroom-agent-bootstrap')
const { checkChatRoomAgentRuntimeReadiness } = bootstrap
const coordinatorModule = await import('./chatroom-agent-coordinator')

afterAll(() => rmSync(fixtureRoot, { recursive: true, force: true }))

beforeEach(() => {
  cachedUserId = 'user-production'
  bootstrapDeviceId = 'device-production'
  storeIdentities.length = 0
  managementCalls.length = 0
  gatewayStatusReads = 0
  gatewayStatus = { ready: false, epoch: 0, capabilityState: 'preparing', mode: 'legacy', socketGeneration: 0, snapshotReady: false, selectedCapabilities: [] }
  rmSync(join(fixtureRoot, 'chatrooms'), { recursive: true, force: true })
  piWorkerAvailability = { available: true, kind: 'executable' }
})

function prepareRuntimeFixture() {
  const workspaceRoot = join(fixtureRoot, 'workspace-files', 'fixture-workspace')
  const sessionRoot = join(fixtureRoot, 'rooms', 'fixture-room', 'fixture-agent', 'sessions')
  const projectRoot = join(fixtureRoot, 'rooms', 'fixture-room', 'fixture-agent', 'project')
  mkdirSync(workspaceRoot, { recursive: true })
  mkdirSync(sessionRoot, { recursive: true })
  mkdirSync(projectRoot, { recursive: true })
  writeFileSync(join(fixtureRoot, 'agent-workspaces.json'), JSON.stringify({ version: 3, workspaces: [{ id: 'fixture-workspace', slug: 'fixture-workspace', createdAt: 1, updatedAt: 1 }] }))
  const agent = {
    roomAgentId: 'fixture-agent', displayName: 'Fixture', sourceWorkspaceId: 'fixture-workspace', sessionId: 'fixture-session',
    channelId: 'copis-working', modelId: COPIS_WORKING_FAST_MODEL_ID, contextMessageCount: 10,
    memorySharingEnabled: false, skillSharingEnabled: false,
  }
  writeFileSync(join(sessionRoot, 'meta.json'), JSON.stringify({
    id: agent.sessionId, title: agent.displayName, createdAt: 1, updatedAt: 1, agentRuntime: 'pi',
    channelId: agent.channelId, modelId: agent.modelId, workspaceId: agent.sourceWorkspaceId,
  }))
  return { agent, sessionRoot }
}

test('生产runtime checker要求Pi Worker入口、渠道/model、hidden meta绑定均真实可用', () => {
  const { agent, sessionRoot } = prepareRuntimeFixture()
  expect(checkChatRoomAgentRuntimeReadiness('fixture-room', agent, { available: true, kind: 'executable' })).toEqual({ available: true })
  expect(checkChatRoomAgentRuntimeReadiness('fixture-room', agent, { available: false, reason: 'pi_worker_entry_missing' })).toMatchObject({ available: false, reason: 'pi_worker_entry_missing' })
  expect(checkChatRoomAgentRuntimeReadiness('fixture-room', agent, { available: false, reason: 'pi_worker_runtime_missing' })).toMatchObject({ available: false, reason: 'pi_worker_runtime_missing' })

  const missingChannel = { ...agent, channelId: 'missing-channel' }
  expect(checkChatRoomAgentRuntimeReadiness('fixture-room', missingChannel, { available: true, kind: 'executable' })).toMatchObject({ available: false, reason: 'channel_disabled_or_missing' })

  writeFileSync(join(fixtureRoot, 'channels.json'), JSON.stringify({ version: 1, channels: [{
    id: 'custom', name: 'Custom', provider: 'openai', baseUrl: 'https://example.test', apiKey: 'encrypted', enabled: false,
    models: [{ id: 'model-a', name: 'A', enabled: true }], createdAt: 1, updatedAt: 1,
  }] }))
  expect(checkChatRoomAgentRuntimeReadiness('fixture-room', { ...agent, channelId: 'custom', modelId: 'model-a' }, { available: true, kind: 'executable' }))
    .toMatchObject({ available: false, reason: 'channel_disabled_or_missing' })
  writeFileSync(join(fixtureRoot, 'channels.json'), JSON.stringify({ version: 1, channels: [{
    id: 'custom', name: 'Custom', provider: 'openai', baseUrl: 'https://example.test', apiKey: 'encrypted', enabled: true,
    models: [{ id: 'model-a', name: 'A', enabled: false }], createdAt: 1, updatedAt: 1,
  }] }))
  expect(checkChatRoomAgentRuntimeReadiness('fixture-room', { ...agent, channelId: 'custom', modelId: 'model-a' }, { available: true, kind: 'executable' }))
    .toMatchObject({ available: false, reason: 'model_missing' })

  writeFileSync(join(sessionRoot, 'meta.json'), JSON.stringify({ id: 'wrong-session', title: 'Fixture', createdAt: 1, updatedAt: 1, agentRuntime: 'pi', channelId: agent.channelId, modelId: agent.modelId, workspaceId: agent.sourceWorkspaceId }))
  expect(checkChatRoomAgentRuntimeReadiness('fixture-room', agent, { available: true, kind: 'executable' }))
    .toMatchObject({ available: false, reason: 'hidden_session_corrupt' })
  writeFileSync(join(sessionRoot, 'meta.json'), JSON.stringify({ id: agent.sessionId, title: 'Fixture', createdAt: -1, updatedAt: 0, agentRuntime: 'pi', channelId: agent.channelId, modelId: agent.modelId, workspaceId: agent.sourceWorkspaceId }))
  expect(checkChatRoomAgentRuntimeReadiness('fixture-room', agent, { available: true, kind: 'executable' }))
    .toMatchObject({ available: false, reason: 'hidden_session_corrupt' })
})

test('同一coordinator的每次runtime health都读取当前活动Rust进程Worker状态', async () => {
  const { agent } = prepareRuntimeFixture()
  const coordinator = bootstrap.initializeChatRoomAgentCoordinator()
  const deps = (coordinator as unknown as { deps: { readiness: { deps: { checkAgent: (agent: ChatRoomAgentLocalConfig, room: { roomId: string }) => Promise<unknown> } } } }).deps
  const checkAgent = deps.readiness.deps.checkAgent
  expect(await checkAgent(agent, { roomId: 'fixture-room' })).toEqual({ available: true })
  piWorkerAvailability = { available: false, reason: 'pi_worker_runtime_missing' }
  expect(await checkAgent(agent, { roomId: 'fixture-room' })).toMatchObject({ available: false, reason: 'pi_worker_runtime_missing' })
  await bootstrap.disposeChatRoomAgentCoordinator()
})

test('有效房间的调用回传从本地 invocation record 提供可信状态关联上下文', async () => {
  roomFixtures = [{ roomId: 'room-healthy', deviceId: 'device-production', agents: [{ roomAgentId: 'a1' }], invocations: [{ invocationId: 'i1', traceId: 'trace-i1', targetAgentId: 'a1', triggerMessageId: 'm1', depth: 2 }] }]
  rejectStrictList = true
  bootstrap.initializeChatRoomAgentCoordinator()
  try {
    expect(reportContext('i1')).toEqual({
      roomId: 'room-healthy', agentId: 'a1', deviceId: 'device-production', clientMessageId: 'm1',
      traceId: 'trace-i1', targetAgentId: 'a1', triggerMessageId: 'm1', depth: 2,
    })
    expect(reportContext('unknown')).toBeUndefined()
  } finally {
    roomFixtures = []; rejectStrictList = false
    await bootstrap.disposeChatRoomAgentCoordinator()
  }
})

test('Given production bootstrap When initialize executes Then one real coordinator is registered with real adapters and dispose releases token', async () => {
  const coordinator = bootstrap.initializeChatRoomAgentCoordinator()
  expect(coordinator).toBeInstanceOf(coordinatorModule.ChatRoomAgentCoordinator)
  expect(coordinatorModule.getChatRoomAgentCoordinator()).toBe(coordinator)
  const deps = (coordinator as unknown as { deps: Record<string, unknown> }).deps
  expect((deps.getDeviceId as () => string)()).toBe('device-production')
  expect(await (deps.getCurrentUserId as () => Promise<string>)()).toBe('user-production')
  expect((deps.getSensitiveValues as () => string[])()).toEqual(['configured-secret'])
  expect(typeof deps.runAgentHeadless).toBe('function')
  expect(typeof deps.createHiddenSessionStore).toBe('function')
  expect(typeof deps.registerSessionStorageOverride).toBe('function')
  expect(deps.createNextHop).toBeUndefined()
  expect(deps.sendPermissionToHost).toBeUndefined()
  const rosterMethod = (deps.rustApi as { getRoomAgentRoster?: (roomId: string, options?: { signal?: AbortSignal }) => Promise<unknown> }).getRoomAgentRoster
  expect(typeof rosterMethod).toBe('function')
  const rosterSignal = new AbortController().signal
  expect(await rosterMethod!.call(deps.rustApi, 'fixture-room', { signal: rosterSignal })).toEqual({
    roomId: 'fixture-room', hostUserId: 'user-production', agents: [{ roomAgentId: 'server-agent', displayName: 'Server Agent' }],
  })
  expect(roomRosterCalls.at(-1)).toEqual({ roomId: 'fixture-room', signal: rosterSignal })
  await bootstrap.disposeChatRoomAgentCoordinator()
  expect(() => coordinatorModule.getChatRoomAgentCoordinator()).toThrow('聊天室协调器尚未注册')
})

test('Given production bootstrap initialized twice When initialize executes Then it reuses the authoritative coordinator', () => {
  const first = bootstrap.initializeChatRoomAgentCoordinator()
  expect(bootstrap.initializeChatRoomAgentCoordinator()).toBe(first)
  bootstrap.releaseChatRoomAgentCoordinatorRegistration()
})

test('Given bootstrap starts with an empty JSON store When first Agent config is saved before snapshot readiness Then config returns immediately and bootstrap recovery renews legacy lease in background', async () => {
  bootstrapDeviceId = '223e4567-e89b-42d3-a456-426614174000'
  mkdirSync(join(fixtureRoot, 'chatrooms'), { recursive: true })
  gatewayStatus = { ready: false, epoch: 0, capabilityState: 'legacy', mode: 'legacy', socketGeneration: 0, snapshotReady: false, selectedCapabilities: [] }
  const coordinator = bootstrap.initializeChatRoomAgentCoordinator() as unknown as {
    deps: { store: Record<string, any>; leaseRecoveryRetryMs?: number }
    provisionAgent(input: { roomId: string; sourceWorkspaceId: string; displayName: string; channelId: string }): Promise<ChatRoomAgentLocalConfig>
  }
  const store = coordinator.deps.store
  const fixtureStorePath = join(fixtureRoot, 'task-7b-recovery-rooms.json')
  const readRooms = () => {
    try { return (JSON.parse(readFileSync(fixtureStorePath, 'utf8')) as { rooms: any[] }).rooms }
    catch { return [] }
  }
  const saveRooms = (rooms: any[]) => writeFileSync(fixtureStorePath, JSON.stringify({ rooms }), 'utf8')
  store.list = () => readRooms()
  store.listRestorableRooms = () => readRooms()
  store.read = (roomId: string) => readRooms().find((room) => room.roomId === roomId)
  store.provisionAgent = (identity: { hostUserId: string; deviceId: string }, input: { roomId: string; sourceWorkspaceId: string; displayName: string; channelId: string }, serverAgentId: string, options?: { roomCreatedAt?: number }) => {
    const rooms = readRooms()
    const previous = rooms.find((room) => room.roomId === input.roomId)
    const now = Date.now()
    const createdAt = previous?.createdAt ?? options?.roomCreatedAt ?? now
    const agent = {
      roomAgentId: serverAgentId, displayName: input.displayName, sourceWorkspaceId: input.sourceWorkspaceId,
      sessionId: `fixture-session-${serverAgentId}`, channelId: input.channelId,
      contextMessageCount: 50, memorySharingEnabled: false, skillSharingEnabled: false,
    }
    const room = previous
      ? { ...previous, agents: [...previous.agents, agent], updatedAt: Math.max(now, createdAt) }
      : { roomId: input.roomId, hostUserId: identity.hostUserId, deviceId: identity.deviceId, lastProcessedSeq: 0,
          agents: [agent], invocations: [], createdAt, updatedAt: Math.max(now, createdAt) }
    saveRooms([...rooms.filter((candidate) => candidate.roomId !== input.roomId), room])
    return room
  }
  coordinator.deps.leaseRecoveryRetryMs = 5

  try {
    expect(store.listRestorableRooms()).toEqual([])
    const readsBeforeProvision = gatewayStatusReads
    const configured = await coordinator.provisionAgent({ roomId: 'task-7b-room', sourceWorkspaceId: 'fixture-workspace', displayName: 'Task 7b', channelId: 'channel-secret' })
    expect(configured.roomAgentId).toBe('server-agent')
    expect(store.listRestorableRooms()[0]?.agents).toHaveLength(1)
    expect(managementCalls.some((call) => call.method === 'renew')).toBe(false)
    for (let attempt = 0; attempt < 20 && gatewayStatusReads - readsBeforeProvision < 2; attempt++) await new Promise((resolve) => setTimeout(resolve, 1))
    expect(gatewayStatusReads - readsBeforeProvision).toBeGreaterThanOrEqual(2)

    gatewayStatus = { ready: true, epoch: 0, capabilityState: 'legacy', mode: 'legacy', socketGeneration: 0, snapshotReady: true, selectedCapabilities: [] }
    for (let attempt = 0; attempt < 50 && !managementCalls.some((call) => call.method === 'renew'); attempt++) await new Promise((resolve) => setTimeout(resolve, 2))

    expect(managementCalls.filter((call) => call.method === 'renew')).toEqual([{ method: 'renew', roomId: 'task-7b-room', roomAgentId: 'server-agent' }])
  } finally {
    await bootstrap.disposeChatRoomAgentCoordinator()
    bootstrapDeviceId = 'device-production'
  }
})

test('Given a temp restart retains pending remove journal When bootstrap reconnect watcher runs Then only its exact Agent remains unready', async () => {
  const { agent } = prepareRuntimeFixture()
  const room = { roomId: 'fixture-room', hostUserId: 'user-production', deviceId: 'device-production', createdAt: 10, updatedAt: 11,
    lastProcessedSeq: 0, agents: [agent], invocations: [] }
  roomFixtures = [room]
  gatewayStatus = { ready: true, epoch: 0, capabilityState: 'ready', mode: 'modern', socketGeneration: 7, snapshotReady: true, selectedCapabilities: ['agent-ready-v1'] }
  const journalPath = join(fixtureRoot, 'chatrooms', 'chatroom-management-operations.json')
  mkdirSync(join(fixtureRoot, 'chatrooms'), { recursive: true })
  writeFileSync(journalPath, JSON.stringify({ version: 2, records: [{
    action: 'remove', operationId: '123e4567-e89b-42d3-a456-426614174000', hostUserId: 'user-production', deviceId: 'device-production',
    roomId: 'fixture-room', roomCreatedAt: 10, roomWasMissing: false, roomAgentId: 'fixture-agent',
    input: { roomId: 'fixture-room', sourceWorkspaceId: agent.sourceWorkspaceId, displayName: agent.displayName,
      channelId: agent.channelId, modelId: agent.modelId, contextMessageCount: agent.contextMessageCount,
      memorySharingEnabled: false, skillSharingEnabled: false },
    phase: 'unknown', mode: 'v1', createdAt: 10, updatedAt: 11,
  }] }), 'utf8')

  bootstrap.initializeChatRoomAgentCoordinator()
  await bootstrap.disposeChatRoomAgentCoordinator()
  bootstrap.initializeChatRoomAgentCoordinator()
  for (const listener of resumeListeners) listener()
  for (let attempt = 0; attempt < 20 && !managementCalls.some((call) => call.method === 'unready'); attempt++) await Promise.resolve()

  expect(managementCalls.some((call) => call.method === 'unready' && call.roomId === 'fixture-room' && call.roomAgentId === 'fixture-agent')).toBe(true)
  expect(managementCalls.some((call) => call.method === 'ready')).toBe(false)
  await bootstrap.disposeChatRoomAgentCoordinator()
  roomFixtures = []
})

test('Given a journaled remove compensation When Main bootstrap forwards it Then preserve the exact operation/device/actor options', async () => {
  const coordinator = bootstrap.initializeChatRoomAgentCoordinator()
  const deps = (coordinator as unknown as { deps: { rustApi: { unregisterAgent: (roomId: string, roomAgentId: string, operation: unknown) => Promise<void> } } }).deps
  const operation = { operationId: '123e4567-e89b-42d3-a456-426614174000', deviceId: '223e4567-e89b-42d3-a456-426614174000', hostUserId: 'user-production' }
  await deps.rustApi.unregisterAgent('room-exact', 'agent-exact', operation)
  expect(managementCalls).toEqual([{ method: 'unregister', roomId: 'room-exact', roomAgentId: 'agent-exact', operation }])
  await bootstrap.disposeChatRoomAgentCoordinator()
})

test('powerMonitor resume starts current-room reconcile and dispose detaches the listener', async () => {
  roomFixtures = [{
    roomId: 'room-wake', hostUserId: 'user-production', deviceId: 'device-production', lastProcessedSeq: 0,
    agents: [{ roomAgentId: 'agent-wake', displayName: 'Wake', sourceWorkspaceId: 'ws', sessionId: 'session-wake', channelId: 'copis-working', modelId: 'fast', contextMessageCount: 20, memorySharingEnabled: false, skillSharingEnabled: false }],
    invocations: [], createdAt: 1, updatedAt: 1,
  }]
  const coordinator = bootstrap.initializeChatRoomAgentCoordinator()
  expect(resumeListeners.size).toBe(1)
  for (const listener of resumeListeners) listener()
  for (let attempt = 0; attempt < 20 && gatewayStatusReads === 0; attempt++) await Promise.resolve()
  expect(gatewayStatusReads).toBeGreaterThan(0)
  await bootstrap.disposeChatRoomAgentCoordinator()
  expect(resumeListeners.size).toBe(0)
  expect(coordinator).toBeDefined()
  roomFixtures = []
})

test('Given 账号A coordinator已绑定身份 When 登录账号B后恢复 Then 替换coordinator并为B创建身份绑定store', async () => {
  cachedUserId = 'account-a'
  const coordinatorA = bootstrap.initializeChatRoomAgentCoordinator()
  expect(resumeListeners.size).toBe(1)
  expect(storeIdentities.at(-1)).toEqual({ identity: { hostUserId: 'account-a', deviceId: 'device-production' } })

  cachedUserId = 'account-b'
  await bootstrap.resumeChatRoomAgentCoordinatorAfterAuthentication()
  const coordinatorB = coordinatorModule.getChatRoomAgentCoordinator()

  expect(coordinatorB).not.toBe(coordinatorA)
  expect(resumeListeners.size).toBe(1)
  expect(storeIdentities.at(-1)).toEqual({ identity: { hostUserId: 'account-b', deviceId: 'device-production' } })
  await bootstrap.disposeChatRoomAgentCoordinator()
  expect(resumeListeners.size).toBe(0)
})

test('Given A.dispose等待期间连续登录B/C When B与C恢复回调交错 Then 仅最新C注册store且B不重启旧租约', async () => {
  cachedUserId = 'account-a'
  const coordinatorA = bootstrap.initializeChatRoomAgentCoordinator() as unknown as {
    dispose: () => Promise<void>
    resumeAfterAuthentication: () => Promise<void>
  }
  let markDisposeStarted!: () => void
  let resolveDispose!: () => void
  const disposeStarted = new Promise<void>((resolve) => { markDisposeStarted = resolve })
  const disposeBarrier = new Promise<void>((resolve) => { resolveDispose = resolve })
  const originalDispose = coordinatorA.dispose.bind(coordinatorA)
  coordinatorA.dispose = async () => { markDisposeStarted(); await disposeBarrier; await originalDispose() }
  const originalResume = coordinatorA.resumeAfterAuthentication.bind(coordinatorA)
  let oldResumeCalls = 0
  coordinatorA.resumeAfterAuthentication = async () => { oldResumeCalls++; await originalResume() }

  const registrations: ChatRoomAgentCoordinatorRegistration[] = []
  const detach = coordinatorModule.onChatRoomAgentCoordinatorRegistered((coordinator) => registrations.push(coordinator))
  cachedUserId = 'account-b'
  const resumeB = bootstrap.resumeChatRoomAgentCoordinatorAfterAuthentication()
  await disposeStarted
  cachedUserId = 'account-c'
  const resumeC = bootstrap.resumeChatRoomAgentCoordinatorAfterAuthentication()
  resolveDispose()
  await Promise.all([resumeB, resumeC])

  expect(storeIdentities).toEqual([
    { identity: { hostUserId: 'account-a', deviceId: 'device-production' } },
    { identity: { hostUserId: 'account-c', deviceId: 'device-production' } },
  ])
  const activeRegistrations = registrations.filter((coordinator): coordinator is NonNullable<typeof coordinator> => coordinator !== undefined)
  expect(activeRegistrations).toHaveLength(2)
  expect(coordinatorModule.getChatRoomAgentCoordinator()).toBe(activeRegistrations[1]!)
  expect(oldResumeCalls).toBe(0)
  detach()
  await bootstrap.disposeChatRoomAgentCoordinator()
})

test('Given A到B恢复等待A.dispose期间应用退出且C随后重新登录 When barrier释放 Then B不复活且C仍正常注册', async () => {
  cachedUserId = 'account-a'
  const coordinatorA = bootstrap.initializeChatRoomAgentCoordinator() as unknown as { dispose: () => Promise<void> }
  let resolveDispose!: () => void
  let markDisposeStarted!: () => void
  const disposeBarrier = new Promise<void>((resolve) => { resolveDispose = resolve })
  const disposeStarted = new Promise<void>((resolve) => { markDisposeStarted = resolve })
  const originalDispose = coordinatorA.dispose.bind(coordinatorA)
  coordinatorA.dispose = async () => { markDisposeStarted(); await disposeBarrier; await originalDispose() }

  cachedUserId = 'account-b'
  const resumeB = bootstrap.resumeChatRoomAgentCoordinatorAfterAuthentication()
  await disposeStarted
  const appDispose = bootstrap.disposeChatRoomAgentCoordinator()
  cachedUserId = 'account-c'
  const resumeC = bootstrap.resumeChatRoomAgentCoordinatorAfterAuthentication()
  resolveDispose()
  await Promise.all([resumeB, appDispose, resumeC])

  expect(storeIdentities).toEqual([
    { identity: { hostUserId: 'account-a', deviceId: 'device-production' } },
    { identity: { hostUserId: 'account-c', deviceId: 'device-production' } },
  ])
  expect(coordinatorModule.getChatRoomAgentCoordinator()).not.toBe(coordinatorA)
  await bootstrap.disposeChatRoomAgentCoordinator()
})

test('Given A到B恢复等待A.dispose期间其它路径release registration When barrier释放 Then旧队列不能重新注册B', async () => {
  cachedUserId = 'account-a'
  const coordinatorA = bootstrap.initializeChatRoomAgentCoordinator() as unknown as { dispose: () => Promise<void> }
  let resolveDispose!: () => void
  let markDisposeStarted!: () => void
  const disposeBarrier = new Promise<void>((resolve) => { resolveDispose = resolve })
  const disposeStarted = new Promise<void>((resolve) => { markDisposeStarted = resolve })
  const originalDispose = coordinatorA.dispose.bind(coordinatorA)
  coordinatorA.dispose = async () => { markDisposeStarted(); await disposeBarrier; await originalDispose() }

  cachedUserId = 'account-b'
  const resumeB = bootstrap.resumeChatRoomAgentCoordinatorAfterAuthentication()
  await disposeStarted
  bootstrap.releaseChatRoomAgentCoordinatorRegistration()
  resolveDispose()
  await resumeB

  expect(storeIdentities).toEqual([{ identity: { hostUserId: 'account-a', deviceId: 'device-production' } }])
  expect(() => coordinatorModule.getChatRoomAgentCoordinator()).toThrow('聊天室协调器尚未注册')
})

test('Given 旧coordinator dispose失败但logout stop成功 When 切换账号 Then fallback安全停止A后才注册B', async () => {
  cachedUserId = 'account-a'
  const coordinatorA = bootstrap.initializeChatRoomAgentCoordinator() as unknown as {
    dispose: () => Promise<void>
    stopAll: (reason: 'logout' | 'gateway_disconnected' | 'app_quit') => Promise<unknown>
  }
  coordinatorA.dispose = async () => { throw new Error('dispose failed') }
  const originalStop = coordinatorA.stopAll.bind(coordinatorA)
  const stopReasons: string[] = []
  coordinatorA.stopAll = async (reason) => { stopReasons.push(reason); return originalStop(reason) }

  cachedUserId = 'account-b'
  await bootstrap.resumeChatRoomAgentCoordinatorAfterAuthentication()

  expect(stopReasons).toEqual(['logout'])
  expect(storeIdentities.at(-1)).toEqual({ identity: { hostUserId: 'account-b', deviceId: 'device-production' } })
  expect(coordinatorModule.getChatRoomAgentCoordinator()).not.toBe(coordinatorA)
  await bootstrap.disposeChatRoomAgentCoordinator()
})

test('Given dispose与fallback stop都失败 When 切换账号 Then 不注册B也不再暴露旧A coordinator', async () => {
  cachedUserId = 'account-a'
  const coordinatorA = bootstrap.initializeChatRoomAgentCoordinator() as unknown as {
    dispose: () => Promise<void>
    stopAll: (reason: 'logout' | 'gateway_disconnected' | 'app_quit') => Promise<unknown>
  }
  coordinatorA.dispose = async () => { throw new Error('dispose failed') }
  let stopReason: string | undefined
  coordinatorA.stopAll = async (reason) => { stopReason = reason; throw new Error('stop failed') }

  cachedUserId = 'account-b'
  await expect(bootstrap.resumeChatRoomAgentCoordinatorAfterAuthentication()).rejects.toThrow('无法安全停止')

  expect(stopReason).toBe('logout')
  expect(storeIdentities).toEqual([{ identity: { hostUserId: 'account-a', deviceId: 'device-production' } }])
  expect(() => coordinatorModule.getChatRoomAgentCoordinator()).toThrow('聊天室协调器尚未注册')
})

test('Given coordinator 已解析精确 room lease pair When production adapter 释放 Then 不通过 roomAgentId 反查上下文', async () => {
  const coordinator = bootstrap.initializeChatRoomAgentCoordinator()
  const deps = (coordinator as unknown as { deps: { rustApi: { releaseAgentLeases: (input: unknown) => Promise<void> } } }).deps
  await deps.rustApi.releaseAgentLeases({
    roomAgentIds: ['same-agent'],
    leases: [{ roomId: 'room-exact', roomAgentId: 'same-agent' }],
    reason: 'gateway_disconnected',
  })
  expect(rustCalls.at(-1)).toEqual({
    method: 'release',
    input: {
      roomAgentIds: ['same-agent'],
      leases: [{ roomId: 'room-exact', roomAgentId: 'same-agent' }],
      reason: 'gateway_disconnected',
      deviceId: 'device-production',
    },
  })
  bootstrap.releaseChatRoomAgentCoordinatorRegistration()
})
