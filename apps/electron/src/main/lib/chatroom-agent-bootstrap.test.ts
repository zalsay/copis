import { expect, mock, test } from 'bun:test'

const rustCalls: Array<{ method: string; input: unknown }> = []
mock.module('./chatroom-workspace-store', () => ({ ChatRoomWorkspaceStore: class { list() { return [] } read() { return undefined } } }))
mock.module('./chatroom-rust-client', () => ({ HttpChatRoomRustApiClient: class {
  reportAccepted = async (input: unknown) => { rustCalls.push({ method: 'accepted', input }) }
  reportRunning = async (input: unknown) => { rustCalls.push({ method: 'running', input }) }
  reportDelta = async (input: unknown) => { rustCalls.push({ method: 'delta', input }) }
  reportCompleted = async (input: unknown) => { rustCalls.push({ method: 'completed', input }) }
  reportFailed = async (input: unknown) => { rustCalls.push({ method: 'failed', input }) }
  releaseAgentLeases = async (input: unknown) => { rustCalls.push({ method: 'release', input }) }
} }))
mock.module('./client-device-id', () => ({ getOrCreateClientDeviceId: () => 'device-production' }))
mock.module('./working-api-service', () => ({ getWorkingApiClient: () => ({ getCachedUser: () => ({ id: 'user-production' }) }) }))
mock.module('./channel-manager', () => ({ listConfiguredChannels: () => [{ id: 'channel-secret' }], decryptApiKey: () => 'configured-secret' }))
mock.module('./agent-service', () => ({ runAgentHeadless: async () => {}, stopAgent: async () => {}, agentEventBus: { on: () => () => {} } }))
mock.module('./chatroom-hidden-session-store', () => ({ createChatRoomHiddenSessionStore: () => ({}) }))
mock.module('./agent-session-manager', () => ({ registerAgentSessionStorageOverride: () => () => {} }))
mock.module('./chatroom-skill-snapshot', () => ({ syncChatRoomAgentSkillSnapshot: () => ({ snapshotPath: '/tmp/skills', digest: 'a'.repeat(64), skillSlugs: [], syncedAt: Date.now() }), computeChatRoomSkillSnapshotDigest: () => 'a'.repeat(64) }))

const bootstrap = await import('./chatroom-agent-bootstrap')
const coordinatorModule = await import('./chatroom-agent-coordinator')

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
  await bootstrap.disposeChatRoomAgentCoordinator()
  expect(() => coordinatorModule.getChatRoomAgentCoordinator()).toThrow('聊天室协调器尚未注册')
})

test('Given production bootstrap initialized twice When initialize executes Then it reuses the authoritative coordinator', () => {
  const first = bootstrap.initializeChatRoomAgentCoordinator()
  expect(bootstrap.initializeChatRoomAgentCoordinator()).toBe(first)
  bootstrap.releaseChatRoomAgentCoordinatorRegistration()
})
