import { afterEach, expect, test } from 'bun:test'
import type { ChatRoomAgentLocalConfig, ChatRoomLocalRoomConfig } from '@copis/shared'
import { ChatRoomReadinessCoordinator, ChatRoomReadinessError, type ChatRoomReadinessApi, type ChatRoomReadinessStatus } from './chatroom-readiness-coordinator'

const room: ChatRoomLocalRoomConfig = {
  roomId: 'room-1', hostUserId: 'host-1', deviceId: 'device-1', lastProcessedSeq: 0,
  createdAt: 1, updatedAt: 1, invocations: [],
  agents: [{ roomAgentId: 'agent-1', displayName: 'A', sourceWorkspaceId: 'workspace-1', sessionId: 'session-1', channelId: 'channel-1', modelId: 'model-1', contextMessageCount: 20, memorySharingEnabled: false, skillSharingEnabled: false }],
}

let coordinator: ChatRoomReadinessCoordinator | undefined
afterEach(async () => { await coordinator?.dispose(); coordinator = undefined })

function fixture(overrides: {
  status?: () => Promise<ChatRoomReadinessStatus>
  ready?: (roomAgentId: string, signal: AbortSignal) => Promise<unknown>
  unready?: (roomAgentId: string, signal: AbortSignal) => Promise<unknown>
  identity?: () => { hostUserId: string; deviceId: string } | undefined
  remoteHost?: () => string | Promise<string>
  check?: (agent: ChatRoomAgentLocalConfig) => Promise<{ available: boolean; reason?: string; permanent?: boolean }>
  managementPending?: boolean | (() => boolean)
  retryBaseMs?: number
} = {}) {
  const calls: string[] = []
  const states: Array<{ roomAgentId: string; availability: string; reason?: string }> = []
  let currentRoom = room
  let currentIdentity = { hostUserId: 'host-1', deviceId: 'device-1' }
  const api: ChatRoomReadinessApi = {
    getRoomHostUserId: async () => overrides.remoteHost?.() ?? 'host-1',
    getRoomRealtimeStatus: overrides.status ?? (async () => ({ ready: true, epoch: 1, capabilityState: 'ready', mode: 'modern', socketGeneration: 7, snapshotReady: true, selectedCapabilities: ['agent-ready-v1'] })),
    readyAgent: async (_roomId, roomAgentId, options) => { calls.push(`ready:${roomAgentId}`); return overrides.ready?.(roomAgentId, options!.signal!) ?? { outcome: 'confirmed', mode: 'agent-ready-v1', source: 'private-ack', requestId: 'req-1', roomId: 'room-1', roomAgentId, command: 'agent.ready', generation: 7 } },
    unreadyAgent: async (_roomId, roomAgentId, options) => { calls.push(`unready:${roomAgentId}`); return overrides.unready?.(roomAgentId, options!.signal!) ?? { outcome: 'confirmed', mode: 'agent-ready-v1', source: 'private-ack', requestId: 'req-2', roomId: 'room-1', roomAgentId, command: 'agent.unready', generation: 7 } },
  }
  coordinator = new ChatRoomReadinessCoordinator({
    store: { read: (roomId) => roomId === currentRoom.roomId ? currentRoom : undefined },
    api,
    getIdentity: overrides.identity ?? (() => currentIdentity),
    hasPendingManagement: () => typeof overrides.managementPending === 'function' ? overrides.managementPending() : overrides.managementPending ?? false,
    checkAgent: overrides.check ?? (async () => ({ available: true })),
    onStateChanged: (state) => states.push({ roomAgentId: state.roomAgentId, availability: state.availability, reason: state.reason }),
    retryBaseMs: overrides.retryBaseMs ?? 60_000,
  })
  return {
    calls, states,
    setRoom: (value: ChatRoomLocalRoomConfig) => { currentRoom = value },
    setIdentity: (value: { hostUserId: string; deviceId: string } | undefined) => { currentIdentity = value as typeof currentIdentity },
  }
}

