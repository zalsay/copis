import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const testHome = join(process.env.TMPDIR ?? '/tmp', `copis-chatroom-store-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)

mock.module('electron', () => ({ app: { isPackaged: false } }))
mock.module('node:os', () => ({ homedir: () => testHome }))

const {
  getChatRoomAgentInboxPath,
  getChatRoomAgentSkillsSnapshotPath,
  getChatRoomConfigPath,
  getChatRoomPath,
  getChatRoomsRootPath,
} = await import('./config-paths')
const { ChatRoomWorkspaceStore } = await import('./chatroom-workspace-store')
import type {
  ChatRoomAgentLocalConfig,
  ChatRoomInvocationRecord,
  ChatRoomLocalIdentity,
  ProvisionChatRoomAgentInput,
} from '@copis/shared'

const now = 1_700_000_000_000
const DAY = 24 * 60 * 60 * 1000
const identity: ChatRoomLocalIdentity = { hostUserId: 'host-1', deviceId: 'device-1' }

function makeStore(): InstanceType<typeof ChatRoomWorkspaceStore> {
  return new ChatRoomWorkspaceStore({ identity, now: () => now })
}

function makeInput(overrides: Partial<ProvisionChatRoomAgentInput> = {}): ProvisionChatRoomAgentInput {
  return {
    roomId: 'room-1',
    sourceWorkspaceId: 'workspace-1',
    displayName: 'Agent A',
    channelId: 'channel-1',
    ...overrides,
  }
}

function makeInvocation(overrides: Partial<ChatRoomInvocationRecord> = {}): ChatRoomInvocationRecord {
  return {
    invocationId: 'inv-1',
    roomId: 'room-1',
    traceId: 'trace-1',
    targetAgentId: 'agent-1',
    triggerMessageId: 'message-1',
    depth: 0,
    status: 'completed',
    createdAt: now,
    updatedAt: now,
    finishedAt: now,
    ...overrides,
  }
}

function provision(store: InstanceType<typeof ChatRoomWorkspaceStore>, input: Partial<ProvisionChatRoomAgentInput> = {}) {
  return store.provisionAgent(identity, makeInput(input))
}

beforeEach(() => {
  rmSync(testHome, { recursive: true, force: true })
  mkdirSync(testHome, { recursive: true })
})

afterEach(() => {
  rmSync(testHome, { recursive: true, force: true })
})

describe('聊天室本地工作区存储', () => {
  test('孤立 UTF-16 surrogate 不得进入本地 room 配置', () => {
    const store = makeStore()
    expect(() => provision(store, { displayName: '\uD800' })).toThrow('invalid_agent_input')
    expect(store.read('room-1')).toBeUndefined()
  })

  test('updateAgentSkillSnapshot 拒绝与实际快照不一致的 digest', () => {
    const store = makeStore()
    const saved = provision(store)
    const roomAgentId = saved.agents[0]!.roomAgentId
    const snapshotPath = getChatRoomAgentSkillsSnapshotPath('room-1', roomAgentId)
    mkdirSync(snapshotPath, { recursive: true })

    expect(() => store.updateAgentSkillSnapshot('room-1', roomAgentId, {
      snapshotPath,
      digest: '0'.repeat(64),
      skillSlugs: [],
      syncedAt: now,
    })).toThrow('invalid_skill_snapshot')
  })

  test('room 无配置时 provision 建立隔离目录并原子写 room.json', () => {
    const store = makeStore()
    const saved = provision(store)
    const roomAgentId = saved.agents[0]!.roomAgentId

    expect(saved.agents).toHaveLength(1)
    expect(existsSync(getChatRoomAgentInboxPath('room-1', roomAgentId))).toBe(true)
    expect(existsSync(join(testHome, '.copis', 'agent-sessions.json'))).toBe(false)
    expect(lstatSync(getChatRoomConfigPath('room-1')).mode & 0o777).toBe(0o600)
  })

  test('room 已有 3 个 Agent 时拒绝第 4 个且配置不变', () => {
    const store = makeStore()
    provision(store, { displayName: 'Agent A' })
    provision(store, { displayName: 'Agent B' })
    provision(store, { displayName: 'Agent C' })
    const before = readFileSync(getChatRoomConfigPath('room-1'), 'utf8')

    expect(() => provision(store, { displayName: 'Agent D' })).toThrow('agent_limit_reached')
    expect(store.read('room-1')?.agents).toHaveLength(3)
    expect(readFileSync(getChatRoomConfigPath('room-1'), 'utf8')).toBe(before)
  })

  test('terminal 记录超过 30 天且超过 2000 条时删除过期并保留最近 2000 条', () => {
    const store = makeStore()
    const saved = provision(store)
    const records = Array.from({ length: 4_110 }, (_, index) => makeInvocation({
      invocationId: `inv-${index}`,
      traceId: `trace-${index}`,
      targetAgentId: saved.agents[0]!.roomAgentId,
      createdAt: now - index,
      updatedAt: now - index,
      finishedAt: now - index,
    }))
    const configPath = getChatRoomConfigPath('room-1')
    const config = JSON.parse(readFileSync(configPath, 'utf8'))
    writeFileSync(configPath, JSON.stringify({ ...config, invocations: records }))

    const compacted = store.compactInvocationRecords('room-1', now)
    expect(compacted.terminalCount).toBe(2_000)
    expect(compacted.records).toHaveLength(2_000)
    expect(compacted.records.some((record) => record.finishedAt! < now - 30 * DAY)).toBe(false)
  })

  test('running 记录很旧时压缩不裁剪非 terminal 记录', () => {
    const store = makeStore()
    const saved = provision(store)
    store.upsertInvocation('room-1', makeInvocation({
      invocationId: 'inv-running',
      traceId: 'trace-running',
      targetAgentId: saved.agents[0]!.roomAgentId,
      status: 'running',
      createdAt: now - 60 * DAY,
      updatedAt: now - 60 * DAY,
      finishedAt: undefined,
      acceptedAt: now - 60 * DAY,
      startedAt: now - 60 * DAY,
    }))

    store.compactInvocationRecords('room-1', now)
    expect(store.getInvocation('room-1', 'inv-running')?.status).toBe('running')
  })

  test('恢复损坏 room.json 时复用 tmp/bak 且日志不泄露绝对路径', () => {
    const store = makeStore()
    provision(store)
    const configPath = getChatRoomConfigPath('room-1')
    const valid = readFileSync(configPath, 'utf8')
    writeFileSync(configPath, '{broken')
    writeFileSync(`${configPath}.tmp`, valid)
    const logs: string[] = []
    const originalLog = console.log
    const originalWarn = console.warn
    console.log = (...args: unknown[]) => logs.push(args.join(' '))
    console.warn = (...args: unknown[]) => logs.push(args.join(' '))
    try {
      expect(store.read('room-1')?.roomId).toBe('room-1')
    } finally {
      console.log = originalLog
      console.warn = originalWarn
    }
    expect(logs.join('\n')).not.toContain(testHome)
    expect(logs.join('\n')).toContain('聊天室配置')
  })

  test('tmp 损坏时从 bak 恢复且恢复日志不含绝对路径', () => {
    const store = makeStore()
    provision(store)
    const configPath = getChatRoomConfigPath('room-1')
    const valid = readFileSync(configPath, 'utf8')
    writeFileSync(configPath, '{broken')
    writeFileSync(`${configPath}.tmp`, '{also-broken')
    writeFileSync(`${configPath}.bak`, valid)
    const logs: string[] = []
    const originalLog = console.log
    const originalWarn = console.warn
    const originalError = console.error
    console.log = (...args: unknown[]) => logs.push(args.join(' '))
    console.warn = (...args: unknown[]) => logs.push(args.join(' '))
    console.error = (...args: unknown[]) => logs.push(args.join(' '))
    try {
      expect(store.read('room-1')?.roomId).toBe('room-1')
    } finally {
      console.log = originalLog
      console.warn = originalWarn
      console.error = originalError
    }
    expect(logs.join('\n')).not.toContain(testHome)
    expect(logs.join('\n')).toContain('聊天室配置')
  })

  test('重复 upsert 的内容不变化时不刷新 room.json', () => {
    const store = makeStore()
    const saved = provision(store)
    const record = makeInvocation({ targetAgentId: saved.agents[0]!.roomAgentId })
    store.upsertInvocation('room-1', record)
    const before = readFileSync(getChatRoomConfigPath('room-1'), 'utf8')
    store.upsertInvocation('room-1', record)
    expect(readFileSync(getChatRoomConfigPath('room-1'), 'utf8')).toBe(before)
  })

  test('严格拒绝 identity、duplicate id/session、display name 和 context 边界', () => {
    const store = makeStore()
    const first = provision(store)
    const configPath = getChatRoomConfigPath('room-1')
    const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as { agents: ChatRoomAgentLocalConfig[] }
    parsed.agents[0]!.sessionId = parsed.agents[0]!.sessionId
    writeFileSync(configPath, JSON.stringify({ ...parsed, hostUserId: 'other-host' }))
    expect(() => store.read('room-1')).toThrow('identity_mismatch')

    writeFileSync(configPath, JSON.stringify({ ...parsed, hostUserId: identity.hostUserId, deviceId: identity.deviceId, agents: [
      first.agents[0],
      { ...first.agents[0], roomAgentId: 'another-agent', sessionId: 'another-session', displayName: 'AGENT A' },
    ] }))
    expect(() => store.read('room-1')).toThrow('display_name_conflict')
    expect(() => provision(store, { displayName: 'Agent B', contextMessageCount: 0 })).toThrow()
  })

  test('archive 只设置 archivedAt 且不删除 agent 目录', () => {
    const store = makeStore()
    const saved = provision(store)
    const roomAgentId = saved.agents[0]!.roomAgentId
    const agentPath = getChatRoomPath('room-1') + `/agents/${roomAgentId}`

    const archived = store.archiveAgent({ roomId: 'room-1', roomAgentId })
    expect(archived.agents[0]!.archivedAt).toBe(now)
    expect(existsSync(agentPath)).toBe(true)
  })

  test('room、agents 或 agent 目录为 symlink 时 fail closed', () => {
    if (process.platform === 'win32') return
    const external = join(testHome, 'external')
    mkdirSync(external, { recursive: true })
    const roomsRoot = getChatRoomsRootPath()
    symlinkSync(external, join(roomsRoot, 'room-1'))
    const store = makeStore()
    expect(() => store.provisionAgent(identity, makeInput())).toThrow()
  })

  test('非法 roomId 在任何目录 mutation 前拒绝且不创建 chatrooms 外目录', () => {
    const store = makeStore()
    const escaped = join(testHome, '.copis-dev', 'agent-workspaces', 'escaped')

    expect(() => store.provisionAgent(identity, makeInput({ roomId: '../escaped' }))).toThrow()
    expect(existsSync(escaped)).toBe(false)
  })

  test('room.json 持久化并严格要求 version 1', () => {
    const store = makeStore()
    provision(store)
    const configPath = getChatRoomConfigPath('room-1')
    const config = JSON.parse(readFileSync(configPath, 'utf8'))
    expect(config.version).toBe(1)

    delete config.version
    writeFileSync(configPath, JSON.stringify(config))
    expect(() => store.read('room-1')).toThrow('invalid_room_config')
  })

  test('主文件和 tmp/bak 都不可恢复时 provision fail closed 且不覆盖原文件', () => {
    const store = makeStore()
    provision(store)
    const configPath = getChatRoomConfigPath('room-1')
    writeFileSync(configPath, '{main-broken')
    writeFileSync(`${configPath}.tmp`, '{tmp-broken')
    writeFileSync(`${configPath}.bak`, '{bak-broken')

    expect(() => provision(store, { displayName: 'Agent B' })).toThrow('room_config_unrecoverable')
    expect(readFileSync(configPath, 'utf8')).toBe('{main-broken')
  })

  test('配置写入失败时只回滚本次创建的 agents 目录', () => {
    const store = makeStore()
    const roomPath = getChatRoomPath('room-rollback')
    mkdirSync(roomPath, { recursive: true })
    mkdirSync(join(roomPath, 'room.json.tmp'))
    const agentsPath = join(roomPath, 'agents')

    expect(() => store.provisionAgent(identity, makeInput({ roomId: 'room-rollback' }))).toThrow()
    expect(existsSync(join(roomPath, 'room.json.tmp'))).toBe(true)
    expect(existsSync(agentsPath)).toBe(false)
  })

  test('read 校验完整 Agent 目录链路并拒绝缺失目录', () => {
    const store = makeStore()
    const saved = provision(store)
    const inboxPath = getChatRoomAgentInboxPath('room-1', saved.agents[0]!.roomAgentId)
    rmSync(inboxPath, { recursive: true, force: true })

    expect(() => store.read('room-1')).toThrow('聊天室 Agent inbox_path_unavailable')
  })

  test('read 拒绝 agents 和 inbox 目录 symlink', () => {
    if (process.platform === 'win32') return
    const store = makeStore()
    const saved = provision(store)
    const roomsRoot = getChatRoomsRootPath()
    const roomPath = getChatRoomPath('room-1')
    const agentsPath = join(roomPath, 'agents')
    const externalAgents = join(testHome, 'external-agents')
    mkdirSync(externalAgents)
    rmSync(agentsPath, { recursive: true, force: true })
    symlinkSync(externalAgents, agentsPath)
    expect(() => store.read('room-1')).toThrow('聊天室 Agent 根_path_not_directory')

    rmSync(agentsPath, { force: true })
    mkdirSync(agentsPath)
    const agentPath = join(agentsPath, saved.agents[0]!.roomAgentId)
    mkdirSync(agentPath)
    mkdirSync(join(agentPath, 'sessions'))
    mkdirSync(join(agentPath, 'workspace-files'))
    mkdirSync(join(agentPath, 'workspace-files', 'project'))
    const externalInbox = join(testHome, 'external-inbox')
    mkdirSync(externalInbox)
    symlinkSync(externalInbox, join(agentPath, 'workspace-files', 'project', 'inbox'))
    mkdirSync(join(agentPath, 'skills-snapshot'))
    expect(() => store.read('room-1')).toThrow('聊天室 Agent inbox_path_not_directory')
    expect(roomsRoot).toBe(getChatRoomsRootPath())
  })

  test('archived display name 不阻塞 active update，但 active-active 仍冲突', () => {
    const store = makeStore()
    const archived = provision(store, { displayName: 'Reusable' })
    const active = provision(store, { displayName: 'Active A' })
    const other = provision(store, { displayName: 'Active B' })
    store.archiveAgent({ roomId: 'room-1', roomAgentId: archived.agents[0]!.roomAgentId })

    expect(store.updateAgent({
      roomId: 'room-1',
      roomAgentId: active.agents[1]!.roomAgentId,
      displayName: 'Reusable',
    }).agents.find((agent) => agent.roomAgentId === active.agents[1]!.roomAgentId)?.displayName).toBe('Reusable')
    expect(() => store.updateAgent({
      roomId: 'room-1',
      roomAgentId: other.agents[2]!.roomAgentId,
      displayName: 'Reusable',
    })).toThrow('display_name_conflict')
  })

  test('persisted roomAgentId 必须是安全 path component，拒绝目录穿越和特殊组件', () => {
    const store = makeStore()
    const saved = provision(store)
    const configPath = getChatRoomConfigPath('room-1')
    const roomPath = getChatRoomPath('room-1')
    const outsidePath = join(roomPath, 'outside')
    mkdirSync(outsidePath)
    const sentinelPath = join(outsidePath, 'sentinel.txt')
    writeFileSync(sentinelPath, 'keep')
    const config = JSON.parse(readFileSync(configPath, 'utf8'))
    for (const roomAgentId of ['../outside', 'agent/other', '.', '..']) {
      writeFileSync(configPath, JSON.stringify({
        ...config,
        agents: [{ ...saved.agents[0], roomAgentId }],
      }))
      expect(() => store.read('room-1')).toThrow('invalid_room_config')
      expect(readFileSync(sentinelPath, 'utf8')).toBe('keep')
    }
  })

  test('invocation 状态矩阵拒绝不一致的时间和 failure 字段', () => {
    const store = makeStore()
    const saved = provision(store)
    const targetAgentId = saved.agents[0]!.roomAgentId
    const invocation = (overrides: Partial<ChatRoomInvocationRecord>) => makeInvocation({ targetAgentId, ...overrides })

    expect(() => store.upsertInvocation('room-1', invocation({ invocationId: 'terminal-missing-time', finishedAt: undefined }))).toThrow('invalid_room_config')
    expect(() => store.upsertInvocation('room-1', invocation({ invocationId: 'completed-failure', failureCode: 'internal_error' }))).toThrow('invalid_room_config')
    expect(() => store.upsertInvocation('room-1', invocation({ invocationId: 'created-later-time', status: 'created', finishedAt: undefined, acceptedAt: now }))).toThrow('invalid_room_config')
    expect(() => store.upsertInvocation('room-1', invocation({ invocationId: 'accepted-started', status: 'accepted', finishedAt: undefined, acceptedAt: now, startedAt: now }))).toThrow('invalid_room_config')
    expect(() => store.upsertInvocation('room-1', invocation({ invocationId: 'running-finished', status: 'running', acceptedAt: now, startedAt: now, finishedAt: now }))).toThrow('invalid_room_config')
    expect(() => store.upsertInvocation('room-1', invocation({ invocationId: 'failed-missing-code', status: 'failed' }))).toThrow('invalid_room_config')
    expect(() => store.upsertInvocation('room-1', invocation({ invocationId: 'rejected-missing-message', status: 'rejected', failureCode: 'host_approval_denied' }))).toThrow('invalid_room_config')
  })

  test('同 trace 和 target 的不同 invocationId 拒绝为 duplicate', () => {
    const store = makeStore()
    const saved = provision(store)
    const first = makeInvocation({ targetAgentId: saved.agents[0]!.roomAgentId })
    store.upsertInvocation('room-1', first)

    expect(() => store.upsertInvocation('room-1', { ...first, invocationId: 'inv-2' })).toThrow('invocation_duplicate')
  })

  test('archived Agent 不占 active 上限且可复用 display name', () => {
    const store = makeStore()
    const archived = provision(store, { displayName: 'Reusable' })
    store.archiveAgent({ roomId: 'room-1', roomAgentId: archived.agents[0]!.roomAgentId })
    provision(store, { displayName: 'Reusable' })
    provision(store, { displayName: 'Active B' })
    provision(store, { displayName: 'Active C' })

    expect(store.read('room-1')?.agents).toHaveLength(4)
    expect(store.read('room-1')?.agents.filter((agent) => agent.archivedAt === undefined)).toHaveLength(3)
    expect(new Set(store.read('room-1')?.agents.map((agent) => agent.roomAgentId)).size).toBe(4)
  })

  test('invocation CAS 只允许 expected status，terminal 后 late callback 不得覆盖', () => {
    const store = makeStore()
    const saved = provision(store)
    const targetAgentId = saved.agents[0]!.roomAgentId
    const accepted = makeInvocation({ targetAgentId, status: 'accepted', acceptedAt: now, finishedAt: undefined })
    store.upsertInvocation('room-1', accepted)
    expect(store.transitionInvocation('room-1', 'inv-1', ['accepted'], (record) => ({ ...record, status: 'running', startedAt: now, updatedAt: now }))).toMatchObject({ transitioned: true })
    expect(store.transitionInvocation('room-1', 'inv-1', ['running'], (record) => ({ ...record, status: 'failed', finishedAt: now, updatedAt: now, failureCode: 'gateway_disconnected', failureMessage: '聊天室网关已断开' }))).toMatchObject({ transitioned: true })
    expect(store.transitionInvocation('room-1', 'inv-1', ['running'], (record) => ({ ...record, status: 'completed', finishedAt: now, updatedAt: now }))).toMatchObject({ transitioned: false, record: { status: 'failed' } })
  })
})
