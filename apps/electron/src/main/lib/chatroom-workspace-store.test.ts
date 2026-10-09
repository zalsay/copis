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
const { computeChatRoomReplyDigest } = await import('./chatroom-reply-digest')
import type {
  ChatRoomAgentLocalConfig,
  ChatRoomInvocationRecord,
  ChatRoomLocalIdentity,
  ProvisionChatRoomAgentInput,
} from '@copis/shared'
import type { ChatRoomPendingResultInput } from './chatroom-workspace-store'

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

type CompletedPendingResultInput = Extract<ChatRoomPendingResultInput, { expectedStatus: 'completed' }>

function makePendingResult(
  index = 0,
  overrides: Partial<Omit<CompletedPendingResultInput, 'expectedStatus' | 'output' | 'replyDigest'>>
    & Partial<Pick<CompletedPendingResultInput, 'output' | 'replyDigest'>> = {},
): CompletedPendingResultInput {
  const clientMessageId = overrides.clientMessageId ?? `reply-client-${index}`
  const output = { text: `已净化回复 ${index}`, attachmentIds: [], mentionedAgentIds: [] }
  return {
    hostUserId: identity.hostUserId,
    deviceId: identity.deviceId,
    roomId: 'room-1',
    invocationId: `inv-pending-${index}`,
    traceId: `trace-pending-${index}`,
    targetAgentId: 'agent-1',
    triggerMessageId: `trigger-pending-${index}`,
    depth: 0,
    expectedStatus: 'completed',
    clientMessageId,
    output,
    replyDigest: computeChatRoomReplyDigest({ clientMessageId, ...output }),
    createdAt: now,
    ...overrides,
  }
}

beforeEach(() => {
  rmSync(testHome, { recursive: true, force: true })
  mkdirSync(testHome, { recursive: true })
})

afterEach(() => {
  rmSync(testHome, { recursive: true, force: true })
})