test('快照尚未到时只报告 preparing，不宣告 ready', async () => {
  const { calls, states } = fixture({ status: async () => ({ ready: false, epoch: 1, capabilityState: 'preparing', mode: 'legacy', socketGeneration: 7, snapshotReady: false, selectedCapabilities: [] }) })
  await coordinator!.reconcileRoomAgents('room-1')
  expect(calls).toEqual([])
  expect(states.at(-1)).toMatchObject({ roomAgentId: 'agent-1', availability: 'preparing' })
})

test('初始 snapshot 未到但后续同 socket 快照到达时自动 ready，无需再次 provision', async () => {
  let statusCalls = 0
  const { calls } = fixture({ retryBaseMs: 2, status: async () => {
    statusCalls++
    return statusCalls === 1
      ? { ready: false, epoch: 1, capabilityState: 'preparing', mode: 'legacy', socketGeneration: 7, snapshotReady: false, selectedCapabilities: [] }
      : { ready: true, epoch: 1, capabilityState: 'ready', mode: 'modern', socketGeneration: 7, snapshotReady: true, selectedCapabilities: ['agent-ready-v1'] }
  } })
  await coordinator!.reconcileRoomAgents('room-1')
  await new Promise((resolve) => setTimeout(resolve, 15))
  expect(calls.filter((call) => call === 'ready:agent-1')).toHaveLength(1)
})

test('现代 snapshot 与本机 runtime 可用且 private ACK 同代际后才报告 online', async () => {
  const { calls, states } = fixture()
  await coordinator!.reconcileRoomAgents('room-1')
  expect(calls).toEqual(['ready:agent-1'])
  expect(states.at(-1)).toMatchObject({ roomAgentId: 'agent-1', availability: 'online' })
})

test('Given journal reports a target-specific pending removal When readiness reconciles Then confirm unready and never ready that Agent', async () => {
  const { calls, states } = fixture({ managementPending: true })
  await coordinator!.reconcileRoomAgents('room-1')
  expect(calls).toEqual(['unready:agent-1'])
  expect(states.at(-1)).toMatchObject({ roomAgentId: 'agent-1', availability: 'offline', reason: 'management_pending' })
})

test('Given removal journal becomes pending while runtime health check is awaiting When health returns Then do not issue ready', async () => {
  let pending = false
  let releaseCheck!: () => void
  let enteredCheck!: () => void
  const checkEntered = new Promise<void>((resolve) => { enteredCheck = resolve })
  const checkGate = new Promise<void>((resolve) => { releaseCheck = resolve })
  const { calls, states } = fixture({ managementPending: () => pending, check: async () => { enteredCheck(); await checkGate; return { available: true } } })
  const attempt = coordinator!.reconcileRoomAgents('room-1')
  await checkEntered
  pending = true
  releaseCheck()
  await attempt
  expect(calls).toEqual(['unready:agent-1'])
  expect(states.some((state) => state.availability === 'online')).toBe(false)
  expect(states.at(-1)).toMatchObject({ availability: 'offline', reason: 'management_pending' })
})

test('Given removal journal becomes pending while ready ACK is awaiting When the ready ACK arrives Then immediately confirm unready without publishing online', async () => {
  let pending = false
  let releaseReady!: (value: unknown) => void
  let enteredReady!: () => void
  const readyEntered = new Promise<void>((resolve) => { enteredReady = resolve })
  const readyGate = new Promise<unknown>((resolve) => { releaseReady = resolve })
  const { calls, states } = fixture({ managementPending: () => pending, ready: async () => { enteredReady(); return readyGate } })
  const attempt = coordinator!.reconcileRoomAgents('room-1')
  await readyEntered
  pending = true
  releaseReady({ outcome: 'confirmed', mode: 'agent-ready-v1', source: 'private-ack', requestId: 'req-late-ready', roomId: 'room-1', roomAgentId: 'agent-1', command: 'agent.ready', generation: 7 })
  await attempt
  expect(calls).toEqual(['ready:agent-1', 'unready:agent-1'])
  expect(states.some((state) => state.availability === 'online')).toBe(false)
  expect(states.at(-1)).toMatchObject({ availability: 'offline', reason: 'management_pending' })
})

test('旧身份或其他设备配置不发送 ready', async () => {
  const { calls, states } = fixture({ identity: () => ({ hostUserId: 'other-host', deviceId: 'other-device' }) })
  await coordinator!.reconcileRoomAgents('room-1')
  expect(calls).toEqual([])
  expect(states.at(-1)).toMatchObject({ availability: 'offline', reason: 'host_unavailable' })
})

