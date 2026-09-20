import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const testHome = join(process.env.TMPDIR ?? '/tmp', `copis-chatroom-store-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)

mock.module('electron', () => ({ app: { isPackaged: false } }))
mock.module('node:os', () => ({ homedir: () => testHome }))

const {
  getChatRoomAgentInboxPath,
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
})
