import { accessSync, constants, existsSync, lstatSync, readFileSync } from 'node:fs'
import * as electron from 'electron'
import type { ChatRoomInvocationReportContext } from './chatroom-rust-client'
import { ChatRoomAgentCoordinator, getChatRoomAgentCoordinator, registerChatRoomAgentCoordinator } from './chatroom-agent-coordinator'
import { ChatRoomWorkspaceStore } from './chatroom-workspace-store'
import { createChatRoomHiddenSessionStore } from './chatroom-hidden-session-store'
import { registerAgentSessionStorageOverride } from './agent-session-manager'
import { syncChatRoomAgentSkillSnapshot } from './chatroom-skill-snapshot'
import { HttpChatRoomRustApiClient } from './chatroom-rust-client'
import { ChatRoomManagementClient } from './chatroom-management-client'
import { ChatRoomManagementJournal } from './chatroom-management-journal'
import { getOrCreateClientDeviceId } from './client-device-id'
import { getWorkingApiClient } from './working-api-service'
import { listConfiguredChannels, decryptApiKey } from './channel-manager'
import { runAgentHeadless, stopAgent, agentEventBus } from './agent-service'
import { ChatRoomReadinessCoordinator } from './chatroom-readiness-coordinator'
import { watchChatRoomReadinessConfig } from './chatroom-readiness-config-watcher'
import { getPiWorkerRuntimeAvailability, type PiWorkerRuntimeAvailability } from './http-api-server'
import { getAgentWorkspacesIndexPath, getChannelsPath, getConfigDir, getChatRoomAgentProjectPath, getChatRoomAgentSessionDir, getChatRoomAgentSessionMetaPath, getChatRoomAgentSessionMessagesPath, getWorkspaceFilesDir } from './config-paths'
import { getLocalProjectRootStatus } from './agent-workspace-manager'
import { createBuiltinChannels, isCopisWorkingChannelId, withDefaultProviderModels, type AgentWorkspace, type Channel } from '@copis/shared'
import type { ChatRoomLocalIdentity } from '@copis/shared'

let registrationRelease: (() => void) | undefined
let registrationIdentity: ChatRoomLocalIdentity | undefined
let powerResumeCleanup: (() => void) | undefined
let readinessConfigCleanup: (() => void) | undefined
let authenticationResumeEpoch = 0
let authenticationResumeQueue: Promise<void> = Promise.resolve()
const powerMonitor = electron.powerMonitor

function readAgentWorkspaceReadOnly(workspaceId: string): AgentWorkspace | undefined {
  try {
    const indexPath = getAgentWorkspacesIndexPath()
    if (!lstatSync(indexPath).isFile()) return undefined
    const parsed: unknown = JSON.parse(readFileSync(indexPath, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { workspaces?: unknown }).workspaces)) return undefined
    return (parsed as { workspaces: unknown[] }).workspaces.find((workspace): workspace is AgentWorkspace =>
      Boolean(workspace && typeof workspace === 'object' && (workspace as AgentWorkspace).id === workspaceId
        && typeof (workspace as AgentWorkspace).slug === 'string'))
  } catch { return undefined }
}

function readChannelReadinessConfig(): { channels: Channel[]; corrupt: boolean } {
  try {
    const path = getChannelsPath()
    if (!existsSync(path)) return { channels: [], corrupt: false }
    if (!lstatSync(path).isFile()) return { channels: [], corrupt: true }
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (!value || typeof value !== 'object' || !Array.isArray((value as { channels?: unknown }).channels)) return { channels: [], corrupt: true }
    const channels = (value as { channels: unknown[] }).channels.filter((channel): channel is Channel =>
      Boolean(channel && typeof channel === 'object' && typeof (channel as Channel).id === 'string'
        && typeof (channel as Channel).provider === 'string' && Array.isArray((channel as Channel).models)))
    if (channels.length !== (value as { channels: unknown[] }).channels.length) return { channels: [], corrupt: true }
    return { channels: channels.map((channel) => ({ ...channel, models: withDefaultProviderModels(channel.provider, channel.models) })), corrupt: false }
  } catch { return { channels: [], corrupt: true } }
}

function hasConfiguredChannelCredentials(channel: Channel): boolean {
  try {
    if (!electron.safeStorage?.isEncryptionAvailable() || typeof channel.apiKey !== 'string' || !channel.apiKey.trim()) return false
    return electron.safeStorage.decryptString(Buffer.from(channel.apiKey, 'base64')).trim().length > 0
  } catch { return false }
}