test('legacy capability 不发送 ready/unready，保留既有租约路径', async () => {
  const { calls } = fixture({ status: async () => ({ ready: true, epoch: 1, capabilityState: 'legacy', mode: 'legacy', socketGeneration: 7, snapshotReady: true, selectedCapabilities: [] }) })
  await coordinator!.reconcileRoomAgents('room-1')
  expect(calls).toEqual([])
})

test('被 dispose 取消的迟到 ACK 不推进 ready 状态', async () => {
  let resolveReady!: (value: unknown) => void
  const { states } = fixture({ ready: () => new Promise((resolve) => { resolveReady = resolve }) })
  const reconcile = coordinator!.reconcileRoomAgents('room-1')
  for (let i = 0; i < 10 && !resolveReady; i++) await Promise.resolve()
  await coordinator!.dispose()
  resolveReady({ outcome: 'confirmed', mode: 'agent-ready-v1', source: 'private-ack', requestId: 'req-1', roomId: 'room-1', roomAgentId: 'agent-1', generation: 7 })
  await reconcile
  expect(states.some((state) => state.availability === 'online')).toBe(false)
})

test('配置更新打断旧 room flight 并使用新配置启动 reconcile', async () => {
  let releaseOldCheck!: () => void
  let enteredOldCheck!: () => void
  const oldCheckEntered = new Promise<void>((resolve) => { enteredOldCheck = resolve })
  const oldCheck = new Promise<void>((resolve) => { releaseOldCheck = resolve })
  let checks = 0
  const { calls, setRoom } = fixture({ check: async () => { checks++; if (checks === 1) { enteredOldCheck(); await oldCheck } return { available: true } } })
  const oldAttempt = coordinator!.reconcileRoomAgents('room-1')
  await oldCheckEntered
  setRoom({ ...room, agents: [{ ...room.agents[0]!, channelId: 'channel-2' }] })
  await coordinator!.configurationChanged('room-1')
  releaseOldCheck()
  await oldAttempt
  expect(checks).toBe(2)
  expect(calls).toEqual(['ready:agent-1'])
})

test('连接代际失效后新 attempt 不被未结束的旧 I/O 占据', async () => {
  let releaseOldStatus!: () => void
  let enteredOldStatus!: () => void
  const oldStatusEntered = new Promise<void>((resolve) => { enteredOldStatus = resolve })
  const oldStatus = new Promise<void>((resolve) => { releaseOldStatus = resolve })
  let statusCalls = 0
  const { calls } = fixture({ status: async () => {
    statusCalls++
    if (statusCalls === 1) { enteredOldStatus(); await oldStatus }
    return { ready: true, epoch: 2, capabilityState: 'ready', mode: 'modern', socketGeneration: statusCalls === 1 ? 7 : 8, snapshotReady: true, selectedCapabilities: ['agent-ready-v1'] }
  } })
  const oldAttempt = coordinator!.reconcileRoomAgents('room-1')
  await oldStatusEntered
  coordinator!.invalidateConnection()
  await coordinator!.reconcileRoomAgents('room-1')
  releaseOldStatus()
  await oldAttempt
  expect(statusCalls).toBe(2)
  expect(calls).toEqual(['ready:agent-1'])
})

test('Rejected ready 在相同身份和连接代际的外部 resume/poll 下持续阻断', async () => {
  let readyCalls = 0
  const { calls } = fixture({ ready: async () => { readyCalls++; throw new ChatRoomReadinessError('stale', 'Rejected', 'stale_connection') } })
  await coordinator!.reconcileRoomAgents('room-1')
  await coordinator!.reconcileRoomAgents('room-1')
  expect(readyCalls).toBe(1)
  expect(calls).toEqual(['ready:agent-1'])
})

test('本机渠道或模型配置不可用时先确认 unready，再暴露配置异常', async () => {
  const { calls, states } = fixture({ check: async () => ({ available: false, reason: 'model_missing', permanent: true }) })
  await coordinator!.reconcileRoomAgents('room-1')
  expect(calls).toEqual(['unready:agent-1'])
  expect(states.at(-1)).toMatchObject({ availability: 'configuration_error', reason: 'model_missing' })
})