describe('聊天室本地工作区存储', () => {
  test('pending 结果在独立 store 实例中可恢复且保留同一回复', () => {
    const store = makeStore()
    const saved = provision(store)
    const record = makePendingResult(0, { roomId: saved.roomId, targetAgentId: saved.agents[0]!.roomAgentId })
    const persisted = store.savePendingResult(record)

    const restartedStore = makeStore()
    expect(restartedStore.listPendingResults(saved.roomId)).toEqual([persisted])
    expect(lstatSync(join(getChatRoomPath(saved.roomId), 'pending-results.json')).mode & 0o777).toBe(0o600)
  })

  test('失败候选仅持久化固定 failure code，不夹带生成输出', () => {
    const store = makeStore()
    const saved = provision(store)
    const record = {
      hostUserId: identity.hostUserId,
      deviceId: identity.deviceId,
      roomId: saved.roomId,
      invocationId: 'inv-failed-pending',
      traceId: 'trace-failed-pending',
      targetAgentId: saved.agents[0]!.roomAgentId,
      triggerMessageId: 'trigger-failed-pending',
      depth: 0,
      clientMessageId: 'reply-failed-pending',
      createdAt: now,
      expectedStatus: 'failed' as const,
      failureCode: 'internal_error' as const,
    }

    const persisted = store.savePendingResult(record)
    expect(persisted).toMatchObject(record)
    expect(persisted).not.toHaveProperty('output')
    expect(persisted).not.toHaveProperty('replyDigest')
  })

  test('同一 invocation 的相同结果幂等，冲突结果不能覆盖旧回复', () => {
    const store = makeStore()
    const saved = provision(store)
    const original = makePendingResult(0, { targetAgentId: saved.agents[0]!.roomAgentId })
    const persisted = store.savePendingResult(original)

    expect(store.savePendingResult(original)).toEqual(persisted)
    expect(() => store.savePendingResult(makePendingResult(0, {
      targetAgentId: saved.agents[0]!.roomAgentId,
      output: { text: '不同回复', attachmentIds: [], mentionedAgentIds: [] },
      replyDigest: computeChatRoomReplyDigest({ clientMessageId: original.clientMessageId, text: '不同回复', attachmentIds: [], mentionedAgentIds: [] }),
    }))).toThrow('pending_result_conflict')
    expect(store.listPendingResults(saved.roomId)).toEqual([persisted])
  })

  test('同一用户消息发给两个 Agent 时分别保留两份 pending 回复', () => {
    const store = makeStore()
    provision(store, { displayName: 'Agent A' })
    const room = provision(store, { displayName: 'Agent B' })
    const [agentA, agentB] = room.agents
    const clientMessageId = 'shared-user-trigger-1'
    const first = makePendingResult(1, {
      targetAgentId: agentA!.roomAgentId,
      triggerMessageId: clientMessageId,
      clientMessageId,
    })
    const second = makePendingResult(2, {
      targetAgentId: agentB!.roomAgentId,
      triggerMessageId: clientMessageId,
      clientMessageId,
    })

    const firstSaved = store.savePendingResult(first)
    const secondSaved = store.savePendingResult(second)
    expect(secondSaved.invocationId).not.toBe(firstSaved.invocationId)
    expect(store.listPendingResults(room.roomId)).toEqual([firstSaved, secondSaved])
    expect(makeStore().listPendingResults(room.roomId)).toEqual([firstSaved, secondSaved])
  })

  test('同一 Agent 的同一 clientMessageId 不能被另一 invocation 占用', () => {
    const store = makeStore()
    const room = provision(store)
    const targetAgentId = room.agents[0]!.roomAgentId
    const original = store.savePendingResult(makePendingResult(1, {
      targetAgentId,
      triggerMessageId: 'shared-user-trigger-1',
      clientMessageId: 'shared-user-trigger-1',
    }))

    expect(() => store.savePendingResult(makePendingResult(2, {
      targetAgentId,
      triggerMessageId: 'shared-user-trigger-1',
      clientMessageId: 'shared-user-trigger-1',
    }))).toThrow('pending_result_conflict')
    expect(store.listPendingResults(room.roomId)).toEqual([original])
  })

  test('精确记录 compare-and-delete 不会让旧 revision 删除重建的结果', () => {
    const store = makeStore()
    const saved = provision(store)
    const input = makePendingResult(0, { targetAgentId: saved.agents[0]!.roomAgentId })
    const oldRecord = store.savePendingResult(input)

    expect(store.removePendingResultIfUnchanged(oldRecord)).toBe(true)
    const replacement = store.savePendingResult(input)
    expect(replacement.recordRevision).not.toBe(oldRecord.recordRevision)
    expect(store.removePendingResultIfUnchanged(oldRecord)).toBe(false)
    expect(store.listPendingResults(saved.roomId)).toEqual([replacement])
  })

  test('pending 记录满额后拒绝新回复且不自动淘汰唯一结果', () => {
    const store = makeStore()
    const saved = provision(store)
    const records = Array.from({ length: 32 }, (_, index) => store.savePendingResult(makePendingResult(index, {
      targetAgentId: saved.agents[0]!.roomAgentId,
    })))

    expect(() => store.savePendingResult(makePendingResult(32, { targetAgentId: saved.agents[0]!.roomAgentId })))
      .toThrow('pending_results_full')
    expect(store.listPendingResults(saved.roomId)).toEqual(records)
  })

  test('错误账户不能读取其他 host 的 pending 回复', () => {
    const store = makeStore()
    const saved = provision(store)
    store.savePendingResult(makePendingResult(0, { targetAgentId: saved.agents[0]!.roomAgentId }))
    const otherAccount = new ChatRoomWorkspaceStore({ identity: { hostUserId: 'host-2', deviceId: identity.deviceId }, now: () => now })

    expect(() => otherAccount.listPendingResults(saved.roomId)).toThrow('identity_mismatch')
  })

  test('摘要不匹配的输出与单文件超限内容均拒绝读取或写入', () => {
    const store = makeStore()
    const saved = provision(store)
    const original = store.savePendingResult(makePendingResult(0, { targetAgentId: saved.agents[0]!.roomAgentId }))
    expect(() => store.savePendingResult(makePendingResult(1, {
      targetAgentId: saved.agents[0]!.roomAgentId,
      replyDigest: 'b'.repeat(64),
    }))).toThrow('invalid_pending_result_digest')
    expect(store.listPendingResults(saved.roomId)).toEqual([original])

    const pendingPath = join(getChatRoomPath(saved.roomId), 'pending-results.json')
    writeFileSync(pendingPath, Buffer.alloc(3 * 1024 * 1024 + 1, 0x20))
    expect(() => store.listPendingResults(saved.roomId)).toThrow('pending_results_unrecoverable')
  })

  test('pending JSON symlink 与损坏内容均 fail closed', () => {
    const store = makeStore()
    const saved = provision(store)
    const pendingPath = join(getChatRoomPath(saved.roomId), 'pending-results.json')
    const outsidePath = join(testHome, 'outside-pending.json')
    writeFileSync(outsidePath, 'untouched')
    symlinkSync(outsidePath, pendingPath)
    expect(() => store.listPendingResults(saved.roomId)).toThrow('pending_results_path_not_file')
    expect(() => store.savePendingResult(makePendingResult(0, { targetAgentId: saved.agents[0]!.roomAgentId })))
      .toThrow('pending_results_path_not_file')
    expect(readFileSync(outsidePath, 'utf8')).toBe('untouched')

    rmSync(pendingPath)
    writeFileSync(pendingPath, '{broken')
    expect(() => store.listPendingResults(saved.roomId)).toThrow('pending_results_unrecoverable')
  })

  test('超出单条 UTF-8 内容上限时不修改已有结果', () => {
    const store = makeStore()
    const saved = provision(store)
    const original = store.savePendingResult(makePendingResult(0, { targetAgentId: saved.agents[0]!.roomAgentId }))
    const text = '界'.repeat(100_000)
    const output = { text, attachmentIds: [], mentionedAgentIds: [] }
    const tooLarge = makePendingResult(1, {
      targetAgentId: saved.agents[0]!.roomAgentId,
      output,
      replyDigest: 'a'.repeat(64),
    })

    expect(() => store.savePendingResult(tooLarge)).toThrow('pending_result_too_large')
    expect(store.listPendingResults(saved.roomId)).toEqual([original])
  })

  test('恢复租约时跳过单个损坏的 room.json，不阻止其他房间', () => {
    const store = makeStore()
    provision(store, { roomId: 'room-broken' })
    provision(store, { roomId: 'room-healthy' })
    writeFileSync(getChatRoomConfigPath('room-broken'), '{invalid json')
    expect(() => store.list()).toThrow()
    expect(store.listRestorableRooms().map((room) => room.roomId)).toEqual(['room-healthy'])
  })

  test('远端 Agent ID 成为本地配置与独立目录的共同主键', () => {
    const store = makeStore()
    const saved = store.provisionAgent(identity, makeInput(), 'server-agent-1')
    expect(saved.agents[0]?.roomAgentId).toBe('server-agent-1')
    expect(store.read('room-1')?.agents[0]?.roomAgentId).toBe('server-agent-1')
    expect(existsSync(getChatRoomAgentInboxPath('room-1', 'server-agent-1'))).toBe(true)
  })

  test('terminal invocation cannot transition back to another terminal status', () => {
    const store = makeStore()
    const saved = provision(store)
    const roomAgentId = saved.agents[0]!.roomAgentId
    store.upsertInvocation('room-1', makeInvocation({ targetAgentId: roomAgentId, status: 'accepted', acceptedAt: now, finishedAt: undefined }))
    expect(store.transitionInvocation('room-1', 'inv-1', ['accepted'], (record) => ({ ...record, status: 'running', startedAt: now })).transitioned).toBe(true)
    expect(store.transitionInvocation('room-1', 'inv-1', ['running'], (record) => ({ ...record, status: 'completed', finishedAt: now })).transitioned).toBe(true)
    expect(store.transitionInvocation('room-1', 'inv-1', ['completed'], (record) => ({ ...record, status: 'failed', failureCode: 'internal_error', failureMessage: 'x' })).transitioned).toBe(false)
    expect(store.getInvocation('room-1', 'inv-1')?.status).toBe('completed')
  })
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

  test('Given a journal plans room creation time When the first Agent is persisted Then retain that immutable createdAt', () => {
    const store = makeStore()
    const roomCreatedAt = now - 1234
    const saved = (store.provisionAgent as any)(identity, makeInput({ roomId: 'room-planned-time' }), 'server-agent-1', { roomCreatedAt })
    expect(saved.createdAt).toBe(roomCreatedAt)
    expect(store.read('room-planned-time')?.createdAt).toBe(roomCreatedAt)
  })

  test('Given a room already exists When an operation supplies a different immutable createdAt Then reject instead of replacing its identity', () => {
    const store = makeStore()
    const room = provision(store, { roomId: 'room-identity' })
    expect(() => (store.provisionAgent as any)(identity, makeInput({ roomId: 'room-identity', displayName: 'Agent B' }), 'server-agent-2', { roomCreatedAt: room.createdAt + 1 })).toThrow('management_operation_room_identity_mismatch')
    expect(store.read('room-identity')?.createdAt).toBe(room.createdAt)
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