function directoryIsUsable(path: string, writable = false): boolean {
  try {
    const stats = lstatSync(path)
    if (!stats.isDirectory()) return false
    accessSync(path, constants.R_OK | constants.X_OK | (writable ? constants.W_OK : 0))
    return true
  } catch { return false }
}

export function checkChatRoomAgentRuntimeReadiness(
  roomId: string,
  agent: import('@copis/shared').ChatRoomAgentLocalConfig,
  piWorker: PiWorkerRuntimeAvailability,
): { available: boolean; reason?: string; permanent?: boolean } {
  if (!piWorker.available) return { available: false, reason: piWorker.reason, permanent: true }
  const workspace = readAgentWorkspaceReadOnly(agent.sourceWorkspaceId)
  if (!workspace) return { available: false, reason: 'source_workspace_missing', permanent: true }
  if (workspace.projectRootPath && getLocalProjectRootStatus(workspace.projectRootPath) !== 'available') {
    return { available: false, reason: 'source_workspace_unavailable', permanent: true }
  }
  const workspaceRoot = workspace.projectRootPath ?? getWorkspaceFilesDir(workspace.slug)
  if (!directoryIsUsable(workspaceRoot)) return { available: false, reason: 'source_workspace_unavailable', permanent: true }
  const builtinChannel = createBuiltinChannels(getWorkingApiClient().baseUrl).find((item) => item.id === agent.channelId)
  const configured = readChannelReadinessConfig()
  if (configured.corrupt) return { available: false, reason: 'channel_config_corrupt', permanent: true }
  const channel = builtinChannel ?? configured.channels.find((item) => item.id === agent.channelId)
  if (!channel || !channel.enabled) return { available: false, reason: 'channel_disabled_or_missing', permanent: true }
  const activeModels = channel.models.filter((model) => model.enabled)
  if (activeModels.length === 0
    || (agent.modelId !== undefined && !activeModels.some((model) => model.id === agent.modelId))) {
    return { available: false, reason: 'model_missing', permanent: true }
  }
  if (!isCopisWorkingChannelId(agent.channelId) && !hasConfiguredChannelCredentials(channel)) {
    return { available: false, reason: 'channel_credentials_unavailable', permanent: true }
  }
  if (!agent.sessionId
    || !directoryIsUsable(getChatRoomAgentSessionDir(roomId, agent.roomAgentId), true)
    || !directoryIsUsable(getChatRoomAgentProjectPath(roomId, agent.roomAgentId), true)) {
    return { available: false, reason: 'hidden_session_unavailable', permanent: true }
  }
  const metaPath = getChatRoomAgentSessionMetaPath(roomId, agent.roomAgentId)
  const messagesPath = getChatRoomAgentSessionMessagesPath(roomId, agent.roomAgentId)
  try {
    if (existsSync(metaPath)) {
      if (!lstatSync(metaPath).isFile()) return { available: false, reason: 'hidden_session_corrupt', permanent: true }
      const meta: unknown = JSON.parse(readFileSync(metaPath, 'utf8'))
      const metaRecord = meta && typeof meta === 'object' ? meta as Record<string, unknown> : undefined
      const createdAt = metaRecord?.createdAt
      const updatedAt = metaRecord?.updatedAt
      if (!meta || typeof meta !== 'object'
        || metaRecord!.id !== agent.sessionId
        || typeof metaRecord!.title !== 'string'
        || !metaRecord!.title
        || !Number.isSafeInteger(createdAt) || (createdAt as number) < 0
        || !Number.isSafeInteger(updatedAt) || (updatedAt as number) < (createdAt as number)
        || metaRecord!.agentRuntime !== 'pi'
        || metaRecord!.channelId !== agent.channelId
        || metaRecord!.modelId !== agent.modelId
        || metaRecord!.workspaceId !== agent.sourceWorkspaceId) {
        return { available: false, reason: 'hidden_session_corrupt', permanent: true }
      }
    } else if (existsSync(messagesPath)) {
      return { available: false, reason: 'hidden_session_corrupt', permanent: true }
    }
    if (existsSync(messagesPath) && !lstatSync(messagesPath).isFile()) return { available: false, reason: 'hidden_session_corrupt', permanent: true }
  } catch { return { available: false, reason: 'hidden_session_corrupt', permanent: true } }
  return { available: true }
}