test('runtime 配置异常在同代 private unready ACK 未确认前保持 preparing', async () => {
  const { states } = fixture({
    check: async () => ({ available: false, reason: 'model_missing', permanent: true }),
    unready: async () => { throw new ChatRoomReadinessError('not confirmed', 'Unknown', 'lifecycle_unknown', 503) },
  })
  await coordinator!.reconcileRoomAgents('room-1')
  expect(states.some((state) => state.availability === 'configuration_error')).toBe(false)
  expect(states.at(-1)).toMatchObject({ availability: 'preparing', reason: 'lifecycle_unknown' })
})

test('迟到的旧 socket ACK generation 不得报告 online', async () => {
  const { calls, states } = fixture({ ready: async () => ({ outcome: 'confirmed', mode: 'agent-ready-v1', source: 'private-ack', requestId: 'req-old', roomId: 'room-1', roomAgentId: 'agent-1', command: 'agent.ready', generation: 6 }) })
  await coordinator!.reconcileRoomAgents('room-1')
  expect(calls).toEqual(['ready:agent-1'])
  expect(states.some((state) => state.availability === 'online')).toBe(false)
  expect(states.at(-1)).toMatchObject({ availability: 'preparing', reason: 'ready_ack_unconfirmed' })
})

test('连接失效会立即使此前 online 状态回到 preparing', async () => {
  const { states } = fixture()
  await coordinator!.reconcileRoomAgents('room-1')
  expect(states.at(-1)?.availability).toBe('online')
  coordinator!.invalidateConnection()
  expect(states.at(-1)).toMatchObject({ availability: 'preparing', reason: 'connection_changed' })
})

test('初次 snapshot 等待期间身份切换时不发送旧身份 ready', async () => {
  let releaseStatus!: () => void
  let enteredStatus!: () => void
  const entered = new Promise<void>((resolve) => { enteredStatus = resolve })
  const gate = new Promise<void>((resolve) => { releaseStatus = resolve })
  const { calls, setIdentity } = fixture({ status: async () => { enteredStatus(); await gate; return {
    ready: true, epoch: 1, capabilityState: 'ready', mode: 'modern', socketGeneration: 7, snapshotReady: true, selectedCapabilities: ['agent-ready-v1'],
  } } })
  const attempt = coordinator!.reconcileRoomAgents('room-1')
  await entered
  setIdentity({ hostUserId: 'host-2', deviceId: 'device-2' })
  releaseStatus()
  await attempt
  expect(calls).toEqual([])
})

test('最终 status 等待期间身份切换或完整 Agent 配置变化时不报告 online', async () => {
  let releaseFinalStatus!: () => void
  let enteredFinalStatus!: () => void
  const entered = new Promise<void>((resolve) => { enteredFinalStatus = resolve })
  const gate = new Promise<void>((resolve) => { releaseFinalStatus = resolve })
  let statusCalls = 0
  const { states, setIdentity, setRoom } = fixture({ status: async () => {
    statusCalls++
    if (statusCalls === 2) { enteredFinalStatus(); await gate }
    return { ready: true, epoch: 1, capabilityState: 'ready', mode: 'modern', socketGeneration: 7, snapshotReady: true, selectedCapabilities: ['agent-ready-v1'] }
  } })
  const attempt = coordinator!.reconcileRoomAgents('room-1')
  await entered
  setIdentity({ hostUserId: 'host-2', deviceId: 'device-2' })
  setRoom({ ...room, agents: [{ ...room.agents[0]!, modelId: 'changed-model' }] })
  releaseFinalStatus()
  await attempt
  expect(states.some((state) => state.availability === 'online')).toBe(false)
})

