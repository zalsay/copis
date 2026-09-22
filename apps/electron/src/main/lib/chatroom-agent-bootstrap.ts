import type { ChatRoomInvocationReportContext } from './chatroom-rust-client'
import { ChatRoomAgentCoordinator, getChatRoomAgentCoordinator, registerChatRoomAgentCoordinator } from './chatroom-agent-coordinator'
import { ChatRoomWorkspaceStore } from './chatroom-workspace-store'
import { createChatRoomHiddenSessionStore } from './chatroom-hidden-session-store'
import { registerAgentSessionStorageOverride } from './agent-session-manager'
import { syncChatRoomAgentSkillSnapshot } from './chatroom-skill-snapshot'
import { HttpChatRoomRustApiClient } from './chatroom-rust-client'
import { getOrCreateClientDeviceId } from './client-device-id'
import { getWorkingApiClient } from './working-api-service'
import { listConfiguredChannels, decryptApiKey } from './channel-manager'
import { runAgentHeadless, stopAgent, agentEventBus } from './agent-service'

let registrationRelease: (() => void) | undefined

function getInvocationContext(store: ChatRoomWorkspaceStore, invocationId: string): ChatRoomInvocationReportContext | undefined {
  for (const room of store.list()) {
    const invocation = room.invocations.find((candidate) => candidate.invocationId === invocationId)
    if (!invocation) continue
    const agent = room.agents.find((candidate) => candidate.roomAgentId === invocation.targetAgentId)
    if (!agent) return undefined
    return { roomId: room.roomId, agentId: agent.roomAgentId, deviceId: room.deviceId, clientMessageId: invocation.triggerMessageId }
  }
  return undefined
}

function getConfiguredSensitiveValues(): string[] {
  const values: string[] = []
  for (const channel of listConfiguredChannels()) {
    try {
      const value = decryptApiKey(channel.id)
      if (value.trim()) values.push(value)
    } catch { /* 钥匙串不可用时不读取明文，路径和输出清洗仍继续。 */ }
  }
  return values
}

export function initializeChatRoomAgentCoordinator(): ChatRoomAgentCoordinator {
  if (registrationRelease) return getChatRoomAgentCoordinator() as ChatRoomAgentCoordinator
  const store = new ChatRoomWorkspaceStore()
  const deviceId = getOrCreateClientDeviceId()
  const client = new HttpChatRoomRustApiClient({ getInvocationContext: (invocationId) => getInvocationContext(store, invocationId) })
  const coordinator = new ChatRoomAgentCoordinator({
    store,
    rustApi: {
      reportAccepted: (input) => client.reportAccepted(input),
      reportRunning: (input) => client.reportRunning(input),
      reportDelta: (input) => client.reportDelta(input),
      reportCompleted: (input, options) => client.reportCompleted(input, options),
      reportFailed: (input) => client.reportFailed(input),
      releaseAgentLeases: async ({ roomAgentIds, reason }) => {
        const leases = store.list().flatMap((room) => room.agents
          .filter((agent) => roomAgentIds.includes(agent.roomAgentId))
          .map((agent) => ({ roomId: room.roomId, roomAgentId: agent.roomAgentId })))
        if (leases.length !== roomAgentIds.length) throw new Error('聊天室 lease 上下文不可用')
        await client.releaseAgentLeases({ roomAgentIds, reason, deviceId, leases })
      },
    },
    getCurrentUserId: async () => {
      const id = getWorkingApiClient().getCachedUser()?.id
      return id === undefined ? undefined : String(id)
    },
    getDeviceId: () => deviceId,
    getSensitiveValues: getConfiguredSensitiveValues,
    runAgentHeadless,
    stopAgent,
    subscribeAgentEvents: (listener) => agentEventBus.on(listener),
    createHiddenSessionStore: createChatRoomHiddenSessionStore,
    registerSessionStorageOverride: registerAgentSessionStorageOverride,
    syncSkills: syncChatRoomAgentSkillSnapshot,
    now: () => Date.now(),
  })
  try {
    registrationRelease = registerChatRoomAgentCoordinator(coordinator)
    coordinator.start()
    return coordinator
  } catch (error) {
    registrationRelease?.()
    registrationRelease = undefined
    throw error
  }
}

export function releaseChatRoomAgentCoordinatorRegistration(): void {
  registrationRelease?.()
  registrationRelease = undefined
}

export async function disposeChatRoomAgentCoordinator(): Promise<void> {
  try { await getChatRoomAgentCoordinator().dispose() } finally { releaseChatRoomAgentCoordinatorRegistration() }
}