function getAuthenticatedIdentity(): ChatRoomLocalIdentity | undefined {
  const userId = getWorkingApiClient().getCachedUser()?.id
  if (userId === undefined || userId === null || String(userId).trim().length === 0) return undefined
  return { hostUserId: String(userId), deviceId: getOrCreateClientDeviceId() }
}

function sameIdentity(left: ChatRoomLocalIdentity | undefined, right: ChatRoomLocalIdentity | undefined): boolean {
  return left?.hostUserId === right?.hostUserId && left?.deviceId === right?.deviceId
}

function releaseRegistrationIfCurrent(coordinator: ReturnType<typeof getChatRoomAgentCoordinator>, release: () => void): void {
  if (registrationRelease !== release) return
  try { if (getChatRoomAgentCoordinator() !== coordinator) return } catch { return }
  release()
  if (registrationRelease === release) {
    registrationRelease = undefined
    registrationIdentity = undefined
  }
}

function getInvocationContext(store: ChatRoomWorkspaceStore, invocationId: string): ChatRoomInvocationReportContext | undefined {
  for (const room of store.listRestorableRooms()) {
    const invocation = room.invocations.find((candidate) => candidate.invocationId === invocationId)
    if (!invocation) continue
    const agent = room.agents.find((candidate) => candidate.roomAgentId === invocation.targetAgentId)
    if (!agent) return undefined
    return {
      roomId: room.roomId,
      agentId: agent.roomAgentId,
      deviceId: room.deviceId,
      // 保留既有发送方作用域稳定 ID，避免破坏已提交回复的幂等键。
      clientMessageId: invocation.triggerMessageId,
      traceId: invocation.traceId,
      targetAgentId: invocation.targetAgentId,
      triggerMessageId: invocation.triggerMessageId,
      depth: invocation.depth,
    }
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
  const identity = getAuthenticatedIdentity()
  const store = identity ? new ChatRoomWorkspaceStore({ identity }) : new ChatRoomWorkspaceStore()
  const deviceId = identity?.deviceId ?? getOrCreateClientDeviceId()
  const client = new HttpChatRoomRustApiClient({ getInvocationContext: (invocationId) => getInvocationContext(store, invocationId) })
  const management = new ChatRoomManagementClient()
  const managementJournal = new ChatRoomManagementJournal()
  const readiness = new ChatRoomReadinessCoordinator({
    store,
    api: {
      getRoomHostUserId: (roomId, options) => management.getRoomHostUserId(roomId, options),
      getRoomRealtimeStatus: (roomId, options) => management.getRoomRealtimeStatus(roomId, options),
      readyAgent: (roomId, roomAgentId, options) => management.readyAgent(roomId, roomAgentId, options),
      unreadyAgent: (roomId, roomAgentId, options) => management.unreadyAgent(roomId, roomAgentId, options),
    },
    getIdentity: getAuthenticatedIdentity,
    hasPendingManagement: (roomId, roomAgentId, currentIdentity) => managementJournal.hasPendingForAgent(currentIdentity, roomId, roomAgentId),
    checkAgent: async (agent, room) => checkChatRoomAgentRuntimeReadiness(room.roomId, agent, getPiWorkerRuntimeAvailability()),
  })
  const coordinator = new ChatRoomAgentCoordinator({
    store,
    managementJournal,
    rustApi: {
      getRoomHostUserId: (roomId) => management.getRoomHostUserId(roomId),
      getRoomAgentRoster: (roomId, options) => management.getRoomAgentRoster(roomId, options),
      getRoomRealtimeStatus: (roomId) => management.getRoomRealtimeStatus(roomId),
      registerAgent: (input) => management.registerAgent(input),
      lookupManagementOperation: (input) => management.lookupManagementOperation(input),
      unregisterAgent: (roomId, agentId, operation) => management.unregisterAgent(roomId, agentId, operation),
      probeAgentManagementVersion: () => management.probeAgentManagementVersion(),
      updateAgentSharing: (input) => management.updateAgentSharing(input),
      renewAgentLease: (roomId, agentId, id) => management.renewAgentLease(roomId, agentId, id),
      reportAccepted: (input, options) => client.reportAccepted(input, options),
      reportRunning: (input, options) => client.reportRunning(input, options),
      reportDelta: (input) => client.reportDelta(input),
      reportCompleted: (input, options) => client.reportCompleted(input, options),
      reportFailed: (input, options) => client.reportFailed(input, options),
      queryInvocationStatus: (input, options) => client.queryInvocationStatus(input, options),
      releaseAgentLeases: async ({ roomAgentIds, leases, reason }) => {
        if (leases.length !== roomAgentIds.length || leases.some((lease, index) => lease.roomAgentId !== roomAgentIds[index])) throw new Error('聊天室 lease 上下文不可用')
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
    readiness,
    now: () => Date.now(),
  })
  try {
    const release = registerChatRoomAgentCoordinator(coordinator)
    registrationRelease = () => {
      powerResumeCleanup?.()
      powerResumeCleanup = undefined
      readinessConfigCleanup?.()
      readinessConfigCleanup = undefined
      release()
    }
    registrationIdentity = identity
    if (powerMonitor && typeof powerMonitor.on === 'function' && typeof powerMonitor.off === 'function') {
      const onResume = () => {
        readiness.invalidateConnection()
        try {
          for (const room of store.listRestorableRooms()) {
            if (room.hostUserId === identity?.hostUserId && room.deviceId === deviceId) {
              void readiness.reconcileRoomAgents(room.roomId).catch(() => console.warn('[聊天室] 唤醒后 Agent 就绪状态恢复失败'))
            }
          }
        } catch { console.warn('[聊天室] 唤醒后无法读取本地 Agent 配置') }
      }
      powerMonitor.on('resume', onResume)
      powerResumeCleanup = () => powerMonitor.off('resume', onResume)
    }
    readinessConfigCleanup = watchChatRoomReadinessConfig({
      directory: getConfigDir(),
      onChanged: () => {
        try {
          for (const room of store.listRestorableRooms()) {
            if (room.hostUserId === identity?.hostUserId && room.deviceId === deviceId) {
              void readiness.configurationChanged(room.roomId).catch(() => console.warn('[聊天室] 本地配置变化后 Agent 就绪状态同步失败'))
            }
          }
        } catch { console.warn('[聊天室] 本地配置变化后无法读取 Agent 配置') }
      },
    })
    coordinator.start()
    void coordinator.resumeLeases().catch(() => console.warn('[聊天室] 恢复 Agent 租约失败'))
    return coordinator
  } catch (error) {
    registrationRelease?.()
    registrationRelease = undefined
    registrationIdentity = undefined
    throw error
  }
}

export function releaseChatRoomAgentCoordinatorRegistration(): void {
  authenticationResumeEpoch++
  registrationRelease?.()
  registrationRelease = undefined
  registrationIdentity = undefined
}

export function resumeChatRoomAgentCoordinatorAfterAuthentication(): Promise<void> {
  const epoch = ++authenticationResumeEpoch
  const operation = authenticationResumeQueue.then(() => reconcileCoordinatorIdentity(epoch))
  authenticationResumeQueue = operation.catch(() => undefined)
  return operation
}

async function reconcileCoordinatorIdentity(epoch: number): Promise<void> {
  if (epoch !== authenticationResumeEpoch) return
  const identity = getAuthenticatedIdentity()
  if (!identity) return
  if (!registrationRelease) {
    initializeChatRoomAgentCoordinator()
    return
  }
  if (sameIdentity(registrationIdentity, identity)) {
    const coordinator = getChatRoomAgentCoordinator()
    await coordinator.resumeAfterAuthentication?.()
    return
  }

  const previous = getChatRoomAgentCoordinator()
  const previousRelease = registrationRelease
  try {
    await previous.dispose()
  } catch {
    try {
      await previous.stopAll('logout')
    } catch {
      releaseRegistrationIfCurrent(previous, previousRelease)
      throw new Error('旧聊天室协调器无法安全停止；已解除其注册且未复用旧身份 store')
    }
  }

  releaseRegistrationIfCurrent(previous, previousRelease)
  if (epoch !== authenticationResumeEpoch) return

  // dispose 期间可能又登录了其它账号；新 store 始终取此刻的 Main 缓存身份。
  if (getAuthenticatedIdentity()) initializeChatRoomAgentCoordinator()
}

export async function disposeChatRoomAgentCoordinator(): Promise<void> {
  authenticationResumeEpoch++
  let coordinator: ReturnType<typeof getChatRoomAgentCoordinator>
  try { coordinator = getChatRoomAgentCoordinator() } catch (error) {
    registrationRelease?.()
    registrationRelease = undefined
    registrationIdentity = undefined
    throw error
  }
  const release = registrationRelease
  try { await coordinator.dispose() } finally {
    if (release) releaseRegistrationIfCurrent(coordinator, release)
  }
}