test('invalidated A host lookup cannot publish preparing after B is online', async () => {
  let releaseA!: () => void
  let enterA!: () => void
  let hostCalls = 0
  let generation = 7
  const entered = new Promise<void>((resolve) => { enterA = resolve })
  const gate = new Promise<void>((resolve) => { releaseA = resolve })
  const { calls, states } = fixture({
    remoteHost: async () => {
      hostCalls++
      if (hostCalls === 1) { enterA(); await gate }
      return 'host-1'
    },
    status: async () => ({ ready: true, epoch: generation, capabilityState: 'ready', mode: 'modern', socketGeneration: generation, snapshotReady: true, selectedCapabilities: ['agent-ready-v1'] }),
    ready: async (_agentId) => ({ outcome: 'confirmed', mode: 'agent-ready-v1', source: 'private-ack', requestId: 'req', roomId: 'room-1', roomAgentId: 'agent-1', command: 'agent.ready', generation }),
  })
  const attemptA = coordinator!.reconcileRoomAgents('room-1')
  await entered
  coordinator!.invalidateConnection()
  generation = 8
  await coordinator!.reconcileRoomAgents('room-1')
  expect(states.at(-1)?.availability).toBe('online')
  const stateCountAfterB = states.length
  releaseA()
  await attemptA
  expect(states).toHaveLength(stateCountAfterB)
  expect(states.at(-1)?.availability).toBe('online')
  expect(calls).toEqual(['ready:agent-1'])
})

test('configurationChanged B status stays authoritative when cancelled A initial status returns late', async () => {
  let releaseA!: () => void
  let enterA!: () => void
  let statusCalls = 0
  let generation = 7
  const entered = new Promise<void>((resolve) => { enterA = resolve })
  const gate = new Promise<void>((resolve) => { releaseA = resolve })
  const { calls, states } = fixture({
    status: async () => {
      statusCalls++
      if (statusCalls === 1) {
        enterA()
        await gate
        return { ready: true, epoch: 1, capabilityState: 'ready', mode: 'modern', socketGeneration: 7, snapshotReady: true, selectedCapabilities: ['agent-ready-v1'] }
      }
      return { ready: true, epoch: 2, capabilityState: 'ready', mode: 'modern', socketGeneration: generation, snapshotReady: true, selectedCapabilities: ['agent-ready-v1'] }
    },
    ready: async (_agentId) => ({ outcome: 'confirmed', mode: 'agent-ready-v1', source: 'private-ack', requestId: 'req', roomId: 'room-1', roomAgentId: 'agent-1', command: 'agent.ready', generation }),
  })
  const attemptA = coordinator!.reconcileRoomAgents('room-1')
  await entered
  generation = 8
  await coordinator!.configurationChanged('room-1')
  expect(states.at(-1)?.availability).toBe('online')
  const stateCountAfterB = states.length
  releaseA()
  await attemptA
  expect(states).toHaveLength(stateCountAfterB)
  expect(states.at(-1)?.availability).toBe('online')
  expect(calls).toEqual(['ready:agent-1'])
})

test('同代最终 status 已 preparing、not ready 或撤销 ready capability 时不报告 online', async () => {
  for (const finalStatus of [
    { ready: false, capabilityState: 'ready' as const, capabilities: ['agent-ready-v1'] },
    { ready: true, capabilityState: 'preparing' as const, capabilities: ['agent-ready-v1'] },
    { ready: true, capabilityState: 'ready' as const, capabilities: [] },
  ]) {
    let statusCalls = 0
    const { states } = fixture({ status: async () => {
      statusCalls++
      return {
        ready: statusCalls === 1 || finalStatus.ready,
        epoch: 1,
        capabilityState: statusCalls === 1 ? 'ready' : finalStatus.capabilityState,
        mode: 'modern', socketGeneration: 7, snapshotReady: true,
        selectedCapabilities: statusCalls === 1 ? ['agent-ready-v1'] : finalStatus.capabilities,
      }
    } })
    await coordinator!.reconcileRoomAgents('room-1')
    expect(states.some((state) => state.availability === 'online')).toBe(false)
    await coordinator!.dispose()
    coordinator = undefined
  }
})

test('stale Rejected 跨 socket invalidation 和自动 config reconcile 持久阻断，隔离其它 Agent，仅显式恢复解除', async () => {
  let generation = 7
  let rejected = true
  const agentB = { ...room.agents[0]!, roomAgentId: 'agent-2', displayName: 'B', sessionId: 'session-2' }
  const { calls, setRoom } = fixture({
    status: async () => ({ ready: true, epoch: generation, capabilityState: 'ready', mode: 'modern', socketGeneration: generation, snapshotReady: true, selectedCapabilities: ['agent-ready-v1'] }),
    ready: async (_roomAgentId, _signal) => {
      if (_roomAgentId === 'agent-1' && rejected) throw new ChatRoomReadinessError('stale text', 'Rejected', 'lifecycle_rejected', 409)
      return { outcome: 'confirmed', mode: 'agent-ready-v1', source: 'private-ack', requestId: 'req', roomId: 'room-1', roomAgentId: _roomAgentId, command: 'agent.ready', generation }
    },
  })
  setRoom({ ...room, agents: [room.agents[0]!, agentB] })
  await coordinator!.reconcileRoomAgents('room-1')
  generation = 8
  coordinator!.invalidateConnection()
  await coordinator!.reconcileRoomAgents('room-1')
  await coordinator!.configurationChanged('room-1')
  expect(calls.filter((call) => call === 'ready:agent-1')).toHaveLength(1)
  expect(calls.filter((call) => call === 'ready:agent-2').length).toBeGreaterThan(1)
  rejected = false
  await coordinator!.authorizeRecovery('room-1', 'agent-1')
  expect(calls.filter((call) => call === 'ready:agent-1')).toHaveLength(2)
})

test('401 Rejected 需明确 authentication refresh 才解除，网络恢复本身不封死账号', async () => {
  let authenticated = false
  let readyCalls = 0
  const { calls } = fixture({ ready: async () => {
    readyCalls++
    if (!authenticated) throw new ChatRoomReadinessError('login required', 'Rejected', 'not_authenticated', 401)
    return { outcome: 'confirmed', mode: 'agent-ready-v1', source: 'private-ack', requestId: 'req', roomId: 'room-1', roomAgentId: 'agent-1', command: 'agent.ready', generation: 7 }
  } })
  await coordinator!.reconcileRoomAgents('room-1')
  coordinator!.invalidateConnection()
  await coordinator!.reconcileRoomAgents('room-1')
  expect(readyCalls).toBe(1)
  authenticated = true
  coordinator!.authenticationRefreshed()
  await coordinator!.reconcileRoomAgents('room-1')
  expect(calls.filter((call) => call === 'ready:agent-1')).toHaveLength(2)
})

test('503 Unknown 不形成永久阻断，下一次网络恢复后的 reconcile 可 ready', async () => {
  let failed = true
  let statusReads = 0
  const { calls } = fixture({ status: async () => {
    statusReads++
    if (failed) throw new ChatRoomReadinessError('temporary', 'Unknown', 'lifecycle_unavailable', 503)
    return { ready: true, epoch: 7, capabilityState: 'ready', mode: 'modern', socketGeneration: 7, snapshotReady: true, selectedCapabilities: ['agent-ready-v1'] }
  } })
  await coordinator!.reconcileRoomAgents('room-1')
  failed = false
  await coordinator!.reconcileRoomAgents('room-1')
  expect(statusReads).toBe(3)
  expect(calls).toEqual(['ready:agent-1'])
})

test('账号与可信本机room identity切换后新身份可以重新 reconcile', async () => {
  let remoteHost = 'host-1'
  let generation = 7
  let blocked = true
  const { calls, setIdentity, setRoom } = fixture({
    remoteHost: () => remoteHost,
    status: async () => ({ ready: true, epoch: generation, capabilityState: 'ready', mode: 'modern', socketGeneration: generation, snapshotReady: true, selectedCapabilities: ['agent-ready-v1'] }),
    ready: async (_agentId, _signal) => {
      if (blocked) throw new ChatRoomReadinessError('ownership changed', 'Rejected', 'lifecycle_rejected', 409)
      return { outcome: 'confirmed', mode: 'agent-ready-v1', source: 'private-ack', requestId: 'req', roomId: 'room-1', roomAgentId: 'agent-1', command: 'agent.ready', generation }
    },
  })
  await coordinator!.reconcileRoomAgents('room-1')
  setIdentity({ hostUserId: 'host-2', deviceId: 'device-2' })
  setRoom({ ...room, hostUserId: 'host-2', deviceId: 'device-2' })
  remoteHost = 'host-2'
  generation = 8
  blocked = false
  await coordinator!.reconcileRoomAgents('room-1')
  expect(calls).toEqual(['ready:agent-1', 'ready:agent-1'])
})
